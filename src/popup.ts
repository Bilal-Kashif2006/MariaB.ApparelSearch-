import type {
  CartItem,
  CartState,
  CanonicalIntent,
  ChatMessage,
  ConversationState,
  DeterministicInterpretation,
  ListingCard,
  PopupRequest,
  PopupResponse,
  ProductDetail,
} from './shared/contracts';
import { canonicalizeIntent, type RawIntentFields } from './shared/canonicalize';
import { STORE_ASSISTANT_LABEL, STORE_BLOCKING_COPY, STORE_CONFIG, STORE_OPEN_PROMPT, STORE_STATUS_LABEL } from './shared/store';
import { summarizeIntentMatch } from './shared/summarize-intent-match';
import { renderListingCard } from './ui/product-card';
import { VoiceRecorder } from './voice/voice-recorder';
import {
  CART_KEY,
  CONVERSATION_KEY,
  CONVERSATION_MAX_AGE_MS,
  INTENT_REQUEST_TIMEOUT_MS,
  LAYOUT_KEY,
  MAX_AUDIO_BYTES,
  VOICE_API_BASE_URL,
} from './config';

// The proxy's raw intent shape includes occasion — the one facet the local
// catalog adapter matches that Maria B's live site does not reliably expose
// as a deterministic front-end filter.
type RawIntentWithOccasion = RawIntentFields & { occasion?: string | null };

interface ServerIntentResult {
  intent: RawIntentWithOccasion;
  canonicalIntent: CanonicalIntent;
  products: ListingCard[] | null;
  relaxed: boolean;
  priceRelaxRequested: boolean;
  priceRelaxApplied: boolean;
  conversationAction: 'search' | 'clarify' | 'unsupported';
  assistantReply: string | null;
  deterministicInterpretation?: DeterministicInterpretation;
}

function mustElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as T;
}

const workspaceView = mustElement('workspace-view');
const blockingView = mustElement('blocking-view');
const blockingTitle = mustElement('blocking-title');
const storeContext = mustElement('store-context');
const storeName = mustElement('store-name');
const productsToolbar = document.querySelector('.products-toolbar') as HTMLElement;
const productList = mustElement('product-list');
const productsPane = mustElement('products-pane');
const cartToggle = mustElement<HTMLButtonElement>('cart-toggle');
const cartCount = mustElement('cart-count');
const productFeedControls = mustElement('product-feed-controls');
const productFeedStatus = mustElement('product-feed-status');
const loadMoreButton = mustElement<HTMLButtonElement>('load-more-products');
const loadMoreLabel = mustElement('load-more-label');
const productScrollSentinel = mustElement('product-scroll-sentinel');
const productsEmpty = mustElement('products-empty');
const productsLoading = mustElement('products-loading');
const noMatches = mustElement('no-matches');
const intentChips = mustElement('intent-chips');
const resultSummary = mustElement('result-summary');
const notice = mustElement('notice');
const productDetailView = mustElement('product-detail-view');
const productDetailBody = mustElement('product-detail-body');
const cartView = mustElement('cart-view');
const cartItems = mustElement('cart-items');
const cartEmpty = mustElement('cart-empty');
const cartFooter = mustElement('cart-footer');
const cartViewSiteButton = mustElement<HTMLButtonElement>('cart-view-site');
const cartCheckoutButton = mustElement<HTMLButtonElement>('cart-checkout');
const chatThread = mustElement('chat-thread');
const chatForm = mustElement<HTMLFormElement>('chat-form');
const chatInput = mustElement<HTMLTextAreaElement>('chat-input');
const inputError = mustElement('input-error');
const sendButton = mustElement<HTMLButtonElement>('send-button');
const micButton = mustElement<HTMLButtonElement>('mic-button');
const inlineError = mustElement('inline-error');
const inlineErrorTitle = mustElement('inline-error-title');
const inlineErrorMessage = mustElement('inline-error-message');
const retryButton = mustElement<HTMLButtonElement>('retry-button');
const searchingStrip = mustElement('searching-strip');
const searchingLabel = mustElement('searching-label');
const recordingStrip = mustElement('recording-strip');
const recordingTime = mustElement('recording-time');
const layoutToggle = mustElement<HTMLButtonElement>('layout-toggle');
const checkStoreButton = mustElement<HTMLButtonElement>('check-store');
const blockingMessage = mustElement('blocking-message');
const chatInputLabel = document.querySelector('label[for="chat-input"]') as HTMLLabelElement | null;

const welcomeMessage: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  text: `I’m your ${STORE_ASSISTANT_LABEL} Style Assistant. Tell me the occasion, colour, fabric, or budget you have in mind, and I’ll help you find the right look.`,
};

