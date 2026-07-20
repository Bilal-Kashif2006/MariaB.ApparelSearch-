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

## Status of this repo right now

Scaffold only — confirmed to build clean (`npm run build`, `npm run
typecheck` both pass) with stub content scripts. Nothing scrapes or clicks
anything yet.

## Build order (next steps)

1. `src/shared/contracts.ts` — the real data shape: `{ slug, title, subtitle,
   price, imageUrl }` for a listing card; add `description`/`sizes` for the
   detail page.
2. `content/scrape-listing.ts` — implement against the confirmed selectors
   above; test live against `/casuals`, `/formals`, `/shawls`, `/sale`.
3. `content/scrape-product.ts` — same, for a detail page; confirm whether
   stitched-suit products expose a real size/color selector (the one
   product checked so far had none — single-size item) before designing
   that part of the UI.
4. `background.ts` + `popup.ts` + `src/ui/` — inject the right content
   script for the current tab's URL shape, render results, wire the search
   box to real category URLs.
5. `content/add-to-bag.ts` — click-simulate the real "Add To Bag" button;
   verify a clicked item genuinely lands in Bareeze's own cart (check their
   `/cart`-equivalent page after).
6. Tests: vitest unit tests for the card renderer/URL-mapping logic;
   Playwright e2e against the *live* bareeze.com (matching this session's
   own "verify against live data, not assumptions" approach) for the
   scrapers, since their DOM is the actual contract being depended on.

## Explicit non-goals (kept out to stay "clean")

- No AI/semantic search — Bareeze's own category structure is the filter.
- No wishlist/account/cross-device sync — no backend to persist it in.
- No voice search — dropped from the Resham scaffold to keep scope minimal;
  can be added back later if wanted.
