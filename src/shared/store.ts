import rawConfig from '../../store.config.json';

export interface StoreConfig {
  brandKey: string;
  brandName: string;
  assistantName: string;
  site: {
    origin: string;
    primaryDomain: string;
    hostnames: string[];
    productPathPrefix: string;
    fallbackCollectionPath: string;
  };
  extension: {
    name: string;
    description: string;
    defaultTitle: string;
    conversationKey: string;
    layoutKey: string;
    cspImageHosts: string[];
  };
  server: {
    catalogDbRelativePath: string;
    productUrlPrefix: string;
    catalogScopeLabel: string;
    supportedCollections: string[];
    supportedFabrics: string[];
  };
}

export const STORE_CONFIG = rawConfig as StoreConfig;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const STORE_HOST_PATTERNS = STORE_CONFIG.site.hostnames.map((hostname) => `https://${hostname}/*`);
export const STORE_URL_PATTERN = new RegExp(
  `^https://(?:${STORE_CONFIG.site.hostnames.map(escapeRegex).join('|')})/`,
);

export const STORE_ASSISTANT_LABEL = STORE_CONFIG.assistantName;
export const STORE_STATUS_LABEL = `Live on ${STORE_CONFIG.site.primaryDomain}`;
export const STORE_OPEN_PROMPT = `Open ${STORE_CONFIG.site.primaryDomain}`;
export const STORE_BLOCKING_COPY = `Open ${STORE_CONFIG.site.primaryDomain} in the active tab, then reopen this extension.`;
