// Local catalog matching against data/bareeze-catalog.db (built offline by
// scripts/*.ts) — matches on every recognized facet at once (collection,
// fabric, color, type, pieceCount, occasion, price), including occasion,
// which Bareeze's own live filter UI has no equivalent for at all.
//
// index.ts calls searchCatalog() whenever ANY facet was recognized, not just
// occasion — the live intentToBareezeUrl path is only the fallback for a
// genuinely empty intent (nothing understood) or when this DB isn't
// reachable, not a parallel path picked by which field the shopper used.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ListingCard } from '../../src/shared/contracts';
import {
  canonicalizeCollection,
  canonicalizeColor,
  canonicalizeFabric,
  canonicalizePieceCount,
  canonicalizeType,
  lookupWithWordFallback,
} from '../../src/shared/canonicalize';
import type { RawIntent } from './schema.js';

const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'bareeze-catalog.db');

const OCCASIONS = ['daily-casual', 'office-formal', 'festive-eid', 'wedding-bridal', 'party-evening', 'winter-wear'] as const;
const OCCASION_ALIASES: Record<string, (typeof OCCASIONS)[number]> = {
  casual: 'daily-casual', everyday: 'daily-casual', daily: 'daily-casual', roz: 'daily-casual',
  office: 'office-formal', work: 'office-formal', formal: 'office-formal', daftar: 'office-formal',
  eid: 'festive-eid', festive: 'festive-eid', 'chand raat': 'festive-eid',
  wedding: 'wedding-bridal', shaadi: 'wedding-bridal', bridal: 'wedding-bridal', nikah: 'wedding-bridal', baraat: 'wedding-bridal', walima: 'wedding-bridal', mehndi: 'wedding-bridal',
  party: 'party-evening', evening: 'party-evening', dawat: 'party-evening',
  winter: 'winter-wear', sardi: 'winter-wear', sardiyon: 'winter-wear',
};

// Bareeze is ready-to-wear, not a bridal couture house — the catalog has
// zero products actually classified wedding-bridal (confirmed by crawl, not
// a gap in tagging), so matching wedding-bridal literally always returns
// nothing. In practice, almost everyone searching "wedding"/"shaadi"/
// "baraat"/"walima"/"mehndi" is a GUEST dressing for a function, not the
// bride herself — she needs festive/dressy wear Bareeze does stock, not
// bespoke bridal couture it doesn't. So a wedding-bridal query also accepts
// the two occasions that are the real-world answer to "what do I wear to a
// wedding": festive-eid (richly embroidered/formal-weight) and
// party-evening (dressy eveningwear). The canonical label itself stays
// 'wedding-bridal' (canonicalizeOccasion output/tests are unaffected) —
// only the matching net is widened.
const WEDDING_GUEST_FALLBACK_OCCASIONS = new Set<string>(['wedding-bridal', 'festive-eid', 'party-evening']);

export function canonicalizeOccasion(raw: string | null | undefined): string | null {
  return lookupWithWordFallback(raw, OCCASION_ALIASES);
}

export interface CatalogIntent {
  collection: string | null;
  fabric: string | null;
  color: string | null;
  type: string | null;
  pieceCount: string | null;
  occasion: string | null;
  priceMax: number | null;
}

