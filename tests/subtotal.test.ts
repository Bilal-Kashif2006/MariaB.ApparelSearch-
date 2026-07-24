import { describe, expect, it } from 'vitest';
import { calculateSubtotal } from '../src/shared/cart-utils';
import type { CartItem } from '../src/shared/contracts';

describe('calculateSubtotal', () => {
  it('returns PKR 0 when items list is empty', () => {
    expect(calculateSubtotal([])).toBe('PKR 0');
  });

  it('calculates sum of items with quantities correctly', () => {
    const items: CartItem[] = [
      {
        slug: 'item-1',
        title: 'Item 1',
        price: 'PKR 10,000',
        imageUrl: null,
        quantity: 2,
        addedAt: Date.now(),
      },
      {
        slug: 'item-2',
        title: 'Item 2',
        price: 'PKR 5,500',
        imageUrl: null,
        quantity: 1,
        addedAt: Date.now(),
      },
    ];

    expect(calculateSubtotal(items)).toBe('PKR 25,500');
  });

  it('preserves Rs. currency prefix when present', () => {
    const items: CartItem[] = [
      {
        slug: 'item-1',
        title: 'Item 1',
        price: 'Rs. 15,000',
        imageUrl: null,
        quantity: 1,
        addedAt: Date.now(),
      },
    ];

    expect(calculateSubtotal(items)).toBe('Rs. 15,000');
  });
});
