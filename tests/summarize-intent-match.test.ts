import { describe, expect, it } from 'vitest';
import { summarizeIntentMatch } from '../src/shared/summarize-intent-match';

describe('summarizeIntentMatch', () => {
  it('lists every matched facet as applied, in a human-readable form', () => {
    // Arrange
    const raw = { collection: 'casual', color: 'green', pieceCount: '2 piece', priceMax: 5000 };
    const intent = {
      collection: 'casuals',
      fabric: null,
      color: 'Green',
      type: null,
      pieceCount: '2-Pieces',
      priceMax: 5000,
    };

    // Act
    const summary = summarizeIntentMatch(raw, intent);

    // Assert
    expect(summary.applied).toEqual(['casuals', 'Green', '2-Pieces', 'under Rs 5,000']);
    expect(summary.unmatched).toEqual([]);
  });

  it('lists a raw value as unmatched when canonicalization dropped it', () => {
    // Arrange — "floral" is a print pattern, not one of Bareeze's real color values
    const raw = { color: 'floral', fabric: 'lawn' };
    const intent = { collection: null, fabric: 'lawn', color: null, type: null, pieceCount: null, priceMax: null };

    // Act
    const summary = summarizeIntentMatch(raw, intent);

    // Assert
    expect(summary.applied).toEqual(['lawn']);
    expect(summary.unmatched).toEqual(['floral']);
  });

  it('does not claim fabric was applied when collection supersedes it in the URL', () => {
    // Regression test: intentToBareezeUrl uses collection as the base path
    // and never applies fabric at all when both are named (there's no
    // combined "/casuals/fabric/lawn" URL on Bareeze) — the summary must
    // mirror that precedence exactly, or it tells the shopper a filter was
    // used that the actual results don't reflect.
    const raw = { collection: 'casual', fabric: 'lawn', color: 'green' };
    const intent = {
      collection: 'casuals',
      fabric: 'lawn', // recognized, but superseded — collection won the base-path slot
      color: 'Green',
      type: null,
      pieceCount: null,
      priceMax: null,
    };

    const summary = summarizeIntentMatch(raw, intent);

    expect(summary.applied).toEqual(['casuals', 'Green']);
    expect(summary.unmatched).toEqual(['lawn']);
  });

  it('returns empty arrays when nothing was said and nothing matched', () => {
    // Arrange & Act
    const summary = summarizeIntentMatch({}, {
      collection: null,
      fabric: null,
      color: null,
      type: null,
      pieceCount: null,
      priceMax: null,
    });

    // Assert
    expect(summary).toEqual({ applied: [], unmatched: [] });
  });

  it('does not report an unmatched priceMax that was simply never mentioned', () => {
    // A null/undefined raw.priceMax means "not stated", not "stated but unmatched".
    const summary = summarizeIntentMatch(
      { color: 'green' },
      { collection: null, fabric: null, color: 'Green', type: null, pieceCount: null, priceMax: null },
    );
    expect(summary.unmatched).toEqual([]);
  });
});
