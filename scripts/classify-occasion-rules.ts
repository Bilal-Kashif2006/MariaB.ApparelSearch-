// Deterministic occasion classification, applied as an ordered set of rules
// over real data — no LLM call, no ambiguity, no quota dependency. Each
// product gets the FIRST matching rule below; rules are ordered strongest
// (most specific real signal) to weakest (broadest fallback), so a later
// rule never overrides what an earlier, more specific one already decided.
//
// The first two rules are exactly what classify-occasion.ts's own system
// prompt already calls a "strong real signal" — if it's reliable enough
// that the LLM is *told* to treat it as decisive, it's reliable enough to
// apply directly in code. A cross-check found the LLM did not apply these
// consistently (e.g. real Season=EID-* products classified daily-casual).
// The rest extend the same idea to the next tier of real, still-fairly-
// confident signals, to shrink the genuinely-ambiguous LLM-only remainder
// as far as real data allows before judgment calls become unavoidable.
//
// Run with: node --experimental-strip-types scripts/classify-occasion-rules.ts
// Must not run concurrently with the other catalog scripts against the same
// database file.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureClassificationSchema, type ReviewStatus } from './classification-storage.ts';

const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'bareeze-catalog.db');

function openDatabase(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  ensureClassificationSchema(db);
  return db;
}

interface Product {
  slug: string;
  title: string;
  subtitle: string | null;
  categories: Set<string>;
  seasons: string[];
  fabrics: string[];
  types: string[];
}

function loadProducts(db: DatabaseSync): Product[] {
  const products = db.prepare('SELECT slug, title, subtitle FROM products').all() as Array<{ slug: string; title: string; subtitle: string | null }>;
  const categoryRows = db.prepare('SELECT product_slug, category_key FROM product_categories').all() as Array<{ product_slug: string; category_key: string }>;
  const attributeRows = db.prepare('SELECT product_slug, attribute_type, attribute_value FROM product_attributes').all() as Array<{
    product_slug: string; attribute_type: string; attribute_value: string;
  }>;

  const categoriesBySlug = new Map<string, Set<string>>();
  for (const row of categoryRows) {
    if (!categoriesBySlug.has(row.product_slug)) categoriesBySlug.set(row.product_slug, new Set());
    categoriesBySlug.get(row.product_slug)!.add(row.category_key);
  }
  const seasonsBySlug = new Map<string, string[]>();
  const fabricsBySlug = new Map<string, string[]>();
  const typesBySlug = new Map<string, string[]>();
  for (const row of attributeRows) {
    const target = row.attribute_type === 'Season' ? seasonsBySlug : row.attribute_type === 'Fabric' ? fabricsBySlug : row.attribute_type === 'Type' ? typesBySlug : null;
    if (!target) continue;
    if (!target.has(row.product_slug)) target.set(row.product_slug, []);
    target.get(row.product_slug)!.push(row.attribute_value);
  }

  return products.map((p) => ({
    slug: p.slug,
    title: p.title,
    subtitle: p.subtitle,
    categories: categoriesBySlug.get(p.slug) ?? new Set(),
    seasons: seasonsBySlug.get(p.slug) ?? [],
    fabrics: fabricsBySlug.get(p.slug) ?? [],
    types: typesBySlug.get(p.slug) ?? [],
  }));
}

interface Rule {
  name: string;
  occasion: string;
  confidence: number | ((p: Product) => number);
  matches: (p: Product) => boolean;
}

