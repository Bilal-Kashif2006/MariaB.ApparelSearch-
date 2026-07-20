import { describe, expect, it } from 'vitest';
import { scrapeProductDetail } from '../src/content/scrape-product';

// Real markup shape captured from a live bareeze.com product page (see
// README.md): the SKU is two adjacent <label>s, so textContent concatenates
// with a leading space before "SKU:" — a real bug (double "SKU: SKU:" in
// the popup) came from stripping that prefix before trimming the leading
// space away first.
function realProductHtml(options: { withOptions?: boolean } = {}): string {
  return `
    <div class="product-detail-inner">
      <div class="product-title "><h1> SHADOW WORK </h1></div>
      <div class="mb-10">
        <div class="product-sku"><label> SKU: </label><label class="marginLeft5">MC666-Pink</label></div>
      </div>
      <div class="product-price product-page mb-10">
        <span class="actual-price"> PKR 20,050.00 </span>
      </div>
      ${options.withOptions ? '<fieldset><div role="radiogroup"><label>AVAILABLE SELECTION</label></div></fieldset>' : ''}
    </div>
    <img src="https://cdn-live.bareeze.com/bareeze/products/product_images/mc666-pink130726121416.jpg?width=1300" />
    <img src="https://cdn-live.bareeze.com/bareeze/products/product_images/mc666-pink-3150726181935.jpg?width=1300" />
    <h3>YOU ALSO MAY LIKE</h3>
    <img src="https://cdn-live.bareeze.com/bareeze/products/product_images/mc1582-peach-1100726174826.jpg?width=1300" />
  `;
}

describe('scrapeProductDetail', () => {
  it('reads a real product detail page correctly', () => {
    document.body.innerHTML = realProductHtml();
    const product = scrapeProductDetail();
    expect(product?.title).toBe('SHADOW WORK');
    expect(product?.price).toBe('PKR 20,050.00');
  });

  it('strips the SKU label without leaving a doubled prefix', () => {
    document.body.innerHTML = realProductHtml();
    const product = scrapeProductDetail();
    expect(product?.sku).toBe('MC666-Pink');
  });

  it('only includes images matching this product own SKU, excluding recommended items', () => {
    document.body.innerHTML = realProductHtml();
    const product = scrapeProductDetail();
    expect(product?.images).toEqual([
      'https://cdn-live.bareeze.com/bareeze/products/product_images/mc666-pink130726121416.jpg?width=1300',
      'https://cdn-live.bareeze.com/bareeze/products/product_images/mc666-pink-3150726181935.jpg?width=1300',
    ]);
  });

  it('reads real option labels when present', () => {
    document.body.innerHTML = realProductHtml({ withOptions: true });
    const product = scrapeProductDetail();
    expect(product?.options).toEqual(['AVAILABLE SELECTION']);
  });

  it('returns null on a page with no product-page price block', () => {
    // A listing/category page can still have an <h1> and stray "product
    // card" markup (real observed bug: a detail page's own "you may also
    // like" rail was misread as the whole page being a listing) — the
    // price block is the one marker unique to an actual detail page.
    document.body.innerHTML = '<h1>Formals</h1><div class="singleProductCardContainer"></div>';
    expect(scrapeProductDetail()).toBeNull();
  });
});
