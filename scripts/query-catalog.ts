// The "chat" layer: takes a natural-language request, has the LLM extract
// structured intent (including occasion — which the live extension's
// server/ intentionally does NOT support yet, since the DB work was scoped
// as a separate one-off tool, extension unchanged for now), then matches
// against the local database directly instead of building a Bareeze URL.
// Unlike the live voice search, this can combine occasion with every other
// real attribute, since it isn't limited to what Bareeze's own filter UI
// supports in one URL.
//
// Run with: node --env-file=server/.env --import tsx scripts/query-catalog.ts "green casual lawn suit under 5000"
// (needs tsx specifically, not --experimental-strip-types: it imports
// src/shared/canonicalize.ts, which is written for the main extension's
// bundler-style extensionless imports — tsx's loader handles that
// resolution the same way esbuild does; Node's native loader doesn't.)
import Groq from 'groq-sdk';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  canonicalizeCollection,
  canonicalizeColor,
  canonicalizeFabric,
  canonicalizePieceCount,
  canonicalizeType,
} from '../src/shared/canonicalize.ts';

const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bareeze-catalog.db');
const MODEL = process.env.GROQ_INTENT_MODEL || 'llama-3.3-70b-versatile';

const OCCASIONS = ['daily-casual', 'office-formal', 'festive-eid', 'wedding-bridal', 'party-evening', 'winter-wear'] as const;
const OCCASION_ALIASES: Record<string, (typeof OCCASIONS)[number]> = {
  casual: 'daily-casual', everyday: 'daily-casual', daily: 'daily-casual',
  office: 'office-formal', work: 'office-formal', formal: 'office-formal',
  eid: 'festive-eid', festive: 'festive-eid', 'chand raat': 'festive-eid',
  wedding: 'wedding-bridal', shaadi: 'wedding-bridal', bridal: 'wedding-bridal', nikah: 'wedding-bridal', baraat: 'wedding-bridal', walima: 'wedding-bridal',
  party: 'party-evening', evening: 'party-evening', dawat: 'party-evening',
  winter: 'winter-wear',
};
function canonicalizeOccasion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return OCCASION_ALIASES[raw.trim().toLowerCase()] ?? null;
}

const RawIntentSchema = z.object({
  collection: z.string().nullable().optional(),
  fabric: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  pieceCount: z.string().nullable().optional(),
  occasion: z.string().nullable().optional(),
  priceMax: z.number().nullable().optional(),
});
type RawIntent = z.infer<typeof RawIntentSchema>;

const SYSTEM_PROMPT = `You are a shopping-intent extractor for Bareeze, a Pakistani women's clothing brand.

Given a shopper's request (English, Urdu, or Roman Urdu), extract these fields as a single JSON object:
{ "collection": string|null, "fabric": string|null, "color": string|null, "type": string|null, "pieceCount": string|null, "occasion": string|null, "priceMax": number|null }

- collection: casual, formal, shawl, new arrivals, sale, pret, prints.
- fabric: lawn, khaddar, velvet, chiffon, organza, net, cotton, cambric, karandi.
- color: any named color, in the shopper's own words — do not translate it yourself.
- type: a construction/finish descriptor, e.g. embroidered.
- pieceCount: e.g. "2 piece", "3 piece".
- occasion: the event/context, in the shopper's own words (e.g. "wedding", "eid", "office", "party", "everyday") — do not force it into any fixed list yourself.
- priceMax: an upper budget in PKR if stated.

Only include a field if the shopper actually said something relevant to it — null otherwise. Return ONLY the JSON object, no prose.`;

async function extractIntent(client: Groq, text: string): Promise<RawIntent> {
  const response = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Shopper's request: ${text}` },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? '{}';
  return RawIntentSchema.parse(JSON.parse(raw));
}

interface CatalogIntent {
  collection: string | null;
  fabric: string | null;
  color: string | null;
  type: string | null;
  pieceCount: string | null;
  occasion: string | null;
  priceMax: number | null;
}

function canonicalizeForCatalog(raw: RawIntent): CatalogIntent {
  return {
    collection: canonicalizeCollection(raw.collection),
    fabric: canonicalizeFabric(raw.fabric),
    color: canonicalizeColor(raw.color),
    type: canonicalizeType(raw.type),
    pieceCount: canonicalizePieceCount(raw.pieceCount),
    occasion: canonicalizeOccasion(raw.occasion),
    priceMax: typeof raw.priceMax === 'number' && Number.isFinite(raw.priceMax) && raw.priceMax > 0 ? raw.priceMax : null,
  };
}

