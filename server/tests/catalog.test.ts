import { describe, expect, it } from 'vitest';
import {
  canonicalizeForCatalog,
  canonicalizeOccasion,
  dropNegatedFields,
  isEmptyCatalogIntent,
  matchesIntent,
  mergeCatalogIntent,
  rankCatalog,
  type CatalogIntent,
  type CatalogProduct,
} from '../src/catalog.js';
import type { RawIntent } from '../src/schema.js';

const EMPTY_INTENT: CatalogIntent = {
  collection: null,
  fabric: null,
  color: null,
  type: null,
  pieceCount: null,
  occasion: null,
  priceMax: null,
};

function product(attributes: string[], overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    slug: 'test-product',
    title: 'TEST PRODUCT',
    subtitle: null,
    price: 'PKR 10,000',
    imageUrl: null,
    categories: new Set(),
    attributes: new Set(attributes),
    occasion: null,
    ...overrides,
  };
}

describe('canonicalizeOccasion', () => {
  it('maps an exact single-word occasion phrase', () => {
    expect(canonicalizeOccasion('eid')).toBe('festive-eid');
    expect(canonicalizeOccasion('wedding')).toBe('wedding-bridal');
    expect(canonicalizeOccasion('office')).toBe('office-formal');
  });

  it('is case-insensitive', () => {
    expect(canonicalizeOccasion('EID')).toBe('festive-eid');
  });

  it('matches an exact multi-word phrase in the alias table', () => {
    expect(canonicalizeOccasion('chand raat')).toBe('festive-eid');
  });

  it('falls back to matching any word in an unlisted multi-word phrase', () => {
    // "daily wear" isn't itself in the alias table, but "daily" is — unlike
    // color phrases, occasion phrases don't put the meaningful word in a
    // fixed position, so every word is checked, not just the last one.
    expect(canonicalizeOccasion('daily wear')).toBe('daily-casual');
    expect(canonicalizeOccasion('for the office')).toBe('office-formal');
  });

  it('drops an unrecognized occasion rather than guessing', () => {
    expect(canonicalizeOccasion('space travel')).toBeNull();
    expect(canonicalizeOccasion(null)).toBeNull();
    expect(canonicalizeOccasion(undefined)).toBeNull();
  });

  it('maps common Roman Urdu occasion words to the same buckets as their English equivalents', () => {
    expect(canonicalizeOccasion('daftar')).toBe('office-formal');
    expect(canonicalizeOccasion('sardi')).toBe('winter-wear');
    expect(canonicalizeOccasion('roz')).toBe('daily-casual');
    expect(canonicalizeOccasion('mehndi')).toBe('wedding-bridal');
  });
});

describe('canonicalizeForCatalog', () => {
  it('canonicalizes every field independently, including occasion', () => {
    const raw = { collection: 'casual', color: 'hara', occasion: 'shaadi', priceMax: 20000 };

    const intent = canonicalizeForCatalog(raw);

    expect(intent).toEqual({
      collection: 'casuals',
      fabric: null,
      color: 'GREEN',
      type: null,
      pieceCount: null,
      occasion: 'wedding-bridal',
      priceMax: 20000,
    });
  });

  it('returns an all-null intent for an empty input', () => {
    expect(canonicalizeForCatalog({})).toEqual({
      collection: null,
      fabric: null,
      color: null,
      type: null,
      pieceCount: null,
      occasion: null,
      priceMax: null,
    });
  });
});

describe('isEmptyCatalogIntent', () => {
  it('is true when nothing was recognized', () => {
    expect(isEmptyCatalogIntent(canonicalizeForCatalog({}))).toBe(true);
  });

  it('is false when only a non-occasion facet was recognized', () => {
    // The catalog now matches on any recognized facet, not just occasion —
    // a plain color/fabric/etc. request should still trigger a catalog
    // search rather than being treated as empty.
    expect(isEmptyCatalogIntent(canonicalizeForCatalog({ color: 'green' }))).toBe(false);
  });

  it('is false when only occasion was recognized', () => {
    expect(isEmptyCatalogIntent(canonicalizeForCatalog({ occasion: 'eid' }))).toBe(false);
  });

  it('is false when only priceMax was recognized', () => {
    expect(isEmptyCatalogIntent(canonicalizeForCatalog({ priceMax: 5000 }))).toBe(false);
  });
});

