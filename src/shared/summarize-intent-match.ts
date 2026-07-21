import type { RawIntentFields } from './canonicalize';
import type { ShoppingIntent } from './intent';

// canonicalizeIntent silently drops any facet it can't match to one of
// Bareeze's real filter values — correct for building a safe URL, but that
// makes the results *broader* than the shopper asked for with zero visible
// signal it happened. This turns the before/after of canonicalization into
// a human-readable summary so the popup can show what was actually applied
// versus what couldn't be matched, instead of just silently showing more
// products than intended.
export interface IntentMatchSummary {
  applied: string[]; // human-readable filters that made it into the URL, e.g. "Green", "Lawn", "under Rs 5,000"
  unmatched: string[]; // raw LLM values that couldn't be matched to a real Bareeze filter, e.g. "floral"
}

function formatPrice(priceMax: number): string {
  return `under Rs ${priceMax.toLocaleString('en-PK')}`;
}

export function summarizeIntentMatch(raw: RawIntentFields, intent: ShoppingIntent): IntentMatchSummary {
  const applied: string[] = [];
  const unmatched: string[] = [];

  if (intent.collection) {
    applied.push(intent.collection);
  } else if (raw.collection) {
    unmatched.push(String(raw.collection));
  }

  // Mirrors intentToBareezeUrl's own precedence: fabric only wins the base
  // path when no collection was named — when both are present, collection
  // wins and fabric never makes it into the URL at all. Reporting fabric as
  // "applied" whenever it was merely *recognized* (regardless of whether
  // collection superseded it) would tell the shopper a filter was used that
  // the actual URL doesn't contain.
  if (intent.fabric && !intent.collection) {
    applied.push(intent.fabric);
  } else if (intent.fabric) {
    unmatched.push(intent.fabric);
  } else if (raw.fabric) {
    unmatched.push(String(raw.fabric));
  }

  const otherFields: Array<[keyof RawIntentFields, string | null]> = [
    ['color', intent.color],
    ['type', intent.type],
    ['pieceCount', intent.pieceCount],
  ];
  for (const [field, canonical] of otherFields) {
    const rawValue = raw[field];
    if (canonical) {
      applied.push(canonical);
    } else if (rawValue) {
      unmatched.push(String(rawValue));
    }
  }

  if (intent.priceMax) {
    applied.push(formatPrice(intent.priceMax));
  } else if (raw.priceMax) {
    unmatched.push(String(raw.priceMax));
  }

  return { applied, unmatched };
}
