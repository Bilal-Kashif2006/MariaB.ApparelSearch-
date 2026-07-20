// Injected only on an explicit "Add to Bag" click from the popup. Bareeze
// has no cart API (it isn't Shopify) — this clicks Bareeze's own real
// button so their own React app runs its own real cart logic, exactly as
// it would for a human shopper.

export function clickAddToBag(): { ok: boolean; error?: string } {
  const container = document.querySelector('.add-to-cart-product');
  const button =
    (container?.querySelector('button') as HTMLButtonElement | null) ??
    ([...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Add To Bag'
    ) as HTMLButtonElement | undefined);

  if (!button) {
    return { ok: false, error: 'Add to Bag button not found on this page.' };
  }
  if (button.disabled) {
    return { ok: false, error: 'Add to Bag is disabled — an option may need selecting first.' };
  }
  button.click();
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'CLICK_ADD_TO_BAG') return false;
  // See scrape-listing.ts's matching comment on why this must not claim
  // messages it doesn't own.
  sendResponse(clickAddToBag());
  return true;
});
