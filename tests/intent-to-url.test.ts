import { describe, expect, it } from 'vitest';
import { intentToBareezeUrl } from '../src/shared/intent-to-url';
import type { ShoppingIntent } from '../src/shared/intent';

const EMPTY_INTENT: ShoppingIntent = {
  collection: null,
  fabric: null,
  color: null,
  type: null,
  pieceCount: null,
  priceMax: null,
};

describe('intentToBareezeUrl', () => {
  it('falls back to the New In page with just a sort param when nothing is known', () => {
    // Arrange
    const intent = { ...EMPTY_INTENT };

    // Act
    const url = intentToBareezeUrl(intent);

    // Assert
    expect(url).toBe('/new-in?sort=newest');
  });

  it('uses the collection as the base path and adds color as an attribute filter', () => {
    // Arrange
    const intent: ShoppingIntent = { ...EMPTY_INTENT, collection: 'casuals', color: 'GREEN' };

    // Act
    const url = intentToBareezeUrl(intent);

    // Assert
    expect(url).toBe('/casuals?attribute_name=Color&attribute_value=GREEN&sort=newest');
  });

  it('uses fabric as the base path when no collection is named', () => {
    // Arrange
    const intent: ShoppingIntent = { ...EMPTY_INTENT, fabric: 'lawn', color: 'GREEN' };

    // Act
    const url = intentToBareezeUrl(intent);

    // Assert
    expect(url).toBe('/fabric/lawn?attribute_name=Color&attribute_value=GREEN&sort=newest');
  });

  it('prefers collection over fabric as the base path when both are named', () => {
    // Arrange
    const intent: ShoppingIntent = { ...EMPTY_INTENT, collection: 'formals', fabric: 'lawn' };

    // Act
    const url = intentToBareezeUrl(intent);

    // Assert
    expect(url).toBe('/formals?sort=newest');
  });

  it('joins multiple attribute facets with a literal "+", positionally paired', () => {
    // Arrange
    const intent: ShoppingIntent = {
      ...EMPTY_INTENT,
      collection: 'casuals',
      color: 'GREEN',
      type: 'Embroidered',
      pieceCount: '2-Pieces',
    };

    // Act
    const url = intentToBareezeUrl(intent);

    // Assert
    expect(url).toBe(
      '/casuals?attribute_name=Color+Type+Size&attribute_value=GREEN+Embroidered+2-Pieces&sort=newest',
    );
  });

  it('adds a price param with a 0 floor when priceMax is set', () => {
    // Arrange
    const intent: ShoppingIntent = { ...EMPTY_INTENT, collection: 'casuals', priceMax: 20000 };

    // Act
    const url = intentToBareezeUrl(intent);

    // Assert
    expect(url).toBe('/casuals?price=0-20000&sort=newest');
  });

  it('ignores a non-positive or non-finite priceMax', () => {
    // Arrange
    const zero: ShoppingIntent = { ...EMPTY_INTENT, collection: 'casuals', priceMax: 0 };
    const negative: ShoppingIntent = { ...EMPTY_INTENT, collection: 'casuals', priceMax: -50 };
    const notFinite: ShoppingIntent = { ...EMPTY_INTENT, collection: 'casuals', priceMax: NaN };

    // Act & Assert
    expect(intentToBareezeUrl(zero)).toBe('/casuals?sort=newest');
    expect(intentToBareezeUrl(negative)).toBe('/casuals?sort=newest');
    expect(intentToBareezeUrl(notFinite)).toBe('/casuals?sort=newest');
  });
});
