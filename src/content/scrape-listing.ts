// Injected into a Bareeze category/listing page. Reads real product cards
// straight off the rendered DOM — selectors confirmed live against
// /casuals, /formals, /shawls (see README.md).
import type { ListingCard } from '../shared/contracts';

export function scrapeListingCards(): ListingCard[] {
  const cards: ListingCard[] = [];
  document.querySelectorAll('.singleProductCardContainer').forEach((container) => {
    const link = container.querySelector('a[href]');
    const titleEl = container.querySelector('.singleProductCardProductTitle');
    const subtitleEl = container.querySelector('.singleProductCardProductSubTitle');
    const priceEl = container.querySelector('.singleProductCardActualPrice');
    const imgEl = container.querySelector('img') as HTMLImageElement | null;
    if (!link || !titleEl) return;

    const href = link.getAttribute('href') || '';
    const slug = href.replace(/^\//, '').split('?')[0];
    if (!slug) return;

    cards.push({
      slug,
      title: titleEl.textContent?.trim() || '',
      subtitle: subtitleEl?.textContent?.trim() || null,
      price: priceEl?.textContent?.trim() || '',
      imageUrl: imgEl?.src || null,
    });
  });
  return cards;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'SCRAPE_LISTING') return false;
  // Repeated executeScript calls into the same tab share one isolated
  // world, so every previously-injected script's listener is still alive
  // and receives every later message too. Returning `true` unconditionally
  // here would tell Chrome this listener will respond even to messages it
  // ignores, holding the sender's callback open forever once a *different*
  // message type (e.g. SCRAPE_PRODUCT) is sent on the same tab.
  sendResponse({ cards: scrapeListingCards() });
  return true;
});
