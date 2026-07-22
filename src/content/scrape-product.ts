import type { ProductDetail } from '../shared/contracts';

function firstText(selectors: string[]): string {
  for (const selector of selectors) {
    const text = document.querySelector(selector)?.textContent?.trim();
    if (text) return text;
  }
  return '';
}

function parseSlug(): string {
  const match = location.pathname.match(/^\/products\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : location.pathname.replace(/^\/+/, '');
}

function collectImages(): string[] {
  const images = new Set<string>();
  for (const img of document.querySelectorAll<HTMLImageElement>('img[src*="shopify"], img[src*="cdn"]')) {
    const src = img.currentSrc || img.src;
    if (!src) continue;
    if (img.width < 120 && img.height < 120) continue;
    images.add(src);
    if (images.size >= 6) break;
  }
  return [...images];
}

function collectOptions(): string[] {
  const values = new Set<string>();
  for (const label of document.querySelectorAll('label')) {
    const text = label.textContent?.trim();
    if (text && text.length <= 40) values.add(text);
  }
  for (const option of document.querySelectorAll('select option')) {
    const text = option.textContent?.trim();
    if (text && !/choose|select/i.test(text)) values.add(text);
  }
  return [...values];
}

export function scrapeProductDetail(): ProductDetail | null {
  const legacyPrice = document.querySelector('.product-price.product-page .actual-price');
  if (legacyPrice) {
    const title = firstText(['.product-title h1', 'h1']);
    const skuText = firstText(['.product-sku']);
    const sku = skuText.replace(/^sku[:\s]*/i, '').trim() || null;
    const allProductImages = [
      ...document.querySelectorAll<HTMLImageElement>('img[src*="product_images"]'),
    ];
    const skuKey = (sku || '').toLowerCase();
    const matched = skuKey ? allProductImages.filter((img) => img.src.toLowerCase().includes(skuKey)) : [];
    const images = [...new Set((matched.length ? matched : allProductImages.slice(0, 4)).map((img) => img.src))];
    const options = [...document.querySelectorAll('[role="radiogroup"] label')]
      .map((el) => el.textContent?.trim() || '')
      .filter(Boolean);

    return {
      slug: location.pathname.replace(/^\//, ''),
      title,
      sku,
      price: legacyPrice.textContent?.trim() || '',
      images,
      options,
    };
  }

  const hasCartForm =
    !!document.querySelector('form[action*="/cart/add"]') ||
    !!document.querySelector('button[name="add"], button[type="submit"]');
  if (!hasCartForm || !location.pathname.startsWith('/products/')) return null;

  const title = firstText(['h1', '[class*="product-title"]', '[class*="title"]']);
  const price = firstText([
    '[data-product-price]',
    '[class*="price-item--sale"]',
    '[class*="price-item--regular"]',
    '[class*="price"]',
    '.money',
  ]);
  const skuText = firstText(['[class*="sku"]', '[data-sku]']);
  const sku = skuText.replace(/^sku[:\s]*/i, '').trim() || null;

  return {
    slug: parseSlug(),
    title,
    sku,
    price,
    images: collectImages(),
    options: collectOptions(),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'SCRAPE_PRODUCT') return false;
  sendResponse({ product: scrapeProductDetail() });
  return true;
});
