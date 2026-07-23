// Message contracts between popup, background, and content scripts, plus
// the real data shapes scraped off Maria B pages.

export interface ListingCard {
  slug: string; // e.g. "shadow-work-42", from the card's own link href
  title: string;
  subtitle: string | null; // e.g. "New Selection" / "Casuals"
  price: string; // display string as shown, e.g. "PKR 20,050"
  imageUrl: string | null;
  inStock?: boolean | null;
  onSale?: boolean | null;
  compareAtPrice?: string | null;
  availableSizes?: string[] | null;
  availableVariantCount?: number | null;
  salePercent?: number | null;
}

export interface ProductDetail {
  slug: string;
  title: string;
  sku: string | null;
  price: string;
  compareAtPrice?: string | null;
  images: string[];
  options: string[]; // whatever the live product page exposes, if any
  availableSizes: string[];
  inStock: boolean | null;
}

// Maria B collection landing pages. The extension's primary search path is
// the local catalog served by server/, so these are only used for light
// site hand-offs such as "show me something fresh" when there is no local
// catalog result to render.
export const CATEGORY_PATHS: Record<string, string> = {
  'new arrivals': '/collections/all',
  casuals: '/collections/all',
  'luxury pret': '/collections/all',
  'luxury formals': '/collections/all',
  'wedding wear': '/collections/all',
  couture: '/collections/all',
  accessories: '/collections/all',
  unstitched: '/collections/all',
  lawn: '/collections/all',
  linen: '/collections/all',
  chiffon: '/collections/all',
  cotton: '/collections/all',
  silk: '/collections/all',
};

export type PopupRequest =
  | { type: 'SCRAPE_ACTIVE_TAB' }
  | { type: 'OPEN_CATEGORY'; path: string }
  | { type: 'OPEN_PRODUCT'; slug: string }
  | { type: 'ADD_TO_BAG'; slug: string }
  | { type: 'OPEN_PATH'; path: string }
  | { type: 'OPEN_CHECKOUT'; checkoutUrl?: string | null; viewCartUrl?: string | null }
  | { type: 'SYNC_CART' }
  | { type: 'CHECK_STORE' };

export type PopupResponse =
  | { type: 'LISTING_RESULT'; cards: ListingCard[]; pageUrl: string }
  | { type: 'PRODUCT_RESULT'; product: ProductDetail; pageUrl: string }
  // viewCartUrl/checkoutUrl come from the real cart drawer Maria B itself
  // opens right after a successful add — checkoutUrl in particular is a
  // per-session path (a UUID Bareeze mints for that cart), never a fixed
  // route, so it can only be read off the page, not constructed here.
  | { type: 'ADD_TO_BAG_RESULT'; ok: boolean; error?: string; viewCartUrl?: string | null; checkoutUrl?: string | null }
  | { type: 'CART_SYNC_RESULT'; cart: CartState; synced: boolean; error?: string }
  | { type: 'PATH_OPENED' }
  | { type: 'NOT_A_STORE_PAGE' }
  | { type: 'STORE_OK' }
  | { type: 'ERROR'; error: string };

// --- Chat-based search state -------------------------------------------
// Mirrors CatalogIntent in server/src/catalog.ts — the shopper's last
// resolved, canonical request, echoed back to the server on the next
// message so a follow-up like "cheaper" or "green instead" merges against
// it instead of being treated as an unrelated fresh search (see
// mergeCatalogIntent server-side).
export interface CanonicalIntent {
  collection: string | null;
  fabric: string | null;
  color: string | null;
  type: string | null;
  pieceCount: string | null;
  occasion: string | null;
  priceMax: number | null;
}

export interface DeterministicCatalogTerm {
  term: string;
  reason: string;
  question?: string;
}

export interface QueryConfidence {
  matchedFacetCount: number;
  ambiguousFacetCount: number;
  unmatchedConceptCount: number;
  onlyWeakFacets: boolean;
  mode: 'exact-search' | 'relaxed-search' | 'clarify-first' | 'guided-rewrite';
}

export interface DeterministicInterpretation {
  normalizedRawIntent: {
    collection?: string | null;
    fabric?: string | null;
    color?: string | null;
    type?: string | null;
    pieceCount?: string | null;
    occasion?: string | null;
    priceMax?: number | null;
  };
  canonicalIntent: CanonicalIntent;
  appliedFacets: CanonicalIntent;
  ambiguousTerms: DeterministicCatalogTerm[];
  unmatchedTerms: string[];
  suggestedRewrites: string[];
  clarificationReason: string | null;
  confidence: QueryConfidence;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

// Persisted to chrome.storage.local so the conversation survives the
// popup closing — Chrome can destroy popup.html's whole document the
// instant it loses focus, unlike a normal tab.
export interface ConversationState {
  messages: ChatMessage[];
  currentIntent: CanonicalIntent | null;
  currentProducts: ListingCard[] | null;
  currentRelaxed: boolean;
  lastQuery: string;
  updatedAt: number;
}

export interface CartItem {
  slug: string;
  title: string;
  price: string;
  imageUrl: string | null;
  quantity: number;
  addedAt: number;
}

export interface CartState {
  items: CartItem[];
  viewCartUrl: string;
  checkoutUrl: string | null;
  updatedAt: number;
}
