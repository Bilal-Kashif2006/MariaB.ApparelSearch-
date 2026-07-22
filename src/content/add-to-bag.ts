// Injected only on an explicit "Add to Bag" click from the popup. Bareeze
// has no cart API (it isn't Shopify) — this clicks Bareeze's own real
// button so their own React app runs its own real cart logic, exactly as
// it would for a human shopper.

export type AddToBagResult = {
  ok: boolean;
  error?: string;
  viewCartUrl?: string | null;
  checkoutUrl?: string | null;
};

function findAddToBagButton(): HTMLButtonElement | null {
  const container = document.querySelector('.add-to-cart-product');
  return (
    (container?.querySelector('button') as HTMLButtonElement | null) ??
    ([...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Add To Bag'
    ) as HTMLButtonElement | undefined) ??
    null
  );
}

// A successful click opens Bareeze's own cart drawer, which is the only
// place the checkout URL exists — Bareeze mints a fresh per-session
// checkout path (a UUID) each time, so it can't be constructed, only read
// off the page once the drawer has rendered it.
function waitForCartDrawerLinks(timeoutMs: number): Promise<{ viewCartUrl: string | null; checkoutUrl: string | null }> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const viewCart = document.querySelector('a[href^="/cart"] .cart-drawer-view-cart-button');
      const checkout = document.querySelector('a[href^="/checkout"] .cart-drawer-checkout-button');
      if (viewCart || checkout) {
        resolve({
          viewCartUrl: viewCart?.closest('a')?.getAttribute('href') ?? null,
          checkoutUrl: checkout?.closest('a')?.getAttribute('href') ?? null,
        });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ viewCartUrl: null, checkoutUrl: null });
        return;
      }
      setTimeout(poll, 200);
    };
    poll();
  });
}

export async function clickAddToBag(drawerTimeoutMs = 4000): Promise<AddToBagResult> {
  const button = findAddToBagButton();
  if (!button) {
    return { ok: false, error: 'Add to Bag button not found on this page.' };
  }
  if (button.disabled) {
    return { ok: false, error: 'Add to Bag is disabled — an option may need selecting first.' };
  }
  button.click();
  const { viewCartUrl, checkoutUrl } = await waitForCartDrawerLinks(drawerTimeoutMs);
  // The cart drawer not appearing in time doesn't mean the add failed —
  // Bareeze's own click already ran — so this still reports success and
  // simply falls back to the stable /cart route the popup already knows.
  return { ok: true, viewCartUrl: viewCartUrl ?? '/cart', checkoutUrl };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'CLICK_ADD_TO_BAG') return false;
  // See scrape-listing.ts's matching comment on why this must not claim
  // messages it doesn't own.
  void clickAddToBag().then(sendResponse);
  return true;
});
