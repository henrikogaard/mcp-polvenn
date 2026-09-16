// Vinmonopolet API
export const VINMONOPOLET_API_BASE = "https://apis.vinmonopolet.no";
export const VINMONOPOLET_WEB_BASE = "https://www.vinmonopolet.no";
export const VINMONOPOLET_IMAGE_BASE = "https://bilder.vinmonopolet.no/cache";
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

// Website search pagination: enough pages to fill a max-size listing without
// hammering an undocumented endpoint.
export const WEBSITE_SEARCH_PAGE_SIZE = 25;
export const MAX_WEBSITE_SEARCH_PAGES = 4;

// The stock locator lists stores by proximity; paginate until the target
// store is found or a sane cap is reached.
export const STOCK_LOCATOR_PAGE_SIZE = 25;
export const MAX_STOCK_LOCATOR_PAGES = 8;

// Facet listings can be huge; cap how many values we report per facet.
export const MAX_FACET_VALUES = 30;

// The store list changes rarely; cache it in-memory to avoid re-fetching the
// full list on every nearby-store or store-id lookup.
export const STORES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// App identity — keep in sync with the version in package.json
export const SERVER_NAME = "polvenn-mcp-server";
export const SERVER_VERSION = "0.3.0";
export const PRIMARY_TOOL_PREFIX = "polvenn";

// Database
export const DB_FILENAME = "polvenn.db";
export const DATA_DIRNAME = ".polvenn";
export const DATA_DIR_ENV_VAR = "POLVENN_DATA_DIR";

// User-Agent for HTTP requests
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;
