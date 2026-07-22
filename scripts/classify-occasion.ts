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
import { ensureClassificationSchema, type ReviewStatus } from './classification-storage.ts';

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
  'unclassified',
] as const;

const ClassificationSchema = z.object({
  classifications: z.array(z.object({
    slug: z.string(),
    occasion: z.enum(OCCASIONS),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(500),
  })),
});
const ReviewSchema = z.object({
  reviews: z.array(z.object({
    slug: z.string(),
    occasion: z.enum(OCCASIONS),
    confidence: z.number().min(0).max(1),
    decision: z.enum(['confirm', 'change', 'insufficient-evidence']),
    reason: z.string().min(1).max(500),
  })),
});

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  throw new Error('GROQ_API_KEY is not set. Run with --env-file=server/.env (see the header comment).');
}
const groq = new Groq({ apiKey });

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  ensureClassificationSchema(db);
  return db;
}

interface ProductForClassification {
  slug: string;
  title: string;
  subtitle: string | null;
  categories: string | null;
  attributes: string | null;
}

// Only uncertain labels are sent to the API. Verified and high-confidence
// deterministic labels remain local facts and never consume LLM quota.
function getProductsForClassification(db: DatabaseSync): ProductForClassification[] {
  const rows = db
    .prepare(
      `SELECT p.slug, p.title, p.subtitle,
              GROUP_CONCAT(DISTINCT pc.category_key) as categories,
              GROUP_CONCAT(DISTINCT pa.attribute_type || '=' || pa.attribute_value) as attributes
       FROM products p
       LEFT JOIN product_categories pc ON pc.product_slug = p.slug
       LEFT JOIN product_attributes pa ON pa.product_slug = p.slug
       JOIN product_occasion po ON po.product_slug = p.slug
       WHERE po.review_status = 'needs-llm-review'
          OR po.confidence IS NULL
          OR (po.source IN ('llm', 'llm-review') AND po.review_status = 'needs-recheck')
       GROUP BY p.slug`,
    )
    .all() as unknown as ProductForClassification[];
  return rows;
}

type LlmClassification = z.infer<typeof ClassificationSchema>['classifications'][number];
type LlmReview = z.infer<typeof ReviewSchema>['reviews'][number];

async function classifyBatch(batch: ProductForClassification[]): Promise<Map<string, LlmClassification>> {
  const systemPrompt = `You classify Pakistani women's clothing products by likely occasion/event, for a shopping search feature.

For each product, choose exactly one occasion from this fixed list: ${OCCASIONS.join(', ')}.

Each product may include real attribute tags scraped from Bareeze's own site — these are ground truth and should be weighted more heavily than the generic title/subtitle text (titles are often abstract style names like "SHADOW WORK" that carry little meaning on their own):
- A Season tag containing "EID" (e.g. Season=EID-1-SUMMER-26) is a strong real signal for festive-eid.
- Type=Embroidered leans festive/formal, away from daily-casual, unless other signals say otherwise.
- subtitle "Festive Collection" is a real signal for festive-eid; plain "New Selection" is only a weak/neutral signal, not evidence of daily-casual by itself.
- category=shawls leans toward office-formal or festive-eid rather than daily-casual by default — shawls in Pakistani fashion are commonly formal/festive wear, not routinely everyday wear.
- Fabric=velvet or Season containing "WINTER" leans winter-wear.

Use "daily-casual" only when signals genuinely point that way (e.g. category=casuals with no festive/embroidered signal), not as a fallback for lack of information. It is fine and expected for wedding-bridal, party-evening, and winter-wear to be used when the signals support them — do not systematically avoid the less common categories.

Return ONLY JSON: { "classifications": [{ "slug": string, "occasion": string, "confidence": number, "reason": string }, ...] }.
Return one entry per product. Confidence means support from the supplied catalogue data, not how plausible the style sounds. Use unclassified below 0.60 or when the evidence is insufficient. No prose.`;

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
  return new Map(parsed.classifications.map((c) => [c.slug, c]));
}

