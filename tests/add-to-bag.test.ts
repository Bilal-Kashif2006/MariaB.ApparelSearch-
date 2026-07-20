import { describe, expect, it } from 'vitest';
import { clickAddToBag } from '../src/content/add-to-bag';

describe('clickAddToBag', () => {
  it('clicks the real Add To Bag button when present and enabled', () => {
    document.body.innerHTML = `
      <div class="add-to-cart-product flex gtm-add-to-cart">
        <button type="button">Add To Bag</button>
      </div>`;
    const button = document.querySelector('button') as HTMLButtonElement;
    let clicked = false;
    button.addEventListener('click', () => {
      clicked = true;
    });

    const result = clickAddToBag();

    expect(result).toEqual({ ok: true });
    expect(clicked).toBe(true);
  });

  it('reports an error instead of throwing when no button exists', () => {
    document.body.innerHTML = '<div class="product-detail-inner"></div>';
    const result = clickAddToBag();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it('reports an error without clicking when the button is disabled', () => {
    document.body.innerHTML = `
      <div class="add-to-cart-product">
        <button type="button" disabled>Add To Bag</button>
      </div>`;
    const button = document.querySelector('button') as HTMLButtonElement;
    let clicked = false;
    button.addEventListener('click', () => {
      clicked = true;
    });

    const result = clickAddToBag();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disabled/i);
    expect(clicked).toBe(false);
  });
});