let messages: ChatMessage[] = [welcomeMessage];
let currentIntent: CanonicalIntent | null = null;
let currentProducts: ListingCard[] | null = null;
let currentRelaxed = false;
let currentRequestId: string | null = null;
let lastQuery = '';
let lastRetriableQuery: string | null = null;
let recordingStartedAt = 0;
let recordingTimer: number | null = null;
let visibleProductCount = 0;
let loadingMoreProducts = false;
let productPaneHasScrolled = false;
let currentCart: CartState = {
  items: [],
  viewCartUrl: '/cart',
  checkoutUrl: null,
  updatedAt: 0,
};
let activePane: 'results' | 'detail' | 'cart' = 'results';

const PRODUCT_BATCH_SIZE = 5;

function sendMessage(msg: PopupRequest): Promise<PopupResponse> {
  return chrome.runtime.sendMessage(msg);
}

function message(role: ChatMessage['role'], text: string): ChatMessage {
  return { id: crypto.randomUUID(), role, text };
}

function totalCartCount(): number {
  return currentCart.items.reduce((sum, item) => sum + item.quantity, 0);
}

function hasAnyIntentFacet(intent: CanonicalIntent | null): boolean {
  return Boolean(
    intent &&
    (
      intent.collection ||
      intent.fabric ||
      intent.color ||
      intent.type ||
      intent.pieceCount ||
      intent.occasion ||
      intent.priceMax != null
    )
  );
}

function persistCart(): void {
  currentCart.updatedAt = Date.now();
  void chrome.storage.local.set({ [CART_KEY]: currentCart });
}

function updateCartBadge(): void {
  const count = totalCartCount();
  cartCount.hidden = count === 0;
  cartCount.textContent = String(count);
  cartToggle.setAttribute('aria-label', count > 0 ? `Open cart, ${count} item${count === 1 ? '' : 's'}` : 'Open cart');
  cartToggle.title = count > 0 ? `Open cart (${count})` : 'Open cart';
}

function setPane(nextPane: 'results' | 'detail' | 'cart'): void {
  activePane = nextPane;
  const showingResults = nextPane === 'results';
  const showingDetail = nextPane === 'detail';
  const showingCart = nextPane === 'cart';
  productsToolbar.hidden = !showingResults;
  intentChips.hidden = !showingResults;
  notice.hidden = !showingResults || (!currentRelaxed && !notice.textContent);
  productsEmpty.hidden = !showingResults || currentProducts !== null;
  productList.hidden = !showingResults || !currentProducts || currentProducts.length === 0;
  productFeedControls.hidden = true;
  noMatches.hidden = !showingResults || !currentProducts || currentProducts.length > 0;
  productDetailView.hidden = !showingDetail;
  cartView.hidden = !showingCart;
  cartToggle.setAttribute('aria-pressed', String(showingCart));
}

function renderCart(): void {
  cartItems.replaceChildren();
  const items = [...currentCart.items].sort((a, b) => b.addedAt - a.addedAt);
  cartEmpty.hidden = items.length > 0;
  cartItems.hidden = items.length === 0;
  cartFooter.hidden = items.length === 0;
  cartViewSiteButton.disabled = items.length === 0;
  cartCheckoutButton.disabled = items.length === 0;

  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'cart-item';

    if (item.imageUrl) {
      const image = document.createElement('img');
      image.className = 'cart-item-image';
      image.src = item.imageUrl;
      image.alt = '';
      card.append(image);
    } else {
      const fallback = document.createElement('div');
      fallback.className = 'cart-item-fallback';
      fallback.textContent = 'Image unavailable';
      card.append(fallback);
    }

    const body = document.createElement('div');
    body.className = 'cart-item-body';
    const title = document.createElement('strong');
    title.className = 'cart-item-title';
    title.textContent = item.title;
    const price = document.createElement('p');
    price.className = 'cart-item-price';
    price.textContent = item.price;
    const meta = document.createElement('p');
    meta.className = 'cart-item-meta';
    meta.textContent = `Quantity: ${item.quantity}`;
    const reopen = document.createElement('button');
    reopen.type = 'button';
    reopen.className = 'cart-item-link';
    reopen.textContent = 'Open product';
    reopen.addEventListener('click', () => void openProduct(item.slug));
    body.append(title, price, meta, reopen);
    card.append(body);
    cartItems.append(card);
  }

  updateCartBadge();
}

async function refreshCartFromSite(fallback?: Partial<CartState>): Promise<boolean> {
  const response = await sendMessage({ type: 'SYNC_CART' });
  if (response.type !== 'CART_SYNC_RESULT' || !response.synced) {
    if (fallback) {
      currentCart = {
        items: fallback.items ?? currentCart.items,
        viewCartUrl: fallback.viewCartUrl ?? currentCart.viewCartUrl,
        checkoutUrl: fallback.checkoutUrl ?? currentCart.checkoutUrl,
        updatedAt: Date.now(),
      };
      persistCart();
      renderCart();
    }
    return false;
  }

  currentCart = response.cart;
  persistCart();
  renderCart();
  return true;
}

