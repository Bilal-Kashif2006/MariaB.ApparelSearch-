// Bareeze product pages occasionally retain a responsive-menu scroll lock
// after navigation in a reduced-width browser viewport. This runs only
// after the shopper explicitly opens a recommendation and restores normal
// document scrolling; it does not add wheel listeners or intercept any
// shopper interaction.
function restorePageScroll(): void {
  const styleId = 'bareeze-assistant-scroll-recovery';
  document.getElementById(styleId)?.remove();

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    html, body {
      overflow-y: auto !important;
      height: auto !important;
      overscroll-behavior-y: auto !important;
    }
  `;
  document.head.append(style);

  // Some app-shell variants put the scroll lock on their root instead of
  // the document. Only repair roots that are actually locked so normal
  // layout and product interactions remain untouched.
  for (const root of [document.querySelector('#__next'), document.querySelector('#root'), document.querySelector('main')]) {
    if (!(root instanceof HTMLElement)) continue;
    if (getComputedStyle(root).overflowY === 'hidden') root.style.overflowY = 'auto';
  }
}

restorePageScroll();
