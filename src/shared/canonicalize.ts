import { COLOR_VALUES, PIECE_COUNT_VALUES, TYPE_VALUES } from './intent';
import type { ShoppingIntent } from './intent';

// The LLM is prompted with these vocabularies but may still return a
// synonym, a different casing, or a Roman Urdu / Urdu term instead of the
// exact string Bareeze's filter expects. Each canonicalize* function maps
// loose input to one of the real, confirmed values above, or null if it
// can't be matched — dropping an unrecognized facet rather than sending
// Bareeze an attribute value that silently matches nothing.

const COLOR_ALIASES: Record<string, (typeof COLOR_VALUES)[number]> = {
  red: 'RED', laal: 'RED', lal: 'RED', surkh: 'RED',
  green: 'GREEN', hara: 'GREEN', hari: 'GREEN', sabz: 'GREEN',
  blue: 'BLUE', neela: 'BLUE', neel: 'BLUE',
  black: 'BLACK', kala: 'BLACK', kaala: 'BLACK', siyah: 'BLACK',
  white: 'White', safed: 'White', safaid: 'White',
  yellow: 'YELLOW', peela: 'YELLOW', zard: 'YELLOW',
  pink: 'PINK', gulabi: 'PINK', 'hot pink': 'PINK',
  purple: 'PURPLE', jamni: 'PURPLE',
  orange: 'ORANGE', narangi: 'ORANGE',
  grey: 'GREY', gray: 'GREY', khakstari: 'GREY',
  brown: 'Brown',
  maroon: 'Maroon',
  cream: 'Cream', 'off white': 'Cream',
  teal: 'Teal',
  lemon: 'Lemon',
  aqua: 'Aqua',
  mint: 'Mint',
  beige: 'Beige',
  mehndi: 'Mehndi',
  ferozi: 'FEROZI', firozi: 'FEROZI', turquoise: 'FEROZI',
  charcoal: 'Charcoal',
  orchid: 'Orchid',
  pistachio: 'Pistachio',
  violet: 'Violet',
  ochre: 'Ochre', ocher: 'Ochre',
  peach: 'Peach',
  magenta: 'Magenta',
  mustard: 'Mustard',
  lilac: 'Lilac', lavender: 'Lilac',
  rust: 'Rust',
  zinc: 'Zinc',
  plum: 'Plum',
  golden: 'Golden', gold: 'Golden',
  falsa: 'Falsa',
};

const TYPE_ALIASES: Record<string, (typeof TYPE_VALUES)[number]> = {
  embroidered: 'Embroidered',
  embroidery: 'Embroidered',
  printed: 'Print',
  print: 'Print',
  plain: 'Plain',
};

// Keyed on just the number word, not the full phrase — a shopper can name
// the piece count next to any noun ("2 piece", "two piece suit", "3 suit",
// "teen suit"), and Bareeze's own filter only cares about the number.
const PIECE_COUNT_NUMBER_ALIASES: Record<string, (typeof PIECE_COUNT_VALUES)[number]> = {
  '2': '2-Pieces', two: '2-Pieces', do: '2-Pieces',
  '3': '3-Pieces', three: '3-Pieces', teen: '3-Pieces',
};

// Non-fabric collection keys only — fabric has its own canonicalizer since
// the two share the same CATEGORY_PATHS lookup table but come from
// different intent fields.
const COLLECTION_ALIASES: Record<string, string> = {
  casual: 'casuals', casuals: 'casuals',
  formal: 'formals', formals: 'formals',
  shawl: 'shawls', shawls: 'shawls',
  'new in': 'new in', 'new arrivals': 'new in', new: 'new in', newest: 'new in', naya: 'new in', nayi: 'new in', nai: 'new in',
  prints: 'prints', printed: 'prints',
  // "sasta"/"arzan" (Roman Urdu for cheap/affordable) name no specific
  // collection by themselves, but shoppers use them exactly where they'd
  // otherwise say "sale" — mapping them there gets a real, cheaper set of
  // products instead of dropping the word and returning the full catalog.
  sale: 'sale', discount: 'sale', discounted: 'sale', sasta: 'sale', arzan: 'sale',
  pret: 'pret',
};

