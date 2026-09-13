import * as cheerio from "cheerio";
import { z } from "zod";
import {
  FETCH_CONCURRENCY,
  MAX_FACET_VALUES,
  MAX_LIMIT,
  MAX_STOCK_LOCATOR_PAGES,
  MAX_WEBSITE_SEARCH_PAGES,
  STOCK_LOCATOR_PAGE_SIZE,
  STORES_CACHE_TTL_MS,
  USER_AGENT,
  VINMONOPOLET_API_BASE,
  VINMONOPOLET_PRODUCTS_PATH,
  VINMONOPOLET_STOCK_PATH,
  VINMONOPOLET_STORES_PATH,
  VINMONOPOLET_WEB_BASE,
  VINMONOPOLET_WEB_PRODUCT_STOCK_PATH,
  VINMONOPOLET_WEB_SEARCH_PATH,
  VINMONOPOLET_WEB_STORES_PATH,
  WEBSITE_SEARCH_PAGE_SIZE,
} from "../constants.js";
import { getCachedBeer, getConfigValue, setCachedBeer } from "../db/database.js";
import type {
  VinmonopoletProduct,
  VinmonopoletStockCheck,
  VinmonopoletStockRow,
  VinmonopoletStore,
} from "../types.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { warn } from "../utils/diagnostics.js";
import { haversineDistanceKm } from "../utils/geo.js";
import { fetchWithRetry } from "../utils/http.js";

// Lenient response schemas: these endpoints are only loosely documented, so we
// validate just the invariants the code relies on and let everything else
// through. Non-conforming entries are dropped with a warning instead of
// failing the whole tool call (see parseValidEntries / parseEnvelope).
const ApiProductSchema = z.looseObject({
  basic: z.looseObject({ productId: z.string().min(1) }),
});

const ApiStoreSchema = z.looseObject({
  storeId: z.string().min(1),
  storeName: z.string().min(1),
});

const ApiStockRowSchema = z.looseObject({
  productId: z.string().min(1),
  storeId: z.string().min(1),
  stock: z.number(),
});

const WebsitePaginationSchema = z.looseObject({
  totalPages: z.number().optional(),
  totalResults: z.number().optional(),
});

const WebsiteSearchResponseSchema = z.looseObject({
  products: z.array(z.unknown()).optional(),
  facets: z.array(z.unknown()).optional(),
  pagination: WebsitePaginationSchema.optional(),
});

const WebsiteStoreSchema = z.looseObject({
  geoPoint: z
    .looseObject({
      latitude: z.number().optional(),
      longitude: z.number().optional(),
    })
    .optional(),
});

const WebsiteStockLocatorResponseSchema = z.looseObject({
  stores: z.array(z.unknown()).optional(),
  pagination: WebsitePaginationSchema.optional(),
});

const WebsiteBarcodeResponseSchema = z.looseObject({
  code: z.string().optional(),
  name: z.string().optional(),
});

function parseValidEntries<T>(label: string, schema: z.ZodType<T>, rows: unknown[]): T[] {
  const valid: T[] = [];
  rows.forEach((row, index) => {
    const result = schema.safeParse(row);
    if (result.success) {
      valid.push(result.data);
    } else {
      warn(`dropping malformed ${label} at index ${index}: ${result.error.message}`);
    }
  });
  return valid;
}

function parseEnvelope<T>(schema: z.ZodType<T>, payload: unknown, source: string): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new Error(`Unexpected ${source} response shape: ${result.error.message}`);
  }
  return result.data;
}

interface VinmonopoletWebsiteProduct {
  code?: string;
  name?: string;
  ageLimit?: number;
  buyable?: boolean;
  status?: string;
  product_selection?: string;
  price?: {
    value?: number;
  };
  volume?: {
    value?: number;
  };
  content?: {
    traits?: Array<{
      name?: string;
      readableValue?: string;
    }>;
  };
  main_category?: {
    name?: string;
  };
  main_sub_category?: {
    name?: string;
  };
  main_producer?: {
    name?: string;
  };
  main_wholesaler?: {
    name?: string;
  };
  country?: {
    name?: string;
  };
  characteristics?: {
    color?: string | null;
    odor?: string | null;
    taste?: string | null;
  };
}

interface VinmonopoletProductPagePayload {
  product?: VinmonopoletWebsiteProduct;
}

interface VinmonopoletWebsiteSearchProduct {
  code?: string;
  name?: string;
  buyable?: boolean;
  status?: string;
  url?: string;
  product_selection?: string;
  alcohol?: {
    value?: number;
  };
  price?: {
    value?: number;
  };
  volume?: {
    value?: number;
  };
  main_category?: {
    name?: string;
  };
  main_sub_category?: {
    name?: string;
  };
  main_producer?: {
    name?: string;
  };
  main_country?: {
    name?: string;
  };
}