async function showCartView(): Promise<void> {
  renderCart();
  setPane('cart');
  await refreshCartFromSite();
  mustElement('cart-title').focus();
}

function upsertCartItem(product: ProductDetail, viewCartUrl: string, checkoutUrl: string | null): void {
  const existing = currentCart.items.find((item) => item.slug === product.slug);
  if (existing) {
    existing.quantity += 1;
    existing.addedAt = Date.now();
    existing.price = product.price;
    existing.imageUrl = product.images[0] || existing.imageUrl;
    existing.title = product.title;
  } else {
    currentCart.items.push({
      slug: product.slug,
      title: product.title,
      price: product.price,
      imageUrl: product.images[0] || null,
      quantity: 1,
      addedAt: Date.now(),
    });
  }
  currentCart.viewCartUrl = viewCartUrl;
  currentCart.checkoutUrl = checkoutUrl;
  persistCart();
  renderCart();
}

function setInputError(text: string | null): void {
  inputError.hidden = !text;
  inputError.textContent = text || '';
}

function renderChat(isTyping = false): void {
  chatThread.replaceChildren();
  for (const item of messages) {
    const bubble = document.createElement('div');
    bubble.className = `message ${item.role}`;
    const label = document.createElement('span');
    label.className = 'message-label';
    label.textContent = item.role === 'assistant' ? STORE_ASSISTANT_LABEL : 'You';
    const text = document.createElement('span');
    text.textContent = item.text;
    bubble.append(label, text);
    chatThread.append(bubble);
  }
  if (isTyping) {
    const bubble = document.createElement('div');
    bubble.className = 'message assistant';
    const label = document.createElement('span');
    label.className = 'message-label';
    label.textContent = STORE_ASSISTANT_LABEL;
    const typing = document.createElement('span');
    typing.className = 'typing-message';
    typing.setAttribute('aria-label', `${STORE_ASSISTANT_LABEL} is thinking`);
    typing.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
    bubble.append(label, typing);
    chatThread.append(bubble);
  }
  chatThread.scrollTop = chatThread.scrollHeight;
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function intentLabels(intent: CanonicalIntent): string[] {
  const labels: string[] = [];
  if (intent.collection) labels.push(titleCase(intent.collection));
  if (intent.fabric) labels.push(titleCase(intent.fabric));
  if (intent.color) labels.push(titleCase(intent.color));
  if (intent.type) labels.push(titleCase(intent.type));
  if (intent.pieceCount) labels.push(titleCase(intent.pieceCount));
  if (intent.occasion) labels.push(titleCase(intent.occasion));
  if (intent.priceMax != null) labels.push(`Under Rs. ${intent.priceMax.toLocaleString('en-PK')}`);
  return labels;
}

// How many facets a shopper has piled up across refinement turns —
// mergeCatalogIntent has no way to REMOVE a facet, only replace or add one,
// so after several refinements a "relaxed" (no-exact-match) result can be
// ranked against a large combination where it only satisfies one or two of
// them. That reads as a real match if worded the same as a normal close
// match, so it's worded differently once enough facets have accumulated.
function recognizedFacetCount(intent: CanonicalIntent): number {
  return [intent.collection, intent.fabric, intent.color, intent.type, intent.pieceCount, intent.occasion].filter(Boolean).length;
}

function updateProductFeedControls(): void {
  const total = currentProducts?.length || 0;
  const hasMore = visibleProductCount < total;
  // The assistant is intentionally a concise recommendation layer, not a
  // second storefront. Server results are capped at five verified picks.
  productFeedControls.hidden = true;
  loadMoreButton.hidden = !hasMore;
  loadMoreButton.disabled = loadingMoreProducts;
  loadMoreButton.classList.toggle('is-loading', loadingMoreProducts);
  loadMoreLabel.textContent = loadingMoreProducts
    ? 'Loading products…'
    : `Load ${Math.min(PRODUCT_BATCH_SIZE, total - visibleProductCount)} more`;
  productFeedStatus.textContent = hasMore
    ? `Showing ${visibleProductCount} of ${total} matches.`
    : total > 0
      ? `${total} curated top pick${total === 1 ? '' : 's'}.`
      : '';
  if (currentProducts) {
    resultSummary.textContent = hasMore ? `Showing ${visibleProductCount} of ${total}` : `${total} curated top pick${total === 1 ? '' : 's'}`;
  }
}

function appendNextProductBatch(immediate = false): void {
  if (!currentProducts || loadingMoreProducts || visibleProductCount >= currentProducts.length) return;
  loadingMoreProducts = true;
  updateProductFeedControls();
  const append = () => {
    if (!currentProducts) return;
    const start = visibleProductCount;
    const end = Math.min(start + PRODUCT_BATCH_SIZE, currentProducts.length);
    for (let index = start; index < end; index += 1) {
      productList.append(renderListingCard(currentProducts[index], index, openProduct));
    }
    visibleProductCount = end;
    loadingMoreProducts = false;
    updateProductFeedControls();
  };
  if (immediate) append();
  else window.requestAnimationFrame(append);
}

function renderResults(products: ListingCard[] | null, relaxed: boolean): void {
  currentProducts = products;
  currentRelaxed = relaxed;
  activePane = 'results';
  visibleProductCount = 0;
  loadingMoreProducts = false;
  productPaneHasScrolled = false;
  productsPane.scrollTop = 0;
  productList.replaceChildren();
  intentChips.replaceChildren();
  productsLoading.hidden = true;
  setPane('results');

  if (!products) {
    productList.hidden = true;
    productsEmpty.hidden = false;
    noMatches.hidden = true;
    notice.hidden = true;
    resultSummary.textContent = 'Start with a request in the chat.';
    productFeedControls.hidden = true;
    productFeedStatus.textContent = '';
    chatInput.placeholder = 'Describe what you want…';
    return;
  }

  productsEmpty.hidden = true;
  if (currentIntent) {
    for (const label of intentLabels(currentIntent)) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = label;
      intentChips.append(chip);
    }
  }
  notice.hidden = false;
  notice.textContent = relaxed
    ? 'No exact match — these are the closest curated alternatives.'
    : `Curated from the ${STORE_ASSISTANT_LABEL} catalog. Confirm price and availability on the product page.`;
  appendNextProductBatch(true);
  noMatches.hidden = products.length > 0;
  productList.hidden = products.length === 0;
  resultSummary.textContent = `${products.length} curated top pick${products.length === 1 ? '' : 's'}`;
  chatInput.placeholder = 'Refine these results…';
}

