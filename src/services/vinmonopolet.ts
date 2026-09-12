import * as cheerio from "cheerio";
import { z } from "zod";
import {
  FETCH_CONCURRENCY,
  MAX_LIMIT,
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
} from "../constants.js";
import { getCachedBeer, getConfigValue, setCachedBeer } from "../db/database.js";
import type {
  VinmonopoletProduct,
  VinmonopoletStockCheck,
  VinmonopoletStockRow,
  VinmonopoletStore,
} from "../types.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
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

const WebsiteSearchResponseSchema = z.looseObject({
  products: z.array(z.unknown()).optional(),
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
});

function parseValidEntries<T>(label: string, schema: z.ZodType<T>, rows: unknown[]): T[] {
  const valid: T[] = [];
  rows.forEach((row, index) => {
    const result = schema.safeParse(row);
    if (result.success) {
      valid.push(result.data);
    } else {
      console.error(
        `polvenn: dropping malformed ${label} at index ${index}: ${result.error.message}`,
      );
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

async function websiteRequest(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(path, VINMONOPOLET_WEB_BASE);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetchWithRetry(url.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Vinmonopolet website error ${response.status}: ${response.statusText}. ${body}`,
    );
  }

  return response.json();
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
      volume: null,
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

async function getWebsiteBeerListings(
  query: string,
  maxResults = 25,
): Promise<VinmonopoletProduct[]> {
  const payload = parseEnvelope(
    WebsiteSearchResponseSchema,
    await websiteSearchRequest({
      q: query,
      fields: "FULL",
      pageSize: String(maxResults),
      currentPage: "0",
    }),
    "vinmonopolet.no search",
  );

  const candidates = (payload.products ?? []) as VinmonopoletWebsiteSearchProduct[];

  // Each candidate needs its own detail lookup; run them with bounded
  // concurrency instead of one-at-a-time so a 100-item listing doesn't
  // turn into 100 sequential requests.
  const products = await mapWithConcurrency(candidates, FETCH_CONCURRENCY, async (candidate) => {
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
  });

  return products
    .filter((product): product is VinmonopoletProduct => product != null)
    .filter(isBeer);
}

export async function getUpcomingBeers(maxResults = 25): Promise<VinmonopoletProduct[]> {
  return getWebsiteBeerListings(":relevance:upcomingProduct:true:mainCategory:øl", maxResults);
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

  const payload = parseEnvelope(
    WebsiteStockLocatorResponseSchema,
    await websiteRequest(
      `${VINMONOPOLET_WEB_PRODUCT_STOCK_PATH}/${encodeURIComponent(productId)}/stock`,
      {
        pageSize: "10",
        currentPage: "0",
        fields: "BASIC",
        latitude: latitude.toString(),
        longitude: longitude.toString(),
      },
    ),
    "vinmonopolet.no stock locator",
  );

  const rows = (
    (payload.stores ?? []) as NonNullable<VinmonopoletWebsiteStockLocatorResponse["stores"]>
  )
    .map((entry): VinmonopoletStockRow | null => {
      const pointOfService = entry.pointOfService;
      const matchedStoreId = pointOfService?.id ?? pointOfService?.name;
      const stockLevel = entry.stockInfo?.stockLevel;

      if (!matchedStoreId || stockLevel == null) {
        return null;
      }

      return {
        productId,
        storeId: matchedStoreId,
        stock: stockLevel,
      };
    })
    .filter((row): row is VinmonopoletStockRow => row != null);

  return rows;
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
