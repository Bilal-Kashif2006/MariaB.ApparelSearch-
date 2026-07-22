// Deterministic confidence scoring for Maria B's existing occasion labels.
//
// Unlike Bareeze, Maria B already stores an `occasion` value on each product.
// The job here is not to invent a new label taxonomy, but to score how well
// that stored occasion is supported by structured evidence already present in
// the catalog: category, Shopify tags, local tags, product_formality, title,
// and description text.
//
// Run with:
// node --experimental-strip-types scripts/classify-maria-b-occasion-rules.ts
//
// This writes confidence-scored records into `product_occasion` inside
// data/maria-b.db, using product IDs in the legacy `product_slug` column so
// the existing classification table shape can be reused without changing the
// bareeze pipeline.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureClassificationSchema, type ReviewStatus } from './classification-storage.ts';

const DEFAULT_DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'maria-b.db');
const DB_PATH = path.resolve(process.cwd(), process.argv[2] ?? DEFAULT_DB_PATH);

interface Product {
  id: string;
  title: string;
  category: string | null;
  productFamily: string | null;
  occasion: string | null;
  tags: string[];
  shopifyTags: string[];
  descriptionText: string | null;
  productFormality: string | null;
}

interface Classification {
  occasion: string;
  confidence: number;
  reviewStatus: ReviewStatus;
  reason: string;
  source: 'verified-taxonomy' | 'rule-based';
  evidence: Record<string, unknown>;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

function loadProducts(db: DatabaseSync): Product[] {
  return db.prepare(
    `SELECT id, title, category, product_family, occasion, tags, shopify_tags, description_text, product_formality
     FROM products
     WHERE occasion IS NOT NULL AND trim(occasion) <> ''`,
  ).all().map((row: any) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    productFamily: row.product_family,
    occasion: row.occasion,
    tags: parseJsonArray(row.tags),
    shopifyTags: parseJsonArray(row.shopify_tags),
    descriptionText: row.description_text,
    productFormality: row.product_formality,
  }));
}

function includesAny(haystacks: string[], needles: string[]): boolean {
  return needles.some((needle) => haystacks.some((hay) => hay.includes(needle)));
}

function countSignals(signals: boolean[]): number {
  return signals.filter(Boolean).length;
}

function normalize(product: Product) {
  const title = (product.title || '').toLowerCase();
  const category = (product.category || '').toLowerCase();
  const family = (product.productFamily || '').toLowerCase();
  const occasion = (product.occasion || '').toLowerCase();
  const formality = (product.productFormality || '').toLowerCase();
  const desc = (product.descriptionText || '').toLowerCase();
  const tags = product.tags.map((tag) => tag.toLowerCase());
  const shopifyTags = product.shopifyTags.map((tag) => tag.toLowerCase());
  const text = [title, category, family, formality, desc, ...tags, ...shopifyTags];
  return { title, category, family, occasion, formality, desc, tags, shopifyTags, text };
}

