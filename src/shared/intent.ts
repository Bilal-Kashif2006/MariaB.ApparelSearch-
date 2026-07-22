// Structured shopping intent for Maria B voice/typed search. These values
// are chosen to match the normalized Maria B catalog adapter in
// server/src/catalog.ts rather than a scraped filter drawer vocabulary.
export interface ShoppingIntent {
  collection: string | null;
  fabric: string | null;
  color: string | null;
  type: string | null;
  pieceCount: string | null;
  priceMax: number | null;
}

export const COLOR_VALUES = [
  'Black', 'Blue', 'Brown', 'Cream', 'Green', 'Grey', 'Lilac', 'Maroon',
  'Mint', 'Off White', 'Orange', 'Peach', 'Pink', 'Purple', 'Red', 'White',
  'Yellow',
] as const;

export const TYPE_VALUES = ['Embroidered', 'Printed', 'Dyed'] as const;

export const PIECE_COUNT_VALUES = ['2 Piece', '3 Piece'] as const;