function persistConversation(): void {
  const state: ConversationState = {
    messages,
    currentIntent,
    currentProducts,
    currentRelaxed,
    lastQuery,
    updatedAt: Date.now(),
  };
  void chrome.storage.local.set({ [CONVERSATION_KEY]: state });
}

function setSearching(searching: boolean, showProductLoading = true, label = 'Understanding your request…'): void {
  if (searching) searchingLabel.textContent = label;
  searchingStrip.hidden = !searching;
  sendButton.disabled = searching;
  micButton.disabled = searching;
  chatInput.disabled = searching;
  productsLoading.hidden = !searching || !showProductLoading || currentProducts !== null;
  productList.setAttribute('aria-busy', String(searching));
  renderChat(searching);
}

function hideInlineError(): void {
  inlineError.hidden = true;
}

function showInlineError(title: string, text: string, retriable: boolean): void {
  inlineErrorTitle.textContent = title;
  inlineErrorMessage.textContent = text;
  retryButton.hidden = !retriable;
  inlineError.hidden = false;
}

// --- Result → chat-message honesty -----------------------------------------
// Every silent gap here is exactly the failure mode this whole matching
// system has otherwise been built to avoid (see server/src/catalog.ts's own
// comments) — a shopper who says "cheaper" with nothing to lower, or whose
// words didn't map to any real facet, is told so directly instead of the
// assistant just... not doing anything about it.
function buildAssistantReply(result: ServerIntentResult, unmatched: string[]): string {
  const { products, relaxed, priceRelaxRequested, priceRelaxApplied, canonicalIntent } = result;
  const parts: string[] = [];

  // Said first, not after the result — it's context for the search that
  // follows ("I lowered the budget, THEN searched"), not an afterthought.
  // Concrete number, not "a bit": a shopper who asked to go cheaper should
  // see exactly what cheaper now means.
  if (priceRelaxApplied && canonicalIntent.priceMax != null) {
    parts.push(`Lowered the budget to Rs. ${canonicalIntent.priceMax.toLocaleString('en-PK')}.`);
  } else if (priceRelaxRequested && !priceRelaxApplied) {
    parts.push("I don't have a price to lower yet — what's your budget?");
  }

  if (products === null) {
    parts.push("I couldn't quite place a specific request there — here's what's newly arrived instead.");
  } else if (products.length === 0) {
    parts.push("Still couldn't find anything, even loosely related. Tell me what to change and I'll keep digging.");
  } else if (relaxed) {
    const weak = recognizedFacetCount(canonicalIntent) >= 3;
    parts.push(
      weak
        ? `No exact match, so these ${products.length} are only loosely related to everything you've asked for so far — tell me which detail matters most and I'll narrow it down.`
        : `No exact match, but here ${products.length === 1 ? 'is' : 'are'} ${products.length} close option${products.length === 1 ? '' : 's'}.`,
    );
  } else {
    parts.push(`Found ${products.length} curated top pick${products.length === 1 ? '' : 's'}.`);
  }

  if (unmatched.length > 0) {
    parts.push(`Couldn't match: ${unmatched.join(', ')}.`);
  }

  if (products && products.length > 0) {
    parts.push('What would you like to refine next?');
  }

  return parts.join(' ');
}

