// Injected into a Bareeze product detail page. Selectors confirmed live
// against a real product page (see README.md). Images are matched by the
// product's own SKU appearing in the image filename — the same
// filename-matching approach Resham's main catalog uses elsewhere for
// exactly this kind of "no structured linkage, but the name is right there
// in the filename" gap — so a "you may also like" thumbnail elsewhere on
// the page can't get pulled into this product's gallery.
import type { ProductDetail } from '../shared/contracts';

export function scrapeProductDetail(): ProductDetail | null {
  // `.product-price.product-page` only exists on a real detail page — a
  // plain `h1` alone isn't a reliable enough signal, since a category page
  // can have its own unrelated heading elsewhere on the page.
  const priceEl = document.querySelector('.product-price.product-page .actual-price');
  if (!priceEl) return null;
  const price = priceEl.textContent?.trim() || '';

  const titleEl = document.querySelector('.product-title h1') || document.querySelector('h1');
  const title = titleEl?.textContent?.trim() || '';

  const skuEl = document.querySelector('.product-sku');
  // The real markup is two adjacent <label>s ("SKU:" then the value), so
  // textContent concatenates with a leading space before "SKU:" — trim
  // first, or the anchored strip below silently never matches.
  const sku = skuEl?.textContent?.trim().replace(/^SKU:\s*/i, '').trim() || null;

  const allProductImages = [
    ...document.querySelectorAll<HTMLImageElement>('img[src*="product_images"]'),
  ];
  const skuKey = (sku || '').toLowerCase();
  const matched = skuKey
    ? allProductImages.filter((img) => img.src.toLowerCase().includes(skuKey))
    : [];
  const images = [...new Set((matched.length ? matched : allProductImages.slice(0, 4)).map((img) => img.src))];

  const options = [...document.querySelectorAll('[role="radiogroup"] label')]
    .map((el) => el.textContent?.trim() || '')
    .filter(Boolean);

  return {
    slug: location.pathname.replace(/^\//, ''),
    title,
    sku,
    price,
    images,
    options,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'SCRAPE_PRODUCT') return false;
  // See scrape-listing.ts's matching comment: only claim this message when
  // it's actually ours, since stale listeners from earlier injections into
  // this same tab persist and would otherwise hang the sender forever.
  sendResponse({ product: scrapeProductDetail() });
  return true;
});
