 How Search Works Now

  AI judgement is used in exactly one place: the planner /
  intent extractor in server/src/intent.ts:56. A model
  decides:

  - whether the turn is search, clarify, or unsupported
  - whether it is a fresh search or a refinement
  - which raw facets to extract: collection, fabric, color,
    type, pieceCount, occasion, priceMax

  That part is probabilistic. It depends on prompt-following
  and language understanding, not rules.

  Everything after that is deterministic.

  The deterministic stages are:

  - Canonicalization in src/shared/canonicalize.ts:4 and
    server/src/catalog.ts:121

  - Negation handling like not blue in server/src/
    catalog.ts:152

  - Refinement merging like green instead / cheaper in server/
    src/catalog.ts:185

  - Catalog loading and attribute extraction in server/src/
    catalog.ts:251

  - Matching and ranking in server/src/catalog.ts:489
  - User-facing fallback copy in src/popup.ts:438

  The deterministic matcher uses:

  - alias tables
  - word fallback
  - regex
  - substring checks
  - exact set membership
  - facet counts
  - a hand-built commerce score

  It does not use embeddings, vector similarity, semantic
  reranking, BM25, cosine similarity, or any learned relevance
  score.

  Where Deterministic Logic Is Strong

  - Colors: alias map plus tail-word fallback. plain white
    dress still canonicalizes to White because the color
    matcher checks the last word or last two words in src/
    shared/canonicalize.ts:112.

  - Collections: words like pret, formal, stitched, unstitched
    are mapped by lookup tables in src/shared/
    canonicalize.ts:42.

  - Occasion: shaadi, mehndi, office, eid are mapped by alias
    table plus regex fallback in server/src/catalog.ts:23.

  - Matching: each recognized facet contributes 1 point. Exact
    matches require matching every soft facet; otherwise
    fallback ranking shows partial matches in descending
    facet-count order in server/src/catalog.ts:541.

  Why Your Example Fails

  Your diagnosis is basically correct: the current system is
  only partly synonym-aware.

  For white 3 piece, the system has a good path:

  - white canonicalizes cleanly
  - 3 piece canonicalizes cleanly
  - the catalog really contains many 3 Piece products and many
    white/off-white items

  - fallback ranking can still show partial matches if nothing
    is exact

  For white shalwar kameez, the system is much weaker:

  - there is no canonical alias for shalwar kameez
  - there is no dedicated garment-shape facet for shalwar,
    kameez, kurta, gharara, lehenga, etc.

  - if the LLM extracts shalwar kameez into type or
    collection, canonicalization likely drops it

  - once dropped, the search may collapse to just color =
    White

  - then ranking returns any white item or white-adjacent
    partials, which feels irrelevant

  I verified this against the active DB:

  - Luxury Pret appears heavily in the real category field:
    1050 products

  - white exact color exists: 193 products
  - off white exists even more: 417 products
  - shalwar appears in descriptions: 519 products
  - kameez appears far less: 23 products
  - suit appears in titles a lot: 4849 products

  So the raw catalog vocabulary already shows the problem: the
  matcher understands color and piece count well, but shopper
  garment terms like shalwar kameez are not normalized into a
  search facet today.

  A second issue: the current “not relevant” detection is
  weak. If there is no exact match, the system simply returns
  any product with softMatchScore > 0 and labels it “close” or
  “loosely related” in server/src/catalog.ts:600 and src/
  popup.ts:456. It does not currently decide “this result set
  is low-confidence enough that I should clarify instead.”

  A third issue: unmatched terms are surfaced, but only
  passively. The popup can say Couldn't match: ... via src/
  shared/summarize-intent-match.ts:20 and src/popup.ts:467,
  but it does not turn that into a guided salesperson-style
  question.

  # Plan

  Audit the current planner-to-catalog path, then tighten the
  system around a controlled terminology layer and a relevance
  gate. The goal is to stop treating dropped or weakly-mapped
  shopper language as permission to show broad “close enough”
  products, and instead turn those cases into guided
  clarification.

  ## Scope

  - In:
  - Add a terminology/intent normalization layer for shopper
    language like shalwar kameez, stitched, pret, plain white,
    basic white, solid white, 2 piece, 3 piece

  - Add deterministic low-relevance detection after ranking
  - Add salesperson-style clarification prompts when
    terminology is ambiguous or dropped

  - Add evaluation cases for the exact problem phrases you
    raised

  - Out:
  - No embedding search
  - No code changes in this pass
  - No redesign of the whole UI or search architecture
  - No blind LLM-only fix without deterministic safeguards

  ## Action items

  [ ] Map the full current search flow from planner output to
  canonical intent, catalog matching, fallback ranking, and
  popup reply behavior.
  [ ] Build a terminology matrix from real catalog vocabulary
  and shopper vocabulary, especially for pret, stitched,
  shalwar kameez, suit, white, off white, 2 piece, and 3
  piece.
  [ ] Introduce a deterministic synonym layer that can map
  shopper garment phrases into the existing facets or a new
  controlled facet where needed.
  [ ] Add ambiguity rules for phrases that imply multiple
  valid product shapes, so queries like white shalwar kameez
  trigger clarification such as 2 piece or 3 piece? instead of
  broad white-product fallback.
  [ ] Add a relevance gate after ranking that checks how many
  requested facets survived canonicalization, how many matched
  exactly, and whether the returned set is only color-only or
  otherwise too weak.
  [ ] Change the assistant response policy so low-confidence
  or partially-dropped queries produce guided rephrasing
  suggestions instead of only Couldn't match: ....
  [ ] Add explicit evaluation scenarios for white shalwar
  kameez, white 3 piece, plain white, solid white, basic
  white, stitched suits, and refinement turns built on those
  phrases.
  [ ] Verify that the clarification path still preserves
  conversational refinement behavior like green instead,
  cheaper, and negations.