interface VinmonopoletWebsiteStore {
  id?: string;
  name?: string;
  displayName?: string;
  geoPoint?: {
    latitude?: number;
    longitude?: number;
  };
}

interface VinmonopoletWebsiteStockLocatorResponse {
  stores?: Array<{
    pointOfService?: VinmonopoletWebsiteStore;
    stockInfo?: {
      stockLevel?: number;
    };
  }>;
}

async function getApiKey(): Promise<string> {
  const key = await getConfigValue("vinmonopolet_api_key");
  if (!key) {
    throw new Error(
      "Vinmonopolet API key not configured. Use polvenn_configure to set it. " +
        "Register at https://api.vinmonopolet.no and subscribe to the 'Open' product.",
    );
  }
  return key;
}

async function apiRequest(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(path, VINMONOPOLET_API_BASE);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetchWithRetry(url.toString(), {
    headers: {
      "Ocp-Apim-Subscription-Key": await getApiKey(),
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Vinmonopolet API error ${response.status}: ${response.statusText}. ${body}`);
  }

  return response.json();
}

// Minimal cookie jar for website requests: the site may set cookies that
// later requests are expected to present, and cookie-less clients risk being
// treated differently. Best-effort — never blocks a request.
const websiteCookies = new Map<string, string>();

function cookieHeader(): Record<string, string> {
  if (websiteCookies.size === 0) {
    return {};
  }
  const cookie = Array.from(websiteCookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return { Cookie: cookie };
}

function rememberCookies(response: Response): void {
  const setCookie =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const raw of setCookie) {
    const [pair] = raw.split(";");
    const separator = pair.indexOf("=");
    if (separator > 0) {
      websiteCookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }
}

/** Test hook: forget remembered website cookies. */
export function resetWebsiteCookiesForTests(): void {
  websiteCookies.clear();
}

async function websiteRequest(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(path, VINMONOPOLET_WEB_BASE);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetchWithRetry(url.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      ...cookieHeader(),
    },
  });

  rememberCookies(response);

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Vinmonopolet website error ${response.status}: ${response.statusText}. ${body}`,
    );
  }

  const payload: unknown = await response.json();

  // The website API signals failures inside an otherwise-200 body.
  if (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { errors?: unknown }).errors) &&
    ((payload as { errors: unknown[] }).errors.length ?? 0) > 0
  ) {
    throw new Error(
      `Vinmonopolet website error in response body: ${JSON.stringify((payload as { errors: unknown[] }).errors)}`,
    );
  }

  return payload;
}

async function websiteSearchRequest(params: Record<string, string>): Promise<unknown> {
  return websiteRequest(VINMONOPOLET_WEB_SEARCH_PATH, params);
}

function normalizeSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, "_");
}

