// Structured shopping intent for Bareeze voice/typed search, scoped to the
// real filter facets confirmed live on bareeze.com's own filter drawer (open
// "Filter" on any category page). Every vocabulary value below is an exact
// attribute_value string Bareeze's own filter accepts — not guessed.
//
// Bareeze's own filter data has inconsistent duplicate casing for several
// colors (e.g. both "Red" and "RED" exist as separate, non-overlapping
// filter values — a data-entry inconsistency on their side, not ours). Each
// canonical color below picks one casing; the other-cased subset of
// products is simply unreachable through this filter, same as it would be
// for a human shopper who only ever clicks one of the two checkboxes.
//
// The casing picked below is verified against real product counts (via a
// full-catalog crawl, not guessed): for every duplicate pair, the ALL-CAPS
// variant holds the current real inventory (e.g. GREEN:82 products vs
// Green:1; BLUE:89 vs no "Blue" tag at all) — Title-Case appears to be a
// legacy/near-empty batch. An earlier version of this file picked the
// Title-Case casing by appearance alone without checking product counts,
// which meant voice/typed searches for these colors were mostly hitting
// empty filters. Fixed here; see git history for the original picks.
export interface ShoppingIntent {
  collection: string | null; // key into CATEGORY_PATHS, e.g. "casuals"
  fabric: string | null; // key into CATEGORY_PATHS, e.g. "lawn" — shares the base-path slot with collection
  color: string | null;
  type: string | null;
  pieceCount: string | null; // "2-Pieces" | "3-Pieces"
  priceMax: number | null;
}

export const COLOR_VALUES = [
  'ORANGE', 'GREEN', 'PURPLE', 'PINK', 'Lilac', 'Rust', 'RED', 'YELLOW',
  'Maroon', 'Cream', 'Teal', 'Lemon', 'Aqua', 'Mint', 'BLUE', 'Beige',
  'Mehndi', 'FEROZI', 'Charcoal', 'Orchid', 'Pistachio', 'Violet', 'GREY',
  'White', 'Ochre', 'BLACK', 'Peach', 'Magenta', 'Mustard', 'Brown',
  // Zinc/Plum/Golden/Falsa: rare (single-product) real values found in the
  // same full-catalog crawl that surfaced the duplicate-casing issue above
  // — each was previously entirely absent from this list, so a shopper
  // naming any of them would always get dropped rather than matched.
  'Zinc', 'Plum', 'Golden', 'Falsa',
] as const;

// The practically nameable Type values. Bareeze's drawer also lists
// "EMBROIDERED", "EMBL", and "EMB & EMBL" as separate values (the last one
// contains "&", which would break query-string parsing if ever attribute-
// filtered on) — those aren't included since no shopper asks for them by
// name. "Print" and "Plain" were missing entirely from an earlier version
// of this list (checked against too narrow a set of collections' filter
// drawers at the time) — added after a full-catalog crawl found 103 real
// products tagged Printed/Print/PLAIN with nothing in the vocabulary able
// to match any of them. "Print" (not "Printed") is the canonical pick since
// hasAttribute's substring match (server/src/catalog.ts) needs the shorter
// stem to match both "Print" and "Printed" as they appear in real data.
export const TYPE_VALUES = ['Embroidered', 'Print', 'Plain'] as const;

export const PIECE_COUNT_VALUES = ['2-Pieces', '3-Pieces'] as const;
