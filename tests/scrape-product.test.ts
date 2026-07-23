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
  function setProductPath(slug = 'shadow-work-42') {
    window.history.replaceState({}, '', `/products/${slug}`);
  }

  it('reads a real product detail page correctly', () => {
    setProductPath();
    document.body.innerHTML = realProductHtml();
    const product = scrapeProductDetail();
    expect(product?.title).toBe('SHADOW WORK');
    expect(product?.price).toBe('PKR 20,050.00');
    expect(product?.inStock).toBeNull();
  });

  it('strips the SKU label without leaving a doubled prefix', () => {
    setProductPath();
    document.body.innerHTML = realProductHtml();
    const product = scrapeProductDetail();
    expect(product?.sku).toBe('MC666-Pink');
  });

  it('only includes images matching this product own SKU, excluding recommended items', () => {
    setProductPath();
    document.body.innerHTML = realProductHtml();
    const product = scrapeProductDetail();
    expect(product?.images).toEqual([
      'https://cdn-live.bareeze.com/bareeze/products/product_images/mc666-pink130726121416.jpg?width=1300',
      'https://cdn-live.bareeze.com/bareeze/products/product_images/mc666-pink-3150726181935.jpg?width=1300',
    ]);
  });

  it('keeps the bare product slug on legacy product pages', () => {
    setProductPath('shadow-work-42');
    document.body.innerHTML = realProductHtml();
    const product = scrapeProductDetail();
    expect(product?.slug).toBe('shadow-work-42');
  });

  it('reads real option labels when present', () => {
    setProductPath();
    document.body.innerHTML = realProductHtml({ withOptions: true });
    const product = scrapeProductDetail();
    expect(product?.options).toEqual(['AVAILABLE SELECTION']);
    expect(product?.availableSizes).toEqual([]);
  });

  it('returns null on a page with no product-page price block', () => {
    setProductPath();
    // A listing/category page can still have an <h1> and stray "product
    // card" markup (real observed bug: a detail page's own "you may also
    // like" rail was misread as the whole page being a listing) — the
    // price block is the one marker unique to an actual detail page.
    document.body.innerHTML = '<h1>Formals</h1><div class="singleProductCardContainer"></div>';
    expect(scrapeProductDetail()).toBeNull();
  });

  it('prefers product JSON-LD over unrelated page widgets when scraping modern product pages', () => {
    setProductPath('stitched-embroidered-shirt');
    document.body.innerHTML = `
      <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Product",
          "name": "Stitched Embroidered Shirt",
          "sku": "MB-123",
          "image": ["https://cdn.shopify.com/product-main.jpg"],
          "offers": { "@type": "Offer", "price": "11990" }
        }
      </script>
      <section class="predictive-search">
        <h1>Search your Favourite</h1>
        <p>SKU: BARCODE:MKS-EF22-04R1-Pink-2-4</p>
        <button type="submit">Search</button>
      </section>
      <main>
        <form action="/cart/add">
          <button type="submit">Add to cart</button>
        </form>
      </main>`;

    const product = scrapeProductDetail();

    expect(product).toEqual({
      slug: 'stitched-embroidered-shirt',
      title: 'Stitched Embroidered Shirt',
      sku: 'MB-123',
      price: '11990',
      compareAtPrice: null,
      images: ['https://cdn.shopify.com/product-main.jpg'],
      options: [],
      availableSizes: [],
      inStock: true,
    });
  });

  it('scopes modern product images to the active product root instead of stale page images', () => {
    setProductPath('fresh-lawn-shirt');
    document.body.innerHTML = `
      <img src="https://cdn.shopify.com/previous-product.jpg" width="400" height="400" />
      <main>
        <h1>Fresh Lawn Shirt</h1>
        <div data-product-price>PKR 12,990</div>
        <form action="/cart/add">
          <button type="submit">Add to cart</button>
        </form>
        <img src="https://cdn.shopify.com/current-product.jpg" width="400" height="400" />
      </main>`;

    const product = scrapeProductDetail();

    expect(product?.images).toEqual(['https://cdn.shopify.com/current-product.jpg']);
  });

  it('reads live stock state and sizes from the product root', () => {
    setProductPath('suit-pink');
    document.body.innerHTML = `
      <main>
        <h1>Suit Pink MKD-W22-29</h1>
        <div data-product-price>Rs.4,314</div>
        <form action="/cart/add">
          <button type="submit" disabled>Sold out</button>
        </form>
        <button type="button">2-4</button>
        <button type="button" disabled>4-6</button>
        <button type="button">6-8</button>
        <img src="https://cdn.shopify.com/suit-pink.jpg" width="400" height="400" />
      </main>`;

    const product = scrapeProductDetail();

    expect(product?.inStock).toBe(false);
    expect(product?.availableSizes).toEqual(['2-4', '6-8']);
    expect(product?.images).toEqual(['https://cdn.shopify.com/suit-pink.jpg']);
  });
});
