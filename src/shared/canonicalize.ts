import { COLOR_VALUES, PIECE_COUNT_VALUES, TYPE_VALUES } from './intent';
import type { ShoppingIntent } from './intent';

const COLOR_ALIASES: Record<string, (typeof COLOR_VALUES)[number]> = {
  black: 'Black', kala: 'Black', kaala: 'Black', siyah: 'Black',
  blue: 'Blue', neela: 'Blue', neel: 'Blue',
  brown: 'Brown',
  cream: 'Cream', beige: 'Cream',
  green: 'Green', hara: 'Green', sabz: 'Green',
  grey: 'Grey', gray: 'Grey', silver: 'Grey',
  lilac: 'Lilac', lavender: 'Lilac',
  maroon: 'Maroon', wine: 'Maroon', burgundy: 'Maroon',
  mint: 'Mint',
  'off white': 'Off White', offwhite: 'Off White', white: 'White', safed: 'White',
  orange: 'Orange', narangi: 'Orange',
  peach: 'Peach',
  pink: 'Pink', gulabi: 'Pink',
  plum: 'Purple',
  purple: 'Purple', jamni: 'Purple',
  red: 'Red', laal: 'Red', lal: 'Red',
  teal: 'Green', turquoise: 'Green', ferozi: 'Green', firozi: 'Green',
  yellow: 'Yellow', peela: 'Yellow', mustard: 'Yellow',
  zinc: 'Grey',
  golden: 'Yellow', gold: 'Yellow',
  falsa: 'Purple',
};

const TYPE_ALIASES: Record<string, (typeof TYPE_VALUES)[number]> = {
  embroidered: 'Embroidered',
  embroidery: 'Embroidered',
  printed: 'Printed',
  print: 'Printed',
  dyed: 'Dyed',
  plain: 'Dyed',
};

const PIECE_COUNT_ALIASES: Record<string, (typeof PIECE_COUNT_VALUES)[number]> = {
  '2': '2 Piece', two: '2 Piece', do: '2 Piece',
  '3': '3 Piece', three: '3 Piece', teen: '3 Piece',
};

const COLLECTION_ALIASES: Record<string, string> = {
  casual: 'casuals',
  casuals: 'casuals',
  pret: 'luxury pret',
  'luxury pret': 'luxury pret',
  formal: 'luxury formals',
  formals: 'luxury formals',
  'luxury formal': 'luxury formals',
  'luxury formals': 'luxury formals',
  wedding: 'wedding wear',
  bridal: 'wedding wear',
  couture: 'couture',
  stitched: 'casuals',
  unstitched: 'unstitched',
  accessories: 'accessories',
  accessory: 'accessories',
  bag: 'accessories',
  bags: 'accessories',
  'new in': 'new arrivals',
  'new arrival': 'new arrivals',
  'new arrivals': 'new arrivals',
  new: 'new arrivals',
  naya: 'new arrivals',
  nayi: 'new arrivals',
  nai: 'new arrivals',
  eid: 'luxury pret',
  sale: 'new arrivals',
  sasta: 'new arrivals',
  arzan: 'new arrivals',
};

const FABRIC_ALIASES: Record<string, string> = {
  lawn: 'lawn',
  linen: 'linen',
  chiffon: 'chiffon',
  chifon: 'chiffon',
  cotton: 'cotton',
  silk: 'silk',
  velvet: 'velvet',
  organza: 'organza',
  net: 'net',
  polyester: 'polyester',
  wool: 'wool',
  khaddar: 'linen',
  khadar: 'linen',
  pashmina: 'wool',
};

function lookup<T extends string>(
  raw: string | null | undefined,
  aliases: Record<string, T>,
): T | null {
  if (!raw) return null;
  return aliases[raw.trim().toLowerCase()] ?? null;
}

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

function lookupColor(raw: string | null | undefined): string | null {
  const exact = lookup(raw, COLOR_ALIASES);
  if (exact) return exact;
  const words = raw?.trim().toLowerCase().split(/[\s-]+/) ?? [];
  if (words.length === 0) return null;
  const joinedTail = words.slice(-2).join(' ');
  return COLOR_ALIASES[joinedTail] ?? COLOR_ALIASES[words[words.length - 1]] ?? null;
}

export function canonicalizeColor(raw: string | null | undefined): string | null {
  return lookupColor(raw);
}

export function canonicalizeType(raw: string | null | undefined): string | null {
  return lookupWithWordFallback(raw, TYPE_ALIASES);
}

export function canonicalizePieceCount(raw: string | null | undefined): string | null {
  return lookupWithWordFallback(raw, PIECE_COUNT_ALIASES);
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