describe('matchesIntent', () => {
  it('matches a compound fabric attribute value against the bare canonical stem', () => {
    // Regression: real catalog fabric values are frequently compound
    // ("Chiffon Self", "Light Cotton", "Air Jet Lawn", "Lawn Karandi",
    // "Polyester Net") while canonicalizeFabric only ever produces the bare
    // stem ("chiffon", "cotton", "lawn", "net") — exact equality matched
    // almost none of the real data for these fabrics.
    const chiffonSelf = product(['Fabric:Chiffon Self']);
    const lightCotton = product(['Fabric:Light Cotton']);
    const airJetLawn = product(['Fabric:Air Jet Lawn']);
    const polyesterNet = product(['Fabric:Polyester Net']);

    expect(matchesIntent(chiffonSelf, { ...EMPTY_INTENT, fabric: 'chiffon' })).toBe(true);
    expect(matchesIntent(lightCotton, { ...EMPTY_INTENT, fabric: 'cotton' })).toBe(true);
    expect(matchesIntent(airJetLawn, { ...EMPTY_INTENT, fabric: 'lawn' })).toBe(true);
    expect(matchesIntent(polyesterNet, { ...EMPTY_INTENT, fabric: 'net' })).toBe(true);
  });

  it('matches "linen" against the compound "Viscose Linen" real value', () => {
    const viscoseLinen = product(['Fabric:Viscose Linen']);
    const plainLinen = product(['Fabric:LINEN']);

    expect(matchesIntent(viscoseLinen, { ...EMPTY_INTENT, fabric: 'linen' })).toBe(true);
    expect(matchesIntent(plainLinen, { ...EMPTY_INTENT, fabric: 'linen' })).toBe(true);
  });

  it('unifies "Print" and "Printed" real Type values under one canonical request', () => {
    const printed = product(['Type:Printed']);
    const print = product(['Type:Print']);
    const plain = product(['Type:PLAIN']);

    expect(matchesIntent(printed, { ...EMPTY_INTENT, type: 'Print' })).toBe(true);
    expect(matchesIntent(print, { ...EMPTY_INTENT, type: 'Print' })).toBe(true);
    expect(matchesIntent(plain, { ...EMPTY_INTENT, type: 'Print' })).toBe(false);
  });

  it('tolerates an untrimmed attribute value from the crawl', () => {
    const untrimmed = product(['Fabric:Chiffon ']);
    expect(matchesIntent(untrimmed, { ...EMPTY_INTENT, fabric: 'chiffon' })).toBe(true);
  });

  it('does not cross-match unrelated attribute values', () => {
    const plain = product(['Type:PLAIN']);
    expect(matchesIntent(plain, { ...EMPTY_INTENT, type: 'Embroidered' })).toBe(false);
  });

  describe('wedding-bridal occasion fallback', () => {
    // Bareeze's catalog has zero products actually classified wedding-bridal
    // (it's ready-to-wear, not a bridal couture house) — a strict equality
    // match here would return nothing for every "wedding"/"shaadi"/"baraat"
    // search. Almost everyone searching those terms is dressing as a GUEST,
    // whose real need is festive/dressy wear the catalog does stock.
    it('matches a wedding-bridal query against festive-eid and party-evening products too', () => {
      const eidSuit = product([], { occasion: 'festive-eid' });
      const eveningSuit = product([], { occasion: 'party-evening' });
      expect(matchesIntent(eidSuit, { ...EMPTY_INTENT, occasion: 'wedding-bridal' })).toBe(true);
      expect(matchesIntent(eveningSuit, { ...EMPTY_INTENT, occasion: 'wedding-bridal' })).toBe(true);
    });

    it('still excludes unrelated occasions from a wedding-bridal query', () => {
      const casual = product([], { occasion: 'daily-casual' });
      const winter = product([], { occasion: 'winter-wear' });
      expect(matchesIntent(casual, { ...EMPTY_INTENT, occasion: 'wedding-bridal' })).toBe(false);
      expect(matchesIntent(winter, { ...EMPTY_INTENT, occasion: 'wedding-bridal' })).toBe(false);
    });

    it('does not widen matching for any other occasion query', () => {
      const eidSuit = product([], { occasion: 'festive-eid' });
      expect(matchesIntent(eidSuit, { ...EMPTY_INTENT, occasion: 'party-evening' })).toBe(false);
    });
  });
});

