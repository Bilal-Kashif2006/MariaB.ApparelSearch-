// Message contracts between popup, background, and content scripts, plus
// the real data shapes scraped off bareeze.com. See README.md for the
// verified DOM structure these are read from.

export interface ListingCard {
  slug: string; // e.g. "shadow-work-42", from the card's own link href
  title: string;
  subtitle: string | null; // e.g. "New Selection" / "Casuals"
  price: string; // display string as shown, e.g. "PKR 20,050"
  imageUrl: string | null;
}

export interface ProductDetail {
  slug: string;
  title: string;
  sku: string | null;
  price: string;
  images: string[];
  options: string[]; // whatever the page's own option radiogroup offers, if any
}

// Bareeze's own real category/fabric pages — confirmed from the live site's
// nav menu, not guessed. The popup search maps a shopper's words to the
// closest of these rather than running its own search index.
export const CATEGORY_PATHS: Record<string, string> = {
  casuals: '/casuals',
  formals: '/formals',
  shawls: '/shawls',
  'new in': '/new-in',
  prints: '/prints/view-all',
  embroidered: '/formals',
  sale: '/sale',
  pret: '/bareeze-pret',
  lawn: '/fabric/lawn',
  khaddar: '/fabric/khaddar',
  velvet: '/fabric/velvet',
  chiffon: '/fabric/chiffon',
  organza: '/fabric/organza',
  net: '/fabric/net',
  cotton: '/fabric/cotton',
  cambric: '/fabric/cambric',
  karandi: '/fabric/karandi',
};

export type PopupRequest =
  | { type: 'SCRAPE_ACTIVE_TAB' }
  | { type: 'OPEN_CATEGORY'; path: string }
  | { type: 'OPEN_PRODUCT'; slug: string }
  | { type: 'ADD_TO_BAG'; slug: string }
  | { type: 'CHECK_STORE' };

export type PopupResponse =
  | { type: 'LISTING_RESULT'; cards: ListingCard[]; pageUrl: string }
  | { type: 'PRODUCT_RESULT'; product: ProductDetail; pageUrl: string }
  | { type: 'PRODUCT_OPENED'; slug: string }
  | { type: 'ADD_TO_BAG_RESULT'; ok: boolean; error?: string }
  | { type: 'NOT_A_BAREEZE_PAGE' }
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
