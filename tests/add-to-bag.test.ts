import { describe, expect, it } from 'vitest';
import { clickAddToBag } from '../src/content/add-to-bag';

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

  it('still reports success with a /cart fallback when the drawer never renders', async () => {
    document.body.innerHTML = `
      <div class="add-to-cart-product">
        <button type="button">Add To Bag</button>
      </div>`;

    const result = await clickAddToBag(50);

    expect(result).toEqual({ ok: true, viewCartUrl: '/cart', checkoutUrl: null });
  });
});
