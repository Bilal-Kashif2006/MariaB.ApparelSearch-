import { CATEGORY_PATHS } from './contracts';
import type { ShoppingIntent } from './intent';

const PRICE_FLOOR = 0;
const DEFAULT_SORT = 'newest';

// No collection/fabric named at all: land on a broad Maria B collection page.
const DEFAULT_BASE_PATH = CATEGORY_PATHS['new arrivals'];

function encodeToken(value: string): string {
  return encodeURIComponent(value);
}

// Bareeze's own filter drawer applies multiple attribute facets by joining
// names and values with a literal "+", positionally paired — confirmed live:
// checking Color=Green then Type=Embroidered lands on
// `attribute_name=Type+Color&attribute_value=Embroidered+Green`. Collection
// and fabric are not part of this mechanism — they instead pick the base
// path (e.g. /casuals, /fabric/lawn), since Bareeze has no combined
// "casuals that are also lawn" URL. When both are named, collection wins:
// it's the more distinctive, intentional part of a request ("formals" vs
// "casuals") whereas fabric is usually a modifier.
export function intentToBareezeUrl(intent: ShoppingIntent): string {
  const basePath =
    (intent.collection && CATEGORY_PATHS[intent.collection]) ||
    (intent.fabric && CATEGORY_PATHS[intent.fabric]) ||
    DEFAULT_BASE_PATH;

  const attributeNames: string[] = [];
  const attributeValues: string[] = [];
  if (intent.color) {
    attributeNames.push('Color');
    attributeValues.push(intent.color);
  }
  if (intent.type) {
    attributeNames.push('Type');
    attributeValues.push(intent.type);
  }
  if (intent.pieceCount) {
    attributeNames.push('Size');
    attributeValues.push(intent.pieceCount);
  }

  const params: string[] = [];
  if (attributeNames.length > 0) {
    params.push(`attribute_name=${attributeNames.map(encodeToken).join('+')}`);
    params.push(`attribute_value=${attributeValues.map(encodeToken).join('+')}`);
  }
  if (intent.priceMax != null && Number.isFinite(intent.priceMax) && intent.priceMax > 0) {
    params.push(`price=${PRICE_FLOOR}-${Math.round(intent.priceMax)}`);
  }
  params.push(`sort=${DEFAULT_SORT}`);

  return `${basePath}?${params.join('&')}`;
}
