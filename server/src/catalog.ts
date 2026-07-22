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
import { STORE_CONFIG } from '../../src/shared/store';
import type { RawIntent } from './schema.js';

const DB_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  STORE_CONFIG.server.catalogDbRelativePath,
);

const OCCASION_ALIASES: Record<string, string> = {
  casual: 'daily-casual',
  everyday: 'daily-casual',
  daily: 'daily-casual',
  roz: 'daily-casual',
  picnic: 'daily-casual',
  brunch: 'daily-casual',
  outing: 'daily-casual',
  office: 'office-formal',
  work: 'office-formal',
  formal: 'office-formal',
  daftar: 'office-formal',
  interview: 'office-formal',
  meeting: 'office-formal',
  presentation: 'office-formal',
  eid: 'festive-eid',
  festive: 'festive-eid',
  iftar: 'festive-eid',
  'chand raat': 'festive-eid',
  wedding: 'wedding-bridal',
  shaadi: 'wedding-bridal',
  bridal: 'wedding-bridal',
  baraat: 'wedding-bridal',
  mehndi: 'wedding-bridal',
  walima: 'wedding-bridal',
  engagement: 'wedding-bridal',
  party: 'party-evening',
  evening: 'party-evening',
  ceremony: 'party-evening',
  function: 'party-evening',
  event: 'party-evening',
  graduation: 'party-evening',
  convocation: 'party-evening',
  farewell: 'party-evening',
  celebration: 'party-evening',
  winter: 'winter-wear',
  sardi: 'winter-wear',
};

const WEDDING_GUEST_FALLBACK_OCCASIONS = new Set<string>([
  'wedding-bridal',
  'festive-eid',
  'party-evening',
]);

