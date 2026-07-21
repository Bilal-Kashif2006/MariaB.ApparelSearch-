import { ListingCard, PopupRequest, PopupResponse, ProductDetail } from './shared/contracts';
import { bestCategoryPath } from './shared/category-search';
import { renderListingCard } from './ui/product-card';
import { canonicalizeIntent, type RawIntentFields } from './shared/canonicalize';
import { intentToBareezeUrl } from './shared/intent-to-url';
import { summarizeIntentMatch } from './shared/summarize-intent-match';
import { VoiceRecorder } from './voice/voice-recorder';
import { INTENT_REQUEST_TIMEOUT_MS, MAX_AUDIO_BYTES, VOICE_API_BASE_URL } from './config';

// The proxy's raw intent shape now includes occasion — the one facet the
// local catalog (data/bareeze-catalog.db) can match that Bareeze's own live
// filter UI has no equivalent for. See server/src/catalog.ts.
type RawIntentWithOccasion = RawIntentFields & { occasion?: string | null };

const app = document.getElementById('app')!;

function sendMessage(message: PopupRequest): Promise<PopupResponse> {
  return chrome.runtime.sendMessage(message);
}

function renderShell(): { results: HTMLElement; status: HTMLElement } {
  app.innerHTML = `
    <div class="header">
      <span class="brand">Bareeze</span>
      <div class="search-row">
        <input id="search" type="text" placeholder="e.g. lawn, formals, shawls..." />
        <button id="mic-button" type="button" title="Search by voice" aria-pressed="false">🎤</button>
      </div>
    </div>
    <div id="voice-summary" class="voice-summary" hidden></div>
    <div id="status" class="status"></div>
    <div id="results" class="results"></div>
  `;
  const search = document.getElementById('search') as HTMLInputElement;
  search.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    hideVoiceSummary();
    await handleTypedSearch(search.value);
  });
  wireMicButton();
  return {
    results: document.getElementById('results')!,
    status: document.getElementById('status')!,
  };
}

// --- Voice search --------------------------------------------------------
// Mic capture happens client-side (VoiceRecorder). The recorded clip is sent
// as-is to a small local proxy (see server/) that holds the Groq API key and
// returns { transcript, intent }. The intent is only ever loose,
// natural-language field values — canonicalizeIntent (already tested against
// Bareeze's real filter vocabulary) is what turns it into the exact
// attribute_value strings Bareeze's own filters expect, so a wrong/unmatched
// LLM guess is dropped rather than sent to Bareeze as garbage.

const recorder = new VoiceRecorder(async (blob) => {
  await handleRecording(blob);
});

function wireMicButton(): void {
  const micButton = document.getElementById('mic-button') as HTMLButtonElement;
  micButton.addEventListener('click', async () => {
    if (recorder.isRecording) {
      recorder.stop();
      return;
    }
    try {
      await recorder.start();
      hideVoiceSummary();
      micButton.classList.add('recording');
      micButton.setAttribute('aria-pressed', 'true');
      setStatus('Listening… tap the mic again to stop.');
    } catch (error) {
      await handleMicStartError(error);
    }
  });
}

function hideVoiceSummary(): void {
  const el = document.getElementById('voice-summary');
  if (el) {
    el.hidden = true;
    el.innerHTML = '';
  }
}

// The single #status element gets overwritten right after this (first
// "Loading…", then "N products") — this is a separate, persistent element
// so what was heard and which filters actually got applied doesn't
// disappear the moment results render. canonicalizeIntent silently drops
// any facet it can't match to a real Bareeze filter value, which makes
// results *broader* than asked for with no other visible sign that
// happened — this is what makes that visible. Shared by voice and typed
// smart search, since both now go through the same intent pipeline.
function showIntentSummary(
  sourceLabel: string,
  text: string,
  rawIntent: RawIntentFields,
  intent: ReturnType<typeof canonicalizeIntent>,
  recognizedOccasion: string | null,
): void {
  const el = document.getElementById('voice-summary');
  if (!el) return;
  const { applied, unmatched } = summarizeIntentMatch(rawIntent, intent);
  const appliedWithOccasion = recognizedOccasion ? [...applied, `occasion: ${recognizedOccasion}`] : applied;
  const parts = [`${sourceLabel}: “${escapeHtml(text)}”`];
  parts.push(
    appliedWithOccasion.length > 0
      ? `Filtering by: ${appliedWithOccasion.map(escapeHtml).join(', ')}`
      : 'No specific filters understood — showing New In.',
  );
  if (unmatched.length > 0) {
    parts.push(`<span class="unmatched">Couldn't match: ${unmatched.map(escapeHtml).join(', ')}</span>`);
  }
  el.innerHTML = parts.join('<br>');
  el.hidden = false;
}

