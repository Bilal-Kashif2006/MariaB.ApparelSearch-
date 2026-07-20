import { CATEGORY_PATHS } from './contracts';

// Bareeze's own real category/fabric URLs act as the whole filter system
// (see contracts.ts) — this maps a shopper's typed words to the closest
// one. Longest matching key wins so a query like "printed lawn" prefers
// the more specific "lawn" over a shorter incidental match.
export function bestCategoryPath(query: string): string | null {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  let best: { key: string; path: string } | null = null;
  for (const [key, path] of Object.entries(CATEGORY_PATHS)) {
    if (normalized.includes(key) && (!best || key.length > best.key.length)) {
      best = { key, path };
    }
  }
  return best?.path ?? null;
}
