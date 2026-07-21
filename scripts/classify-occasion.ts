// Phase 3: classifies each product's likely occasion/event — the one
// dimension with no real Bareeze filter to ground-truth against (unlike
// color/fabric/type/piece-count, which come from scripts/tag-attributes.ts
// reading Bareeze's own real filter drawer). This is necessarily an LLM
// inference from title/subtitle/category, not "real data" the way the
// other attributes are — approximate by nature, and marked as such in the
// schema (classified_at, not "confirmed_at").
//
// Run with: node --experimental-strip-types --env-file=server/.env scripts/classify-occasion.ts
// (groq-sdk/zod are installed as root devDependencies specifically so this
// and query-catalog.ts can run standalone with the same flag as
// scrape-catalog.ts/tag-attributes.ts, without needing tsx.)
//
// Must not run concurrently with scrape-catalog.ts or tag-attributes.ts
// against the same database file.
import Groq from 'groq-sdk';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bareeze-catalog.db');
const MODEL = process.env.GROQ_INTENT_MODEL || 'llama-3.3-70b-versatile';
const BATCH_SIZE = 10; // smaller batches reduce the chance the model drops an item from a long JSON array

const OCCASIONS = [
  'daily-casual',
  'office-formal',
  'festive-eid',
  'wedding-bridal',
  'party-evening',
  'winter-wear',
] as const;

const ClassificationSchema = z.object({
  classifications: z.array(z.object({ slug: z.string(), occasion: z.enum(OCCASIONS) })),
});

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  throw new Error('GROQ_API_KEY is not set. Run with --env-file=server/.env (see the header comment).');
}
const groq = new Groq({ apiKey });

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_occasion (
      product_slug TEXT PRIMARY KEY,
      occasion TEXT NOT NULL,
      classified_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'llm'
    );
  `);
  const columns = db.prepare("PRAGMA table_info(product_occasion)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'source')) {
    db.exec(`ALTER TABLE product_occasion ADD COLUMN source TEXT NOT NULL DEFAULT 'llm';`);
  }
  return db;
}

interface ProductForClassification {
  slug: string;
  title: string;
  subtitle: string | null;
  categories: string | null;
  attributes: string | null;
}

// Classifies every product, not just unclassified ones — cheap to re-run in
// full (a few minutes, batched), and means a later re-run after more
// attribute data is gathered will actually refresh existing guesses instead
// of leaving first-pass mistakes stuck forever. Excludes products already
// verified against a real Bareeze collection (scripts/verify-eid-collection.ts)
// or already resolved by a deterministic rule (scripts/classify-occasion-
// rules.ts) — both are higher-confidence than an LLM guess, and a blind
// re-run must never overwrite either with a worse one.
function getAllProductsForClassification(db: DatabaseSync): ProductForClassification[] {
  const rows = db
    .prepare(
      `SELECT p.slug, p.title, p.subtitle,
              GROUP_CONCAT(DISTINCT pc.category_key) as categories,
              GROUP_CONCAT(DISTINCT pa.attribute_type || '=' || pa.attribute_value) as attributes
       FROM products p
       LEFT JOIN product_categories pc ON pc.product_slug = p.slug
       LEFT JOIN product_attributes pa ON pa.product_slug = p.slug
       WHERE p.slug NOT IN (SELECT product_slug FROM product_occasion WHERE source IN ('verified-collection', 'rule-based'))
       GROUP BY p.slug`,
    )
    .all() as unknown as ProductForClassification[];
  return rows;
}

async function classifyBatch(batch: ProductForClassification[]): Promise<Map<string, string>> {
  const systemPrompt = `You classify Pakistani women's clothing products by likely occasion/event, for a shopping search feature.

For each product, choose exactly one occasion from this fixed list: ${OCCASIONS.join(', ')}.

Each product may include real attribute tags scraped from Bareeze's own site — these are ground truth and should be weighted more heavily than the generic title/subtitle text (titles are often abstract style names like "SHADOW WORK" that carry little meaning on their own):
- A Season tag containing "EID" (e.g. Season=EID-1-SUMMER-26) is a strong real signal for festive-eid.
- Type=Embroidered leans festive/formal, away from daily-casual, unless other signals say otherwise.
- subtitle "Festive Collection" is a real signal for festive-eid; plain "New Selection" is only a weak/neutral signal, not evidence of daily-casual by itself.
- category=shawls leans toward office-formal or festive-eid rather than daily-casual by default — shawls in Pakistani fashion are commonly formal/festive wear, not routinely everyday wear.
- Fabric=velvet or Season containing "WINTER" leans winter-wear.

Use "daily-casual" only when signals genuinely point that way (e.g. category=casuals with no festive/embroidered signal), not as a fallback for lack of information. It is fine and expected for wedding-bridal, party-evening, and winter-wear to be used when the signals support them — do not systematically avoid the less common categories.

Return ONLY a JSON object: { "classifications": [{ "slug": string, "occasion": string }, ...] }, one entry per product given, in any order. No prose.`;

  const userPrompt = batch
    .map((p) => `slug: ${p.slug}\ntitle: ${p.title}\nsubtitle: ${p.subtitle || '(none)'}\ncategory: ${p.categories || '(none)'}\nattributes: ${p.attributes || '(none)'}`)
    .join('\n---\n');

  const response = await groq.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    temperature: 0.1,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '{}';
  const parsed = ClassificationSchema.parse(JSON.parse(raw));
  return new Map(parsed.classifications.map((c) => [c.slug, c.occasion]));
}

async function main() {
  const db = openDatabase();
  const products = getAllProductsForClassification(db);
  console.log(`${products.length} products to classify.`);

  const insert = db.prepare(
    "INSERT OR REPLACE INTO product_occasion (product_slug, occasion, classified_at, source) VALUES (?, ?, ?, 'llm')",
  );

  let classified = 0;
  let skipped = 0;
  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(products.length / BATCH_SIZE);
    try {
      let results = await classifyBatch(batch);
      let missing = batch.filter((p) => !results.has(p.slug));

      // The model can drop a slug from a long JSON array without erroring —
      // retrying just the missing ones (a much shorter list) gives it a
      // second, easier chance rather than silently guessing an occasion for
      // them. A wrong hardcoded guess here (the previous behavior: falling
      // back to 'daily-casual') defeats the whole point of the prompt above
      // explicitly saying not to use daily-casual as a fallback.
      if (missing.length > 0) {
        console.log(`  Batch ${batchNum}: retrying ${missing.length} product(s) missing from the response.`);
        const retryResults = await classifyBatch(missing);
        results = new Map([...results, ...retryResults]);
        missing = batch.filter((p) => !results.has(p.slug));
      }

      const now = new Date().toISOString();
      for (const product of batch) {
        const occasion = results.get(product.slug);
        if (!occasion) continue; // never insert a guess the model didn't actually make
        insert.run(product.slug, occasion, now);
        classified++;
      }
      if (missing.length > 0) {
        skipped += missing.length;
        console.log(`  Batch ${batchNum}: ${missing.length} product(s) still unclassified after retry, left as-is: ${missing.map((p) => p.slug).join(', ')}`);
      }
      console.log(`Batch ${batchNum}/${totalBatches}: classified ${batch.length - missing.length}/${batch.length} products.`);
    } catch (error) {
      console.log(`Batch ${batchNum} FAILED: ${(error as Error).message}`);
    }
  }

  console.log(`\nDone. ${classified} products classified, ${skipped} left unclassified (never guessed).`);
  db.close();
}

await main();