function parseDecimalValue(value: string): number | null {
  const match = value.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) {
    return null;
  }

  const parsed = Number.parseFloat(match[1].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function getAlcoholContentFromWebsiteProduct(product: VinmonopoletWebsiteProduct): number | null {
  for (const trait of product.content?.traits ?? []) {
    if (trait.name?.toLowerCase() === "alkohol" && trait.readableValue) {
      return parseDecimalValue(trait.readableValue);
    }
  }

  return null;
}

function buildProductPageUrl(productId: string): string {
  return new URL(`/p/${encodeURIComponent(productId)}`, VINMONOPOLET_WEB_BASE).toString();
}

function isDetailedProduct(product: VinmonopoletProduct): boolean {
  return Boolean(
    product.classification?.mainProductTypeName &&
      product.origins?.productionOrigin?.producerName &&
      product.prices?.salesPrice != null,
  );
}

function hasReusableCachedProduct(product: VinmonopoletProduct): boolean {
  return (
    isDetailedProduct(product) && Boolean(product.lastChanged?.date && product.lastChanged?.time)
  );
}

function mergeProductData(
  apiProduct: VinmonopoletProduct | null,
  fallbackProduct: VinmonopoletProduct,
): VinmonopoletProduct {
  if (!apiProduct) {
    return fallbackProduct;
  }

  return {
    basic: { ...fallbackProduct.basic, ...apiProduct.basic },
    lastChanged: apiProduct.lastChanged ?? fallbackProduct.lastChanged,
    classification: apiProduct.classification
      ? { ...(fallbackProduct.classification ?? {}), ...apiProduct.classification }
      : fallbackProduct.classification,
    origins: apiProduct.origins
      ? {
          origin: {
            ...(fallbackProduct.origins?.origin ?? {}),
            ...apiProduct.origins.origin,
          },
          productionOrigin: {
            ...(fallbackProduct.origins?.productionOrigin ?? {}),
            ...apiProduct.origins.productionOrigin,
          },
        }
      : fallbackProduct.origins,
    logistics: apiProduct.logistics
      ? { ...(fallbackProduct.logistics ?? {}), ...apiProduct.logistics }
      : fallbackProduct.logistics,
    prices: apiProduct.prices
      ? { ...(fallbackProduct.prices ?? {}), ...apiProduct.prices }
      : fallbackProduct.prices,
    availability: apiProduct.availability
      ? { ...(fallbackProduct.availability ?? {}), ...apiProduct.availability }
      : fallbackProduct.availability,
    description: apiProduct.description
      ? { ...(fallbackProduct.description ?? {}), ...apiProduct.description }
      : fallbackProduct.description,
  };
}

function mapWebsiteProductToVinmonopoletProduct(
  product: VinmonopoletWebsiteProduct,
  productPageUrl: string,
): VinmonopoletProduct {
  const productId = product.code?.trim();
  const productShortName = product.name?.trim();
  if (!productId || !productShortName) {
    throw new Error("Vinmonopolet product page payload did not include a code and name.");
  }

  return {
    basic: {
      productId,
      productShortName,
      productLongName: productShortName,
      volume: product.volume?.value ?? null,
      alcoholContent: getAlcoholContentFromWebsiteProduct(product),
      vintage: null,
      ageLimit: product.ageLimit != null ? String(product.ageLimit) : null,
      packagingMaterialId: null,
      packagingMaterial: null,
      volumeType: null,
      corkType: null,
      bottlePerSalesUnit: null,
      introductionDate: null,
      productStatusSaleName: product.status ?? null,
      productStatusSaleCode: null,
      isNewProduct: false,
    },
    classification: {
      mainProductTypeId: "",
      mainProductTypeName: product.main_category?.name ?? "",
      subProductTypeId: null,
      subProductTypeName: product.main_sub_category?.name ?? null,
      productGroupId: null,
      productGroupName: null,
    },
    origins: {
      origin: {
        country: product.country?.name ?? null,
        countryId: null,
        regionId: null,
        region: null,
        subRegionId: null,
        subRegion: null,
      },
      productionOrigin: {
        producerId: null,
        producerName: product.main_producer?.name ?? null,
      },
    },
    logistics: {
      wholesalerId: null,
      wholesalerName: product.main_wholesaler?.name ?? null,
      vendorId: null,
      vendorName: null,
    },
    prices: {
      salesPrice: product.price?.value ?? null,
      salesPricePrLiter: null,
      bottleReturnValue: null,
    },
    availability: {
      buyable: product.buyable,
      productSelection: product.product_selection ?? null,
      status: product.status ?? null,
      productPageUrl,
    },
    description: {
      characteristics: {
        colour: product.characteristics?.color ?? null,
        odour: product.characteristics?.odor ?? null,
        taste: product.characteristics?.taste ?? null,
      },
    },
  };
}

function mapWebsiteSearchProductToVinmonopoletProduct(
  product: VinmonopoletWebsiteSearchProduct,
): VinmonopoletProduct | null {
  const productId = product.code?.trim();
  const productShortName = product.name?.trim();
  if (!productId || !productShortName) {
    return null;
  }

  return {
    basic: {
      productId,
      productShortName,
      productLongName: productShortName,
      alcoholContent: product.alcohol?.value ?? null,
      volume: product.volume?.value ?? null,
      vintage: null,
      ageLimit: null,
      packagingMaterialId: null,
      packagingMaterial: null,
      volumeType: null,
      corkType: null,
      bottlePerSalesUnit: null,
      introductionDate: null,
      productStatusSaleName: product.status ?? null,
      productStatusSaleCode: null,
      isNewProduct: false,
    },
    classification: {
      mainProductTypeId: "",
      mainProductTypeName: product.main_category?.name ?? "",
      subProductTypeId: null,
      subProductTypeName: product.main_sub_category?.name ?? null,
      productGroupId: null,
      productGroupName: null,
    },
    origins: {
      origin: {
        country: product.main_country?.name ?? null,
        countryId: null,
        regionId: null,
        region: null,
        subRegionId: null,
        subRegion: null,
      },
      productionOrigin: {
        producerId: null,
        producerName: product.main_producer?.name ?? null,
      },
    },
    prices:
      product.price?.value != null
        ? {
            salesPrice: product.price.value,
            salesPricePrLiter: null,
            bottleReturnValue: null,
          }
        : undefined,
    availability: {
      buyable: product.buyable,
      productSelection: product.product_selection ?? null,
      status: product.status ?? null,
      productPageUrl: product.url ? new URL(product.url, VINMONOPOLET_WEB_BASE).toString() : null,
    },
  };
}

export function parseProductFromProductPageHtml(
  html: string,
  productPageUrl: string,
): VinmonopoletProduct {
  const $ = cheerio.load(html);
  const payloadText = $("main script[type='application/json']").first().text().trim();

  if (!payloadText) {
    throw new Error("Vinmonopolet product page did not contain an embedded product payload.");
  }

  const payload = JSON.parse(payloadText) as VinmonopoletProductPagePayload;
  if (!payload.product) {
    throw new Error("Vinmonopolet product page payload did not include a product.");
  }

  return mapWebsiteProductToVinmonopoletProduct(payload.product, productPageUrl);
}

async function getProductFromProductPage(productId: string): Promise<VinmonopoletProduct> {
  const productPageUrl = buildProductPageUrl(productId);
  const response = await fetchWithRetry(productPageUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`Vinmonopolet product page error ${response.status}: ${response.statusText}.`);
  }

  return parseProductFromProductPageHtml(await response.text(), productPageUrl);
}

