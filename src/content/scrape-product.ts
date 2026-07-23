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

function parseProductJsonLd(): Partial<ProductDetail> | null {
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
    const raw = script.textContent?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const graph =
        parsed && typeof parsed === 'object' && '@graph' in parsed
          ? (parsed as { '@graph'?: unknown })['@graph']
          : null;
      const candidates = Array.isArray(parsed)
        ? parsed
        : Array.isArray(graph)
          ? graph
          : [parsed];
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const type = (candidate as { '@type'?: unknown })['@type'];
        const types = Array.isArray(type) ? type : [type];
        if (!types.some((item) => typeof item === 'string' && item.toLowerCase() === 'product')) continue;
        const product = candidate as {
          name?: unknown;
          sku?: unknown;
          image?: unknown;
          offers?: unknown;
        };
        const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
        const price =
          offers && typeof offers === 'object' && 'price' in offers && typeof (offers as { price?: unknown }).price === 'string'
            ? String((offers as { price: string }).price)
            : '';
        const compareAtPrice =
          offers && typeof offers === 'object' && 'priceSpecification' in offers
            ? (() => {
                const priceSpec = (offers as { priceSpecification?: unknown }).priceSpecification;
                if (priceSpec && typeof priceSpec === 'object' && 'price' in priceSpec && typeof (priceSpec as { price?: unknown }).price === 'string') {
                  return String((priceSpec as { price: string }).price);
                }
                return null;
              })()
            : null;
        const availability =
          offers && typeof offers === 'object' && 'availability' in offers && typeof (offers as { availability?: unknown }).availability === 'string'
            ? String((offers as { availability: string }).availability)
            : null;
        const images = Array.isArray(product.image)
          ? product.image.filter((item): item is string => typeof item === 'string')
          : typeof product.image === 'string'
            ? [product.image]
            : [];
        return {
          title: typeof product.name === 'string' ? product.name.trim() : '',
          sku: typeof product.sku === 'string' ? product.sku.trim() : null,
          price,
          compareAtPrice,
          images,
          inStock: availability ? !/outofstock/i.test(availability) : null,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function findProductRoot(): HTMLElement | null {
  const form = document.querySelector<HTMLFormElement>('form[action*="/cart/add"]');
  if (form) {
    return (
      form.closest<HTMLElement>('[data-product], [class*="product"], main, section, article, div') ??
      form
    );
  }
  return document.querySelector<HTMLElement>('.product-detail-inner, [data-product], [class*="product"]');
}

function collectImages(root?: ParentNode | null): string[] {
  const images = new Set<string>();
  const scope = root ?? document;
  for (const img of scope.querySelectorAll<HTMLImageElement>('img[src*="shopify"], img[src*="cdn"], img[src*="product_images"]')) {
    const src = img.currentSrc || img.src;
    if (!src) continue;
    if (img.width < 120 && img.height < 120) continue;
    images.add(src);
    if (images.size >= 6) break;
  }
  if (images.size === 0) {
    const metaImage =
      document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content?.trim() ||
      document.querySelector<HTMLMetaElement>('meta[name="twitter:image"]')?.content?.trim() ||
      '';
    if (metaImage) images.add(metaImage);
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

function detectInStock(productRoot: HTMLElement | null, productJson: Partial<ProductDetail> | null): boolean | null {
  if (typeof productJson?.inStock === 'boolean') return productJson.inStock;

  const scope = productRoot ?? document;
  const soldOutText = scope.textContent?.toLowerCase() || '';
  if (/\bout of stock\b|\bsold out\b/.test(soldOutText)) return false;

  const addButton =
    scope.querySelector<HTMLButtonElement>('form[action*="/cart/add"] button') ??
    scope.querySelector<HTMLButtonElement>('button[name="add"]');
  if (addButton) {
    const label = addButton.textContent?.trim().toLowerCase() || '';
    if (/sold out|out of stock/.test(label)) return false;
    if (!addButton.disabled) return true;
  }

  return null;
}

function collectAvailableSizes(productRoot: HTMLElement | null): string[] {
  const scope = productRoot ?? document;
  const values = new Set<string>();

  for (const button of scope.querySelectorAll<HTMLButtonElement>('button')) {
    const text = button.textContent?.trim();
    if (!text || text.length > 40) continue;
    if (/add to cart|add to bag|sold out|out of stock/i.test(text)) continue;
    if (button.getAttribute('aria-disabled') === 'true' || button.disabled) continue;
    if (/^\d/.test(text) || /\b(xs|s|m|l|xl|xxl)\b/i.test(text)) values.add(text);
  }

  for (const label of scope.querySelectorAll('label')) {
    const text = label.textContent?.trim();
    if (!text || text.length > 40) continue;
    if (/select|choose|size|available selection/i.test(text)) continue;
    if (/^\d/.test(text) || /\b(xs|s|m|l|xl|xxl)\b/i.test(text)) values.add(text);
  }

  for (const option of scope.querySelectorAll('select option')) {
    const text = option.textContent?.trim();
    if (!text || /choose|select/i.test(text)) continue;
    values.add(text);
  }

  return [...values];
}

export function scrapeProductDetail(): ProductDetail | null {
  if (!location.pathname.startsWith('/products/')) return null;

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
      slug: parseSlug(),
      title,
      sku,
      price: legacyPrice.textContent?.trim() || '',
      compareAtPrice: null,
      images,
      options,
      availableSizes: options.filter((option) => option !== 'AVAILABLE SELECTION'),
      inStock: detectInStock(document.querySelector('.product-detail-inner'), null),
    };
  }

  const productRoot = findProductRoot();
  if (!productRoot) return null;
  const productJson = parseProductJsonLd();

  const title =
    productJson?.title?.trim() ||
    firstText(['main h1', 'h1']) ||
    firstText(['[data-product] h1', '[class*="product-title"]', '[class*="product__title"]']);
  const price =
    productJson?.price?.trim() ||
    firstText([
      'form[action*="/cart/add"] [data-product-price]',
      'form[action*="/cart/add"] [class*="price"]',
      'main [data-product-price]',
      '[class*="price-item--sale"]',
      '[class*="price-item--regular"]',
      '.money',
    ]);
  const skuText = productJson?.sku?.trim() || firstText(['[class*="sku"]', '[data-sku]']);
  const sku = skuText.replace(/^sku[:\s]*/i, '').trim() || null;
  if (!title || !price) return null;

  const images = productJson?.images?.length ? productJson.images : collectImages(productRoot);
  const availableSizes = collectAvailableSizes(productRoot);
  const options = collectOptions();

  return {
    slug: parseSlug(),
    title,
    sku,
    price,
    compareAtPrice: productJson?.compareAtPrice?.trim() || null,
    images,
    options,
    availableSizes,
    inStock: detectInStock(productRoot, productJson),
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'SCRAPE_PRODUCT') return false;
  sendResponse({ product: scrapeProductDetail() });
  return true;
});
