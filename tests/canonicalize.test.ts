import { describe, expect, it } from 'vitest';
import {
  canonicalizeCollection,
  canonicalizeColor,
  canonicalizeFabric,
  canonicalizeIntent,
  canonicalizePieceCount,
  canonicalizeType,
} from '../src/shared/canonicalize';

describe('canonicalizeColor', () => {
  it('maps an exact English color name to itself', () => {
    expect(canonicalizeColor('GREEN')).toBe('GREEN');
  });

  it('is case-insensitive', () => {
    // GREEN is the real canonical casing — verified against actual product
    // counts (see intent.ts): Bareeze's own "Green" (Title Case) tag is a
    // near-empty legacy duplicate, "GREEN" holds the real inventory.
    expect(canonicalizeColor('green')).toBe('GREEN');
    expect(canonicalizeColor('Green')).toBe('GREEN');
  });

  it('maps common Roman Urdu color words to the matching Bareeze value', () => {
    expect(canonicalizeColor('hara')).toBe('GREEN');
    expect(canonicalizeColor('laal')).toBe('RED');
    expect(canonicalizeColor('kaala')).toBe('BLACK');
    expect(canonicalizeColor('safed')).toBe('White');
  });

  it('drops an unrecognized color rather than guessing', () => {
    expect(canonicalizeColor('holographic')).toBeNull();
    expect(canonicalizeColor(null)).toBeNull();
    expect(canonicalizeColor(undefined)).toBeNull();
  });

  it('falls back to the base color noun for an unlisted modifier + color phrase', () => {
    // "dark green" isn't in the alias table itself, but shouldn't be
    // dropped entirely — the shopper still clearly wants green.
    expect(canonicalizeColor('dark green')).toBe('GREEN');
    expect(canonicalizeColor('royal blue')).toBe('BLUE');
    expect(canonicalizeColor('sea-green')).toBe('GREEN');
  });

  it('still drops a multi-word phrase whose last word is also unrecognized', () => {
    expect(canonicalizeColor('dark holographic')).toBeNull();
  });

  it('maps rare real colors that were entirely missing from the vocabulary', () => {
    // Zinc/Plum/Golden/Falsa each appear on exactly one real product in a
    // full-catalog crawl but had no entry anywhere in COLOR_VALUES/
    // COLOR_ALIASES — canonicalizeColor used to drop all four unconditionally.
    expect(canonicalizeColor('zinc')).toBe('Zinc');
    expect(canonicalizeColor('plum')).toBe('Plum');
    expect(canonicalizeColor('golden')).toBe('Golden');
    expect(canonicalizeColor('gold')).toBe('Golden');
    expect(canonicalizeColor('falsa')).toBe('Falsa');
  });
});

describe('canonicalizeType', () => {
  it('maps "embroidery" to the real "Embroidered" filter value', () => {
    expect(canonicalizeType('embroidery')).toBe('Embroidered');
    expect(canonicalizeType('Embroidered')).toBe('Embroidered');
  });

  it('matches when the alias word is part of a longer natural phrase', () => {
    // Regression, same class of bug as canonicalizePieceCount: a shopper
    // saying "embroidered suit" or "with heavy embroidery" is far more
    // natural than the bare alias word alone, and used to silently drop.
    expect(canonicalizeType('embroidered suit')).toBe('Embroidered');
    expect(canonicalizeType('with heavy embroidery')).toBe('Embroidered');
  });

  it('maps printed and plain to their real catalog values', () => {
    // These were missing from the vocabulary entirely until a full-catalog
    // crawl found 103 real products tagged Printed/Print/PLAIN with no
    // alias able to match any of them — canonicalizeType('printed') used to
    // return null even though it's a real, common Bareeze Type value.
    expect(canonicalizeType('printed')).toBe('Print');
    expect(canonicalizeType('print')).toBe('Print');
    expect(canonicalizeType('plain')).toBe('Plain');
    expect(canonicalizeType('printed suit')).toBe('Print');
  });

  it('drops an unrecognized type', () => {
    expect(canonicalizeType('striped')).toBeNull();
  });
});

describe('canonicalizePieceCount', () => {
  it('maps natural phrasing to the exact Bareeze piece-count value', () => {
    expect(canonicalizePieceCount('2 piece')).toBe('2-Pieces');
    expect(canonicalizePieceCount('two piece')).toBe('2-Pieces');
    expect(canonicalizePieceCount('three piece')).toBe('3-Pieces');
  });

  it('matches the number regardless of which noun it sits next to', () => {
    // Regression: shoppers call these "suits", not just "pieces" — an
    // earlier version only matched the exact phrase "N piece(s)" and
    // silently dropped anything else, including this very natural phrasing.
    expect(canonicalizePieceCount('two suit')).toBe('2-Pieces');
    expect(canonicalizePieceCount('three suit')).toBe('3-Pieces');
    expect(canonicalizePieceCount('3 suit')).toBe('3-Pieces');
    expect(canonicalizePieceCount('2-piece suit')).toBe('2-Pieces');
  });

  it('maps Roman Urdu number words', () => {
    expect(canonicalizePieceCount('do suit')).toBe('2-Pieces');
    expect(canonicalizePieceCount('teen suit')).toBe('3-Pieces');
  });

  it('drops an unrecognized piece count', () => {
    expect(canonicalizePieceCount('4 piece')).toBeNull();
    expect(canonicalizePieceCount('four suit')).toBeNull();
  });
});