export function getProductName(product: VinmonopoletProduct): string {
  return product.basic.productShortName;
}

export function getProductProducer(product: VinmonopoletProduct): string | null {
  return product.origins?.productionOrigin?.producerName ?? null;
}

export function getProductStyle(product: VinmonopoletProduct): string | null {
  return product.classification?.subProductTypeName ?? null;
}

export function getProductAbv(product: VinmonopoletProduct): number | null {
  return product.basic.alcoholContent ?? null;
}

export function getProductCountry(product: VinmonopoletProduct): string | null {
  return product.origins?.origin?.country ?? null;
}

export function getProductLastChangedAt(product: VinmonopoletProduct): string | null {
  const date = product.lastChanged?.date;
  const time = product.lastChanged?.time;
  if (!date || !time) {
    return null;
  }

  return `${date}T${time}`;
}

export function isStockAccessLimitedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:401|403|404)|restricted|forbidden|resource not found/i.test(message);
}

export function isInvalidApiKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /401|invalid subscription key|access denied due to invalid subscription key/i.test(
    message,
  );
}

/** Fetch all products, optionally filtered by changedSince date */
export async function getProducts(
  options: { changedSince?: string; maxResults?: number; start?: number } = {},
): Promise<VinmonopoletProduct[]> {
  const params: Record<string, string> = {};
  if (options.changedSince) params.changedSince = options.changedSince;
  if (options.maxResults) params.maxResults = String(options.maxResults);
  if (options.start) params.start = String(options.start);

  const payload = await apiRequest(VINMONOPOLET_PRODUCTS_PATH, params);
  const rows = Array.isArray(payload) ? payload : [];
  return parseValidEntries("product", ApiProductSchema, rows) as unknown as VinmonopoletProduct[];
}

/**
 * The official API's details-normal responses have been slimmed down to
 * `basic` + `lastChanged` only. This fills in the missing detail (style,
 * category, prices, …) from cached or scraped product pages, leaving already
 * complete products untouched. Best-effort per product.
 */
export async function enrichSlimProducts(
  products: VinmonopoletProduct[],
): Promise<VinmonopoletProduct[]> {
  return mapWithConcurrency(products, FETCH_CONCURRENCY, async (product) => {
    if (product.classification?.mainProductTypeName) {
      return product;
    }

    const productId = product.basic.productId;

    const cached = await getCachedBeer(productId);
    if (cached) {
      const parsed = JSON.parse(cached) as VinmonopoletProduct;
      if (parsed.classification?.mainProductTypeName) {
        return mergeProductData(parsed, product);
      }
    }

    try {
      const pageProduct = await getProductFromProductPage(productId);
      const merged = mergeProductData(pageProduct, product);
      await setCachedBeer(productId, JSON.stringify(merged), "vinmonopolet");
      return merged;
    } catch {
      return product;
    }
  });
}

/** One page of the website product search. */
async function getWebsiteSearchPage(
  query: string,
  page: number,
  pageSize: number,
): Promise<{ payload: z.infer<typeof WebsiteSearchResponseSchema> }> {
  const payload = parseEnvelope(
    WebsiteSearchResponseSchema,
    await websiteSearchRequest({
      q: query,
      fields: "FULL",
      pageSize: String(pageSize),
      currentPage: String(page),
    }),
    "vinmonopolet.no search",
  );
  return { payload };
}

