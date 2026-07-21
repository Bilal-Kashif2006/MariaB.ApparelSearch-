import { describe, expect, it } from 'vitest';
import { isListingPage, scrapeListingCards } from '../src/content/scrape-listing';

// Real markup captured from bareeze.com/casuals via a live headless-browser
// render (see README.md) — not hand-typed guesses at the DOM shape.
const REAL_CARD_HTML = `
<div class="product-grid-item" style="width: 24%;">
  <div class="singleProductCardContainer">
    <div class="singleProductCardProductTop">
      <div class="carousel_container">
        <a href="/shadow-work-42" style="display: flex;">
          <img alt="SHADOW WORK" class="carousel_image" src="https://cdn-live.bareeze.com/bareeze/products/product_images/mc666-pink130726121416.jpg?width=1300">
        </a>
      </div>
    </div>
    <div class="singleProductCardProductBottom singleProductCardProductInfo">
      <a href="/shadow-work-42">
        <div class="singleProductCardTitlePrice">
          <p class="singleProductCardProductTitle">SHADOW WORK</p>
          <p class="singleProductCardProductSubTitle">New Selection</p>
          <p class="singleProductCardPrice"><span class="singleProductCardActualPrice">PKR 20,050</span></p>
        </div>
      </a>
    </div>
  </div>
</div>`;

describe('scrapeListingCards', () => {
  it('reads a real product card into a ListingCard', () => {
    document.body.innerHTML = REAL_CARD_HTML;
    const cards = scrapeListingCards();
    expect(cards).toEqual([
      {
        slug: 'shadow-work-42',
        title: 'SHADOW WORK',
        subtitle: 'New Selection',
        price: 'PKR 20,050',
        imageUrl: 'https://cdn-live.bareeze.com/bareeze/products/product_images/mc666-pink130726121416.jpg?width=1300',
      },
    ]);
  });

  it('skips a card with no title or no link, rather than throwing', () => {
    document.body.innerHTML = `
      <div class="singleProductCardContainer">
        <p class="singleProductCardActualPrice">PKR 1,000</p>
      </div>`;
    expect(scrapeListingCards()).toEqual([]);
  });

  it('returns an empty list on a page with no cards at all', () => {
    document.body.innerHTML = '<div class="product-detail-inner"></div>';
    expect(scrapeListingCards()).toEqual([]);
  });
});

describe('isListingPage', () => {
  it('recognizes a real listing page by its sort dropdown, even with zero product cards', () => {
    // A filtered search can legitimately match nothing — Bareeze itself
    // still renders the sort control and its own "No Products Found" text.
    document.body.innerHTML = '<div class="sort_select_option">Newest</div><p>No Products Found</p>';
    expect(isListingPage()).toBe(true);
  });

  it('recognizes a real listing page by Bareeze\'s own "No Products Found" text alone', () => {
    document.body.innerHTML = '<p>No Products Found</p>';
    expect(isListingPage()).toBe(true);
  });

  it('returns false for a page with neither marker (e.g. the cart or account page)', () => {
    document.body.innerHTML = '<div class="account-page">Your Account</div>';
    expect(isListingPage()).toBe(false);
  });
});
