import { describe, expect, it } from 'vitest';
import { clickAddToBag, selectSizeOnPage } from '../src/content/add-to-bag';

describe('clickAddToBag', () => {
  it('clicks the real Add To Bag button when present and enabled', async () => {
    document.body.innerHTML = `
      <div class="add-to-cart-product flex gtm-add-to-cart">
        <button type="button">Add To Bag</button>
      </div>`;
    const button = document.querySelector('button') as HTMLButtonElement;
    let clicked = false;
    button.addEventListener('click', () => {
      clicked = true;
    });

    const result = await clickAddToBag(50);

    expect(result.ok).toBe(true);
    expect(clicked).toBe(true);
  });

  it('reports an error instead of throwing when no button exists', async () => {
    document.body.innerHTML = '<div class="product-detail-inner"></div>';
    const result = await clickAddToBag(50);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('reports an error without clicking when the button is disabled', async () => {
    document.body.innerHTML = `
      <div class="add-to-cart-product">
        <button type="button" disabled>Add To Bag</button>
      </div>`;
    const button = document.querySelector('button') as HTMLButtonElement;
    let clicked = false;
    button.addEventListener('click', () => {
      clicked = true;
    });

    const result = await clickAddToBag(50);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disabled/i);
    expect(clicked).toBe(false);
  });

  it('reports sold out when the disabled add button reflects out-of-stock state', async () => {
    document.body.innerHTML = `
      <main>
        <h1>Suit Pink MKD-W22-29</h1>
        <form action="/cart/add">
          <button type="submit" disabled>Sold out</button>
        </form>
      </main>`;

    const result = await clickAddToBag(50);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/sold out|out of stock/i);
  });

  it('reads viewCartUrl and checkoutUrl off the cart drawer once it renders', async () => {
    document.body.innerHTML = `
      <div class="add-to-cart-product">
        <button type="button">Add To Bag</button>
      </div>`;
    const button = document.querySelector('button') as HTMLButtonElement;
    button.addEventListener('click', () => {
      // Simulates Bareeze's own React app rendering the cart drawer
      // asynchronously after the click, the way the real site does.
      setTimeout(() => {
        document.body.insertAdjacentHTML(
          'beforeend',
          `<a href="/cart"><button class="cart-drawer-view-cart-button">View Cart</button></a>
           <a href="/checkout/50035d62-e41b-4f97-b01a-753f3d80844e"><button class="cart-drawer-checkout-button">Checkout</button></a>`,
        );
      }, 20);
    });

    const result = await clickAddToBag(500);

    expect(result).toEqual({
      ok: true,
      viewCartUrl: '/cart',
      checkoutUrl: '/checkout/50035d62-e41b-4f97-b01a-753f3d80844e',
    });
  });

  it('prefers the real cart form button over unrelated page buttons', async () => {
    document.body.innerHTML = `
      <section class="predictive-search">
        <button type="button">Add To Bag</button>
      </section>
      <form action="/cart/add">
        <button type="submit">Add To Cart</button>
      </form>`;

    document.querySelector('form')?.addEventListener('submit', (event) => event.preventDefault());
    const buttons = [...document.querySelectorAll('button')] as HTMLButtonElement[];
    let clickedIndex = -1;
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => {
        clickedIndex = index;
      });
    });

    const result = await clickAddToBag(50);

    expect(result.ok).toBe(true);
    expect(clickedIndex).toBe(1);
  });

  it('prefers the main product form when recommendation quick-add forms appear first', async () => {
    document.body.innerHTML = `
      <section class="recommendations">
        <form action="/cart/add">
          <button type="submit">Add To Cart</button>
        </form>
      </section>
      <main>
        <h1>Embroidered Lawn</h1>
        <form action="/cart/add">
          <button type="submit">Add To Cart</button>
        </form>
      </main>`;

    document.querySelectorAll('form').forEach((form) => {
      form.addEventListener('submit', (event) => event.preventDefault());
    });
    const buttons = [...document.querySelectorAll('button')] as HTMLButtonElement[];
    let clickedIndex = -1;
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => {
        clickedIndex = index;
      });
    });

    const result = await clickAddToBag(50);

    expect(result.ok).toBe(true);
    expect(clickedIndex).toBe(1);
  });

  it('prefers the active product root button over stale page buttons outside the product container', async () => {
    document.body.innerHTML = `
      <section class="recently-viewed">
        <button type="button">Add To Bag</button>
      </section>
      <main>
        <h1>Embroidered Lawn</h1>
        <button type="button">Add To Bag</button>
      </main>`;

    const buttons = [...document.querySelectorAll('button')] as HTMLButtonElement[];
    let clickedIndex = -1;
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => {
        clickedIndex = index;
      });
    });

    const result = await clickAddToBag(50);

    expect(result.ok).toBe(true);
    expect(clickedIndex).toBe(1);
  });

  it('still reports success with a /cart fallback when the drawer never renders', async () => {
    document.body.innerHTML = `
      <div class="add-to-cart-product">
        <button type="button">Add To Bag</button>
      </div>`;

    const result = await clickAddToBag(50);

    expect(result).toEqual({ ok: true, viewCartUrl: '/cart', checkoutUrl: null });
  });

  it('selects size on page via button chip', () => {
    document.body.innerHTML = `
      <main>
        <button type="button" class="size-btn">Small</button>
        <button type="button" class="size-btn">Medium</button>
        <button type="button" class="size-btn">Large</button>
      </main>`;
    let clickedText = '';
    document.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => { clickedText = b.textContent || ''; });
    });

    const ok = selectSizeOnPage('Medium');
    expect(ok).toBe(true);
    expect(clickedText).toBe('Medium');
  });

  it('selects size on page via select dropdown', () => {
    document.body.innerHTML = `
      <main>
        <select name="options[Size]">
          <option value="S">Small</option>
          <option value="M">Medium</option>
          <option value="L">Large</option>
        </select>
      </main>`;

    const select = document.querySelector('select') as HTMLSelectElement;
    const ok = selectSizeOnPage('Large');

    expect(ok).toBe(true);
    expect(select.value).toBe('L');
  });
});