async function getWebsiteBeerListings(
  query: string,
  maxResults = 25,
): Promise<VinmonopoletProduct[]> {
  const candidates: VinmonopoletWebsiteSearchProduct[] = [];
  let page = 0;
  let totalPages = 1;

  // Follow pagination (capped) until we have enough candidates to fill the
  // requested result size after beer-filtering.
  do {
    const { payload } = await getWebsiteSearchPage(query, page, WEBSITE_SEARCH_PAGE_SIZE);
    candidates.push(...((payload.products ?? []) as VinmonopoletWebsiteSearchProduct[]));
    totalPages = Math.max(1, Math.floor(payload.pagination?.totalPages ?? page + 1));
    page += 1;
  } while (
    page < totalPages &&
    page < MAX_WEBSITE_SEARCH_PAGES &&
    candidates.filter((candidate) => candidate.code).length < maxResults
  );

  const limitedCandidates = candidates.slice(0, maxResults);

  // Each candidate needs its own detail lookup; run them with bounded
  // concurrency instead of one-at-a-time so a 100-item listing doesn't
  // turn into 100 sequential requests.
  const products = await mapWithConcurrency(
    limitedCandidates,
    FETCH_CONCURRENCY,
    async (candidate) => {
      const productId = candidate.code?.trim();
      if (!productId) {
        return null;
      }

      const mapped = mapWebsiteSearchProductToVinmonopoletProduct(candidate);
      const detailed = await getProductById(productId);
      if (detailed) {
        return mapped ? mergeProductData(detailed, mapped) : detailed;
      }
      return mapped;
    },
  );

  return products
    .filter((product): product is VinmonopoletProduct => product != null)
    .filter(isBeer);
}

export type WebsiteProductSort =
  | "relevance"
  | "name_asc"
  | "name_desc"
  | "price_asc"
  | "price_desc";

/**
 * Free-text product search against vinmonopolet.no. Needs no API key, covers
 * the whole assortment (including bestillingsutvalget), and supports sorting
 * by name or price.
 */
export async function searchWebsiteProducts(
  query: string,
  options: { maxResults?: number; sort?: WebsiteProductSort } = {},
): Promise<VinmonopoletProduct[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const maxResults = Math.min(Math.max(options.maxResults ?? 25, 1), MAX_LIMIT);
  // The website wire format joins sort field and order with a hyphen
  // (e.g. "price-asc"), while our public enum uses underscores.
  const sortParam = (options.sort ?? "relevance").replace(/_(asc|desc)$/, "-$1");
  const searchQuery = `${trimmedQuery}:${sortParam}`;

  const { payload } = await getWebsiteSearchPage(searchQuery, 0, maxResults);
  const candidates = (payload.products ?? []) as VinmonopoletWebsiteSearchProduct[];

  return candidates
    .map((candidate) => mapWebsiteSearchProductToVinmonopoletProduct(candidate))
    .filter((product): product is VinmonopoletProduct => product != null)
    .slice(0, maxResults);
}

/** Look up a product by EAN-13 barcode via the vinmonopolet.no website API. */
export async function getProductByBarcode(barcode: string): Promise<VinmonopoletProduct | null> {
  const payload = parseEnvelope(
    WebsiteBarcodeResponseSchema,
    await websiteRequest(`/vmpws/v2/vmp/products/barCodeSearch/${encodeURIComponent(barcode)}`, {
      fields: "FULL",
    }),
    "vinmonopolet.no barcode search",
  );

  return mapWebsiteSearchProductToVinmonopoletProduct(payload as VinmonopoletWebsiteSearchProduct);
}

export interface SearchFacetValue {
  name: string;
  count: number | null;
}

export interface SearchFacet {
  name: string;
  displayName: string | null;
  values: SearchFacetValue[];
}

/**
 * Fetch the facet tree (available filters). The old dedicated facets endpoint
 * died in a site rebuild; the search response itself carries the facets now.
 */
export async function getSearchFacets(): Promise<SearchFacet[]> {
  const { payload } = await getWebsiteSearchPage(":relevance", 0, 1);

  const facets = (payload.facets ?? []) as Array<{
    code?: unknown;
    name?: unknown;
    values?: unknown;
  }>;

  const result: SearchFacet[] = [];
  for (const facet of facets) {
    if (typeof facet.code !== "string") {
      continue;
    }

    const rawValues = Array.isArray(facet.values) ? facet.values : [];
    const values: SearchFacetValue[] = [];
    for (const rawValue of rawValues.slice(0, MAX_FACET_VALUES)) {
      if (
        typeof rawValue === "object" &&
        rawValue !== null &&
        typeof (rawValue as { name?: unknown }).name === "string"
      ) {
        const count = (rawValue as { count?: unknown }).count;
        values.push({
          name: (rawValue as { name: string }).name,
          count: typeof count === "number" ? count : null,
        });
      }
    }

    result.push({
      name: facet.code,
      displayName: typeof facet.name === "string" ? facet.name : null,
      values,
    });
  }

  return result;
}

const UPCOMING_BEERS_QUERY = ":relevance:upcomingProduct:true:mainCategory:øl";