export function canonicalizeForCatalog(raw: RawIntent): CatalogIntent {
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

// --- Multi-turn refinement --------------------------------------------------
// extractIntent has no idea a turn is a follow-up rather than a fresh
// request — a shopper who just says "not blue" or "no eid" after an earlier
// search can come back with color: "blue" / occasion: "eid" from the LLM,
// because the word itself IS in the utterance even though it's being ruled
// OUT. Checked against the field's own raw text, not the canonical value —
// this runs before canonicalizeForCatalog, on exactly what the LLM returned.
const NEGATION_PATTERN = /\b(not|no|don'?t|doesn'?t|isn'?t|without|except)\b/;
const NEGATABLE_FIELDS = ['collection', 'fabric', 'color', 'type', 'pieceCount', 'occasion'] as const;

export type NegatableField = (typeof NEGATABLE_FIELDS)[number];

export interface NegationGuardResult {
  raw: RawIntent;
  // Fields the shopper explicitly ruled out this turn, not just fields the
  // fresh turn happened not to mention — mergeCatalogIntent needs this
  // distinction: nulling the raw value here isn't enough on its own (see
  // that function's comment for why).
  negatedFields: Set<NegatableField>;
}

export function dropNegatedFields(raw: RawIntent, utterance: string): NegationGuardResult {
  // Negation only counts within the same clause — without this split, "not
  // blue, 3 piece is fine" wrongly vetoed pieceCount too, because "not"
  // fell inside a fixed-width lookback window that crossed the comma into
  // an unrelated clause.
  const clauses = utterance.toLowerCase().split(/[,.;!?]+|\band\b|\bbut\b/);
  const result = { ...raw };
  const negatedFields = new Set<NegatableField>();
  for (const field of NEGATABLE_FIELDS) {
    const value = result[field];
    if (typeof value !== 'string' || !value) continue;
    const valueLower = value.toLowerCase();

    // The LLM sometimes folds the negation word straight into the value
    // itself (observed live: color: "not blue" for the utterance "not
    // blue, something else") rather than negating around a clean value —
    // there's no "before" text to examine in that case, so the value's own
    // text is checked first.
    if (NEGATION_PATTERN.test(valueLower)) {
      result[field] = null;
      negatedFields.add(field);
      continue;
    }

    const clause = clauses.find((c) => c.includes(valueLower));
    if (!clause) continue;
    const before = clause.slice(0, clause.indexOf(valueLower));
    if (NEGATION_PATTERN.test(before)) {
      result[field] = null;
      negatedFields.add(field);
    }
  }
  return { raw: result, negatedFields };
}

// Words a shopper uses to ask for a lower price without naming a number —
// extractIntent can't produce a priceMax for these (there isn't one in the
// utterance to extract), so acting on it at all requires this explicit,
// deterministic check rather than hoping the LLM invents a number.
const RELATIVE_PRICE_DOWN_PHRASES = ['cheaper', 'less expensive', 'more affordable', 'lower budget', 'sasta', 'kam qeemat', 'arzan'];

function requestsLowerPrice(utterance: string): boolean {
  const lower = utterance.toLowerCase();
  return RELATIVE_PRICE_DOWN_PHRASES.some((phrase) => lower.includes(phrase));
}

export interface MergeResult {
  intent: CatalogIntent;
  // Honesty signals for the caller to relay in plain language rather than
  // silently no-op'ing or silently broadening — the same principle
  // WEDDING_GUEST_FALLBACK_OCCASIONS and hasAttribute's own comments already
  // apply elsewhere in this file, extended to cover a merge across turns.
  priceRelaxRequested: boolean; // shopper said something like "cheaper"
  priceRelaxApplied: boolean; // ...and there was a previous cap to actually lower
}

// Every facet the fresh turn didn't recognize inherits the previous turn's
// value instead of being dropped; a facet it DID recognize replaces the old
// one. That single rule is what makes "green instead" work (color
// overwrites, everything else survives) with no special handling for the
// word "instead" at all.
//
// negatedFields is what makes "not blue" actually clear a previously-set
// facet rather than silently keeping it: dropNegatedFields nulls the raw
// value, but null-inherits-previous would otherwise just fall right back to
// the old one — indistinguishable from the fresh turn simply not mentioning
// color at all. Without this, dropNegatedFields protected nothing on an
// actual refinement turn (the only place it matters), because the merge
// step erased the distinction it was built to preserve. There's still no
// way to remove a facet with nothing to replace it beyond this explicit
// negation, or to combine "remove" with silence about what to use instead
// — that still requires overwriting with a new value or "New search".
export function mergeCatalogIntent(
  previous: CatalogIntent | null,
  fresh: CatalogIntent,
  utterance: string,
  negatedFields: ReadonlySet<NegatableField> = new Set(),
): MergeResult {
  const priceRelaxRequested = requestsLowerPrice(utterance) && fresh.priceMax == null;

  if (!previous) {
    return { intent: fresh, priceRelaxRequested, priceRelaxApplied: false };
  }

  const inherit = (field: NegatableField, freshValue: string | null): string | null =>
    negatedFields.has(field) ? null : (freshValue ?? previous[field]);

  const merged: CatalogIntent = {
    collection: inherit('collection', fresh.collection),
    fabric: inherit('fabric', fresh.fabric),
    color: inherit('color', fresh.color),
    type: inherit('type', fresh.type),
    pieceCount: inherit('pieceCount', fresh.pieceCount),
    occasion: inherit('occasion', fresh.occasion),
    priceMax: fresh.priceMax ?? previous.priceMax,
  };

  let priceRelaxApplied = false;
  if (priceRelaxRequested && previous.priceMax != null) {
    merged.priceMax = Math.round(previous.priceMax * 0.75);
    priceRelaxApplied = true;
  }

  return { intent: merged, priceRelaxRequested, priceRelaxApplied };
}

export interface CatalogProduct extends ListingCard {
  categories: Set<string>;
  attributes: Set<string>; // "Type:Value" pairs, e.g. "Color:Green"
  occasion: string | null;
}

let cachedCatalog: CatalogProduct[] | null = null;

function loadCatalog(): CatalogProduct[] {
  if (cachedCatalog) return cachedCatalog;

  const db = new DatabaseSync(DB_PATH);
  try {
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

    cachedCatalog = products.map((p) => ({
      ...p,
      categories: categoriesBySlug.get(p.slug) ?? new Set(),
      attributes: attributesBySlug.get(p.slug) ?? new Set(),
      occasion: occasionBySlug.get(p.slug) ?? null,
    }));
    return cachedCatalog;
  } finally {
    db.close();
  }
}

// Substring, not exact equality: real attribute values are frequently
// compound ("Chiffon Self", "Light Cotton", "Air Jet Lawn", "Lawn Karandi",
// "Polyester Net") while the canonicalized facet a shopper asks for is
// always the short bare stem ("chiffon", "cotton", "lawn", "net" — see
// FABRIC_ALIASES/TYPE_ALIASES in src/shared/canonicalize.ts). Exact equality
// silently missed every compound variant — for fabric specifically, that
// was most of the real data. Safe in the other direction too: none of the
// real values in any attribute type are substrings of an unrelated value.
function hasAttribute(product: CatalogProduct, type: string, value: string): boolean {
  const lowerValue = value.toLowerCase();
  return [...product.attributes].some((a) => {
    const [t, v] = a.split(':');
    return t === type && v.trim().toLowerCase().includes(lowerValue);
  });
}

function parsePrice(text: string): number | null {
  const match = text.replace(/,/g, '').match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// Budget is the one facet a shopper states as an actual hard requirement —
// "under 5000" means that or nothing, so unlike every facet below, it's
// never relaxed to produce a "related" result (showing something well
// above a stated budget isn't a related product, it's ignoring the ask).
// Piece count was hard-filtered here too originally, but real data exposed
// why that's wrong: "3 piece party wear" against a 3-item party-evening
// bucket where none happen to be 3-piece produced zero results even from
// the fallback, when the 2-piece party-evening items are clearly what the
// shopper actually wants to see. It belongs with the soft facets below.
function passesHardConstraints(product: CatalogProduct, intent: CatalogIntent): boolean {
  if (intent.priceMax != null) {
    const price = parsePrice(product.price);
    if (price == null || price > intent.priceMax) return false;
  }
  return true;
}

// Everything a shopper would happily see an alternative for if their exact
// combination doesn't exist — a shopper who wants "green wedding suit" and
// finds no green ones would still rather see other wedding-appropriate
// colors than nothing at all. Order doesn't matter here (see searchCatalog,
// which scores by *count* matched, not priority).
const SOFT_FACET_FIELDS = ['collection', 'fabric', 'color', 'type', 'occasion', 'pieceCount'] as const;
type SoftFacetField = (typeof SOFT_FACET_FIELDS)[number];

function matchesSoftFacet(product: CatalogProduct, field: SoftFacetField, value: string): boolean {
  switch (field) {
    case 'collection':
      return product.categories.has(value);
    case 'fabric':
      return product.categories.has(value) || hasAttribute(product, 'Fabric', value);
    case 'color':
      return hasAttribute(product, 'Color', value);
    case 'type':
      return hasAttribute(product, 'Type', value);
    case 'pieceCount':
      return hasAttribute(product, 'Size', value);
    case 'occasion': {
      const acceptable = value === 'wedding-bridal' ? WEDDING_GUEST_FALLBACK_OCCASIONS : new Set([value]);
      return !!product.occasion && acceptable.has(product.occasion);
    }
  }
}

function countSoftFacets(intent: CatalogIntent): number {
  return SOFT_FACET_FIELDS.filter((field) => intent[field]).length;
}

function softMatchScore(product: CatalogProduct, intent: CatalogIntent): number {
  let score = 0;
  for (const field of SOFT_FACET_FIELDS) {
    const value = intent[field];
    if (value && matchesSoftFacet(product, field, value)) score++;
  }
  return score;
}

// Strict match: every recognized facet, hard and soft alike. Still exactly
// what a plain "does this product satisfy the whole request" check should
// mean — searchCatalog below is the one that additionally knows what to do
// when *no* product clears this bar.
export function matchesIntent(product: CatalogProduct, intent: CatalogIntent): boolean {
  if (!passesHardConstraints(product, intent)) return false;
  return softMatchScore(product, intent) === countSoftFacets(intent);
}

// True when nothing in the intent was recognized at all — the one case
// where there's nothing for the catalog to filter on, so index.ts falls
// back to the live "New In" default instead of returning the full catalog.
export function isEmptyCatalogIntent(intent: CatalogIntent): boolean {
  return (
    !intent.collection &&
    !intent.fabric &&
    !intent.color &&
    !intent.type &&
    !intent.pieceCount &&
    !intent.occasion &&
    intent.priceMax == null
  );
}

export interface CatalogSearchResult {
  products: ListingCard[];
  // True when nothing satisfied every recognized facet, so what's returned
  // is the closest related set instead (ranked by how many facets they DO
  // match) — a real shop assistant's "we don't have that exact one, but
  // here's what's close" rather than a bare empty result the shopper has no
  // way to act on. index.ts/popup.ts use this to say so honestly rather
  // than silently presenting a relaxed set as if it were an exact match.
  relaxed: boolean;
}

function toListingCard({ slug, title, subtitle, price, imageUrl }: CatalogProduct): ListingCard {
  return { slug, title, subtitle, price, imageUrl };
}

// Separated from searchCatalog (which reads the real DB) purely so the
// ranking/relaxation behavior can be unit-tested against synthetic products,
// the same way matchesIntent's tests do — no behavior difference.
export function rankCatalog(catalog: CatalogProduct[], intent: CatalogIntent): CatalogSearchResult {
  const eligible = catalog.filter((p) => passesHardConstraints(p, intent));
  const softTotal = countSoftFacets(intent);

  if (softTotal === 0) {
    return { products: eligible.map(toListingCard), relaxed: false };
  }

  const exact = eligible.filter((p) => softMatchScore(p, intent) === softTotal);
  if (exact.length > 0) {
    return { products: exact.map(toListingCard), relaxed: false };
  }

  // No product satisfied the whole combination — rank the rest by how many
  // of the requested facets they DO satisfy (dropping the worst-matching
  // ones entirely, a product matching none of what was asked isn't
  // "related") rather than returning a dead end.
  const ranked = eligible
    .map((product) => ({ product, score: softMatchScore(product, intent) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ product }) => product);

  return { products: ranked.map(toListingCard), relaxed: ranked.length > 0 };
}

// Returns ListingCard-shaped results so the popup can render them with the
// exact same card component it already uses for live-scraped results.
export function searchCatalog(intent: CatalogIntent): CatalogSearchResult {
  return rankCatalog(loadCatalog(), intent);
}
