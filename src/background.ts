// MV3 service worker — relays messages between the popup and the content
// scripts injected into the active bareeze.com tab. Every action starts
// from an explicit popup click, so `activeTab` is enough permission —
// nothing here runs unprompted in the background.
import type { ListingCard, PopupRequest, PopupResponse, ProductDetail } from './shared/contracts';

const BAREEZE_URL_PATTERN = /^https:\/\/(www\.)?bareeze\.com\//;

async function activeBareezeTab(): Promise<chrome.tabs.Tab | null> {
  // Prefer the actually-active tab (the normal case: the shopper clicked
  // the toolbar icon while on bareeze.com). host_permissions already
  // covers bareeze.com broadly (this extension is single-site by design,
  // unlike Resham's multi-brand one), so falling back to "most recently
  // used bareeze.com tab in any window" is both permitted and more
  // resilient than requiring exact focus at the instant of the message.
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id && active.url && BAREEZE_URL_PATTERN.test(active.url)) return active;

  const candidates = await chrome.tabs.query({ url: ['https://www.bareeze.com/*', 'https://bareeze.com/*'] });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return candidates[0];
}

function injectAndMessage<T>(tabId: number, file: string, message: unknown): Promise<T | null> {
  return chrome.scripting
    .executeScript({ target: { tabId }, files: [file] })
    .then(
      () =>
        new Promise<T | null>((resolve) => {
          chrome.tabs.sendMessage(tabId, message, (response) => {
            resolve(chrome.runtime.lastError ? null : (response as T));
          });
        })
    )
    .catch(() => null);
}

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    function listener(updatedTabId: number, info: chrome.tabs.TabChangeInfo) {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function scrapeActiveTab(): Promise<PopupResponse> {
  const tab = await activeBareezeTab();
  if (!tab?.id || !tab.url) return { type: 'NOT_A_BAREEZE_PAGE' };

  // Product detail pages have their own "you may also like" carousel built
  // from the exact same card markup as a real category listing — so a
  // listing-shaped result alone doesn't prove this is a listing page.
  // Checking for the product page's own, more specific markers first (real
  // observed bug: without this order, a detail page's related-products rail
  // was misread as the whole page being a category listing) is what
  // actually disambiguates the two.
  const product = await injectAndMessage<{ product: ProductDetail | null }>(
    tab.id,
    'scrapeProduct.js',
    { type: 'SCRAPE_PRODUCT' }
  );
  if (product?.product) {
    return { type: 'PRODUCT_RESULT', product: product.product, pageUrl: tab.url };
  }

  const listing = await injectAndMessage<{ cards: ListingCard[]; isListingPage: boolean }>(
    tab.id,
    'scrapeListing.js',
    { type: 'SCRAPE_LISTING' }
  );
  // A filter can legitimately match zero products — isListingPage confirms
  // this genuinely is a listing/category page (Bareeze's own sort/filter
  // chrome, or its own "No Products Found" text, is present) rather than
  // some other bareeze.com page (cart, account, ...) where neither scraper
  // applies. Without this check, a real 0-result search was
  // indistinguishable from "not a Bareeze page" and reported as such.
  if (listing?.cards.length || listing?.isListingPage) {
    return { type: 'LISTING_RESULT', cards: listing.cards, pageUrl: tab.url };
  }

  return { type: 'NOT_A_BAREEZE_PAGE' };
}

// Navigation targets are resolved the same way reads are: prefer an
// existing bareeze.com tab over the popup's own transient tab (real popups
// aren't tabs at all, but automated tooling that opens popup.html as a page
// makes this distinction concrete — and it's the right call for a real
// shopper too, since it means "keep browsing in the tab I was already on"
// rather than hijacking whatever happens to be focused).
async function resolveTabToNavigate(): Promise<chrome.tabs.Tab | null> {
  const existing = await activeBareezeTab();
  if (existing?.id) return existing;
  const [fallback] = await chrome.tabs.query({ active: true, currentWindow: true });
  return fallback?.id ? fallback : null;
}

async function navigateActiveTab(path: string): Promise<PopupResponse> {
  const tab = await resolveTabToNavigate();
  if (!tab?.id) return { type: 'ERROR', error: 'No tab to navigate.' };

  await chrome.tabs.update(tab.id, { url: `https://www.bareeze.com${path}` });
  await waitForTabLoad(tab.id);
  // The SPA still renders its product grid client-side after "complete" fires.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return scrapeActiveTab();
}

// A recommendation click is a hand-off to Bareeze, not an in-extension
// replica of the product page. Let the shopper use Bareeze's own product
// UI for gallery, sizes, options, bag, and checkout without injecting a
// scraper or waiting on the page after navigation.
async function openProduct(slug: string): Promise<PopupResponse> {
  const tab = await resolveTabToNavigate();
  if (!tab?.id) return { type: 'ERROR', error: 'No tab to navigate.' };
  await chrome.tabs.update(tab.id, { url: `https://www.bareeze.com/${encodeURIComponent(slug)}` });
  restoreProductPageScroll(tab.id);
  return { type: 'PRODUCT_OPENED', slug };
}

function restoreProductPageScroll(tabId: number): void {
  const timeout = setTimeout(() => chrome.tabs.onUpdated.removeListener(listener), 12_000);
  function listener(updatedTabId: number, info: chrome.tabs.TabChangeInfo) {
    if (updatedTabId !== tabId || info.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(listener);
    clearTimeout(timeout);
    // Bareeze hydrates after the browser's load event, so wait briefly for
    // its app shell to finish applying responsive classes before repairing
    // a lingering scroll lock.
    setTimeout(() => {
      void chrome.scripting.executeScript({ target: { tabId }, files: ['restorePageScroll.js'] }).catch(() => undefined);
    }, 900);
  }
  chrome.tabs.onUpdated.addListener(listener);
}

async function addToBag(slug: string): Promise<PopupResponse> {
  const targetUrl = `https://www.bareeze.com/${slug}`;
  const existing = await activeBareezeTab();
  let tabId = existing?.id;

  if (!existing || existing.url !== targetUrl) {
    const tab = await resolveTabToNavigate();
    if (!tab?.id) return { type: 'ADD_TO_BAG_RESULT', ok: false, error: 'No tab to navigate.' };
    tabId = tab.id;
    await chrome.tabs.update(tabId, { url: targetUrl });
    await waitForTabLoad(tabId);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  const result = await injectAndMessage<{ ok: boolean; error?: string }>(
    tabId!,
    'addToBag.js',
    { type: 'CLICK_ADD_TO_BAG' }
  );
  return { type: 'ADD_TO_BAG_RESULT', ok: result?.ok ?? false, error: result?.error };
}

chrome.runtime.onMessage.addListener((message: PopupRequest, _sender, sendResponse) => {
  (async () => {
    if (message.type === 'SCRAPE_ACTIVE_TAB') {
      sendResponse(await scrapeActiveTab());
    } else if (message.type === 'OPEN_CATEGORY') {
      sendResponse(await navigateActiveTab(message.path));
    } else if (message.type === 'OPEN_PRODUCT') {
      sendResponse(await openProduct(message.slug));
    } else if (message.type === 'ADD_TO_BAG') {
      sendResponse(await addToBag(message.slug));
    } else if (message.type === 'CHECK_STORE') {
      // Cheaper than SCRAPE_ACTIVE_TAB for a plain support check: no content
      // script injection, just "does a bareeze.com tab exist" (same lookup
      // scrapeActiveTab itself relies on).
      const tab = await activeBareezeTab();
      sendResponse(tab ? { type: 'STORE_OK' } : { type: 'NOT_A_BAREEZE_PAGE' });
    }
  })();
  return true; // keep the message channel open for the async response above
});
