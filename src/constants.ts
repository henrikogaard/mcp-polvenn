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
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const CHARACTER_LIMIT = 50_000;
export const REQUEST_RETRY_ATTEMPTS = 3;
export const REQUEST_RETRY_BASE_DELAY_MS = 500;
export const VINMONOPOLET_PAGE_SIZE = 100;

// App identity
export const SERVER_NAME = "polvenn-mcp-server";
export const PRIMARY_TOOL_PREFIX = "polvenn";

// Database
export const DB_FILENAME = "polvenn.db";
export const DATA_DIRNAME = ".polvenn";
export const DATA_DIR_ENV_VAR = "POLVENN_DATA_DIR";

// User-Agent for HTTP requests
export const USER_AGENT = `${SERVER_NAME}/0.1.0`;
