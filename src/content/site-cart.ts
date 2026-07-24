import type { CartItem, CartState } from '../shared/contracts';
import { matchesSizeText } from '../shared/cart-utils';

type ShopifyCartItem = {
  id?: unknown;
  key?: unknown;
  variant_id?: unknown;
  variant_title?: unknown;
  options_with_values?: Array<{ name?: unknown; value?: unknown }>;
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

function extractSizeFromItem(raw: ShopifyCartItem): string | null {
  if (typeof raw.variant_title === 'string' && raw.variant_title && !/default/i.test(raw.variant_title)) {
    return normalizeSpace(raw.variant_title);
  }
  if (Array.isArray(raw.options_with_values)) {
    for (const opt of raw.options_with_values) {
      if (opt && typeof opt === 'object') {
        const name = String((opt as { name?: unknown }).name || '').toLowerCase();
        const val = String((opt as { value?: unknown }).value || '');
        if ((name.includes('size') || name.includes('option')) && val && !/default/i.test(val)) {
          return normalizeSpace(val);
        }
      }
    }
  }
  return null;
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
      const id = typeof raw.id === 'number' || typeof raw.id === 'string' ? raw.id : (typeof raw.variant_id === 'number' || typeof raw.variant_id === 'string' ? raw.variant_id : null);
      const key = typeof raw.key === 'string' ? raw.key : null;
      const size = extractSizeFromItem(raw);
      return {
        id,
        key,
        slug,
        title,
        price: formatPrice(priceSource),
        imageUrl: imageUrlFromItem(raw),
        quantity,
        addedAt: Date.now(),
        size,
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

export async function removeSiteCartItem(options: {
  slug: string;
  size?: string | null;
  key?: string | null;
  id?: number | string | null;
}): Promise<CartState> {
  const cartResponse = await fetch('/cart.js', { credentials: 'include' });
  if (!cartResponse.ok) {
    throw new Error(`Cart JSON request failed with status ${cartResponse.status}`);
  }

  const cartJson = (await cartResponse.json()) as { items?: unknown[] };
  const rawItems = Array.isArray(cartJson.items) ? cartJson.items : [];

  let targetId: string | number | null = options.key || options.id || null;
  let targetLineIndex: number | null = null;

  if (rawItems.length > 0) {
    // 1. Try exact key/id or slug + size match
    for (let index = 0; index < rawItems.length; index++) {
      const item = rawItems[index];
      if (!item || typeof item !== 'object') continue;
      const raw = item as ShopifyCartItem;
      const itemSlug = parseSlugFromUrl(
        typeof raw.url === 'string' ? raw.url : typeof raw.handle === 'string' ? `/products/${raw.handle}` : null,
      );
      const rawKey = typeof raw.key === 'string' ? raw.key : null;
      const rawId = typeof raw.id === 'number' || typeof raw.id === 'string' ? raw.id : (typeof raw.variant_id === 'number' || typeof raw.variant_id === 'string' ? raw.variant_id : null);

      const keyOrIdMatch = (options.key && rawKey === options.key) || (options.id != null && String(rawId) === String(options.id));
      const slugMatch = itemSlug && itemSlug === options.slug;

      if (keyOrIdMatch) {
        targetId = rawKey ?? rawId;
        targetLineIndex = index + 1;
        break;
      }

      if (slugMatch) {
        if (options.size) {
          const itemSize = extractSizeFromItem(raw);
          if (itemSize && matchesSizeText(options.size, itemSize)) {
            targetId = rawKey ?? rawId;
            targetLineIndex = index + 1;
            break;
          }
        } else {
          targetId = rawKey ?? rawId;
          targetLineIndex = index + 1;
          break;
        }
      }
    }

    // 2. Fallback: If matching with size failed, match by slug alone
    if (targetId == null && targetLineIndex == null) {
      for (let index = 0; index < rawItems.length; index++) {
        const item = rawItems[index];
        if (!item || typeof item !== 'object') continue;
        const raw = item as ShopifyCartItem;
        const itemSlug = parseSlugFromUrl(
          typeof raw.url === 'string' ? raw.url : typeof raw.handle === 'string' ? `/products/${raw.handle}` : null,
        );
        if (itemSlug && itemSlug === options.slug) {
          targetId = (typeof raw.key === 'string' ? raw.key : null) ?? (typeof raw.id === 'number' || typeof raw.id === 'string' ? raw.id : null);
          targetLineIndex = index + 1;
          break;
        }
      }
    }
  }

  if (targetId != null || targetLineIndex != null) {
    const jsonPayload: Record<string, unknown> = { quantity: 0 };
    if (targetId != null) jsonPayload.id = String(targetId);
    if (targetLineIndex != null) jsonPayload.line = targetLineIndex;

    const changeResponse = await fetch('/cart/change.js', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify(jsonPayload),
    });

    if (!changeResponse.ok) {
      const formBody = new URLSearchParams({ quantity: '0' });
      if (targetId != null) formBody.set('id', String(targetId));
      if (targetLineIndex != null) formBody.set('line', String(targetLineIndex));
      await fetch('/cart/change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'include',
        body: formBody.toString(),
      }).catch(() => {});
    }
  }

  const updatedCart = await readSiteCart();

  // Dispatch events to refresh live page cart UI & cart drawer
  try {
    document.dispatchEvent(new CustomEvent('cart:updated', { detail: { cart: updatedCart } }));
    document.dispatchEvent(new CustomEvent('cart:refresh'));
    window.dispatchEvent(new CustomEvent('cart:change'));
    const removeLinks = document.querySelectorAll<HTMLElement>(
      'a[href*="/cart/change"], button[name="clear"], [data-cart-remove], .cart__remove, .cart-item__remove'
    );
    for (const link of removeLinks) {
      const href = link.getAttribute('href') || '';
      if (
        (targetId != null && href.includes(String(targetId))) ||
        (targetLineIndex != null && href.includes(`line=${targetLineIndex}`))
      ) {
        link.click();
      }
    }
  } catch {
    // Ignore DOM dispatch errors
  }

  return updatedCart;
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
  if (message?.type === 'REMOVE_FROM_CART') {
    void removeSiteCartItem({
      slug: message.slug,
      size: message.size,
      key: message.key,
      id: message.id,
    })
      .then((cart) => sendResponse({ ok: true, cart }))
      .catch((error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Could not remove item.' }));
    return true;
  }
  if (message?.type === 'START_CHECKOUT') {
    void startCheckout().then(sendResponse);
    return true;
  }
  return false;
});