const FABRIC_ALIASES: Record<string, string> = {
  lawn: 'lawn',
  khaddar: 'khaddar', khadar: 'khaddar', khaddi: 'khaddar',
  velvet: 'velvet',
  chiffon: 'chiffon',
  organza: 'organza',
  net: 'net',
  cotton: 'cotton',
  cambric: 'cambric',
  karandi: 'karandi',
  // Polyester/linen/pashmina have no dedicated /fabric/<name> collection
  // page on the live site (confirmed live: those paths behave identically
  // to a nonexistent path, 0 real product cards) — unlike the fabrics
  // above, they only ever work as a catalog attribute filter
  // (server/src/catalog.ts's hasAttribute), never as intentToBareezeUrl's
  // base path. Still real, tagged values found via the full-catalog crawl
  // (21/9/1 products respectively) with no alias able to match any of them
  // before this.
  polyester: 'polyester',
  linen: 'linen',
  pashmina: 'pashmina',
};

function lookup<T extends string>(
  raw: string | null | undefined,
  aliases: Record<string, T>,
): T | null {
  if (!raw) return null;
  return aliases[raw.trim().toLowerCase()] ?? null;
}

// Shoppers rarely say the bare alias word on its own — "lawn suit", "casual
// wear", "embroidered dress", "formal collection" are all more natural than
// "lawn"/"casual"/"embroidered"/"formal" alone. Matching only the whole
// phrase (plain lookup()) silently drops every one of these, which was a
// real, reported bug for piece count ("three suit" never matched "3 piece").
// This checks the whole phrase first (so multi-word alias keys like "new
// arrivals" still take priority), then falls back to any single word in the
// phrase matching an alias — used for every field except color, which has
// its own narrower last-word-only fallback (see lookupColor) tuned to how
// color phrases specifically order their words. Exported so
// server/src/catalog.ts can reuse the same fallback for occasion matching.
export function lookupWithWordFallback<T extends string>(
  raw: string | null | undefined,
  aliases: Record<string, T>,
): T | null {
  const exact = lookup(raw, aliases);
  if (exact) return exact;
  const words = raw?.trim().toLowerCase().split(/[\s-]+/) ?? [];
  for (const word of words) {
    const match = aliases[word];
    if (match) return match;
  }
  return null;
}

// Colors are the field most likely to arrive as a modifier + base-color
// phrase ("dark green", "royal blue", "sea green") rather than the bare
// word in COLOR_ALIASES. Falling back to the *last* word catches these
// without becoming a fuzzy matcher — English color phrases put the base
// color noun last, unlike the other fields (see lookupWithWordFallback,
// which checks every word since those fields don't share that convention).
function lookupColor(raw: string | null | undefined): string | null {
  const exact = lookup(raw, COLOR_ALIASES);
  if (exact) return exact;
  const words = raw?.trim().toLowerCase().split(/[\s-]+/) ?? [];
  if (words.length < 2) return null;
  return COLOR_ALIASES[words[words.length - 1]] ?? null;
}

export function canonicalizeColor(raw: string | null | undefined): string | null {
  return lookupColor(raw);
}

export function canonicalizeType(raw: string | null | undefined): string | null {
  return lookupWithWordFallback(raw, TYPE_ALIASES);
}

export function canonicalizePieceCount(raw: string | null | undefined): string | null {
  return lookupWithWordFallback(raw, PIECE_COUNT_NUMBER_ALIASES);
}

export function canonicalizeCollection(raw: string | null | undefined): string | null {
  return lookupWithWordFallback(raw, COLLECTION_ALIASES);
}

export function canonicalizeFabric(raw: string | null | undefined): string | null {
  return lookupWithWordFallback(raw, FABRIC_ALIASES);
}

function canonicalizePriceMax(raw: number | null | undefined): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

// Loosely-typed fields as the LLM might actually return them, before any
// canonicalization — every field optional/nullable since the LLM only
// includes what the shopper actually said.
export interface RawIntentFields {
  collection?: string | null;
  fabric?: string | null;
  color?: string | null;
  type?: string | null;
  pieceCount?: string | null;
  priceMax?: number | null;
}

export function canonicalizeIntent(raw: RawIntentFields): ShoppingIntent {
  return {
    collection: canonicalizeCollection(raw.collection),
    fabric: canonicalizeFabric(raw.fabric),
    color: canonicalizeColor(raw.color),
    type: canonicalizeType(raw.type),
    pieceCount: canonicalizePieceCount(raw.pieceCount),
    priceMax: canonicalizePriceMax(raw.priceMax),
  };
}