export async function getUpcomingBeers(maxResults = 25): Promise<VinmonopoletProduct[]> {
  // A vinmonopolet.no site rebuild removed the "Kommende nyheter" listing:
  // the query still succeeds but matches nothing, which would silently look
  // like "no upcoming beers". Detect the removed facet and say so instead.
  const probe = parseEnvelope(
    WebsiteSearchResponseSchema,
    await websiteSearchRequest({
      q: UPCOMING_BEERS_QUERY,
      fields: "FULL",
      pageSize: "1",
      currentPage: "0",
    }),
    "vinmonopolet.no search",
  );

  const facetCodes = new Set(
    ((probe.facets ?? []) as Array<{ code?: unknown }>)
      .map((facet) => (typeof facet.code === "string" ? facet.code : ""))
      .filter(Boolean),
  );

  if (!facetCodes.has("upcomingProduct")) {
    throw new Error(
      "Vinmonopolet's 'Kommende nyheter' listing is no longer available: the upcomingProduct facet was removed from vinmonopolet.no in a site rebuild, and no replacement has been found yet.",
    );
  }

  return getWebsiteBeerListings(UPCOMING_BEERS_QUERY, maxResults);
}

export async function getNewBeers(maxResults = MAX_LIMIT): Promise<VinmonopoletProduct[]> {
  return getWebsiteBeerListings(":relevance:newProducts:true:mainCategory:øl", maxResults);
}

export async function getNewBeersForStore(
  storeId: string,
  maxResults = MAX_LIMIT,
): Promise<VinmonopoletProduct[]> {
  return getWebsiteBeerListings(
    `:relevance:mainCategory:øl:newProducts:true:availableInStores:${storeId}`,
    maxResults,
  );
}

/** Search products by name */
export async function searchProducts(
  query: string,
  maxResults = 25,
): Promise<VinmonopoletProduct[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  if (/^\d+$/.test(trimmedQuery)) {
    const product = await getProductById(trimmedQuery);
    return product ? [product] : [];
  }

  const payload = await apiRequest(VINMONOPOLET_PRODUCTS_PATH, {
    productShortNameContains: normalizeSearchQuery(trimmedQuery),
    maxResults: String(maxResults),
  });
  const rows = Array.isArray(payload) ? payload : [];
  return parseValidEntries("product", ApiProductSchema, rows) as unknown as VinmonopoletProduct[];
}

/** Get a single product by ID */
export async function getProductById(productId: string): Promise<VinmonopoletProduct | null> {
  const cached = await getCachedBeer(productId);
  if (cached) {
    const parsed = JSON.parse(cached) as VinmonopoletProduct;
    if (hasReusableCachedProduct(parsed)) {
      return parsed;
    }
  }

  let apiProduct: VinmonopoletProduct | null = null;
  try {
    const payload = await apiRequest(VINMONOPOLET_PRODUCTS_PATH, {
      productId,
    });
    const products = Array.isArray(payload)
      ? (parseValidEntries(
          "product",
          ApiProductSchema,
          payload,
        ) as unknown as VinmonopoletProduct[])
      : [];
    apiProduct = products[0] ?? null;
  } catch {
    apiProduct = null;
  }

  let product = apiProduct;
  if (!product || !isDetailedProduct(product)) {
    try {
      const productFromPage = await getProductFromProductPage(productId);
      product = mergeProductData(product, productFromPage);
    } catch {
      if (!product) {
        return null;
      }
    }
  }

  if (product) {
    await setCachedBeer(productId, JSON.stringify(product), "vinmonopolet");
  }

  return product;
}

let storeListCache: { stores: VinmonopoletStore[]; fetchedAt: number } | null = null;
let storeListFetch: Promise<VinmonopoletStore[]> | null = null;

/** Get all stores, cached in memory for STORES_CACHE_TTL_MS */
export async function getStores(): Promise<VinmonopoletStore[]> {
  if (storeListCache && Date.now() - storeListCache.fetchedAt < STORES_CACHE_TTL_MS) {
    return storeListCache.stores;
  }

  // Share a single in-flight request between concurrent callers.
  if (!storeListFetch) {
    storeListFetch = (async () => {
      try {
        const payload = await apiRequest(VINMONOPOLET_STORES_PATH);
        const rows = Array.isArray(payload) ? payload : [];
        const stores = parseValidEntries(
          "store",
          ApiStoreSchema,
          rows,
        ) as unknown as VinmonopoletStore[];
        storeListCache = { stores, fetchedAt: Date.now() };
        return stores;
      } finally {
        storeListFetch = null;
      }
    })();
  }

  return storeListFetch;
}

/** Test hook: forget the in-memory store list cache. */
export function resetStoreListCacheForTests(): void {
  storeListCache = null;
  storeListFetch = null;
}