function parsePrice(text: string): number | null {
  const match = text.replace(/,/g, '').match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

interface CatalogProduct {
  slug: string;
  title: string;
  subtitle: string | null;
  price: string;
  imageUrl: string | null;
  categories: Set<string>;
  attributes: Set<string>; // "Type:Value" pairs, e.g. "Color:Green"
  occasion: string | null;
}

function loadCatalog(db: DatabaseSync): CatalogProduct[] {
  const products = db.prepare('SELECT slug, title, subtitle, price, image_url as imageUrl FROM products').all() as unknown as Array<{
    slug: string; title: string; subtitle: string | null; price: string; imageUrl: string | null;
  }>;
  const categoryRows = db.prepare('SELECT product_slug, category_key FROM product_categories').all() as unknown as Array<{ product_slug: string; category_key: string }>;
  const attributeRows = db.prepare('SELECT product_slug, attribute_type, attribute_value FROM product_attributes').all() as unknown as Array<{
    product_slug: string; attribute_type: string; attribute_value: string;
  }>;
  const occasionRows = db.prepare('SELECT product_slug, occasion FROM product_occasion').all() as unknown as Array<{ product_slug: string; occasion: string }>;

  const categoriesBySlug = new Map<string, Set<string>>();
  for (const row of categoryRows) {
    if (!categoriesBySlug.has(row.product_slug)) categoriesBySlug.set(row.product_slug, new Set());
    categoriesBySlug.get(row.product_slug)!.add(row.category_key);
  }
  const attributesBySlug = new Map<string, Set<string>>();
  for (const row of attributeRows) {
    if (!attributesBySlug.has(row.product_slug)) attributesBySlug.set(row.product_slug, new Set());
    attributesBySlug.get(row.product_slug)!.add(`${row.attribute_type}:${row.attribute_value}`);
  }
  const occasionBySlug = new Map(occasionRows.map((r) => [r.product_slug, r.occasion]));

  return products.map((p) => ({
    ...p,
    categories: categoriesBySlug.get(p.slug) ?? new Set(),
    attributes: attributesBySlug.get(p.slug) ?? new Set(),
    occasion: occasionBySlug.get(p.slug) ?? null,
  }));
}

function hasAttribute(product: CatalogProduct, type: string, value: string): boolean {
  const lowerValue = value.toLowerCase();
  return [...product.attributes].some((a) => {
    const [t, v] = a.split(':');
    return t === type && v.toLowerCase() === lowerValue;
  });
}

function matches(product: CatalogProduct, intent: CatalogIntent): boolean {
  if (intent.collection && !product.categories.has(intent.collection)) return false;
  if (intent.fabric) {
    const inFabricCategory = product.categories.has(intent.fabric);
    const inFabricAttribute = hasAttribute(product, 'Fabric', intent.fabric);
    if (!inFabricCategory && !inFabricAttribute) return false;
  }
  if (intent.color && !hasAttribute(product, 'Color', intent.color)) return false;
  if (intent.type && !hasAttribute(product, 'Type', intent.type)) return false;
  if (intent.pieceCount && !hasAttribute(product, 'Size', intent.pieceCount)) return false;
  if (intent.occasion && product.occasion !== intent.occasion) return false;
  if (intent.priceMax != null) {
    const price = parsePrice(product.price);
    if (price == null || price > intent.priceMax) return false;
  }
  return true;
}

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Usage: node --env-file=server/.env --import tsx scripts/query-catalog.ts "<your request>"');
    process.exit(1);
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY is not set — run with --env-file=server/.env');
  const groq = new Groq({ apiKey });

  const raw = await extractIntent(groq, query);
  const intent = canonicalizeForCatalog(raw);

  console.log(`Heard: "${query}"`);
  console.log('Understood as:', JSON.stringify(intent, null, 2));

  const db = new DatabaseSync(DB_PATH);
  const catalog = loadCatalog(db);
  db.close();

  const results = catalog.filter((p) => matches(p, intent));
  console.log(`\n${results.length} matching product(s):`);
  for (const product of results.slice(0, 20)) {
    console.log(`  - ${product.title} — ${product.price} — https://www.bareeze.com/${product.slug}`);
  }
  if (results.length > 20) console.log(`  ...and ${results.length - 20} more.`);
}

await main();
