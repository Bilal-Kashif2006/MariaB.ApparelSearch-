import type { ListingCard } from '../shared/contracts';

function normalizeSlug(href: string | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, location.origin);
    const match = url.pathname.match(/^\/products\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export function isListingPage(): boolean {
  return (
    location.pathname.startsWith('/collections/') ||
    location.pathname === '/collections/all' ||
    !!document.querySelector('.sort_select_option') ||
    (document.body.textContent?.includes('No Products Found') ?? false)
  );
}

function closestText(element: Element | null, selectors: string[]): string | null {
  if (!element) return null;
  for (const selector of selectors) {
    const match = element.querySelector(selector);
    const text = match?.textContent?.trim();
    if (text) return text;
  }
  return null;
}

export function scrapeListingCards(): ListingCard[] {
  const bySlug = new Map<string, ListingCard>();

  for (const container of document.querySelectorAll('.singleProductCardContainer')) {
    const link = container.querySelector<HTMLAnchorElement>('a[href]');
    const titleEl = container.querySelector('.singleProductCardProductTitle');
    if (!link || !titleEl) continue;
    const slug = normalizeSlug(link.getAttribute('href')) ?? link.getAttribute('href')?.replace(/^\//, '').split('?')[0] ?? null;
    if (!slug || bySlug.has(slug)) continue;
    const subtitleEl = container.querySelector('.singleProductCardProductSubTitle');
    const priceEl = container.querySelector('.singleProductCardActualPrice');
    const imgEl = container.querySelector('img') as HTMLImageElement | null;
    bySlug.set(slug, {
      slug,
      title: titleEl.textContent?.trim() || '',
      subtitle: subtitleEl?.textContent?.trim() || null,
      price: priceEl?.textContent?.trim() || '',
      imageUrl: imgEl?.src || null,
    });
  }

  const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href*="/products/"]');

  for (const anchor of anchors) {
    const slug = normalizeSlug(anchor.href);
    if (!slug || bySlug.has(slug)) continue;

    const cardRoot =
      anchor.closest('[class*="card"]') ??
      anchor.closest('[class*="product"]') ??
      anchor.parentElement ??
      anchor;

    const imageUrl =
      (cardRoot.querySelector('img') as HTMLImageElement | null)?.currentSrc ||
      (cardRoot.querySelector('img') as HTMLImageElement | null)?.src ||
      null;
    const title =
      closestText(cardRoot, ['[class*="title"]', '[class*="name"]', 'h3', 'h2']) ||
      anchor.getAttribute('title') ||
      anchor.textContent?.trim() ||
      '';
    if (!title) continue;

    const subtitle = closestText(cardRoot, ['[class*="vendor"]', '[class*="subtitle"]', '[class*="type"]']);
    const price = closestText(cardRoot, ['[class*="price"]', '.money', '[data-product-price]']) || '';

    bySlug.set(slug, {
      slug,
      title,
      subtitle,
      price,
      imageUrl,
    });
  }

  return [...bySlug.values()];
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'SCRAPE_LISTING') return false;
  sendResponse({ cards: scrapeListingCards(), isListingPage: isListingPage() });
  return true;
});
