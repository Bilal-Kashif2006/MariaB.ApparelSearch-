import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSiteCart, startCheckout } from '../src/content/site-cart';

describe('readSiteCart', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('reads the live site cart and maps it into extension cart items', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/cart.js') {
        return new Response(JSON.stringify({
          items: [
            {
              title: 'Embroidered Lawn',
              quantity: 2,
              final_price: 1234500,
              image: 'https://cdn.shopify.com/lawn.jpg',
              url: '/products/embroidered-lawn?variant=1',
            },
          ],
        }), { status: 200 });
      }
      if (url === '/cart') {
        return new Response(
          '<html><body><a href="/checkout/abc123">Checkout</a></body></html>',
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    });

    const cart = await readSiteCart();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cart.viewCartUrl).toBe('/cart');
    expect(cart.checkoutUrl).toBe('/checkout/abc123');
    expect(cart.items).toEqual([
      expect.objectContaining({
        slug: 'embroidered-lawn',
        title: 'Embroidered Lawn',
        quantity: 2,
        price: 'PKR 12,345',
        imageUrl: 'https://cdn.shopify.com/lawn.jpg',
      }),
    ]);
  });

  it('falls back to the cart form action when the page has no direct checkout anchor', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/cart.js') {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url === '/cart') {
        return new Response(
          '<html><body><form action="/cart"><button name="checkout" type="submit">Checkout</button></form></body></html>',
          { status: 200 },
        );
      }
      return new Response('', { status: 404 });
    });

    const cart = await readSiteCart();
    expect(cart.checkoutUrl).toBe('/cart');
  });
});

describe('startCheckout', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('clicks the real checkout link when present on the cart page', async () => {
    document.body.innerHTML = '<a href="/checkout/real-session">Checkout</a>';
    const anchor = document.querySelector('a') as HTMLAnchorElement;
    let clicked = false;
    anchor.addEventListener('click', (event) => {
      event.preventDefault();
      clicked = true;
    });

    const result = await startCheckout(50);

    expect(result.ok).toBe(true);
    expect(clicked).toBe(true);
  });
});
