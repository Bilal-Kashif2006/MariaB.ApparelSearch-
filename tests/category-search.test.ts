import { describe, expect, it } from 'vitest';
import { bestCategoryPath } from '../src/shared/category-search';

describe('bestCategoryPath', () => {
  it('maps a plain category word to its real Bareeze URL', () => {
    expect(bestCategoryPath('formals')).toBe('/formals');
    expect(bestCategoryPath('shawls please')).toBe('/shawls');
  });

  it('maps a fabric word to its real fabric URL', () => {
    expect(bestCategoryPath('something in lawn')).toBe('/fabric/lawn');
  });

  it('prefers the longest matching key over a shorter incidental one', () => {
    // "new in" (6 chars) should win over the shorter "lawn" (4 chars) match
    // in the same query.
    expect(bestCategoryPath('new in lawn')).toBe('/new-in');
  });

  it('returns null for an empty or unmatched query', () => {
    expect(bestCategoryPath('')).toBeNull();
    expect(bestCategoryPath('   ')).toBeNull();
    expect(bestCategoryPath('something totally unrelated')).toBeNull();
  });
});
