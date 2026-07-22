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

// Mirrors CatalogIntent in catalog.ts — the client's own record of the last
// resolved, canonical intent, sent back on the next turn so a follow-up like
// "cheaper" or "green instead" can be merged against it (see
// mergeCatalogIntent). Not the same shape as RawIntentSchema above: this is
// already-canonicalized (Bareeze's exact filter strings, or a real occasion
// slug), not loose natural language.
export const CatalogIntentSchema = z.object({
  collection: z.string().nullable(),
  fabric: z.string().nullable(),
  color: z.string().nullable(),
  type: z.string().nullable(),
  pieceCount: z.string().nullable(),
  occasion: z.string().nullable(),
  priceMax: z.number().nullable(),
});

export type CatalogIntentInput = z.infer<typeof CatalogIntentSchema>;
