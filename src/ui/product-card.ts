import type { ListingCard } from '../shared/contracts';

export function renderListingCard(card: ListingCard, onOpen: (slug: string) => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    ${card.imageUrl ? `<img class="card-image" src="${card.imageUrl}" alt="${escapeHtml(card.title)}" loading="lazy" />` : ''}
    <div class="card-body">
      <p class="card-title">${escapeHtml(card.title)}</p>
      ${card.subtitle ? `<p class="card-subtitle">${escapeHtml(card.subtitle)}</p>` : ''}
      <p class="card-price">${escapeHtml(card.price)}</p>
    </div>
  `;
  el.addEventListener('click', () => onOpen(card.slug));
  return el;
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