const RULES: Rule[] = [
  {
    name: 'Season contains EID',
    occasion: 'festive-eid',
    confidence: 0.98,
    matches: (p) => p.seasons.some((s) => s.toUpperCase().includes('EID')),
  },
  {
    name: 'Season contains WINTER, or velvet/karandi fabric',
    occasion: 'winter-wear',
    confidence: (p) => p.seasons.some((s) => s.toUpperCase().includes('WINTER')) ? 0.96 : 0.86,
    matches: (p) =>
      p.seasons.some((s) => s.toUpperCase().includes('WINTER')) ||
      p.fabrics.some((f) => /velvet|karandi/i.test(f)),
  },
  {
    // The product's own name says so — e.g. "FESTIVE ELEGANCE". A small,
    // explicit signal, but an unambiguous one where it applies.
    name: "title contains 'FESTIVE'",
    occasion: 'festive-eid',
    confidence: 0.78,
    matches: (p) => p.title.toUpperCase().includes('FESTIVE'),
  },
  {
    // A named formal product line, not a generic "New Selection" — seen
    // directly on real BLACK CLASSIC MHR-style embroidered daywear.
    name: "subtitle 'Embroidered Classics'",
    occasion: 'office-formal',
    confidence: 0.84,
    matches: (p) => p.subtitle === 'Embroidered Classics',
  },
  {
    // Shawls in Pakistani fashion are commonly formal/festive wear, not
    // routine everyday wear (the same heuristic the LLM prompt states) —
    // by this point in the rule order, any shawl with an EID season tag is
    // already resolved above, so what's left leans office-formal.
    name: 'category=shawls (no EID/winter signal)',
    occasion: 'office-formal',
    confidence: 0.76,
    matches: (p) => p.categories.has('shawls'),
  },
  {
    // Lawn is THE defining everyday fabric in Pakistani fashion — an
    // embroidered lawn suit (or anything from the casuals/lawn/pret lines)
    // is still casual daywear, embroidery detail notwithstanding. Checking
    // this before the formal rule below matters: 198/224 of the first
    // version's office-formal picks turned out to be exactly this —
    // ordinary embroidered lawn suits from the casuals collection wrongly
    // promoted to "office-formal" just for having any embroidery at all.
    name: 'Type=EMBROIDERED but Lawn/casuals/pret (still everyday wear)',
    occasion: 'daily-casual',
    confidence: 0.76,
    matches: (p) =>
      p.types.some((t) => t.toUpperCase() === 'EMBROIDERED') &&
      (p.fabrics.some((f) => f.toLowerCase() === 'lawn') ||
        p.categories.has('casuals') ||
        p.categories.has('lawn') ||
        p.categories.has('pret')),
  },
  {
    // What's left of Type=Embroidered after the rule above is genuinely
    // formal-weight (chiffon/cambric/organza/velvet/net, or the formals
    // line itself) — the LLM prompt's "leans festive/formal" heuristic
    // applies here, with festive already resolved by the EID-season rule.
    name: 'Type=EMBROIDERED, formal-weight fabric/collection',
    occasion: 'office-formal',
    confidence: 0.83,
    matches: (p) => p.types.some((t) => t.toUpperCase() === 'EMBROIDERED'),
  },
  {
    // Net (plain, or as "Polyester Net") is a characteristically sheer,
    // dressy eveningwear fabric in Pakistani fashion, distinct from the
    // everyday lawn/cotton fabrics above — checked before the broader
    // "category=embroidered" rule below, since a net-fabric product is
    // often *also* in the embroidered category and this more specific
    // signal should win.
    name: "Fabric/category is net-based (sheer eveningwear), not lawn",
    occasion: 'party-evening',
    confidence: 0.83,
    matches: (p) =>
      (p.fabrics.some((f) => /\bnet\b/i.test(f)) || p.categories.has('net')) &&
      !p.fabrics.some((f) => f.toLowerCase() === 'lawn'),
  },
  {
    // The product's own name says so — "HAUTE COUTURE" is unambiguously
    // event/eveningwear language, not everyday terminology. Same reasoning
    // for checking before the category=embroidered rule below.
    name: "title contains 'COUTURE'",
    occasion: 'party-evening',
    confidence: 0.88,
    matches: (p) => p.title.toUpperCase().includes('COUTURE'),
  },
  {
    // "embroidered" is also a real crawled *category* (a sub-listing under
    // /formals), distinct from the Type=Embroidered *attribute* handled
    // above — a product can be in this category without carrying that
    // attribute tag. Same lawn/casual exception applies: real signal, not
    // a blanket "any embroidered thing is formal" rule.
    name: "category=embroidered (not Lawn/casual)",
    occasion: 'office-formal',
    confidence: 0.77,
    matches: (p) =>
      p.categories.has('embroidered') &&
      !p.fabrics.some((f) => f.toLowerCase() === 'lawn') &&
      !p.categories.has('casuals'),
  },
  {
    name: 'Type is Printed/Print/Plain',
    occasion: 'daily-casual',
    confidence: 0.84,
    matches: (p) => p.types.some((t) => /^print|^plain$/i.test(t)),
  },
  {
    name: "subtitle 'Premium Prints'",
    occasion: 'daily-casual',
    confidence: 0.82,
    matches: (p) => p.subtitle === 'Premium Prints',
  },
  {
    name: "subtitle 'Bareeze Pret' (not embroidered — that's caught above)",
    occasion: 'daily-casual',
    confidence: 0.78,
    matches: (p) => p.subtitle === 'Bareeze Pret',
  },
  {
    // The genuine floor: a plain current-season item with no line/finish
    // signal at all beyond color — nothing points away from ordinary wear.
    name: 'no Type tag, only in "new in" (nothing else to go on)',
    occasion: 'daily-casual',
    confidence: 0.45,
    matches: (p) => p.types.length === 0 && p.categories.size <= 1 && p.categories.has('new in'),
  },
  {
    // Same floor, broadened: plain Lawn fabric with no finish/Type signal
    // at all is ordinary daywear regardless of which specific listing
    // (sale, prints, etc.) it happened to be crawled from.
    name: 'Lawn fabric, no Type tag (nothing points away from ordinary wear)',
    occasion: 'daily-casual',
    confidence: 0.65,
    matches: (p) => p.types.length === 0 && p.fabrics.some((f) => f.toLowerCase() === 'lawn'),
  },
];