describe('rankCatalog', () => {
  // The real gap this closes: a shopper who asks for a specific combination
  // (e.g. "yellow party wear", "3 piece for a wedding") that nothing in the
  // catalog satisfies exactly used to get a bare empty result — even when
  // products satisfying *most* of what they asked for exist. A real shop
  // assistant would show those instead of saying "we have nothing".

  it('returns only exact matches, unflagged, when at least one product satisfies every recognized facet', () => {
    const exactMatch = product(['Color:GREEN'], { slug: 'exact', occasion: 'festive-eid' });
    const partialMatch = product(['Color:BLUE'], { slug: 'partial', occasion: 'festive-eid' });

    const result = rankCatalog([exactMatch, partialMatch], { ...EMPTY_INTENT, color: 'GREEN', occasion: 'festive-eid' });

    expect(result.relaxed).toBe(false);
    expect(result.products.map((p) => p.slug)).toEqual(['exact']);
  });

  it('falls back to related products ranked by how many facets they match, when nothing matches everything', () => {
    const colorOnly = product(['Color:GREEN'], { slug: 'color-only', occasion: 'daily-casual' });
    const occasionOnly = product(['Color:BLUE'], { slug: 'occasion-only', occasion: 'festive-eid' });
    const neither = product(['Color:BLUE'], { slug: 'neither', occasion: 'daily-casual' });

    const result = rankCatalog(
      [colorOnly, occasionOnly, neither],
      { ...EMPTY_INTENT, color: 'GREEN', occasion: 'festive-eid' },
    );

    expect(result.relaxed).toBe(true);
    // "neither" matches nothing requested — not "related", excluded entirely.
    expect(result.products.map((p) => p.slug).sort()).toEqual(['color-only', 'occasion-only']);
  });

  it('ranks a product matching more of the requested facets ahead of one matching fewer', () => {
    const matchesTwo = product(['Color:GREEN', 'Type:Embroidered'], { slug: 'matches-two', occasion: 'daily-casual' });
    const matchesOne = product(['Color:GREEN'], { slug: 'matches-one', occasion: 'daily-casual' });

    const result = rankCatalog(
      [matchesOne, matchesTwo],
      { ...EMPTY_INTENT, color: 'GREEN', occasion: 'festive-eid', type: 'Embroidered' },
    );

    expect(result.relaxed).toBe(true);
    expect(result.products.map((p) => p.slug)).toEqual(['matches-two', 'matches-one']);
  });

  it('never relaxes price, even to complete an otherwise-exact combination', () => {
    const overBudgetButOtherwiseExact = product(['Color:GREEN'], {
      slug: 'over-budget', occasion: 'festive-eid', price: 'PKR 50,000',
    });
    const inBudgetPartialMatch = product(['Color:BLUE'], {
      slug: 'in-budget', occasion: 'festive-eid', price: 'PKR 4,000',
    });

    const result = rankCatalog(
      [overBudgetButOtherwiseExact, inBudgetPartialMatch],
      { ...EMPTY_INTENT, color: 'GREEN', occasion: 'festive-eid', priceMax: 5000 },
    );

    expect(result.relaxed).toBe(true);
    expect(result.products.map((p) => p.slug)).toEqual(['in-budget']);
  });

  it('relaxes piece count rather than dropping a product that matches everything else', () => {
    // Regression: found against the real catalog — "3 piece party wear"
    // against the 3-item party-evening bucket (none actually 3-piece) used
    // to return zero results even from the fallback, because piece count
    // was originally a hard, never-relaxed filter. A shopper asking for
    // that combination almost certainly wants the 2-piece option shown
    // instead of nothing.
    const twoPieceEvening = product(['Size:2-Pieces'], { slug: 'two-piece-evening', occasion: 'party-evening' });
    const threePieceCasual = product(['Size:3-Pieces'], { slug: 'three-piece-casual', occasion: 'daily-casual' });

    const result = rankCatalog(
      [twoPieceEvening, threePieceCasual],
      { ...EMPTY_INTENT, occasion: 'party-evening', pieceCount: '3-Pieces' },
    );

    expect(result.relaxed).toBe(true);
    // Both products match exactly one of the two requested facets (occasion
    // vs. piece count) — a tie, so both surface rather than either being
    // dropped for "only" partially matching.
    expect(result.products.map((p) => p.slug).sort()).toEqual(['three-piece-casual', 'two-piece-evening']);
  });

  it('returns hard-filtered results without ranking when no soft facet was recognized at all', () => {
    const cheap = product([], { slug: 'cheap', price: 'PKR 3,000' });
    const expensive = product([], { slug: 'expensive', price: 'PKR 9,000' });

    const result = rankCatalog([cheap, expensive], { ...EMPTY_INTENT, priceMax: 5000 });

    expect(result.relaxed).toBe(false);
    expect(result.products.map((p) => p.slug)).toEqual(['cheap']);
  });

  it('reports relaxed: false (not true) when even the fallback finds nothing related', () => {
    const unrelated = product(['Color:BLUE'], { slug: 'unrelated', occasion: 'daily-casual' });

    const result = rankCatalog([unrelated], { ...EMPTY_INTENT, color: 'GREEN', occasion: 'festive-eid' });

    expect(result.relaxed).toBe(false);
    expect(result.products).toEqual([]);
  });
});

