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
    expect(canonicalizeColor('GREEN')).toBe('Green');
  });

  it('is case-insensitive', () => {
    expect(canonicalizeColor('green')).toBe('Green');
    expect(canonicalizeColor('Green')).toBe('Green');
  });

  it('maps common Roman Urdu color words to the matching Maria B value', () => {
    expect(canonicalizeColor('hara')).toBe('Green');
    expect(canonicalizeColor('laal')).toBe('Red');
    expect(canonicalizeColor('kaala')).toBe('Black');
    expect(canonicalizeColor('safed')).toBe('White');
  });

  it('drops an unrecognized color rather than guessing', () => {
    expect(canonicalizeColor('holographic')).toBeNull();
    expect(canonicalizeColor(null)).toBeNull();
    expect(canonicalizeColor(undefined)).toBeNull();
  });

  it('falls back to the base color noun for an unlisted modifier + color phrase', () => {
    expect(canonicalizeColor('dark green')).toBe('Green');
    expect(canonicalizeColor('royal blue')).toBe('Blue');
    expect(canonicalizeColor('sea-green')).toBe('Green');
  });

  it('still drops a multi-word phrase whose last word is also unrecognized', () => {
    expect(canonicalizeColor('dark holographic')).toBeNull();
  });

  it('maps rarer color words to the nearest Maria B canonical color bucket', () => {
    expect(canonicalizeColor('zinc')).toBe('Grey');
    expect(canonicalizeColor('plum')).toBe('Purple');
    expect(canonicalizeColor('golden')).toBe('Yellow');
    expect(canonicalizeColor('gold')).toBe('Yellow');
    expect(canonicalizeColor('falsa')).toBe('Purple');
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

  it('maps printed and plain into the Maria B type buckets', () => {
    expect(canonicalizeType('printed')).toBe('Printed');
    expect(canonicalizeType('print')).toBe('Printed');
    expect(canonicalizeType('plain')).toBe('Dyed');
    expect(canonicalizeType('printed suit')).toBe('Printed');
  });

  it('drops an unrecognized type', () => {
    expect(canonicalizeType('striped')).toBeNull();
  });
});

describe('canonicalizePieceCount', () => {
  it('maps natural phrasing to the Maria B piece-count value', () => {
    expect(canonicalizePieceCount('2 piece')).toBe('2 Piece');
    expect(canonicalizePieceCount('two piece')).toBe('2 Piece');
    expect(canonicalizePieceCount('three piece')).toBe('3 Piece');
  });

  it('matches the number regardless of which noun it sits next to', () => {
    // Regression: shoppers call these "suits", not just "pieces" — an
    // earlier version only matched the exact phrase "N piece(s)" and
    // silently dropped anything else, including this very natural phrasing.
    expect(canonicalizePieceCount('two suit')).toBe('2 Piece');
    expect(canonicalizePieceCount('three suit')).toBe('3 Piece');
    expect(canonicalizePieceCount('3 suit')).toBe('3 Piece');
    expect(canonicalizePieceCount('2-piece suit')).toBe('2 Piece');
  });

  it('maps Roman Urdu number words', () => {
    expect(canonicalizePieceCount('do suit')).toBe('2 Piece');
    expect(canonicalizePieceCount('teen suit')).toBe('3 Piece');
  });

  it('drops an unrecognized piece count', () => {
    expect(canonicalizePieceCount('4 piece')).toBeNull();
    expect(canonicalizePieceCount('four suit')).toBeNull();
  });
});

describe('canonicalizeCollection', () => {
  it('maps a plural/singular collection word to its CATEGORY_PATHS key', () => {
    expect(canonicalizeCollection('casual')).toBe('casuals');
    expect(canonicalizeCollection('formals')).toBe('luxury formals');
  });

  it('maps "new arrivals" to the Maria B new-arrivals key', () => {
    expect(canonicalizeCollection('new arrivals')).toBe('new arrivals');
  });

  it('matches when the alias word is part of a longer natural phrase', () => {
    // Same regression class as pieceCount/type: "casual wear" and "formal
    // dress" are how people actually talk, not the bare alias word.
    expect(canonicalizeCollection('casual wear')).toBe('casuals');
    expect(canonicalizeCollection('formal dress')).toBe('luxury formals');
    expect(canonicalizeCollection('pret collection')).toBe('luxury pret');
  });

  it('drops an unrecognized collection', () => {
    expect(canonicalizeCollection('menswear')).toBeNull();
  });

  it('maps Roman Urdu words for "cheap" and "new" to the closest Maria B collection', () => {
    expect(canonicalizeCollection('sasta')).toBe('new arrivals');
    expect(canonicalizeCollection('sasta suit')).toBe('new arrivals');
    expect(canonicalizeCollection('naya')).toBe('new arrivals');
    expect(canonicalizeCollection('nayi collection')).toBe('new arrivals');
  });
});

describe('canonicalizeFabric', () => {
  it('maps a fabric word to its CATEGORY_PATHS key', () => {
    expect(canonicalizeFabric('Lawn')).toBe('lawn');
    expect(canonicalizeFabric('khadar')).toBe('linen');
  });

  it('matches when the alias word is part of a longer natural phrase', () => {
    expect(canonicalizeFabric('lawn suit')).toBe('lawn');
    expect(canonicalizeFabric('chiffon dress')).toBe('chiffon');
  });

  it('tolerates a close fabric spelling mistake', () => {
    expect(canonicalizeFabric('chifon suit')).toBe('chiffon');
  });

  it('maps fabrics that only exist as a catalog attribute, not a live collection page', () => {
    expect(canonicalizeFabric('polyester')).toBe('polyester');
    expect(canonicalizeFabric('linen')).toBe('linen');
    expect(canonicalizeFabric('pashmina')).toBe('wool');
  });

  it('keeps real Maria B fabrics instead of dropping them', () => {
    expect(canonicalizeFabric('silk')).toBe('silk');
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
      fabric: 'silk',
      color: 'Green',
      type: 'Embroidered',
      pieceCount: '2 Piece',
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
