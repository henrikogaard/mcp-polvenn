// Vinmonopolet API
export const VINMONOPOLET_API_BASE = "https://apis.vinmonopolet.no";
export const VINMONOPOLET_WEB_BASE = "https://www.vinmonopolet.no";
export const VINMONOPOLET_PRODUCTS_PATH = "/products/v0/details-normal";
export const VINMONOPOLET_STORES_PATH = "/stores/v0/details";
export const VINMONOPOLET_STOCK_PATH = "/products/v0/accumulated-stock";
export const VINMONOPOLET_WEB_SEARCH_PATH = "/vmpws/v2/vmp/products/search";
export const VINMONOPOLET_WEB_STORES_PATH = "/vmpws/v2/vmp/stores";
export const VINMONOPOLET_WEB_PRODUCT_STOCK_PATH = "/vmpws/v2/vmp/products";
export const RELEASE_FEED_LATEST_PATH = "/releases/latest";

// Defaults
export const MAX_LIMIT = 100;
export const REQUEST_RETRY_ATTEMPTS = 3;
export const REQUEST_RETRY_BASE_DELAY_MS = 500;
export const REQUEST_TIMEOUT_MS = 15_000;
export const FETCH_CONCURRENCY = 5;

// The store list changes rarely; cache it in-memory to avoid re-fetching the
// full list on every nearby-store or store-id lookup.
export const STORES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// App identity — keep in sync with the version in package.json
export const SERVER_NAME = "polvenn-mcp-server";
export const SERVER_VERSION = "0.2.0";
export const PRIMARY_TOOL_PREFIX = "polvenn";

// Database
export const DB_FILENAME = "polvenn.db";
export const DATA_DIRNAME = ".polvenn";
export const DATA_DIR_ENV_VAR = "POLVENN_DATA_DIR";

// User-Agent for HTTP requests
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;