describe('canonicalizeCollection', () => {
  it('maps a plural/singular collection word to its CATEGORY_PATHS key', () => {
    expect(canonicalizeCollection('casual')).toBe('casuals');
    expect(canonicalizeCollection('formals')).toBe('formals');
  });

  it('maps "new arrivals" to the "new in" key', () => {
    expect(canonicalizeCollection('new arrivals')).toBe('new in');
  });

  it('matches when the alias word is part of a longer natural phrase', () => {
    // Same regression class as pieceCount/type: "casual wear" and "formal
    // dress" are how people actually talk, not the bare alias word.
    expect(canonicalizeCollection('casual wear')).toBe('casuals');
    expect(canonicalizeCollection('formal dress')).toBe('formals');
    expect(canonicalizeCollection('shawl collection')).toBe('shawls');
  });

  it('drops an unrecognized collection', () => {
    expect(canonicalizeCollection('menswear')).toBeNull();
  });

  it('maps Roman Urdu words for "cheap" and "new" to their real collections', () => {
    // "sasta suit chahiye" / "naya collection dikhao" are how shoppers who
    // default to Roman Urdu actually phrase these two requests.
    expect(canonicalizeCollection('sasta')).toBe('sale');
    expect(canonicalizeCollection('sasta suit')).toBe('sale');
    expect(canonicalizeCollection('naya')).toBe('new in');
    expect(canonicalizeCollection('nayi collection')).toBe('new in');
  });
});

describe('canonicalizeFabric', () => {
  it('maps a fabric word to its CATEGORY_PATHS key', () => {
    expect(canonicalizeFabric('Lawn')).toBe('lawn');
    expect(canonicalizeFabric('khadar')).toBe('khaddar');
  });

  it('matches when the alias word is part of a longer natural phrase', () => {
    expect(canonicalizeFabric('lawn suit')).toBe('lawn');
    expect(canonicalizeFabric('chiffon dress')).toBe('chiffon');
  });

  it('tolerates a close fabric spelling mistake', () => {
    expect(canonicalizeFabric('chifon suit')).toBe('chiffon');
  });

  it('maps fabrics that only exist as a catalog attribute, not a live collection page', () => {
    // Regression: polyester/linen/pashmina are real, crawl-verified Fabric
    // attribute values (21/9/1 products) but canonicalizeFabric used to
    // drop all three — there's no live /fabric/polyester or /fabric/linen
    // page (confirmed: both behave like a nonexistent path), but they still
    // need to work for the catalog attribute match.
    expect(canonicalizeFabric('polyester')).toBe('polyester');
    expect(canonicalizeFabric('linen')).toBe('linen');
    expect(canonicalizeFabric('pashmina')).toBe('pashmina');
  });

  it('drops an unrecognized fabric', () => {
    expect(canonicalizeFabric('silk')).toBeNull();
  });
});

describe('canonicalizeIntent', () => {
  it('canonicalizes every field independently and drops unknown ones', () => {
    // Arrange
    const raw = {
      collection: 'casual',
      fabric: 'silk',
      color: 'hara',
      type: 'embroidery',
      pieceCount: '2 piece',
      priceMax: 20000,
    };

    // Act
    const intent = canonicalizeIntent(raw);

    // Assert
    expect(intent).toEqual({
      collection: 'casuals',
      fabric: null,
      color: 'GREEN',
      type: 'Embroidered',
      pieceCount: '2-Pieces',
      priceMax: 20000,
    });
  });

  it('returns an all-null intent for an empty input', () => {
    // Arrange & Act
    const intent = canonicalizeIntent({});

    // Assert
    expect(intent).toEqual({
      collection: null,
      fabric: null,
      color: null,
      type: null,
      pieceCount: null,
      priceMax: null,
    });
  });

  it('drops a non-positive or non-finite priceMax', () => {
    expect(canonicalizeIntent({ priceMax: 0 }).priceMax).toBeNull();
    expect(canonicalizeIntent({ priceMax: -100 }).priceMax).toBeNull();
    expect(canonicalizeIntent({ priceMax: NaN }).priceMax).toBeNull();
  });
});