function rawIntent(overrides: Partial<RawIntent> = {}): RawIntent {
  return {
    collection: null, fabric: null, color: null, type: null, pieceCount: null, occasion: null, priceMax: null,
    ...overrides,
  };
}

describe('dropNegatedFields', () => {
  // extractIntent has no idea a turn is a refinement — it can pick up a
  // mentioned word as the field's value even when the shopper is ruling it
  // out, not asking for it.
  it('drops a field whose own value is negated shortly before it in the utterance', () => {
    const intent = rawIntent({ color: 'blue' });
    expect(dropNegatedFields(intent, 'not blue please').raw.color).toBeNull();
    expect(dropNegatedFields(intent, 'no blue this time').raw.color).toBeNull();
    expect(dropNegatedFields(intent, "don't want blue").raw.color).toBeNull();
  });

  it('reports the negated field, not just nulling its value', () => {
    const intent = rawIntent({ color: 'blue' });
    const result = dropNegatedFields(intent, 'not blue please');
    expect(result.negatedFields.has('color')).toBe(true);
  });

  // Regression: found live — the real Groq model returned color: "not blue"
  // for the utterance "not blue, something else", folding the negation word
  // straight into the extracted value. There's no "before the value" text
  // to check in that case at all, so the value's own text has to be
  // checked directly, not just what precedes it.
  it('catches a negation word folded directly into the extracted value', () => {
    const intent = rawIntent({ color: 'not blue' });
    const result = dropNegatedFields(intent, 'not blue, something else');
    expect(result.raw.color).toBeNull();
    expect(result.negatedFields.has('color')).toBe(true);
  });

  it('keeps a field whose value is not negated', () => {
    const intent = rawIntent({ color: 'blue', occasion: 'eid' });
    const result = dropNegatedFields(intent, 'blue for eid please');
    expect(result.raw.color).toBe('blue');
    expect(result.raw.occasion).toBe('eid');
    expect(result.negatedFields.size).toBe(0);
  });

  it('only drops the specific field that was actually negated', () => {
    const intent = rawIntent({ color: 'blue', pieceCount: '3' });
    const result = dropNegatedFields(intent, 'not blue, 3 piece is fine');
    expect(result.raw.color).toBeNull();
    expect(result.raw.pieceCount).toBe('3');
    expect(result.negatedFields.has('pieceCount')).toBe(false);
  });

  it('leaves priceMax untouched (not a negatable string field)', () => {
    const intent = rawIntent({ priceMax: 5000 });
    expect(dropNegatedFields(intent, 'not 5000').raw.priceMax).toBe(5000);
  });
});