function main() {
  const db = openDatabase();
  const products = loadProducts(db);
  // A verified collection is Bareeze's own explicit catalogue evidence, not
  // an inference. Backfill its audit fields without changing its label.
  db.prepare(
    `UPDATE product_occasion
     SET confidence = 0.99,
         review_status = 'accepted',
         reason = 'Verified against Bareeze collection data',
         evidence_json = '{"verification":"Bareeze collection"}'
     WHERE source = 'verified-collection'`,
  ).run();
  const previousOccasion = db.prepare('SELECT occasion, source FROM product_occasion WHERE product_slug = ?');
  const upsert = db.prepare(
    `INSERT INTO product_occasion
       (product_slug, occasion, classified_at, source, confidence, review_status, reason, evidence_json,
        reviewer_confidence, reviewer_reason, reviewed_at)
     VALUES (?, ?, ?, 'rule-based', ?, ?, ?, ?, NULL, NULL, NULL)
     ON CONFLICT(product_slug) DO UPDATE SET
       occasion = excluded.occasion,
       classified_at = excluded.classified_at,
       source = excluded.source,
       confidence = excluded.confidence,
       review_status = excluded.review_status,
       reason = excluded.reason,
       evidence_json = excluded.evidence_json,
       reviewer_confidence = NULL,
       reviewer_reason = NULL,
       reviewed_at = NULL`,
  );

  const now = new Date().toISOString();
  const resolvedThisRun = new Set<string>();
  const counts = new Map<string, { total: number; changed: number }>();

  for (const rule of RULES) {
    const stats = { total: 0, changed: 0 };
    for (const product of products) {
      if (resolvedThisRun.has(product.slug)) continue; // an earlier, higher-priority rule already claimed this one
      if (!rule.matches(product)) continue;

      const prior = previousOccasion.get(product.slug) as { occasion: string; source: string } | undefined;
      if (prior?.source === 'verified-collection') {
        resolvedThisRun.add(product.slug); // real ground truth wins over any rule guess
        continue;
      }

      stats.total++;
      if (!prior || prior.occasion !== rule.occasion) stats.changed++;
      const confidence = typeof rule.confidence === 'function' ? rule.confidence(product) : rule.confidence;
      const reviewStatus: ReviewStatus = confidence >= 0.8 ? 'accepted' : 'needs-llm-review';
      const evidence = {
        rule: rule.name,
        categories: [...product.categories],
        seasons: product.seasons,
        fabrics: product.fabrics,
        types: product.types,
      };
      upsert.run(
        product.slug,
        rule.occasion,
        now,
        confidence,
        reviewStatus,
        rule.name,
        JSON.stringify(evidence),
      );
      resolvedThisRun.add(product.slug);
    }
    counts.set(rule.name, stats);
  }

  for (const rule of RULES) {
    const stats = counts.get(rule.name)!;
    console.log(`${rule.occasion.padEnd(14)} <- ${rule.name}: ${stats.total} products, ${stats.changed} changed.`);
  }
  console.log(`\n${resolvedThisRun.size} / ${products.length} products resolved by a deterministic rule.`);

  db.close();
}

main();
