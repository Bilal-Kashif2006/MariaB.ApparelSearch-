import type { ListingCard, PopupRequest, PopupResponse, ProductDetail } from './shared/contracts';
import { STORE_CONFIG, STORE_HOST_PATTERNS, STORE_URL_PATTERN } from './shared/store';

const STORE_ORIGIN = STORE_CONFIG.site.origin;
const STORE_QUERY_PATTERNS = STORE_HOST_PATTERNS;

async function activeStoreTab(): Promise<chrome.tabs.Tab | null> {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id && active.url && STORE_URL_PATTERN.test(active.url)) return active;

  const candidates = await chrome.tabs.query({ url: STORE_QUERY_PATTERNS });
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
        }),
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
  const tab = await activeStoreTab();
  if (!tab?.id || !tab.url) return { type: 'NOT_A_STORE_PAGE' };

  const product = await injectAndMessage<{ product: ProductDetail | null }>(
    tab.id,
    'scrapeProduct.js',
    { type: 'SCRAPE_PRODUCT' },
  );
  if (product?.product) {
    return { type: 'PRODUCT_RESULT', product: product.product, pageUrl: tab.url };
  }

  const listing = await injectAndMessage<{ cards: ListingCard[]; isListingPage: boolean }>(
    tab.id,
    'scrapeListing.js',
    { type: 'SCRAPE_LISTING' },
  );
  if (listing?.cards.length || listing?.isListingPage) {
    return { type: 'LISTING_RESULT', cards: listing.cards, pageUrl: tab.url };
  }

  return { type: 'NOT_A_STORE_PAGE' };
}

async function resolveTabToNavigate(): Promise<chrome.tabs.Tab | null> {
  const existing = await activeStoreTab();
  if (existing?.id) return existing;
  const [fallback] = await chrome.tabs.query({ active: true, currentWindow: true });
  return fallback?.id ? fallback : null;
}

async function navigateActiveTab(path: string): Promise<PopupResponse> {
  const tab = await resolveTabToNavigate();
  if (!tab?.id) return { type: 'ERROR', error: 'No tab to navigate.' };

  await chrome.tabs.update(tab.id, { url: `${STORE_ORIGIN}${path}` });
  await waitForTabLoad(tab.id);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return scrapeActiveTab();
}

async function openProduct(slug: string): Promise<PopupResponse> {
  const tab = await resolveTabToNavigate();
  if (!tab?.id) return { type: 'ERROR', error: 'No tab to navigate.' };
  await chrome.tabs.update(tab.id, { url: `${STORE_ORIGIN}${STORE_CONFIG.site.productPathPrefix}${encodeURIComponent(slug)}` });
  await waitForTabLoad(tab.id);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return scrapeActiveTab();
}

async function openPath(path: string): Promise<PopupResponse> {
  const tab = await resolveTabToNavigate();
  if (!tab?.id) return { type: 'ERROR', error: 'No tab to navigate.' };
  await chrome.tabs.update(tab.id, { url: path.startsWith('http') ? path : `${STORE_ORIGIN}${path}` });
  return { type: 'PATH_OPENED' };
}

async function addToBag(slug: string): Promise<PopupResponse> {
  const targetUrl = `${STORE_ORIGIN}${STORE_CONFIG.site.productPathPrefix}${encodeURIComponent(slug)}`;
  const existing = await activeStoreTab();
  let tabId = existing?.id;

  if (!existing || existing.url !== targetUrl) {
    const tab = await resolveTabToNavigate();
    if (!tab?.id) return { type: 'ADD_TO_BAG_RESULT', ok: false, error: 'No tab to navigate.' };
    tabId = tab.id;
    await chrome.tabs.update(tabId, { url: targetUrl });
    await waitForTabLoad(tabId);
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  const result = await injectAndMessage<{ ok: boolean; error?: string; viewCartUrl?: string | null; checkoutUrl?: string | null }>(
    tabId!,
    'addToBag.js',
    { type: 'CLICK_ADD_TO_BAG' },
  );
  return {
    type: 'ADD_TO_BAG_RESULT',
    ok: result?.ok ?? false,
    error: result?.error,
    viewCartUrl: result?.viewCartUrl,
    checkoutUrl: result?.checkoutUrl,
  };
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
    } else if (message.type === 'OPEN_PATH') {
      sendResponse(await openPath(message.path));
    } else if (message.type === 'CHECK_STORE') {
      const tab = await activeStoreTab();
      sendResponse(tab ? { type: 'STORE_OK' } : { type: 'NOT_A_STORE_PAGE' });
    }
  })();
  return true;
});