// Applies a resolved intent from either voice or typed smart search: renders
// local-catalog products directly whenever the server understood anything
// to filter on (products !== null — see server/src/catalog.ts, which
// matches on every recognized facet at once, not just occasion), otherwise
// falls back to the live, always-current Bareeze-URL path for a genuinely
// empty intent.
async function applyIntentResult(
  sourceLabel: string,
  heardText: string,
  rawIntent: RawIntentWithOccasion,
  products: ListingCard[] | null,
  relaxed: boolean,
): Promise<void> {
  const intent = canonicalizeIntent(rawIntent);
  showIntentSummary(sourceLabel, heardText, rawIntent, intent, products !== null ? rawIntent.occasion ?? null : null);
  if (products !== null) {
    // relaxed means no product matched the whole request — these are the
    // closest related ones instead (see server/src/catalog.ts). Said
    // outright rather than labelled the same as an exact match, same
    // "never silently show something other than what was asked" principle
    // showIntentSummary already applies to unmatched facets.
    const statusText =
      products.length === 0
        ? 'No products in the local catalog matched that — try broadening your search.'
        : relaxed
          ? `No exact match — showing ${products.length} closest option${products.length === 1 ? '' : 's'}`
          : `${products.length} products`;
    renderCards(products, statusText);
    return;
  }
  const path = intentToBareezeUrl(intent);
  setStatus('Loading…');
  const result = await sendMessage({ type: 'OPEN_CATEGORY', path });
  handleResponse(result);
}

function renderCards(cards: ListingCard[], statusText: string): void {
  setStatus(statusText);
  const results = document.getElementById('results')!;
  results.innerHTML = '';
  cards.forEach((card) => results.appendChild(renderListingCard(card, openProduct)));
}

type TextIntentResult =
  | { kind: 'ok'; intent: RawIntentWithOccasion; products: ListingCard[] | null; relaxed: boolean }
  | { kind: 'unreachable' }
  | { kind: 'error'; message: string };

async function fetchTextIntent(text: string): Promise<TextIntentResult> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), INTENT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${VOICE_API_BASE_URL}/text-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error: unknown }).error)
          : 'Smart search failed.';
      return { kind: 'error', message };
    }
    const intent = ((payload as { intent?: RawIntentWithOccasion }).intent ?? {}) as RawIntentWithOccasion;
    const products = ((payload as { products?: ListingCard[] | null }).products ?? null) as ListingCard[] | null;
    const relaxed = (payload as { relaxed?: boolean }).relaxed ?? false;
    return { kind: 'ok', intent, products, relaxed };
  } catch {
    return { kind: 'unreachable' };
  } finally {
    window.clearTimeout(timeout);
  }
}

// Typed search now tries the same intent-extraction pipeline voice search
// uses (better multi-facet matching, plus occasion support the live Bareeze
// URL can't do), falling back to the instant local keyword match only when
// the local proxy isn't reachable at all — so typed search still works with
// no backend running, same as before this integration.
async function handleTypedSearch(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    setStatus('Type something to search for.');
    return;
  }

  setStatus('Searching…');
  const result = await fetchTextIntent(trimmed);
  if (result.kind === 'ok') {
    await applyIntentResult('Searching', trimmed, result.intent, result.products, result.relaxed);
    return;
  }
  if (result.kind === 'error') {
    setStatus(result.message);
    return;
  }

  const path = bestCategoryPath(trimmed);
  if (!path) {
    setStatus('No matching Bareeze category — try lawn, formals, casuals, shawls, sale...');
    return;
  }
  setStatus('Loading…');
  const response = await sendMessage({ type: 'OPEN_CATEGORY', path });
  handleResponse(response);
}

async function handleMicStartError(error: unknown): Promise<void> {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('mic-setup.html') });
    setStatus('Finish microphone setup in the new tab, then tap the mic again.');
    return;
  }
  setStatus(
    name === 'NotFoundError'
      ? 'No microphone was found. Connect one and try again.'
      : 'Could not start the microphone. Check your browser and system settings.',
  );
}

async function handleRecording(blob: Blob): Promise<void> {
  const micButton = document.getElementById('mic-button') as HTMLButtonElement | null;
  micButton?.classList.remove('recording');
  micButton?.setAttribute('aria-pressed', 'false');
  // Disabled for the whole processing window, not just the fetch: the
  // recorder's "stop" event (and isRecording flipping back to false) fires
  // well before this network round-trip resolves, so without this a second
  // tap here would start an overlapping voice request racing the first one.
  if (micButton) micButton.disabled = true;

  try {
    if (blob.size === 0) {
      setStatus('No audio was recorded. Try again.');
      return;
    }
    if (blob.size > MAX_AUDIO_BYTES) {
      setStatus('That recording is too long. Keep it under 15 seconds.');
      return;
    }

    setStatus('Understanding your request…');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), INTENT_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${VOICE_API_BASE_URL}/voice-intent`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error: unknown }).error) : 'Voice search failed.';
        setStatus(error);
        return;
      }
      const transcript = (payload as { transcript?: string }).transcript ?? '';
      const rawIntent = ((payload as { intent?: RawIntentWithOccasion }).intent ?? {}) as RawIntentWithOccasion;
      const products = ((payload as { products?: ListingCard[] | null }).products ?? null) as ListingCard[] | null;
      const relaxed = (payload as { relaxed?: boolean }).relaxed ?? false;
      await applyIntentResult('Heard', transcript, rawIntent, products, relaxed);
    } catch {
      setStatus('Voice search needs the local proxy running (see README) — try typing your search instead.');
    } finally {
      window.clearTimeout(timeout);
    }
  } finally {
    if (micButton) micButton.disabled = false;
  }
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
    renderCards(
      response.cards,
      response.cards.length > 0 ? `${response.cards.length} products` : 'No products matched — try broadening your search.',
    );
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
