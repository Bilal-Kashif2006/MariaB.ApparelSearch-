import type { ListingCard } from '../shared/contracts';

function externalLinkIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('card-link-icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M14 5h5v5M19 5l-9 9M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

// index === 0 gets a "Best match" badge — meaningful because the catalog
// already ranks results before this ever renders (exact matches first, or
// closest-related ones when nothing satisfied the whole request; see
// rankCatalog in server/src/catalog.ts), so position in the list is a real
// signal, not arbitrary.
export function renderListingCard(card: ListingCard, index: number, onOpen: (slug: string) => void): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'product-card';
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', `${card.title}, ${card.price}`);

  const media = document.createElement('span');
  media.className = 'product-media';
  const image = document.createElement('img');
  const fallback = document.createElement('span');
  fallback.className = 'image-fallback';
  fallback.textContent = 'Image unavailable';
  if (card.imageUrl) {
    image.src = card.imageUrl;
    image.alt = '';
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      image.hidden = true;
      fallback.classList.add('is-visible');
    }, { once: true });
    media.append(image, fallback);
  } else {
    fallback.classList.add('is-visible');
    media.append(fallback);
  }

  const body = document.createElement('span');
  body.className = 'product-body';
  if (index === 0) {
    const badge = document.createElement('span');
    badge.className = 'best-match';
    badge.textContent = 'Best match';
    body.append(badge);
  }
  const title = document.createElement('span');
  title.className = 'product-title';
  title.textContent = card.title;
  body.append(title);
  if (card.subtitle) {
    const subtitle = document.createElement('span');
    subtitle.className = 'product-subtitle';
    subtitle.textContent = card.subtitle;
    body.append(subtitle);
  }
  const price = document.createElement('span');
  price.className = 'product-price';
  price.textContent = card.price;
  body.append(price);
  if (card.onSale && card.compareAtPrice) {
    const compareAt = document.createElement('span');
    compareAt.className = 'product-compare-price';
    compareAt.textContent = card.compareAtPrice;
    body.append(compareAt);
  }
  if (card.availableSizes?.length) {
    const sizes = document.createElement('span');
    sizes.className = 'product-meta';
    sizes.textContent = `Sizes: ${card.availableSizes.slice(0, 4).join(', ')}${card.availableSizes.length > 4 ? '…' : ''}`;
    body.append(sizes);
  }
  if (card.inStock === false) {
    const stock = document.createElement('span');
    stock.className = 'product-stock';
    stock.textContent = 'Out of stock';
    body.append(stock);
  } else if (card.onSale && typeof card.salePercent === 'number' && card.salePercent > 0) {
    const stock = document.createElement('span');
    stock.className = 'product-stock';
    stock.textContent = `${card.salePercent}% off`;
    body.append(stock);
  }

  el.append(media, body, externalLinkIcon());

  const open = () => onOpen(card.slug);
  el.addEventListener('click', open);
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
  return el;
}
