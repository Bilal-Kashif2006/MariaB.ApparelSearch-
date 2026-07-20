// The content scripts under test register a chrome.runtime.onMessage
// listener at module top-level (that's how they work when actually
// injected into a page) — this stub just needs to exist so importing them
// under plain jsdom doesn't throw. Real message-passing behavior is
// exercised by the extension-loaded verification in README.md instead,
// not by these unit tests.
(globalThis as any).chrome = {
  runtime: {
    onMessage: {
      addListener: () => {},
    },
  },
};
