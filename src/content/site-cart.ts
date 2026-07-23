import type { CartItem, CartState } from '../shared/contracts';

type ShopifyCartItem = {
  quantity?: unknown;
  title?: unknown;
  final_price?: unknown;
  price?: unknown;
  featured_image?: { url?: unknown } | null;
  image?: unknown;
  url?: unknown;
  handle?: unknown;
};

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function toStorePath(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, location.origin);
    return `${url.pathname}${url.search}`;
  } catch {
    return value.startsWith('/') ? value : `/${value.replace(/^\/+/, '')}`;
  }
}

function parseSlugFromUrl(url: string | null | undefined): string {
  const path = toStorePath(url);
  const match = path?.match(/^\/products\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

function formatPrice(raw: unknown): string {
  const amount = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  return `PKR ${Math.round(amount / 100).toLocaleString('en-PK')}`;
}

function imageUrlFromItem(item: ShopifyCartItem): string | null {
  const direct = typeof item.image === 'string' ? item.image : null;
  if (direct) return direct;
  const nested = item.featured_image?.url;
  return typeof nested === 'string' ? nested : null;
}

function mapCartItems(rawItems: unknown): CartItem[] {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .map((item): CartItem | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as ShopifyCartItem;
      const slug = parseSlugFromUrl(typeof raw.url === 'string' ? raw.url : (typeof raw.handle === 'string' ? `/products/${raw.handle}` : null));
      if (!slug) return null;
      const title = typeof raw.title === 'string' ? normalizeSpace(raw.title) : slug;
      const quantity = typeof raw.quantity === 'number' && Number.isFinite(raw.quantity) && raw.quantity > 0 ? raw.quantity : 1;
      const priceSource = typeof raw.final_price === 'number' ? raw.final_price : raw.price;
      return {
        slug,
        title,
        price: formatPrice(priceSource),
        imageUrl: imageUrlFromItem(raw),
        quantity,
        addedAt: Date.now(),
      };
    })
    .filter((item): item is CartItem => item !== null);
}

function parseDocument(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function checkoutPathFromDocument(doc: Document): string | null {
  const anchor = doc.querySelector<HTMLAnchorElement>('a[href*="/checkout"], a[href*="/checkouts/"]');
  if (anchor?.getAttribute('href')) return toStorePath(anchor.getAttribute('href'));

  const checkoutForm = doc.querySelector<HTMLFormElement>('form[action*="/checkout"], form[action*="/checkouts/"]');
  if (checkoutForm?.getAttribute('action')) return toStorePath(checkoutForm.getAttribute('action'));

  const cartForm = doc.querySelector<HTMLFormElement>('form[action*="/cart"]');
  const checkoutButton =
    cartForm?.querySelector<HTMLButtonElement>('button[name="checkout"], button[type="submit"]') ??
    cartForm?.querySelector<HTMLInputElement>('input[name="checkout"], input[type="submit"]') ??
    null;
  if (cartForm && checkoutButton) return toStorePath(cartForm.getAttribute('action') || '/cart');

  return null;
}

async function readCartPageHtml(): Promise<string> {
  const response = await fetch('/cart', { credentials: 'include' });
  if (!response.ok) throw new Error(`Cart page request failed with status ${response.status}`);
  return response.text();
}

export async function readSiteCart(): Promise<CartState> {
  const [cartResponse, cartHtml] = await Promise.all([
    fetch('/cart.js', { credentials: 'include' }),
    readCartPageHtml(),
  ]);
  if (!cartResponse.ok) {
    throw new Error(`Cart JSON request failed with status ${cartResponse.status}`);
  }

  const cartJson = await cartResponse.json() as { items?: unknown };
  const cartDoc = parseDocument(cartHtml);
  const checkoutUrl = checkoutPathFromDocument(cartDoc);

  return {
    items: mapCartItems(cartJson.items),
    viewCartUrl: '/cart',
    checkoutUrl,
    updatedAt: Date.now(),
  };
}

function checkoutTargets(): Array<() => void> {
  const targets: Array<() => void> = [];
  const anchor = document.querySelector<HTMLAnchorElement>('a[href*="/checkout"], a[href*="/checkouts/"]');
  if (anchor) targets.push(() => anchor.click());

  const button =
    document.querySelector<HTMLButtonElement>('button[name="checkout"], button[type="submit"]') ??
    document.querySelector<HTMLInputElement>('input[name="checkout"], input[type="submit"]');
  if (button) {
    targets.push(() => {
      const form = button.closest('form');
      if (form) {
        if (button instanceof HTMLButtonElement) {
          form.requestSubmit(button);
        } else {
          form.requestSubmit();
        }
      } else {
        button.click();
      }
    });
  }

  const form = document.querySelector<HTMLFormElement>('form[action*="/checkout"], form[action*="/checkouts/"]');
  if (form) targets.push(() => form.requestSubmit());

  return targets;
}

export async function startCheckout(timeoutMs = 1500): Promise<{ ok: boolean }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = checkoutTargets();
    if (targets.length > 0) {
      targets[0]!();
      return { ok: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { ok: false };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'READ_SITE_CART') {
    void readSiteCart()
      .then((cart) => sendResponse({ ok: true, cart }))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Could not read cart.' }));
    return true;
  }
  if (message?.type === 'START_CHECKOUT') {
    void startCheckout().then(sendResponse);
    return true;
  }
  return false;
});