/** Get stock for a product, optionally filtered by store */
export async function getStock(
  options: { productId?: string; storeId?: string; changedSince?: string } = {},
): Promise<VinmonopoletStockRow[]> {
  const params: Record<string, string> = {};
  if (options.productId) params.productId = options.productId;
  if (options.storeId) params.storeId = options.storeId;
  if (options.changedSince) params.changedSince = options.changedSince;

  const payload = await apiRequest(VINMONOPOLET_STOCK_PATH, params);
  const rows = Array.isArray(payload) ? payload : [];
  return parseValidEntries(
    "stock row",
    ApiStockRowSchema,
    rows,
  ) as unknown as VinmonopoletStockRow[];
}

async function getWebsiteStoreById(storeId: string) {
  const payload = parseEnvelope(
    WebsiteStoreSchema,
    await websiteRequest(`${VINMONOPOLET_WEB_STORES_PATH}/${encodeURIComponent(storeId)}`, {
      fields: "FULL",
    }),
    "vinmonopolet.no store",
  );
  return payload;
}

interface StockLocatorEntry {
  storeId: string;
  storeName: string | null;
  stockLevel: number;
}

async function getStockLocatorPage(
  productId: string,
  latitude: number,
  longitude: number,
  page: number,
): Promise<{ entries: StockLocatorEntry[]; totalPages: number }> {
  const payload = parseEnvelope(
    WebsiteStockLocatorResponseSchema,
    await websiteRequest(
      `${VINMONOPOLET_WEB_PRODUCT_STOCK_PATH}/${encodeURIComponent(productId)}/stock`,
      {
        pageSize: String(STOCK_LOCATOR_PAGE_SIZE),
        currentPage: String(page),
        fields: "BASIC",
        latitude: latitude.toString(),
        longitude: longitude.toString(),
      },
    ),
    "vinmonopolet.no stock locator",
  );

  const rawEntries = (payload.stores ?? []) as NonNullable<
    VinmonopoletWebsiteStockLocatorResponse["stores"]
  >;

  const entries = rawEntries
    .map((entry): StockLocatorEntry | null => {
      const pointOfService = entry.pointOfService;
      const matchedStoreId = pointOfService?.id ?? pointOfService?.name;
      const stockLevel = entry.stockInfo?.stockLevel;
      if (!matchedStoreId || stockLevel == null) {
        return null;
      }
      return {
        storeId: matchedStoreId,
        storeName: pointOfService?.displayName ?? pointOfService?.name ?? null,
        stockLevel,
      };
    })
    .filter((entry): entry is StockLocatorEntry => entry != null);

  const totalPages = Math.max(1, Math.floor(payload.pagination?.totalPages ?? page + 1));
  return { entries, totalPages };
}

/**
 * Pages through the vinmonopolet.no stock locator (stores listed by
 * proximity) collecting stock entries, until `shouldContinue` says stop.
 */
async function collectStockLocatorEntries(
  productId: string,
  latitude: number,
  longitude: number,
  shouldContinue: (collected: StockLocatorEntry[], page: number, totalPages: number) => boolean,
): Promise<StockLocatorEntry[]> {
  const collected: StockLocatorEntry[] = [];
  let page = 0;
  let totalPages = 1;

  do {
    const { entries, totalPages: pages } = await getStockLocatorPage(
      productId,
      latitude,
      longitude,
      page,
    );
    totalPages = pages;
    collected.push(...entries);
    page += 1;
  } while (
    page < totalPages &&
    page < MAX_STOCK_LOCATOR_PAGES &&
    shouldContinue(collected, page, totalPages)
  );

  return collected;
}

async function getWebsiteStockRows(
  productId: string,
  storeId: string,
): Promise<VinmonopoletStockRow[]> {
  const store = await getWebsiteStoreById(storeId);
  const latitude = store.geoPoint?.latitude;
  const longitude = store.geoPoint?.longitude;

  if (latitude == null || longitude == null) {
    throw new Error(`Vinmonopolet website store ${storeId} did not include coordinates.`);
  }

  // The locator lists stores by proximity; keep paging until the target
  // store appears so a stocked store outside the first page is not missed.
  const entries = await collectStockLocatorEntries(
    productId,
    latitude,
    longitude,
    (collected) => !collected.some((entry) => entry.storeId === storeId),
  );

  return entries.map((entry) => ({
    productId,
    storeId: entry.storeId,
    stock: entry.stockLevel,
  }));
}

export interface WebsiteStoreStock {
  storeId: string;
  storeName: string;
  stockLevel: number;
}

/**
 * Finds stores that currently have a product in stock, ordered by distance
 * from the given coordinates (the stock locator's native ordering).
 */
