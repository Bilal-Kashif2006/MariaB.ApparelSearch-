export type AddToBagResult = {
  ok: boolean;
  error?: string;
  viewCartUrl?: string | null;
  checkoutUrl?: string | null;
};

function candidateButtons(selector: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>(selector)];
}

function buttonLabel(button: HTMLButtonElement): string {
  return button.textContent?.trim() || button.getAttribute('aria-label') || '';
}

function findPrimaryProductRoot(): HTMLElement | null {
  const main = document.querySelector<HTMLElement>('main');
  if (main?.querySelector('h1')) return main;

  return (
    document.querySelector<HTMLElement>('[data-product]') ??
    [...document.querySelectorAll<HTMLElement>('section, article, div')].find(
      (element) => !!element.querySelector('h1') && (!!element.querySelector('form[action*="/cart/add"]') || !!element.querySelector('button')),
    ) ??
    null
  );
}

function findAddToBagButton(): HTMLButtonElement | null {
  const primaryRoot = findPrimaryProductRoot();
  if (primaryRoot) {
    const rootedGeneralButton = [...primaryRoot.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      /add to cart|add to bag/i.test(buttonLabel(button)),
    );
    if (rootedGeneralButton) return rootedGeneralButton;
  }

  const formButtons = [
    ...candidateButtons('form[action*="/cart/add"] button[type="submit"]'),
    ...candidateButtons('form[action*="/cart/add"] button[name="add"]'),
  ].filter((button, index, buttons) => buttons.indexOf(button) === index);

  if (primaryRoot) {
    const rootedMatch = formButtons.find((button) => primaryRoot.contains(button));
    if (rootedMatch) return rootedMatch;
  }

  const labeledFormButton = formButtons.find((button) => /add to cart|add to bag/i.test(buttonLabel(button)));
  if (labeledFormButton) return labeledFormButton;
  if (formButtons[0]) return formButtons[0];

  return (
    document.querySelector<HTMLButtonElement>('button[name="add"]') ??
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      /add to cart|add to bag/i.test(buttonLabel(button)),
    ) ??
    null
  );
}

function disabledAddToBagReason(button: HTMLButtonElement): string {
  const root = findPrimaryProductRoot() ?? document.body;
  const buttonText = buttonLabel(button).toLowerCase();
  const pageText = root.textContent?.toLowerCase() || '';

  if (/sold out|out of stock/.test(buttonText) || /\bsold out\b|\bout of stock\b/.test(pageText)) {
    return 'This product appears to be sold out on the site.';
  }

  return 'Add to cart is disabled on the site. Select the required size or option first.';
}

async function waitForAddToBagButton(timeoutMs: number): Promise<HTMLButtonElement | null> {
  const deadline = Date.now() + timeoutMs;
  let disabledCandidate: HTMLButtonElement | null = null;

  while (Date.now() < deadline) {
    const button = findAddToBagButton();
    if (button && !button.disabled) return button;
    if (button?.disabled) disabledCandidate = button;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return findAddToBagButton() ?? disabledCandidate;
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
  const button = await waitForAddToBagButton(timeoutMs);
  if (!button) {
    return { ok: false, error: 'Add to cart button not found on this page.' };
  }
  if (button.disabled) {
    return { ok: false, error: disabledAddToBagReason(button) };
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