function classify(product: Product): Classification {
  const n = normalize(product);

  const hasEidToken = includesAny(n.text, ['eid collection', 'eid-', 'eidi', 'eid ']);
  const hasIftarToken = includesAny(n.text, ['iftar', 'ramadan']);
  const hasEveningWear = includesAny(n.text, ['evening wear']);
  const hasCasualsTag = includesAny(n.text, ['casuals']);
  const hasPrinted = includesAny(n.text, ['printed', 'm.prints']);
  const hasEmbroidered = includesAny(n.text, ['embroidered']);
  const hasBridalsTag = includesAny(n.text, ['bridals', 'bridal']);
  const hasWeddingWearCategory = n.category === 'wedding wear';
  const hasLuxuryFormalCategory = n.category === 'luxury formals';
  const hasLuxuryPretCategory = n.category === 'luxury pret';
  const hasCoutureCategory = n.category === 'couture';
  const hasKidsCategory = n.category === 'kidsclothes';
  const hasLooseFabricCategory = n.category === 'loose fabrics';
  const hasLawnFabricWord = includesAny(n.text, [' lawn', 'lawn ', 'cambric', 'cotton']);
  const hasDressyFabricWord = includesAny(n.text, ['organza', 'chiffon', 'silk', 'raw silk', 'tissue', 'velvet', 'jamawar', 'net']);
  const isPartyish = n.formality === 'party' || n.formality === 'formal';
  const isBridal = n.formality === 'bridal';

  const explicitOccasionMatch = includesAny(n.text, [n.occasion]);
  const occasion = n.occasion;

  if (occasion === 'eid') {
    if (hasEidToken) {
      return {
        occasion: product.occasion!,
        confidence: 0.99,
        reviewStatus: 'accepted',
        reason: 'Explicit Eid collection/tag in Maria B catalog metadata',
        source: 'verified-taxonomy',
        evidence: { category: product.category, productFormality: product.productFormality, matched: 'eid-tag' },
      };
    }
    const corroboration = countSignals([
      hasLuxuryPretCategory || hasLuxuryFormalCategory || hasKidsCategory || hasLooseFabricCategory,
      hasEmbroidered,
      isPartyish,
      hasDressyFabricWord,
    ]);
    if (corroboration >= 2) {
      return {
        occasion: product.occasion!,
        confidence: 0.84,
        reviewStatus: 'accepted',
        reason: 'Eid label corroborated by festive-formal category/material signals',
        source: 'rule-based',
        evidence: { category: product.category, productFormality: product.productFormality, corroboration },
      };
    }
    if (corroboration === 1 || hasLuxuryPretCategory || hasPrinted || hasLawnFabricWord) {
      return {
        occasion: product.occasion!,
        confidence: 0.68,
        reviewStatus: 'needs-llm-review',
        reason: 'Eid label has only partial support from category or fabric signals',
        source: 'rule-based',
        evidence: { category: product.category, productFormality: product.productFormality, corroboration },
      };
    }
    return {
      occasion: product.occasion!,
      confidence: 0.45,
      reviewStatus: 'needs-llm-review',
      reason: 'Eid label weakly supported by available Maria B metadata',
      source: 'rule-based',
      evidence: { category: product.category, productFormality: product.productFormality },
    };
  }

  if (occasion === 'baraat') {
    if (hasWeddingWearCategory || hasBridalsTag || isBridal) {
      return {
        occasion: product.occasion!,
        confidence: 0.99,
        reviewStatus: 'accepted',
        reason: 'Baraat label explicitly supported by bridal/wedding category tags',
        source: 'verified-taxonomy',
        evidence: { category: product.category, productFormality: product.productFormality },
      };
    }
    if (hasCoutureCategory || hasLuxuryFormalCategory || hasDressyFabricWord) {
      return {
        occasion: product.occasion!,
        confidence: 0.82,
        reviewStatus: 'accepted',
        reason: 'Baraat label supported by couture/formal bridalwear signals',
        source: 'rule-based',
        evidence: { category: product.category, productFormality: product.productFormality },
      };
    }
    return {
      occasion: product.occasion!,
      confidence: 0.55,
      reviewStatus: 'needs-llm-review',
      reason: 'Baraat label present but weakly supported',
      source: 'rule-based',
      evidence: { category: product.category, productFormality: product.productFormality },
    };
  }

  if (['wedding', 'mehndi', 'walima', 'engagement'].includes(occasion)) {
    const exactEvent = explicitOccasionMatch;
    const bridalSupport = countSignals([
      hasWeddingWearCategory || hasCoutureCategory || hasLuxuryFormalCategory,
      hasBridalsTag,
      isBridal || isPartyish,
      hasDressyFabricWord,
      exactEvent,
    ]);
    if (exactEvent || bridalSupport >= 3) {
      return {
        occasion: product.occasion!,
        confidence: 0.92,
        reviewStatus: 'accepted',
        reason: `${product.occasion} label strongly supported by bridal/formal event signals`,
        source: exactEvent ? 'verified-taxonomy' : 'rule-based',
        evidence: { category: product.category, productFormality: product.productFormality, bridalSupport },
      };
    }
    if (bridalSupport >= 2) {
      return {
        occasion: product.occasion!,
        confidence: 0.74,
        reviewStatus: 'needs-llm-review',
        reason: `${product.occasion} label has partial bridal/formal support`,
        source: 'rule-based',
        evidence: { category: product.category, productFormality: product.productFormality, bridalSupport },
      };
    }
    return {
      occasion: product.occasion!,
      confidence: 0.52,
      reviewStatus: 'needs-llm-review',
      reason: `${product.occasion} label weakly supported by available metadata`,
      source: 'rule-based',
      evidence: { category: product.category, productFormality: product.productFormality, bridalSupport },
    };
  }

  if (occasion === 'iftar') {
    if (hasIftarToken) {
      return {
        occasion: product.occasion!,
        confidence: 0.97,
        reviewStatus: 'accepted',
        reason: 'Explicit iftar/Ramadan metadata in catalog tags',
        source: 'verified-taxonomy',
        evidence: { category: product.category, productFormality: product.productFormality },
      };
    }
    if (hasLuxuryFormalCategory && isPartyish) {
      return {
        occasion: product.occasion!,
        confidence: 0.78,
        reviewStatus: 'needs-llm-review',
        reason: 'Iftar label inferred from formal eveningwear positioning only',
        source: 'rule-based',
        evidence: { category: product.category, productFormality: product.productFormality },
      };
    }
    return {
      occasion: product.occasion!,
      confidence: 0.5,
      reviewStatus: 'needs-llm-review',
      reason: 'Iftar label weakly supported without explicit Ramadan metadata',
      source: 'rule-based',
      evidence: { category: product.category, productFormality: product.productFormality },
    };
  }

  if (occasion === 'formal') {
    const formalSupport = countSignals([
      hasLuxuryFormalCategory || hasCoutureCategory,
      hasEveningWear,
      isPartyish || isBridal,
      hasDressyFabricWord,
      hasEmbroidered,
    ]);
    if (formalSupport >= 2) {
      return {
        occasion: product.occasion!,
        confidence: 0.84,
        reviewStatus: 'accepted',
        reason: 'Formal label corroborated by eveningwear/formal material signals',
        source: 'rule-based',
        evidence: { category: product.category, productFormality: product.productFormality, formalSupport },
      };
    }
    if (formalSupport === 1) {
      return {
        occasion: product.occasion!,
        confidence: 0.68,
        reviewStatus: 'needs-llm-review',
        reason: 'Formal label has only one strong corroborating signal',
        source: 'rule-based',
        evidence: { category: product.category, productFormality: product.productFormality, formalSupport },
      };
    }
    return {
      occasion: product.occasion!,
      confidence: 0.48,
      reviewStatus: 'needs-llm-review',
      reason: 'Formal label weakly supported by current metadata',
      source: 'rule-based',
      evidence: { category: product.category, productFormality: product.productFormality, formalSupport },
    };
  }

  if (occasion === 'casual') {
    if (n.category === 'payment link') {
      return {
        occasion: product.occasion!,
        confidence: 0.12,
        reviewStatus: 'unclassified',
        reason: 'Payment Link is not a real apparel product; casual label is not meaningful',
        source: 'rule-based',
        evidence: { category: product.category },
      };
    }
    if (hasCasualsTag) {
      return {
        occasion: product.occasion!,
        confidence: 0.9,
        reviewStatus: 'accepted',
        reason: 'Explicit Casuals tag in catalog metadata',
        source: 'verified-taxonomy',
        evidence: { category: product.category, productFormality: product.productFormality },
      };
    }
    const casualSupport = countSignals([
      n.category === 'womensclothing' || n.category === 'stitched m.prints' || n.category === 'stitched lawn' || n.category === 'unstitched lawn' || n.category === 'unstitched m.prints' || n.category === 'womensunstitched' || n.category === 'stitched intl.' || n.category === 'stitched linen' || n.category === 'unstitched linen',
      hasPrinted || hasLawnFabricWord,
      n.formality === 'casual' || n.formality === 'semi-formal',
      !hasLuxuryFormalCategory && !hasWeddingWearCategory && !hasCoutureCategory,
    ]);
    if (casualSupport >= 3) {
      return {
        occasion: product.occasion!,
        confidence: 0.82,
        reviewStatus: 'accepted',
        reason: 'Casual label supported by daywear category and fabric signals',
        source: 'rule-based',
        evidence: { category: product.category, productFormality: product.productFormality, casualSupport },
      };
    }
    if (casualSupport >= 2) {
      return {
        occasion: product.occasion!,
        confidence: 0.66,
        reviewStatus: 'needs-llm-review',
        reason: 'Casual label partially supported, but not strongly enough to accept outright',
        source: 'rule-based',
        evidence: { category: product.category, productFormality: product.productFormality, casualSupport },
      };
    }
    return {
      occasion: product.occasion!,
      confidence: 0.42,
      reviewStatus: 'needs-llm-review',
      reason: 'Casual label is weak or contradicted by more formal signals',
      source: 'rule-based',
      evidence: { category: product.category, productFormality: product.productFormality, casualSupport },
    };
  }

  return {
    occasion: product.occasion!,
    confidence: 0.4,
    reviewStatus: 'needs-llm-review',
    reason: 'Occasion falls outside the Maria B deterministic scoring rules',
    source: 'rule-based',
    evidence: { category: product.category, productFormality: product.productFormality },
  };
}

function main() {
  const db = new DatabaseSync(DB_PATH);
  ensureClassificationSchema(db);

  const products = loadProducts(db);
  const upsert = db.prepare(
    `INSERT INTO product_occasion
       (product_slug, occasion, classified_at, source, confidence, review_status, reason, evidence_json,
        reviewer_confidence, reviewer_reason, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
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
  const bucketCounts = { high: 0, medium: 0, low: 0 };

  db.exec('BEGIN');
  try {
    for (const product of products) {
      const result = classify(product);
      if (result.confidence >= 0.8) bucketCounts.high++;
      else if (result.confidence >= 0.6) bucketCounts.medium++;
      else bucketCounts.low++;

      upsert.run(
        product.id,
        result.occasion,
        now,
        result.source,
        result.confidence,
        result.reviewStatus,
        result.reason,
        JSON.stringify({
          category: product.category,
          productFamily: product.productFamily,
          productFormality: product.productFormality,
          tags: product.tags,
          shopifyTags: product.shopifyTags,
          ...result.evidence,
        }),
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }

  console.log(JSON.stringify({
    dbPath: DB_PATH,
    classifiedProducts: products.length,
    bucketCounts,
  }, null, 2));
}

main();