async function fetchLiveNewIn(): Promise<ListingCard[]> {
  const response = await sendMessage({ type: 'OPEN_CATEGORY', path: STORE_CONFIG.site.fallbackCollectionPath });
  return response.type === 'LISTING_RESULT' ? response.cards.slice(0, PRODUCT_BATCH_SIZE) : [];
}

async function applyServerResult(result: ServerIntentResult): Promise<void> {
  if (result.conversationAction !== 'search') {
    if (result.conversationAction === 'clarify' && hasAnyIntentFacet(result.canonicalIntent)) {
      currentIntent = result.canonicalIntent;
    }
    messages.push(message('assistant', result.assistantReply || 'What would you like help finding?'));
    renderChat();
    persistConversation();
    chatInput.focus();
    return;
  }
  currentIntent = result.canonicalIntent;

  let products = result.products;
  let relaxed = result.relaxed;
  if (products === null) {
    products = await fetchLiveNewIn();
    relaxed = false;
  }

  const shoppingIntent = canonicalizeIntent(result.intent);
  const { unmatched: summarizedUnmatched } = summarizeIntentMatch(result.intent, shoppingIntent);
  const unmatched = result.deterministicInterpretation?.unmatchedTerms.length
    ? result.deterministicInterpretation.unmatchedTerms
    : summarizedUnmatched;

  renderResults(products, relaxed);
  messages.push(message('assistant', buildAssistantReply({ ...result, products }, unmatched)));
  renderChat();
  persistConversation();
  mustElement('products-title').focus();
}

async function fetchTextIntent(text: string): Promise<
  | { kind: 'ok'; result: ServerIntentResult }
  | { kind: 'unreachable' }
  | { kind: 'error'; message: string }
> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), INTENT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${VOICE_API_BASE_URL}/text-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        previousIntent: currentIntent,
        history: messages.slice(-8).map((item) => `${item.role}: ${item.text}`).join('\n'),
      }),
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errMessage =
        payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error: unknown }).error)
          : 'Smart search failed.';
      return { kind: 'error', message: errMessage };
    }
    return { kind: 'ok', result: payload as ServerIntentResult };
  } catch (error) {
    if ((error as Error).name === 'AbortError') return { kind: 'error', message: 'Cancelled.' };
    return { kind: 'unreachable' };
  } finally {
    window.clearTimeout(timeout);
  }
}

async function beginSearch(query: string, addUserMessage = true): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) {
    setInputError('Describe a color, fabric, occasion, piece count, or budget.');
    chatInput.focus();
    return;
  }

  hideInlineError();
  setInputError(null);
  lastQuery = trimmed;
  if (addUserMessage) messages.push(message('user', trimmed));
  chatInput.value = '';
  renderChat();
  persistConversation();

  const requestId = crypto.randomUUID();
  currentRequestId = requestId;

  setSearching(true, true, 'Understanding your request…');
  const nextStage = window.setTimeout(() => {
    if (currentRequestId === requestId) searchingLabel.textContent = 'Checking the catalog…';
  }, 450);

  const outcome = await fetchTextIntent(trimmed);
  window.clearTimeout(nextStage);
  if (currentRequestId !== requestId) return;
  currentRequestId = null;
  setSearching(false);

  if (outcome.kind === 'unreachable') {
    lastRetriableQuery = trimmed;
    showInlineError('Search interrupted', 'Could not reach the local search proxy. Make sure it is running (see README), then retry.', true);
    messages.push(message('assistant', 'I could not reach the local search service. Retry, or type your request again.'));
    renderChat();
    persistConversation();
    return;
  }
  if (outcome.kind === 'error') {
    lastRetriableQuery = trimmed;
    showInlineError('Search interrupted', outcome.message, true);
    messages.push(message('assistant', `${outcome.message} Retry, or edit the request and try again.`));
    renderChat();
    persistConversation();
    return;
  }

  lastRetriableQuery = null;
  await applyServerResult(outcome.result);
}

async function cancelSearch(): Promise<void> {
  currentRequestId = null;
  setSearching(false);
}

function resetConversation(): void {
  void cancelSearch();
  hideInlineError();
  messages = [welcomeMessage];
  currentIntent = null;
  currentProducts = null;
  currentRelaxed = false;
  lastQuery = '';
  lastRetriableQuery = null;
  renderResults(null, false);
  renderChat();
  void chrome.storage.local.remove(CONVERSATION_KEY);
  chatInput.focus();
}

// --- Product detail (bareeze-specific: real add-to-bag needs the actual
// live page, unlike a generic in-grid "Add to Cart" a crawled snapshot
// alone can't safely offer — see README for why this differs from a
// straight visual port) --------------------------------------------------
function hideProductDetail(): void {
  setPane('results');
}

