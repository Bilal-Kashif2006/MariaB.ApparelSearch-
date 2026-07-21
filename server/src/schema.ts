import { z } from 'zod';

// Mirrors RawIntentFields in ../../src/shared/canonicalize.ts. Deliberately
// loose/generic (no Bareeze-specific enums) — the LLM returns natural-
// language values in the shopper's own words, and the extension's own
// canonicalize.ts (already built, tested against Bareeze's real filter
// vocabulary) is solely responsible for mapping that to Bareeze's exact
// filter strings. Keeping Bareeze's vocabulary out of the server means it
// never needs updating here if Bareeze's own filter options change.
export const RawIntentSchema = z.object({
  collection: z.string().nullable().optional(),
  fabric: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  pieceCount: z.string().nullable().optional(),
  // The event/context the shopper is dressing for (e.g. "wedding", "eid",
  // "office"), in their own words. Bareeze's own filter UI has no occasion
  // facet — this only ever drives the local catalog match in catalog.ts, and
  // is never sent to Bareeze as an attribute_value.
  occasion: z.string().nullable().optional(),
  priceMax: z.number().nullable().optional(),
});

export type RawIntent = z.infer<typeof RawIntentSchema>;
