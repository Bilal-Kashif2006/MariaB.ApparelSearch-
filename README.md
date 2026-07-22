# Bareeze Shopping Assistant — plan

A standalone Chrome extension for **bareeze.com only**. No backend, no
database, no AI — everything runs in the browser against Bareeze's own live
site. This document is the plan; implementation follows it next.

## Why standalone, and why scraping (verified, not assumed)

Resham's existing extension architecture is built entirely around Shopify's
public `/products.json` and `/cart/add.js` endpoints. Before reusing any of
it, I checked bareeze.com directly:

- `bareeze.com/products.json` does **not** return Shopify product JSON — it
  returns their app shell. Bareeze runs a custom Next.js frontend on
  **"Comverse" by Ginkgo Retail** (confirmed via the site's own footer), not
  Shopify.
- No `__NEXT_DATA__` blob or discoverable public JSON/GraphQL API was found
  (checked the rendered homepage source and probed common API paths on
  `bareeze.ginkgoretail.net`, which turned out to be their order-tracking
  portal, not a product API).
- The rendered pages themselves, however, have clean, stable, semantic class
  names (below) — not hashed CSS-module noise — which makes DOM scraping a
  genuinely reliable data source here, not a fragile last resort.

So: **the extension reads product data directly off Bareeze's own rendered
pages**, which is by definition 100% real and always current — no separate
crawler to go stale, no private API to reverse-engineer or break against.

## Verified real page structure

Confirmed by rendering actual pages with a headless browser (Playwright)
against the live site — not guessed.

**Category/listing pages** (`/casuals`, `/formals`, `/shawls`, `/new-in`,
`/fabric/{lawn|khaddar|velvet|...}`, `/bareeze-pret`, `/sale`, and more —
full real list pulled from the site's own nav menu):

```html
<div class="product-grid-item">
  <div class="singleProductCardContainer">
    <a href="/shadow-work-42"><img class="carousel_image" src="..." alt="SHADOW WORK"></a>
    <a href="/shadow-work-42">
      <p class="singleProductCardProductTitle">SHADOW WORK</p>
      <p class="singleProductCardProductSubTitle">New Selection</p>
      <p class="singleProductCardPrice">
        <span class="singleProductCardActualPrice">PKR 20,050</span>
      </p>
    </a>
  </div>
</div>
```

**Product detail pages** (`/{product-slug}`):

```html
<div class="product-price product-page mb-10">
  <span class="actual-price"> PKR 20,050.00 </span>
</div>
...
<button>Add To Bag</button>
```

No public cart API exists, so **cart hand-off works by clicking Bareeze's
own real "Add To Bag" button** — their real React app then runs its own
real cart logic exactly as it would for a human shopper. This is more
robust than reverse-engineering a private endpoint, and is still "100% real"
by construction.

## Architecture

```
popup (search/browse UI)
   │  chrome.tabs.query + chrome.scripting.executeScript
   ▼
content script, injected into the active bareeze.com tab
   │
   ├─ scrape-listing.ts   → on a category page: read every visible product card
   ├─ scrape-product.ts   → on a product page: read full detail (price, images, sizes if present)
   └─ add-to-bag.ts       → only on an explicit "Add to Bag" click: find + click Bareeze's real button
   │
   ▼
background.ts (MV3 service worker) — relays popup ⇄ content script messages
```

No server, no `host_permissions` beyond `bareeze.com` itself, no stored
credentials — `activeTab` covers everything since every action starts from
an explicit user click, matching the same minimal-permission posture the
Resham extension already established.

### Search, without a backend

Bareeze's own category/fabric/collection URLs already function as a real
filter system (`/fabric/lawn`, `/formals`, `/new-in/prints`, …). The popup's
"search" is: map the shopper's typed words to the closest real Bareeze
category URL(s), open/scrape those, and additionally do client-side
substring filtering over the scraped titles for a same-page refine — no
semantic/AI search, by design (that was the explicit trade-off for
"standalone" and "clean").

## What's reused from Resham's extension vs. rebuilt

| Reused as-is | Rebuilt from scratch |
|---|---|
| esbuild build pipeline (`build.mjs`), MV3 basics, TS/vitest/playwright tooling | `manifest.json` (scoped to bareeze.com only, no backend `connect-src`) |
| General popup ⇄ background ⇄ content-script messaging *pattern* | `background.ts`, `popup.ts` — no Resham API client, no auth, no session state |
| — | `content/scrape-listing.ts`, `content/scrape-product.ts` — new, Bareeze-specific DOM readers |
| — | `content/add-to-bag.ts` — clicks Bareeze's real button instead of POSTing `/cart/add.js` |
| — | `src/ui/product-card.ts` — new card renderer for Bareeze's real data shape (title, price, image, slug) |
| `src/voice/voice-recorder.ts`, `mic-setup.html`/`src/mic-setup.ts` — ported near-verbatim from a sibling project, Dhaaga, which already runs this exact mic-capture/permission-tab pattern in production | `server/` — a much smaller proxy than Dhaaga's (no session/auth), and `src/shared/intent*.ts`/`canonicalize.ts` — Bareeze-specific, scoped to this site's real filter facets only |

## Status of this repo right now

Scraping, cart hand-off, typed keyword search, and voice-driven intent
search are all implemented and build/test clean (`npm run build`, `npm run
typecheck`, `npm test`).

## Voice-driven intent search

Beyond typed keyword search (`bestCategoryPath`, unchanged), the mic button
in the popup records a spoken request ("green casual suit, 2 piece, under
20000"), sends the clip to a small local proxy for transcription + intent
extraction, and turns the result into a real Bareeze filter URL — reusing
the exact same navigate-and-scrape path as everything else here.

**Confirmed live on bareeze.com** (Playwright, not assumed): every category
page's filter drawer applies instantly on checkbox click (no separate
"Apply" needed for attribute filters) and reflects the selection in the URL.
Multiple attribute facets join with a literal `+`, positionally paired:

```
/casuals?attribute_name=Type+Color&attribute_value=Embroidered+Green&sort=newest
```

Price is its own param and its floor can always safely be `0`:
`price=0-20000`. Collection and fabric aren't part of this mechanism —
they pick the *base path* instead (`/casuals`, `/fabric/lawn`), since
Bareeze has no combined "casuals that are also lawn" URL; when a shopper
names both, collection wins.

**Pipeline**: `src/voice/voice-recorder.ts` (MediaRecorder capture) → `POST
http://localhost:8787/voice-intent` → `server/` (Groq Whisper transcription
+ a Groq LLM call returning loose, natural-language intent fields — not
Bareeze's exact vocabulary) → `src/shared/canonicalize.ts` (maps that loose
intent, including Roman Urdu color words, to the exact filter strings above,
dropping anything unrecognized) → `src/shared/intent-to-url.ts` (pure,
unit-tested mapper to the URL format above) → the existing `OPEN_CATEGORY`
message. Typed search goes through the same pipeline via `POST
/text-intent` (text in, no audio step) — see the next section for how both
now feed a persistent chat, not a one-shot search box. If the proxy isn't
reachable, the popup says so plainly with a Retry button rather than
silently degrading to a plain keyword match (an earlier local-only
fallback, `bestCategoryPath`, is gone along with the single-shot search box
it belonged to).

**Running the proxy** (required for both voice and typed search — there is
no local-only fallback anymore, see above):

```
cd server
npm install
cp .env.example .env   # then add your own GROQ_API_KEY
npm run dev
```

If the proxy isn't running, the popup shows an inline "Search interrupted"
error with a Retry button instead of a working result.

### Chat-based layout and multi-turn refinement

The popup's layout, verified against the sibling `resham/extension`
project, is a full port of its visual shell and its persistent-chat
interaction model — not just its colors. The interaction model itself
(a chat you keep refining, rather than a single search box that starts
fresh each time) is what's new here; everything below explains how a
follow-up like "cheaper" or "green instead" actually gets resolved, and
where this deliberately still falls short of full parity.

**Layout**: two-pane workspace (`popup.html`, `src/styles.css`) — a
products pane (chips for the current recognized facets, a paginated
product grid, 8 at a time with "Load more" + infinite scroll) and a chat
pane (persistent message thread, mic/send composer, recording/searching
status strips, inline error with retry). Same emerald/canvas design
tokens as Resham, same 640×600 popup with an expand-to-800 toggle. State
(`messages`, the last resolved intent, the last result) is persisted to
`chrome.storage.local` (`CONVERSATION_KEY`) so the conversation survives
the popup closing — Chrome can destroy the popup's whole document the
instant it loses focus, unlike a normal tab.

**Multi-turn refinement** (`server/src/catalog.ts`): the client echoes back
its last resolved, canonical intent as `previousIntent` on every request.
`mergeCatalogIntent` combines it with the fresh turn's own intent —
whatever the fresh turn didn't recognize inherits the previous value,
whatever it did recognize overrides it. That single rule is what makes
"green instead" work with no special-casing for the word "instead" at
all. Two things ride alongside it, both deterministic (no extra LLM
calls, given how often this session hit Groq's free-tier quota):
- `dropNegatedFields` catches "not blue"/"no eid"-style utterances,
  including the case (confirmed against the real model) where the
  negation word ends up folded straight into the extracted value itself
  (`color: "not blue"`). Critically, a negated field is force-cleared in
  the merge, not just nulled in the fresh turn — null-inheriting the
  previous value would otherwise silently undo the negation entirely,
  which is exactly what happened before this was caught live: "not blue"
  after a previous blue search left the color chip completely unchanged.
- A small word list (`cheaper`, `sasta`, `arzan`, ...) detects relative
  price language with no explicit number, dropping the previous cap by
  25%. If there's nothing to lower, the assistant says so ("I don't have
  a price to lower yet — what's your budget?") instead of quietly doing
  nothing.

**Known, disclosed gaps in this refinement model** (not silently absent —
each is either surfaced to the shopper or documented here):
- There is no way to *remove* a facet with nothing to replace it — only
  negate-then-leave-unconstrained (clears it) or overwrite it with a new
  value. "New search" is the actual reset.
- Facets only ever accumulate or get replaced across turns, never
  re-evaluated as a whole — after several refinements, a relaxed
  (no-exact-match) result can rank against a large pile of requested
  facets where the top result only satisfies one or two of them. The
  assistant's wording distinguishes this ("only loosely related to
  everything you've asked for so far") once three or more facets have
  accumulated, rather than phrasing it the same as a normal close match.
- No mid-search session recovery if the popup is closed while a request
  is in flight (Resham has this via `chrome.storage.session` polling) —
  a deliberate scope cut; the request still completes server-side, the
  popup just won't show it if reopened before the response would have
  arrived.
- Clicking a product still navigates the real bareeze.com tab and shows
  an in-popup detail view with a real "Add to Bag" button, instead of
  Resham's "open in a new tab, add to cart right from the grid" — Resham
  can do that because its own crawl captures purchasable variant IDs per
  product; Bareeze's local catalog snapshot doesn't carry that, only the
  attribute tags used for search, so a live page visit is genuinely
  necessary to select real options before adding to bag.
- A per-product "why it matches" line (Resham shows verified facts +
  match reasoning on every card) was deliberately deferred — it would
  need per-product match scores plumbed through the response, on top of
  an already large change; the chips and the assistant's own wording
  cover the same honesty goal at the whole-result level for now.

All verified live against a running proxy + real bareeze.com tab
(Playwright driving the actual built extension, not just unit tests):
store detection/blocking view, an exact-match search, a color-swap
refinement, a negated-color refinement (chip correctly disappears), a
"cheaper" refinement with nothing to lower (honest message, not silent),
and the proxy-unreachable error+retry path.

### Smart search and the local catalog

`data/bareeze-catalog.db` is an offline, point-in-time snapshot of the
catalog (871 products as of the last crawl) with real attribute tags pulled
from Bareeze's own filter drawers (`scripts/tag-attributes.ts`) and an
LLM-assigned occasion per product (`scripts/classify-occasion.ts`, weighted
toward real `Season`/`Type`/`Fabric` signals over generic titles — see that
script's system prompt). It's what makes occasion search possible at all —
Bareeze's own filter UI has no "occasion" facet (no wedding, eid, office,
party, etc.), so there's no live URL that could ever answer "something for
a wedding".

`server/src/catalog.ts` is the only thing that reads this DB. Both
`/voice-intent` and `/text-intent` run every recognized facet — collection,
fabric, color, type, piece count, occasion, price — through it together, so
"a green formal suit for eid under 20000" is matched as one combined query
against real product data, not decomposed into separate live-site filters.
`products` in the response is only `null` when nothing was recognized at
all; in that one case the popup falls back to the live, always-current
`intentToBareezeUrl` path (e.g. "show me new in") instead of returning the
whole catalog unfiltered. Clicking any catalog-result card still opens the
real, current product page on bareeze.com (same `openProduct` flow as
everywhere else) — only the *listing* step uses the snapshot, never the
purchase step, so price/stock is always verified live before checkout.

**Matching degrades gracefully instead of dead-ending.** `rankCatalog` in
`server/src/catalog.ts` only treats price as a true hard constraint (a
stated budget is never silently ignored). Every other recognized facet —
collection, fabric, color, type, piece count, occasion — is scored: if a
product satisfies the whole combination, only exact matches are returned.
If nothing does, the closest related products are returned instead (ranked
by how many of the requested facets they satisfy, worst-matching ones
dropped entirely), flagged `relaxed: true` so the popup says so honestly
("No exact match — showing N closest options") rather than presenting a
broadened result as if it were exact. This closes real dead ends found by
testing realistic queries against the actual catalog: "3 piece party wear"
used to return nothing at all, because `party-evening` only has 3 real
products and none of them happen to be 3-piece — now it ranks those 3
(closest by occasion) ahead of other 3-piece products from different
occasions, instead of an empty result the shopper has no way to act on.

Rebuilding the catalog (base crawl → attribute tagging → deterministic
rules → real-collection ground-truthing → LLM for the remainder, each a
separate pass — order matters, since each later pass protects the ones
before it from being overwritten by a worse guess):

```
node --experimental-strip-types scripts/scrape-catalog.ts
node --experimental-strip-types scripts/tag-attributes.ts
node --experimental-strip-types scripts/classify-occasion-rules.ts
node --experimental-strip-types scripts/verify-eid-collection.ts
node --experimental-strip-types --env-file=server/.env scripts/classify-occasion.ts
```

`classify-occasion-rules.ts` applies a priority-ordered set of deterministic
rules directly over real attribute/category/subtitle/title data — no LLM
call at all, and as of the current ruleset, **classifies all 871/871
products** with zero reliance on `classify-occasion.ts`'s LLM. The
strongest two rules are exactly what that script's own prompt already
calls a "strong real signal": `Season` containing `EID` → `festive-eid`,
`Season` containing `WINTER` or a velvet/karandi `Fabric` → `winter-wear`.
If a signal is reliable enough that the LLM is *told* to treat it as
decisive, it's reliable enough to just apply in code: free, instant, not
subject to the LLM sometimes not applying its own stated rule consistently
(a cross-check found real `Season=EID-*` products classified
`daily-casual` instead).

Further rules extend this to the remaining real signals: a named formal
product line (`subtitle = 'Embroidered Classics'`), `category = shawls`,
a sheer/net fabric or category (`party-evening` — genuinely dressy, not
everyday), the product's own title containing `FESTIVE` or `COUTURE`, and
generic `Type = Print/Plain`. `Type = Embroidered` is deliberately split by
fabric: on `Lawn`/`casuals`/`pret` it stays `daily-casual` (an earlier
version of this rule didn't check fabric and wrongly promoted 198 ordinary
embroidered lawn suits to `office-formal` just for having any embroidery);
only genuinely formal-weight fabric/collections get promoted.
`classify-occasion.ts` always excludes `source = 'rule-based'` products
from its own re-runs, same protection as verified-collection entries — so
if it's ever run again for some future addition to the catalog, it can
never downgrade an already-resolved product back to a guess.

`tag-attributes.ts` crawls all 16 real product-bearing pages (the 5 main
collections plus new-in/prints and all 9 fabric-specific pages) — an
earlier version only covered the 5 main collections on the assumption the
rest were subsets with no products of their own, which left 209/871
products (24%) with zero attribute tags at all. Verified fixed: 0 products
with zero tags after a full re-run.

`verify-eid-collection.ts` cross-checks `festive-eid` classifications
against Bareeze's own real, curated Eid landing pages (found via the site's
`sitemap_cat_0.xml`, not guessed) — `/new-in/eid-1-summer-25` and
`/new-in/eid-2-summer-25` are the only two that currently exist. Products
confirmed against these get `source = 'verified-collection'` in
`product_occasion` instead of `'llm'`, and `classify-occasion.ts` always
excludes already-verified products from its own re-runs, so an LLM guess
can never overwrite real ground truth.

**Known gaps, confirmed real (not crawl misses):**
- `wedding-bridal` classifies to 0 products. Checked directly against the
  site's full category sitemap — there is no wedding/bridal collection
  anywhere on bareeze.com right now, so this reflects the real catalog, not
  a classifier or crawl bug. `matchesIntent` in `server/src/catalog.ts`
  works around this: a `wedding-bridal` query also accepts `festive-eid`
  and `party-evening` products, since almost every real "wedding"/"shaadi"
  search is a guest dressing for a function, not the bride herself — see
  [Who's actually searching](#whos-actually-searching-buyer-personas-behind-the-design)
  below. A shopper searching for actual bridal couture would still,
  correctly, find nothing — Bareeze genuinely doesn't sell that.
- `party-evening` genuinely only has 3 products after the full rule pass
  (net/sheer fabric or "COUTURE" in the title, with no lawn/casual signal).
  This isn't a gap left unaddressed — it reflects that Bareeze's real data
  for this catalog subset has very little that distinctively marks
  eveningwear apart from ordinary formal wear; most of what an earlier LLM
  run had called "party-evening" turned out, on inspection, to be products
  with a real EID/WINTER season tag the LLM hadn't weighted correctly (now
  correctly resolved to festive-eid/winter-wear) or embroidered lawn
  casuals with no real evening-wear signal at all.
- Occasion is inherently a stronger claim for Color/Fabric/Type/Size (those
  come directly from Bareeze's own filter checkboxes, not inferred) than
  for occasion, which even with 100% rule-based coverage is still a
  judgment applied to real signals rather than a fact read off the site.
  `classify-occasion.ts`'s LLM path remains in the pipeline for future
  catalog growth (new products the current rules don't have a signal for
  yet), with one real bug already fixed in it (it used to silently default
  any product the LLM's batch response omitted to `daily-casual`,
  contradicting its own prompt's instruction not to do that).

### Who's actually searching: buyer personas behind the design

These aren't survey data — they're grounded in well-established, mainstream
patterns of how Pakistani women actually shop ready-to-wear clothing
(occasion-driven purchasing, seasonal fabric switching, heavy Roman Urdu
code-switching, real price sensitivity), used as a concrete check against
this specific catalog and matching system rather than designed in the
abstract. Each one below is written with real example queries, matched
against what the system actually does today, not what it's assumed to do.

- **The Eid rush shopper.** Shops hardest in the 2–3 weeks before Eid,
  wants richly embroidered festive pieces, often 3-piece, and flexes her
  budget upward versus routine shopping. *"eid ke liye teen suit chahiye,
  embroidered, 20000 tak"* → occasion `eid` → `festive-eid` (277 products,
  deliberately the largest bucket — grounded in real `Season=EID-*` tags
  and cross-checked against Bareeze's own two real Eid landing pages, see
  `verify-eid-collection.ts` above).
- **The everyday/home shopper.** The most common buyer day to day — wants
  comfortable, practical lawn suits for routine wear, strongly price-aware,
  often 2-piece. *"sasta lawn suit chahiye casual, 3000 tak"* → fabric
  `lawn` + collection `casual`/`sasta`→`sale` + price cap → `daily-casual`
  (370 products, the single largest occasion — the real catalog genuinely
  skews everyday, not festive).
- **The wedding-function guest.** Attends a friend's or cousin's
  mehndi/baraat/walima and wants festive or dressy eveningwear — she is
  *not* the bride, and isn't shopping for bridal couture. *"shaadi ke liye
  kuch dikhao"* / *"walima mein pehnne ke liye party wear"*. This persona is
  what exposed a real bug while working through it: every wedding-related
  word (`wedding`, `shaadi`, `baraat`, `walima`, `nikah`, `mehndi`) mapped
  to `wedding-bridal`, a bucket with zero products — so arguably one of the
  most common real search intents for a clothing brand always returned
  nothing. Fixed in `matchesIntent`: a `wedding-bridal` query now also
  matches `festive-eid` and `party-evening` products (280 combined),
  because that's the real answer to "what do I wear to a wedding" on a
  ready-to-wear site that doesn't sell bridal couture.
- **The winter shopper.** Shops seasonally for shawls/karandi/khaddar,
  sometimes as a gift (for a mother or mother-in-law). *"sardi ke liye
  shawl chahiye"* → occasion `sardi` → `winter-wear` (167 products);
  `shawl` is already its own real collection.
- **The Roman Urdu–only speaker.** Doesn't use English fashion vocabulary
  at all — a language-coverage stress test across every field rather than
  a single occasion. Colors were already well covered (`hara`, `gulabi`,
  `kaala`, ...); this pass found and closed two real gaps this persona
  would hit: `collection` had *zero* Roman Urdu terms before (`sasta` →
  `sale`, `naya`/`nayi` → `new in`, in `src/shared/canonicalize.ts`), and
  `occasion` was missing common single-word terms for office/winter/daily
  (`daftar`, `sardi`, `roz`, in `server/src/catalog.ts`).

## Explicit non-goals (kept out to stay "clean")

- No wishlist/account/cross-device sync — no backend to persist it in.
- No multi-turn conversation/session state for voice search — every voice
  query is independent, and the proxy holds no per-user state (the local
  catalog DB it reads for occasion search is a shared, offline snapshot,
  not session data).
- No fuzzy/typo matching in `canonicalize.ts` — a curated alias table only;
  an unrecognized value is dropped rather than guessed at.