function findListingCard(slug: string): ListingCard | null {
  return currentProducts?.find((item) => item.slug === slug) ?? null;
}

function showProductDetail(product: ProductDetail, fallbackCard: ListingCard | null = null): void {
  setPane('detail');

  productDetailBody.replaceChildren();
  const primaryImage = product.images[0] || fallbackCard?.imageUrl || null;
  if (primaryImage) {
    const img = document.createElement('img');
    img.className = 'detail-image';
    img.src = primaryImage;
    img.alt = '';
    productDetailBody.append(img);
  }
  const title = document.createElement('h2');
  title.id = 'product-detail-title';
  title.textContent = product.title;
  productDetailBody.append(title);
  if (product.sku) {
    const sku = document.createElement('p');
    sku.className = 'sku';
    sku.textContent = `SKU: ${product.sku}`;
    productDetailBody.append(sku);
  }
  const price = document.createElement('p');
  price.className = 'price';
  price.textContent = product.price;
  productDetailBody.append(price);
  if (product.compareAtPrice && product.compareAtPrice !== product.price) {
    const compareAt = document.createElement('p');
    compareAt.className = 'detail-compare-price';
    compareAt.textContent = product.compareAtPrice;
    productDetailBody.append(compareAt);
  }

  const stock = document.createElement('p');
  stock.className = `detail-stock ${product.inStock === false ? 'is-out' : 'is-in'}`;
  stock.textContent = product.inStock === false ? 'Out of stock' : product.inStock === true ? 'In stock' : 'Check availability on site';
  productDetailBody.append(stock);

  const sizes = product.availableSizes.length ? product.availableSizes : (fallbackCard?.availableSizes ?? []);
  if (sizes.length) {
    const sizeMeta = document.createElement('p');
    sizeMeta.className = 'detail-meta';
    sizeMeta.textContent = `Available sizes: ${sizes.join(', ')}`;
    productDetailBody.append(sizeMeta);
  }

  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'primary-action';
  addButton.textContent = 'Add to Bag';
  addButton.disabled = product.inStock === false;
  if (product.inStock === false) addButton.textContent = 'Sold out';
  const status = document.createElement('p');
  status.className = 'add-status';

  // Only ever shown once a bag genuinely exists — viewCartUrl/checkoutUrl
  // arrive from ADD_TO_BAG_RESULT (read off Bareeze's own cart drawer;
  // checkoutUrl is a per-session path Bareeze mints, so it isn't known
  // until then). checkoutUrl can come back null if the drawer didn't
  // render in time; falling back to the cart page keeps the button honest
  // — it still lands the shopper on a real path to checkout, on Bareeze's
  // own site, rather than promising something this extension can't do.
  const cartActions = document.createElement('div');
  cartActions.className = 'cart-actions';
  cartActions.hidden = true;
  let viewCartUrl = '/cart';
  let checkoutUrl: string | null = null;
  const viewCartButton = document.createElement('button');
  viewCartButton.type = 'button';
  viewCartButton.className = 'header-button';
  viewCartButton.textContent = 'View Cart';
  viewCartButton.addEventListener('click', () => void sendMessage({ type: 'OPEN_PATH', path: viewCartUrl }));
  const checkoutButton = document.createElement('button');
  checkoutButton.type = 'button';
  checkoutButton.className = 'primary-action';
  checkoutButton.textContent = 'Checkout';
  checkoutButton.addEventListener('click', () => void sendMessage({
    type: 'OPEN_CHECKOUT',
    checkoutUrl,
    viewCartUrl,
  }));
  cartActions.append(viewCartButton, checkoutButton);

  addButton.addEventListener('click', async () => {
    addButton.disabled = true;
    addButton.textContent = 'Adding…';
    cartActions.hidden = true;
    const response = await sendMessage({ type: 'ADD_TO_BAG', slug: product.slug });
    if (response.type === 'ADD_TO_BAG_RESULT' && response.ok) {
      status.textContent = `Added to your ${STORE_ASSISTANT_LABEL} cart.`;
      addButton.textContent = 'Added';
      viewCartUrl = response.viewCartUrl || '/cart';
      checkoutUrl = response.checkoutUrl ?? null;
      upsertCartItem(
        {
          ...product,
          images: primaryImage ? [primaryImage, ...product.images.filter((image) => image !== primaryImage)] : product.images,
        },
        viewCartUrl,
        checkoutUrl,
      );
      await refreshCartFromSite({
        viewCartUrl,
        checkoutUrl,
      });
      cartActions.hidden = false;
    } else {
      status.textContent = response.type === 'ADD_TO_BAG_RESULT' ? response.error || 'Could not add to bag.' : 'Could not add to bag.';
      addButton.disabled = false;
      addButton.textContent = product.inStock === false ? 'Sold out' : 'Add to Bag';
    }
  });
  productDetailBody.append(addButton, status, cartActions);
  title.focus();
}