const RELATIVE_PRICE_DOWN_PHRASES = ['cheaper', 'less expensive', 'more affordable', 'lower budget', 'sasta', 'kam qeemat', 'arzan'];
const NEGATION_PATTERN = /\b(not|no|don'?t|doesn'?t|isn'?t|without|except)\b/;
const NEGATABLE_FIELDS = ['collection', 'fabric', 'color', 'type', 'pieceCount', 'occasion'] as const;
const SOFT_FACET_FIELDS = ['collection', 'fabric', 'color', 'type', 'occasion', 'pieceCount'] as const;

type NegatableField = (typeof NEGATABLE_FIELDS)[number];
type SoftFacetField = (typeof SOFT_FACET_FIELDS)[number];

export interface CatalogIntent {
  collection: string | null;
  fabric: string | null;
  color: string | null;
  type: string | null;
  pieceCount: string | null;
  occasion: string | null;
  priceMax: number | null;
}

export interface CatalogProduct extends ListingCard {
  categories: Set<string>;
  attributes: Set<string>;
  occasion: string | null;
  inStock: boolean;
  availableVariantCount: number;
  totalVariantCount: number;
  availableSizes: string[];
  onSale: boolean;
  compareAtPrice: string | null;
  salePercent: number | null;
}

export interface NegationGuardResult {
  raw: RawIntent;
  negatedFields: Set<NegatableField>;
}

export interface MergeResult {
  intent: CatalogIntent;
  priceRelaxRequested: boolean;
  priceRelaxApplied: boolean;
}

export interface CatalogSearchResult {
  products: ListingCard[];
  relaxed: boolean;
}

let cachedCatalog: CatalogProduct[] | null = null;

export function invalidateCatalogCache(): void {
  cachedCatalog = null;
}

export function canonicalizeOccasion(raw: string | null | undefined): string | null {
  const direct = lookupWithWordFallback(raw, OCCASION_ALIASES);
  if (direct) return direct;

  const normalized = raw?.trim().toLowerCase() || '';
  if (!normalized) return null;

  if (/\b(picnic|outing|brunch|day out|summer day)\b/.test(normalized)) return 'daily-casual';
  if (/\b(interview|meeting|presentation|office|work|school function)\b/.test(normalized)) return 'office-formal';
  if (/\b(wedding|shaadi|mehndi|walima|baraat|bridal|engagement|nikkah|nikah)\b/.test(normalized)) return 'wedding-bridal';
  if (/\b(eid|iftar|festive|chand raat)\b/.test(normalized)) return 'festive-eid';
  if (/\b(ceremony|function|event|graduation|convocation|farewell|celebration|award|prize distribution)\b/.test(normalized)) {
    return 'party-evening';
  }
  if (/\b(winter|sardi)\b/.test(normalized)) return 'winter-wear';

  return null;
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

export function dropNegatedFields(raw: RawIntent, utterance: string): NegationGuardResult {
  const clauses = utterance.toLowerCase().split(/[,.;!?]+|\band\b|\bbut\b/);
  const result = { ...raw };
  const negatedFields = new Set<NegatableField>();

  for (const field of NEGATABLE_FIELDS) {
    const value = result[field];
    if (typeof value !== 'string' || !value) continue;
    const valueLower = value.toLowerCase();

    if (NEGATION_PATTERN.test(valueLower)) {
      result[field] = null;
      negatedFields.add(field);
      continue;
    }

    const clause = clauses.find((part) => part.includes(valueLower));
    if (!clause) continue;
    const before = clause.slice(0, clause.indexOf(valueLower));
    if (NEGATION_PATTERN.test(before)) {
      result[field] = null;
      negatedFields.add(field);
    }
  }

  return { raw: result, negatedFields };
}

function requestsLowerPrice(utterance: string): boolean {
  const lower = utterance.toLowerCase();
  return RELATIVE_PRICE_DOWN_PHRASES.some((phrase) => lower.includes(phrase));
}

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

function safeJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function titleCase(value: string): string {
  return normalizeSpace(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function parsePriceNumber(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return `PKR ${Math.round(value).toLocaleString('en-PK')}`;
}

function occasionFromRow(raw: string | null): string | null {
  if (!raw) return null;
  return canonicalizeOccasion(raw);
}

function extractCollectionKeys(category: string | null, shopifyTags: string[]): string[] {
  const normalized = normalizeSpace(category || '').toLowerCase();
  const keys = new Set<string>();
  const lowerTags = shopifyTags.map((item) => item.toLowerCase());

  if (normalized.includes('luxury pret')) keys.add('luxury pret');
  if (normalized.includes('luxury formal')) keys.add('luxury formals');
  if (normalized.includes('wedding') || normalized.includes('couture')) keys.add('wedding wear');
  if (normalized.includes('couture')) keys.add('couture');
  if (normalized.includes('accessories')) keys.add('accessories');
  if (normalized.includes('unstitched') || normalized.includes('fabric')) keys.add('unstitched');
  if (normalized.includes('loose fabric')) keys.add('unstitched');
  if (normalized.includes('lawn')) keys.add('lawn');
  if (normalized.includes('chiffon')) keys.add('chiffon');
  if (normalized.includes('women')) keys.add('casuals');
  if (normalized.includes('womensclothing')) keys.add('casuals');

  for (const tag of lowerTags) {
    if (tag === 'casuals') keys.add('casuals');
    if (tag.includes('luxury pret')) keys.add('luxury pret');
    if (tag.includes('luxury formal')) keys.add('luxury formals');
    if (tag.includes('new arrivals') || tag === '_label_new') keys.add('new arrivals');
    if (tag.includes('accessories') || tag.includes('bags')) keys.add('accessories');
    if (tag.includes('unstitched')) keys.add('unstitched');
    if (tag.includes('eid collection formals')) keys.add('luxury formals');
    if (tag.includes('eid collection pret') || tag.includes('eid pret')) keys.add('luxury pret');
    if (tag.includes('bridal') || tag.includes('bridals viewall')) keys.add('wedding wear');
    if (tag.includes('couture')) keys.add('couture');
    if (tag.includes('loose fabric')) keys.add('unstitched');
    if (tag.includes('women stitched')) keys.add('casuals');
  }

  return [...keys];
}

function addAttribute(set: Set<string>, type: string, value: string | null | undefined): void {
  if (!value) return;
  const normalized = normalizeSpace(value);
  if (!normalized) return;
  set.add(`${type}:${normalized}`);
}

function extractPieceCount(description: string, tags: string[]): string | null {
  const descMatch = description.match(/\b([23])\s*piece\b/i);
  if (descMatch) return `${descMatch[1]} Piece`;
  for (const tag of tags) {
    const match = tag.match(/\b([23])\s*piece\b/i);
    if (match) return `${match[1]} Piece`;
  }
  return null;
}

function extractFabrics(description: string, tags: string[]): string[] {
  const results = new Set<string>();
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    for (const fabric of ['lawn', 'linen', 'chiffon', 'cotton', 'silk', 'velvet', 'organza', 'net', 'polyester', 'wool']) {
      if (lower.includes(fabric)) results.add(titleCase(fabric));
    }
  }

  for (const line of description.split('\n')) {
    if (!/fabric/i.test(line)) continue;
    const [, rawValue = ''] = line.split(':');
    for (const part of rawValue.split(/,|\/|and/i)) {
      const normalized = normalizeSpace(part);
      if (normalized) results.add(titleCase(normalized));
    }
  }

  return [...results];
}

function extractTypes(description: string, tags: string[]): string[] {
  const values = new Set<string>();
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (lower.includes('embroidered')) values.add('Embroidered');
    if (lower.includes('printed')) values.add('Printed');
    if (lower.includes('dyed')) values.add('Dyed');
  }
  const descriptionLower = description.toLowerCase();
  if (descriptionLower.includes('embroider')) values.add('Embroidered');
  if (descriptionLower.includes('print')) values.add('Printed');
  if (descriptionLower.includes('dyed')) values.add('Dyed');
  return [...values];
}

function inferOccasion(category: string | null, tags: string[], description: string, productFormality: string | null, rawOccasion: string | null): string | null {
  const explicit = occasionFromRow(rawOccasion);
  if (explicit) return explicit;

  const text = [category || '', productFormality || '', description, ...tags].join(' ').toLowerCase();
  if (/\b(eid|iftar|ramadan|festive)\b/.test(text)) return 'festive-eid';
  if (/\b(bridal|bridals|bridalwear|wedding|walima|baraat|mehndi|engagement|nikah|nikkah)\b/.test(text)) {
    return 'wedding-bridal';
  }
  if (/\b(evening|party|formal dinner|graduation|ceremony|event|function|celebration)\b/.test(text)) {
    return 'party-evening';
  }
  if (/\b(office|work|daftar|interview|presentation)\b/.test(text)) return 'office-formal';
  if (/\b(casual|daily|everyday|summer|daywear|pret|lawn)\b/.test(text)) return 'daily-casual';
  if (/\b(winter|khaddar|linen|velvet|wool|pashmina)\b/.test(text)) return 'winter-wear';
  return productFormality === 'formal' ? 'office-formal' : null;
}

function parseSizeTokens(rawSizes: string[]): string[] {
  return [...new Set(rawSizes.map((item) => normalizeSpace(item)).filter(Boolean))];
}

function loadCatalog(): CatalogProduct[] {
  if (cachedCatalog) return cachedCatalog;

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const products = db.prepare(`
      SELECT handle, title, category, product_family, shopify_tags, tags, occasion, colors,
             min_price, max_price, primary_image_url, product_url, description_text,
             text_derived_color, product_formality, sizes, in_stock
      FROM products
      WHERE lower(department) = 'women'
        AND product_url LIKE ?
    `).all(`${STORE_CONFIG.server.productUrlPrefix}%`) as Array<{
      handle: string;
      title: string;
      category: string | null;
      product_family: string | null;
      shopify_tags: string | null;
      tags: string | null;
      occasion: string | null;
      colors: string | null;
      min_price: number | null;
      max_price: number | null;
      primary_image_url: string | null;
      product_url: string;
      description_text: string | null;
      text_derived_color: string | null;
      product_formality: string | null;
      sizes: string | null;
      in_stock: number | null;
    }>;

    const variants = db.prepare(`
      SELECT p.handle, v.color, v.size, v.price, v.compare_at_price, v.available
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      WHERE lower(p.department) = 'women'
        AND p.product_url LIKE ?
    `).all(`${STORE_CONFIG.server.productUrlPrefix}%`) as Array<{
      handle: string;
      color: string | null;
      size: string | null;
      price: number | null;
      compare_at_price: number | null;
      available: number | null;
    }>;

    const variantsByHandle = new Map<string, typeof variants>();
    for (const row of variants) {
      const bucket = variantsByHandle.get(row.handle) ?? [];
      bucket.push(row);
      variantsByHandle.set(row.handle, bucket);
    }

    cachedCatalog = products.map((row) => {
      const shopifyTags = safeJsonArray(row.shopify_tags);
      const tags = safeJsonArray(row.tags);
      const colors = safeJsonArray(row.colors);
      const productSizes = parseSizeTokens(safeJsonArray(row.sizes));
      const productVariants = variantsByHandle.get(row.handle) ?? [];
      const description = row.description_text || '';
      const attributes = new Set<string>();
      const categories = new Set<string>(extractCollectionKeys(row.category, shopifyTags));
      const variantColors = parseSizeTokens(productVariants.map((variant) => variant.color || ''));
      const availableVariants = productVariants.filter((variant) => Boolean(variant.available));
      const availableSizes = parseSizeTokens(availableVariants.map((variant) => variant.size || ''));
      const allSizes = parseSizeTokens([...productSizes, ...productVariants.map((variant) => variant.size || '')]);
      const comparePrices = productVariants
        .map((variant) => ({ price: variant.price, compareAt: variant.compare_at_price }))
        .filter((item) => typeof item.price === 'number' && typeof item.compareAt === 'number' && item.compareAt > item.price) as Array<{
          price: number;
          compareAt: number;
        }>;
      const bestSale = comparePrices
        .map((item) => ({
          compareAt: item.compareAt,
          salePercent: Math.max(1, Math.round(((item.compareAt - item.price) / item.compareAt) * 100)),
        }))
        .sort((left, right) => right.salePercent - left.salePercent)[0] ?? null;

      if (row.product_family) categories.add(row.product_family.toLowerCase());
      for (const color of colors) addAttribute(attributes, 'Color', titleCase(color));
      for (const color of variantColors) addAttribute(attributes, 'Color', titleCase(color));
      addAttribute(attributes, 'Color', row.text_derived_color ? titleCase(row.text_derived_color) : null);
      for (const fabric of extractFabrics(description, tags)) addAttribute(attributes, 'Fabric', fabric);
      for (const type of extractTypes(description, tags)) addAttribute(attributes, 'Type', type);
      addAttribute(attributes, 'Size', extractPieceCount(description, shopifyTags));
      for (const size of allSizes) addAttribute(attributes, 'VariantSize', size);

      return {
        slug: row.handle,
        title: row.title,
        subtitle: row.category,
        price: parsePriceNumber(row.min_price ?? row.max_price),
        imageUrl: row.primary_image_url,
        categories,
        attributes,
        occasion: inferOccasion(row.category, [...shopifyTags, ...tags], description, row.product_formality, row.occasion),
        inStock: availableVariants.length > 0 || Boolean(row.in_stock),
        availableVariantCount: availableVariants.length,
        totalVariantCount: productVariants.length,
        availableSizes,
        onSale: comparePrices.length > 0,
        compareAtPrice: bestSale ? parsePriceNumber(bestSale.compareAt) : null,
        salePercent: bestSale?.salePercent ?? null,
      };
    });

    return cachedCatalog;
  } finally {
    db.close();
  }
}

function hasAttribute(product: CatalogProduct, type: string, value: string): boolean {
  const lowerValue = value.toLowerCase();
  return [...product.attributes].some((attribute) => {
    const [attributeType, attributeValue] = attribute.split(':');
    return attributeType === type && attributeValue.trim().toLowerCase().includes(lowerValue);
  });
}

function parsePrice(text: string): number | null {
  const match = text.replace(/,/g, '').match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

function commerceScore(product: CatalogProduct, intent: CatalogIntent): number {
  const price = parsePrice(product.price) ?? 999_999;
  const availableVariantCount = typeof product.availableVariantCount === 'number' ? product.availableVariantCount : (product.inStock ? 1 : 0);
  const availableSizes = Array.isArray(product.availableSizes) ? product.availableSizes : [];
  let score = 0;

  score += product.inStock !== false ? 40 : -30;
  score += Math.min(availableVariantCount, 5) * 5;
  score += Math.min(availableSizes.length, 5) * 3;
  if (product.onSale) score += 10 + Math.min(product.salePercent ?? 0, 25);

  if (intent.priceMax != null) {
    if (price <= intent.priceMax) score += 12;
    if (price <= intent.priceMax * 0.8) score += 6;
  } else {
    score += Math.max(0, 18 - Math.round(price / 4_000));
  }

  return score;
}

function passesHardConstraints(product: CatalogProduct, intent: CatalogIntent): boolean {
  if (intent.priceMax != null) {
    const price = parsePrice(product.price);
    if (price == null || price > intent.priceMax) return false;
  }
  return true;
}

function matchesSoftFacet(product: CatalogProduct, field: SoftFacetField, value: string): boolean {
  switch (field) {
    case 'collection':
      return product.categories.has(value);
    case 'fabric':
      return hasAttribute(product, 'Fabric', value);
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

export function matchesIntent(product: CatalogProduct, intent: CatalogIntent): boolean {
  if (!passesHardConstraints(product, intent)) return false;
  return softMatchScore(product, intent) === countSoftFacets(intent);
}

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

function toListingCard(product: CatalogProduct): ListingCard {
  const { slug, title, subtitle, price, imageUrl } = product;
  return {
    slug,
    title,
    subtitle,
    price,
    imageUrl,
    inStock: product.inStock,
    onSale: product.onSale,
    compareAtPrice: product.compareAtPrice,
    availableSizes: product.availableSizes,
    availableVariantCount: product.availableVariantCount,
    salePercent: product.salePercent,
  };
}

export function rankCatalog(catalog: CatalogProduct[], intent: CatalogIntent): CatalogSearchResult {
  const eligible = catalog.filter((product) => passesHardConstraints(product, intent));
  const softTotal = countSoftFacets(intent);

  if (softTotal === 0) {
    return { products: eligible.map(toListingCard), relaxed: false };
  }

  const exact = eligible.filter((product) => softMatchScore(product, intent) === softTotal);
  if (exact.length > 0) {
    const rankedExact = exact
      .slice()
      .sort((left, right) => commerceScore(right, intent) - commerceScore(left, intent));
    return { products: rankedExact.map(toListingCard), relaxed: false };
  }

  const ranked = eligible
    .map((product) => ({ product, score: softMatchScore(product, intent), commerce: commerceScore(product, intent) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => (b.score - a.score) || (b.commerce - a.commerce))
    .map(({ product }) => product);

  return { products: ranked.map(toListingCard), relaxed: ranked.length > 0 };
}

export function searchCatalog(intent: CatalogIntent): CatalogSearchResult {
  return rankCatalog(loadCatalog(), intent);
}
