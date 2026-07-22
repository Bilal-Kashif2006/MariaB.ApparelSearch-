export type AddToBagResult = {
  ok: boolean;
  error?: string;
  viewCartUrl?: string | null;
  checkoutUrl?: string | null;
};

function findAddToBagButton(): HTMLButtonElement | null {
  return (
    document.querySelector<HTMLButtonElement>('form[action*="/cart/add"] button[type="submit"]') ??
    document.querySelector<HTMLButtonElement>('button[name="add"]') ??
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      /add to cart|add to bag|buy it now/i.test(button.textContent?.trim() || ''),
    ) ??
    null
  );
}

function waitForCartLinks(timeoutMs: number): Promise<{ viewCartUrl: string | null; checkoutUrl: string | null }> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const viewCart =
        document.querySelector<HTMLAnchorElement>('a[href*="/cart"]')?.getAttribute('href') ??
        null;
      const checkout =
        document.querySelector<HTMLAnchorElement>('a[href*="/checkout"]')?.getAttribute('href') ??
        null;
      if (viewCart || checkout) {
        resolve({ viewCartUrl: viewCart, checkoutUrl: checkout });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ viewCartUrl: null, checkoutUrl: null });
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

export async function clickAddToBag(timeoutMs = 800): Promise<AddToBagResult> {
  const button = findAddToBagButton();
  if (!button) {
    return { ok: false, error: 'Add to cart button not found on this page.' };
  }
  if (button.disabled) {
    return { ok: false, error: 'Add to cart is disabled. Select the required size or option first.' };
  }

  button.click();
  const { viewCartUrl, checkoutUrl } = await waitForCartLinks(timeoutMs);

  return {
    ok: true,
    viewCartUrl: viewCartUrl ?? '/cart',
    checkoutUrl,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'CLICK_ADD_TO_BAG') return false;
  void clickAddToBag().then(sendResponse);
  return true;
});