async function openProduct(slug: string): Promise<void> {
  const response = await sendMessage({ type: 'OPEN_PRODUCT', slug });
  if (response.type === 'PRODUCT_RESULT') {
    showProductDetail(response.product, findListingCard(slug));
  } else {
    messages.push(message('assistant', 'Could not open that product — try again.'));
    renderChat();
    persistConversation();
  }
}

// --- Voice ----------------------------------------------------------------
function extensionForMime(mime: string): string {
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  return 'webm';
}

async function transcribeAndSearch(blob: Blob, mimeType: string): Promise<void> {
  if (blob.size === 0) {
    showInlineError('Voice search', 'No audio was recorded. Try again.', false);
    return;
  }
  if (blob.size > MAX_AUDIO_BYTES) {
    showInlineError('Voice search', 'That recording is too long. Keep it under 15 seconds.', false);
    return;
  }

  const requestId = crypto.randomUUID();
  currentRequestId = requestId;
  setSearching(true, true, 'Understanding your request…');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), INTENT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${VOICE_API_BASE_URL}/voice-intent`, {
      method: 'POST',
      headers: {
        'Content-Type': mimeType || 'audio/webm',
        ...(currentIntent ? { 'X-Previous-Intent': encodeURIComponent(JSON.stringify(currentIntent)) } : {}),
      },
      body: blob,
      signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (currentRequestId !== requestId) return;
    currentRequestId = null;
    setSearching(false);
    if (!response.ok) {
      const errMessage = payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error: unknown }).error) : 'Voice search failed.';
      lastRetriableQuery = null;
      showInlineError('Voice search', errMessage, false);
      return;
    }
    const transcript = (payload as { transcript?: string }).transcript ?? '';
    messages.push(message('user', transcript || '(unclear recording)'));
    lastQuery = transcript;
    renderChat();
    persistConversation();
    await applyServerResult(payload as ServerIntentResult);
  } catch {
    if (currentRequestId !== requestId) return;
    currentRequestId = null;
    setSearching(false);
    showInlineError('Voice search', 'Could not reach the local search proxy. Make sure it is running (see README).', true);
  } finally {
    window.clearTimeout(timeout);
  }
}

function finishRecordingUI(): void {
  stopRecordingClock();
  recordingStrip.hidden = true;
  micButton.classList.remove('recording');
  micButton.setAttribute('aria-pressed', 'false');
  micButton.setAttribute('aria-label', 'Start voice request');
}

function stopRecordingClock(): void {
  if (recordingTimer !== null) window.clearInterval(recordingTimer);
  recordingTimer = null;
}

const recorder = new VoiceRecorder(async (blob, mimeType) => {
  finishRecordingUI();
  await transcribeAndSearch(blob, mimeType);
});

async function handleMicStartError(error: unknown): Promise<void> {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('mic-setup.html') });
    setInputError('Finish microphone setup in the new tab, then tap the mic again.');
    return;
  }
  showInlineError(
    'Microphone',
    name === 'NotFoundError'
      ? 'No microphone was found. Connect one and try again.'
      : 'Could not start the microphone. Check your browser and system settings.',
    false,
  );
}

async function startRecording(): Promise<void> {
  hideInlineError();
  try {
    await recorder.start();
    recordingStrip.hidden = false;
    micButton.classList.add('recording');
    micButton.setAttribute('aria-pressed', 'true');
    micButton.setAttribute('aria-label', 'Stop recording');
    recordingStartedAt = Date.now();
    const update = () => {
      const seconds = Math.floor((Date.now() - recordingStartedAt) / 1000);
      recordingTime.textContent = `0:${String(seconds).padStart(2, '0')}`;
    };
    update();
    recordingTimer = window.setInterval(update, 250);
  } catch (error) {
    await handleMicStartError(error);
  }
}

function cancelRecording(): void {
  recorder.cancel();
  finishRecordingUI();
}

// --- Layout / persistence --------------------------------------------------
function setExpanded(expanded: boolean): void {
  document.body.classList.toggle('is-expanded', expanded);
  document.documentElement.classList.toggle('is-expanded', expanded);
  layoutToggle.setAttribute('aria-pressed', String(expanded));
  layoutToggle.setAttribute('aria-label', expanded ? 'Use compact width' : 'Use expanded width');
  layoutToggle.title = expanded ? 'Use compact width' : 'Use expanded width';
  void chrome.storage.local.set({ [LAYOUT_KEY]: expanded });
}

async function restoreState(): Promise<void> {
  const durable = await chrome.storage.local.get([CONVERSATION_KEY, LAYOUT_KEY, CART_KEY]);
  setExpanded(durable[LAYOUT_KEY] !== false);

  const conversation = durable[CONVERSATION_KEY] as ConversationState | undefined;
  if (conversation && Date.now() - conversation.updatedAt < CONVERSATION_MAX_AGE_MS) {
    messages = conversation.messages.length ? conversation.messages : [welcomeMessage];
    currentIntent = conversation.currentIntent;
    lastQuery = conversation.lastQuery;
    renderResults(conversation.currentProducts, conversation.currentRelaxed);
  } else {
    renderResults(null, false);
  }
  const cart = durable[CART_KEY] as CartState | undefined;
  if (cart?.items) {
    currentCart = {
      items: cart.items,
      viewCartUrl: cart.viewCartUrl || '/cart',
      checkoutUrl: cart.checkoutUrl ?? null,
      updatedAt: cart.updatedAt || 0,
    };
  }
  renderCart();
  await refreshCartFromSite();
  renderChat();
}

async function checkActiveStore(): Promise<void> {
  checkStoreButton.disabled = true;
  checkStoreButton.textContent = 'Checking…';
  storeContext.classList.remove('is-unsupported');
  storeName.textContent = 'Checking store…';

  let response: PopupResponse;
  try {
    response = await sendMessage({ type: 'CHECK_STORE' });
  } catch {
    response = { type: 'ERROR', error: 'Could not check the active tab.' };
  } finally {
    checkStoreButton.disabled = false;
    checkStoreButton.textContent = 'Check current tab';
  }

  if (response.type === 'STORE_OK') {
    storeName.textContent = STORE_STATUS_LABEL;
    workspaceView.hidden = false;
    blockingView.hidden = true;
    chatInput.focus();
  } else {
    storeName.textContent = 'Unsupported page';
    storeContext.classList.add('is-unsupported');
    workspaceView.hidden = true;
    blockingView.hidden = false;
    blockingTitle.focus();
  }
}

// --- Wiring -----------------------------------------------------------------
chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void beginSearch(chatInput.value);
});
chatInput.addEventListener('input', () => setInputError(null));
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});
micButton.addEventListener('click', () => {
  if (recorder.isRecording) recorder.stop();
  else void startRecording();
});
mustElement('stop-recording').addEventListener('click', () => recorder.stop());
mustElement('cancel-recording').addEventListener('click', cancelRecording);
mustElement('cancel-search').addEventListener('click', () => void cancelSearch());
mustElement('new-search').addEventListener('click', resetConversation);
mustElement('back-to-results').addEventListener('click', hideProductDetail);
mustElement('cart-close').addEventListener('click', hideProductDetail);
cartToggle.addEventListener('click', () => {
  if (activePane === 'cart') hideProductDetail();
  else void showCartView();
});
cartViewSiteButton.addEventListener('click', () => void sendMessage({ type: 'OPEN_PATH', path: currentCart.viewCartUrl || '/cart' }));
cartCheckoutButton.addEventListener('click', () => void sendMessage({
  type: 'OPEN_CHECKOUT',
  checkoutUrl: currentCart.checkoutUrl,
  viewCartUrl: currentCart.viewCartUrl || '/cart',
}));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshCartFromSite();
});
retryButton.addEventListener('click', () => {
  if (lastRetriableQuery) void beginSearch(lastRetriableQuery, false);
});
layoutToggle.addEventListener('click', () => setExpanded(!document.body.classList.contains('is-expanded')));
checkStoreButton.addEventListener('click', () => void checkActiveStore());
// Keeps the store context in sync automatically on the rare case the popup
// stays open across a tab switch (e.g. via keyboard shortcut).
chrome.tabs.onActivated.addListener(() => void checkActiveStore());
loadMoreButton.addEventListener('click', () => appendNextProductBatch());
productsPane.addEventListener(
  'scroll',
  () => {
    if (productsPane.scrollTop > 0) productPaneHasScrolled = true;
  },
  { passive: true },
);
new IntersectionObserver(
  (entries) => {
    if (productPaneHasScrolled && entries.some((entry) => entry.isIntersecting)) appendNextProductBatch();
  },
  { root: productsPane, rootMargin: '180px 0px' },
).observe(productScrollSentinel);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (recorder.isRecording) cancelRecording();
  else if (currentRequestId) void cancelSearch();
});
window.addEventListener('pagehide', () => {
  if (recorder.isRecording) recorder.cancel();
  stopRecordingClock();
});

void restoreState();
blockingTitle.textContent = STORE_OPEN_PROMPT;
blockingMessage.textContent = STORE_BLOCKING_COPY;
workspaceView.setAttribute('aria-label', `${STORE_ASSISTANT_LABEL} shopping workspace`);
if (chatInputLabel) chatInputLabel.textContent = `Message the ${STORE_ASSISTANT_LABEL} assistant`;
void checkActiveStore();