describe('mergeCatalogIntent', () => {
  it('uses the fresh intent as-is when there is no previous turn', () => {
    const fresh = { ...EMPTY_INTENT, color: 'GREEN' };
    const result = mergeCatalogIntent(null, fresh, 'green suit');
    expect(result.intent).toEqual(fresh);
    expect(result.priceRelaxRequested).toBe(false);
    expect(result.priceRelaxApplied).toBe(false);
  });

  it('inherits every previous facet the fresh turn did not recognize', () => {
    const previous = { ...EMPTY_INTENT, color: 'GREEN', occasion: 'festive-eid', priceMax: 10000 };
    const fresh = { ...EMPTY_INTENT }; // recognized nothing new
    const result = mergeCatalogIntent(previous, fresh, 'hmm');
    expect(result.intent).toEqual(previous);
  });

  it('overrides only the facet the fresh turn recognized — "green instead"', () => {
    const previous = { ...EMPTY_INTENT, color: 'BLUE', occasion: 'festive-eid', priceMax: 10000 };
    const fresh = { ...EMPTY_INTENT, color: 'GREEN' };
    const result = mergeCatalogIntent(previous, fresh, 'green instead');
    expect(result.intent).toEqual({ ...EMPTY_INTENT, color: 'GREEN', occasion: 'festive-eid', priceMax: 10000 });
  });

  it('lowers a previous price cap when the shopper asks for something cheaper', () => {
    const previous = { ...EMPTY_INTENT, priceMax: 10000 };
    const result = mergeCatalogIntent(previous, EMPTY_INTENT, 'do you have anything cheaper?');
    expect(result.priceRelaxRequested).toBe(true);
    expect(result.priceRelaxApplied).toBe(true);
    expect(result.intent.priceMax).toBe(7500);
  });

  it('recognizes Roman Urdu relative-price phrases too', () => {
    const previous = { ...EMPTY_INTENT, priceMax: 8000 };
    const result = mergeCatalogIntent(previous, EMPTY_INTENT, 'sasta dikhao');
    expect(result.priceRelaxApplied).toBe(true);
    expect(result.intent.priceMax).toBe(6000);
  });

  it('flags a relax request it could not act on, rather than silently doing nothing', () => {
    // No previous price cap exists — there's nothing to lower. The caller
    // (index.ts/popup.ts) uses priceRelaxRequested to say so honestly
    // instead of pretending the request was satisfied.
    const result = mergeCatalogIntent(null, EMPTY_INTENT, 'anything cheaper?');
    expect(result.priceRelaxRequested).toBe(true);
    expect(result.priceRelaxApplied).toBe(false);
    expect(result.intent.priceMax).toBeNull();
  });

  it('does not treat an explicit new price as a relax request, even if "cheaper" was also said', () => {
    const previous = { ...EMPTY_INTENT, priceMax: 10000 };
    const fresh = { ...EMPTY_INTENT, priceMax: 4000 };
    const result = mergeCatalogIntent(previous, fresh, 'something cheaper, under 4000');
    expect(result.priceRelaxRequested).toBe(false);
    expect(result.intent.priceMax).toBe(4000);
  });

  describe('negatedFields', () => {
    // Regression: found live end-to-end — "not blue" after a previous
    // color:"BLUE" search left the color chip showing "Blue" completely
    // unchanged. dropNegatedFields correctly nulled the fresh value, but
    // null-inherits-previous (the rule "green instead" relies on) then just
    // fell back to the OLD blue anyway — indistinguishable from the fresh
    // turn simply not mentioning color. negatedFields is what breaks that
    // false equivalence.
    it('clears a negated facet instead of inheriting the previous value for it', () => {
      const previous = { ...EMPTY_INTENT, color: 'BLUE', fabric: 'lawn', priceMax: 8000 };
      const result = mergeCatalogIntent(previous, EMPTY_INTENT, 'not blue, something else', new Set(['color']));
      expect(result.intent.color).toBeNull();
      // Everything else not negated still inherits normally.
      expect(result.intent.fabric).toBe('lawn');
      expect(result.intent.priceMax).toBe(8000);
    });

    it('lets an explicit new value in the same turn win over a negation of a different field', () => {
      const previous = { ...EMPTY_INTENT, color: 'BLUE', occasion: 'festive-eid' };
      const fresh = { ...EMPTY_INTENT, occasion: 'party-evening' };
      const result = mergeCatalogIntent(previous, fresh, 'not blue, something for a party instead', new Set(['color']));
      expect(result.intent.color).toBeNull();
      expect(result.intent.occasion).toBe('party-evening');
    });

    it('has no effect when nothing was negated (default empty set)', () => {
      const previous = { ...EMPTY_INTENT, color: 'BLUE' };
      const result = mergeCatalogIntent(previous, EMPTY_INTENT, 'hmm');
      expect(result.intent.color).toBe('BLUE');
    });
  });
});