export async function findStoresWithProductStock(
  productId: string,
  latitude: number,
  longitude: number,
  maxStores = 20,
): Promise<WebsiteStoreStock[]> {
  const entries = await collectStockLocatorEntries(
    productId,
    latitude,
    longitude,
    (collected) => collected.filter((entry) => entry.stockLevel > 0).length < maxStores,
  );

  return entries
    .filter((entry) => entry.stockLevel > 0)
    .slice(0, maxStores)
    .map((entry) => ({
      storeId: entry.storeId,
      storeName: entry.storeName ?? entry.storeId,
      stockLevel: entry.stockLevel,
    }));
}

export async function checkStoreStock(
  productId: string,
  storeId: string,
): Promise<VinmonopoletStockCheck> {
  try {
    const rows = await getStock({ productId, storeId });
    const stockLevel = rows[0]?.stock ?? 0;
    return {
      status: "verified",
      stockLevel,
      rows,
      storeStockConclusion: stockLevel > 0 ? "in_stock" : "out_of_stock",
      stockSource: "official_api",
      websiteAvailabilityIsStoreStock: false,
    };
  } catch (error: unknown) {
    try {
      const rows = await getWebsiteStockRows(productId, storeId);
      const matchedRow = rows.find((row) => row.storeId === storeId);
      const stockLevel = matchedRow?.stock ?? 0;

      return {
        status: "verified",
        stockLevel,
        rows: matchedRow ? [matchedRow] : [],
        storeStockConclusion: stockLevel > 0 ? "in_stock" : "out_of_stock",
        stockSource: "website_stock_locator",
        websiteAvailabilityIsStoreStock: false,
        message: matchedRow
          ? "Verified via vinmonopolet.no store stock locator."
          : "Verified via vinmonopolet.no store stock locator: the store was not listed among stores with stock.",
      };
    } catch (websiteError: unknown) {
      if (!isStockAccessLimitedError(error) && !isInvalidApiKeyError(error)) {
        throw error;
      }

      const details = [];
      if (isInvalidApiKeyError(error)) {
        details.push("The configured Vinmonopolet API key is invalid.");
      } else {
        details.push(
          "Vinmonopolet's official stock endpoint is not available with the current API access.",
        );
      }

      const fallbackMessage =
        websiteError instanceof Error ? websiteError.message : String(websiteError);
      if (fallbackMessage) {
        details.push(`Website stock fallback failed: ${fallbackMessage}`);
      }

      return {
        status: "unverified",
        stockLevel: null,
        rows: [],
        storeStockConclusion: "unknown",
        stockSource: "unverified",
        websiteAvailabilityIsStoreStock: false,
        message: `${details.join(" ")} Store-level stock is unknown.`,
      };
    }
  }
}

/** Filter products that are beer (mainProductTypeName contains "Øl") */
export function isBeer(product: VinmonopoletProduct): boolean {
  const typeName = product.classification?.mainProductTypeName?.toLowerCase() ?? "";
  return typeName.includes("øl");
}

/** Find stores near a given lat/lon, sorted by distance */
export async function findNearbyStores(
  lat: number,
  lon: number,
  maxResults = 5,
): Promise<Array<VinmonopoletStore & { distanceKm: number }>> {
  const stores = await getStores();

  const withDistance = stores
    .filter((store) => store.address?.gpsCoord)
    .map((store) => {
      const [storeLat, storeLon] = store.address.gpsCoord.split(";").map(Number);
      const distanceKm = haversineDistanceKm(lat, lon, storeLat, storeLon);
      return { ...store, distanceKm };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return withDistance.slice(0, maxResults);
}

export async function getStoreById(storeId: string): Promise<VinmonopoletStore | null> {
  const stores = await getStores();
  return stores.find((store) => store.storeId === storeId) ?? null;
}

export interface OpeningHoursToday {
  dayOfTheWeek: string;
  openingTime: string;
  closingTime: string;
  closed: boolean;
}

// The store API may use Norwegian or English day names; match either.
const WEEKDAY_NAMES: string[][] = [
  ["søndag", "sunday"], // 0
  ["mandag", "monday"], // 1
  ["tirsdag", "tuesday"], // 2
  ["onsdag", "wednesday"], // 3
  ["torsdag", "thursday"], // 4
  ["fredag", "friday"], // 5
  ["lørdag", "saturday"], // 6
];

export function getTodaysOpeningHours(
  store: VinmonopoletStore,
  date: Date = new Date(),
): OpeningHoursToday | null {
  const candidates = WEEKDAY_NAMES[date.getDay()] ?? [];
  const hours = store.openingHours?.regularHours ?? [];
  return (
    hours.find((entry) => candidates.includes(entry.dayOfTheWeek?.toLowerCase() ?? "")) ?? null
  );
}
