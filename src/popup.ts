import { PopupRequest, PopupResponse, ProductDetail } from './shared/contracts';
import { bestCategoryPath } from './shared/category-search';
import { renderListingCard } from './ui/product-card';

const app = document.getElementById('app')!;

function sendMessage(message: PopupRequest): Promise<PopupResponse> {
  return chrome.runtime.sendMessage(message);
}

function renderShell(): { results: HTMLElement; status: HTMLElement } {
  app.innerHTML = `
    <div class="header">
      <span class="brand">Bareeze</span>
      <input id="search" type="text" placeholder="e.g. lawn, formals, shawls..." />
    </div>
    <div id="status" class="status"></div>
    <div id="results" class="results"></div>
  `;
  const search = document.getElementById('search') as HTMLInputElement;
  search.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    const path = bestCategoryPath(search.value);
    if (!path) {
      setStatus('No matching Bareeze category — try lawn, formals, casuals, shawls, sale...');
      return;
    }
    setStatus('Loading…');
    const response = await sendMessage({ type: 'OPEN_CATEGORY', path });
    handleResponse(response);
  });
  return {
    results: document.getElementById('results')!,
    status: document.getElementById('status')!,
  };
}

function setStatus(text: string): void {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

function openProduct(slug: string): void {
  setStatus('Loading…');
  sendMessage({ type: 'OPEN_CATEGORY', path: `/${slug}` }).then(handleResponse);
}

function renderProductDetail(product: ProductDetail): void {
  const results = document.getElementById('results')!;
  results.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'product-detail';
  el.innerHTML = `
    ${product.images[0] ? `<img class="detail-image" src="${product.images[0]}" alt="" />` : ''}
    <h2>${escapeHtml(product.title)}</h2>
    ${product.sku ? `<p class="sku">SKU: ${escapeHtml(product.sku)}</p>` : ''}
    <p class="price">${escapeHtml(product.price)}</p>
    <button id="add-to-bag">Add to Bag</button>
    <p id="add-status" class="status"></p>
  `;
  results.appendChild(el);
  const button = document.getElementById('add-to-bag') as HTMLButtonElement;
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Adding…';
    const response = await sendMessage({ type: 'ADD_TO_BAG', slug: product.slug });
    const addStatus = document.getElementById('add-status')!;
    if (response.type === 'ADD_TO_BAG_RESULT' && response.ok) {
      addStatus.textContent = 'Added to your Bareeze bag.';
      button.textContent = 'Added';
    } else {
      addStatus.textContent =
        response.type === 'ADD_TO_BAG_RESULT' ? response.error || 'Could not add to bag.' : 'Could not add to bag.';
      button.disabled = false;
      button.textContent = 'Add to Bag';
    }
  });
}

function handleResponse(response: PopupResponse): void {
  const results = document.getElementById('results')!;
  results.innerHTML = '';

  if (response.type === 'LISTING_RESULT') {
    setStatus(`${response.cards.length} products`);
    response.cards.forEach((card) => results.appendChild(renderListingCard(card, openProduct)));
  } else if (response.type === 'PRODUCT_RESULT') {
    setStatus('');
    renderProductDetail(response.product);
  } else if (response.type === 'NOT_A_BAREEZE_PAGE') {
    setStatus('Open a page on bareeze.com to browse it here.');
  } else {
    setStatus(response.type === 'ERROR' ? response.error : 'Something went wrong.');
  }
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

renderShell();
setStatus('Loading…');
sendMessage({ type: 'SCRAPE_ACTIVE_TAB' }).then(handleResponse);