async function reviewBatch(batch: Array<{ product: ProductForClassification; classification: LlmClassification }>): Promise<Map<string, LlmReview>> {
  const response = await groq.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `You are an independent quality reviewer for Pakistani women's clothing occasion tags. Challenge the first classifier using only the supplied real Bareeze product data. Choose one: ${OCCASIONS.join(', ')}. Return unclassified if evidence is inadequate. Do not assume a product is festive, bridal, or casual from an abstract title alone. Return ONLY JSON: { "reviews": [{ "slug": string, "occasion": string, "confidence": number, "decision": "confirm"|"change"|"insufficient-evidence", "reason": string }] }.`,
      },
      {
        role: 'user',
        content: batch.map(({ product, classification }) => `slug: ${product.slug}\ntitle: ${product.title}\nsubtitle: ${product.subtitle || '(none)'}\ncategory: ${product.categories || '(none)'}\nattributes: ${product.attributes || '(none)'}\nfirst result: ${classification.occasion} (${classification.confidence}) — ${classification.reason}`).join('\n---\n'),
      },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? '{}';
  const parsed = ReviewSchema.parse(JSON.parse(raw));
  return new Map(parsed.reviews.map((review) => [review.slug, review]));
}

async function main() {
  const db = openDatabase();
  const products = getProductsForClassification(db);
  console.log(`${products.length} uncertain product(s) queued for LLM classification.`);

  const insert = db.prepare(
    `UPDATE product_occasion SET occasion = ?, classified_at = ?, source = ?, confidence = ?, review_status = ?,
      reason = ?, evidence_json = NULL, reviewer_confidence = ?, reviewer_reason = ?, reviewed_at = ?
     WHERE product_slug = ?`,
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
        const classification = results.get(product.slug);
        if (!classification) continue; // never insert a guess the model didn't actually make
        const needsReview = classification.confidence < 0.8 || classification.occasion === 'unclassified';
        const status: ReviewStatus = needsReview ? 'needs-llm-review' : 'accepted';
        insert.run(classification.occasion, now, 'llm', classification.confidence, status, classification.reason, null, null, null, product.slug);
        classified++;
      }
      const reviewCandidates = batch.flatMap((product) => {
        const classification = results.get(product.slug);
        return classification && (classification.confidence < 0.8 || classification.occasion === 'unclassified') ? [{ product, classification }] : [];
      });
      if (reviewCandidates.length > 0) {
        const reviews = await reviewBatch(reviewCandidates);
        for (const { product, classification } of reviewCandidates) {
          const review = reviews.get(product.slug);
          if (!review) continue;
          const accepted = review.decision !== 'insufficient-evidence' && review.confidence >= 0.8;
          const status: ReviewStatus = accepted ? 'accepted' : review.decision === 'insufficient-evidence' || review.confidence < 0.6 ? 'unclassified' : 'needs-recheck';
          const occasion = status === 'unclassified' ? 'unclassified' : review.occasion;
          insert.run(occasion, now, 'llm-review', review.confidence, status, review.reason, classification.confidence, classification.reason, now, product.slug);
        }
      }
      if (missing.length > 0) {
        skipped += missing.length;
        console.log(`  Batch ${batchNum}: ${missing.length} product(s) still unclassified after retry, left as-is: ${missing.map((p) => p.slug).join(', ')}`);
      }
      console.log(`Batch ${batchNum}/${totalBatches}: classified ${batch.length - missing.length}/${batch.length} products.`);
    } catch (error) {
      const message = (error as Error).message;
      console.log(`Batch ${batchNum} FAILED: ${message}`);
      // A quota error cannot be improved by immediately retrying the remaining
      // batches. Stop cleanly; their existing needs-llm-review status keeps
      // them out of confident occasion matching and makes the next run resume
      // from exactly this point after the provider quota resets.
      if (/rate_limit|\b429\b/i.test(message)) {
        console.log('Stopped after provider rate limit. Re-run later to resume the remaining queue.');
        break;
      }
    }
  }

  console.log(`\nDone. ${classified} products classified, ${skipped} left unclassified (never guessed).`);
  db.close();
}

await main();
