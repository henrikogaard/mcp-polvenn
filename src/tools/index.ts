import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { MAX_LIMIT } from "../constants.js";
import {
  addWatchlistEntry,
  getAllConfig,
  getConfigValue,
  getSeenWatchlistMatchKeys,
  listWatchlistEntries,
  removeWatchlistEntry,
  setConfig,
  setSeenWatchlistMatchKeys,
} from "../db/database.js";
import {
  CheckStoreStockOutputSchema,
  ConfigureOutputSchema,
  FindNearbyStoresOutputSchema,
  FindStoresWithStockOutputSchema,
  GetChangedProductsOutputSchema,
  GetFacetsOutputSchema,
  GetProductOutputSchema,
  SearchNewBeersNearStoreOutputSchema,
  SearchNewBeersOutputSchema,
  SearchProductsOutputSchema,
  SearchUpcomingBeersOutputSchema,
  ValidateConfigOutputSchema,
  WatchlistOutputSchema,
} from "../schemas/output.js";
import {
  CheckStoreStockSchema,
  ConfigureSchema,
  FindNearbyStoresSchema,
  FindStoresWithStockSchema,
  GetChangedProductsSchema,
  GetFacetsSchema,
  GetProductSchema,
  NewBeersNearStoreSchema,
  SearchNewBeersSchema,
  SearchProductsSchema,
  UpcomingBeersSchema,
  ValidateConfigSchema,
  WatchlistSchema,
} from "../schemas/tools.js";
import * as releaseFeed from "../services/release-feed.js";
import * as vinmonopolet from "../services/vinmonopolet.js";
import {
  formatNumericRuleValue,
  getWatchlistMatchKey,
  matchWatchlistEntries,
  splitWatchlistMatches,
} from "../services/watchlist.js";
import type {
  ExternalRelease,
  VinmonopoletProduct,
  WatchlistEntry,
  WatchlistMatch,
} from "../types.js";
import { buildProductImageUrl } from "../utils/images.js";

export function registerAllTools(server: McpServer): void {
  registerSearchNewBeers(server);
  registerSearchUpcomingBeers(server);
  registerSearchNewBeersNearStore(server);
  registerSearchProducts(server);
  registerGetProduct(server);
  registerCheckStoreStock(server);
  registerFindNearbyStores(server);
  registerFindStoresWithStock(server);
  registerGetChangedProducts(server);
  registerGetFacets(server);
  registerWatchlist(server);
  registerConfigure(server);
  registerValidateConfig(server);
}

const WATCHLIST_RESOURCE_URI = "polvenn://watchlist";

function notifyWatchlistUpdated(server: McpServer): void {
  // Advisory only — relevant for clients that subscribed to the watchlist
  // resource. Never let a notification failure break a tool response.
  server.server.sendResourceUpdated({ uri: WATCHLIST_RESOURCE_URI }).catch(() => {});
}

function createToolResult<T>(schema: z.ZodType<T>, payload: unknown, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: schema.parse(payload),
  };
}

function createToolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

type CapabilityStatus = "ok" | "warning" | "error" | "skipped";

interface ValidationCheck {
  name: string;
  status: CapabilityStatus;
  message: string;
  details?: Record<string, unknown>;
}

interface ResolvedStoreContext {
  storeId: string;
  storeName: string;
  resolution: "explicit" | "home_store" | "nearest_home_location";
  distanceKm?: number;
}

const NORWEGIAN_MONTHS: Record<string, number> = {
  januar: 0,
  februar: 1,
  mars: 2,
  april: 3,
  mai: 4,
  juni: 5,
  juli: 6,
  august: 7,
  september: 8,
  oktober: 9,
  november: 10,
  desember: 11,
};

export interface BeerSearchResult {
  name: string;
  producer: string;
  style: string;
  abv: number;
  articleNumber: string;
  country?: string;
  sources: string[];
  releaseDate: string | null;
  vinmonopoletLastChangedAt: string | null;
  vinmonopoletStatus: string | null;
}

export function mergeBeerSearchResults(
  existing: BeerSearchResult | undefined,
  incoming: BeerSearchResult,
): BeerSearchResult {
  if (!existing) {
    return incoming;
  }

  return {
    ...existing,
    name: existing.name || incoming.name,
    producer: existing.producer || incoming.producer,
    style: existing.style || incoming.style,
    abv: existing.abv || incoming.abv,
    country: existing.country ?? incoming.country,
    sources: [...new Set([...existing.sources, ...incoming.sources])],
    releaseDate: existing.releaseDate ?? incoming.releaseDate,
    vinmonopoletLastChangedAt:
      existing.vinmonopoletLastChangedAt ?? incoming.vinmonopoletLastChangedAt,
    vinmonopoletStatus: existing.vinmonopoletStatus ?? incoming.vinmonopoletStatus,
  };
}

function formatBeerSearchResult(beer: BeerSearchResult, index: number): string {
  const metadata = [
    `Style: ${beer.style}`,
    `ABV: ${beer.abv}%`,
    `Art.nr: ${beer.articleNumber}`,
    beer.country ?? null,
    `[${beer.sources.join(" + ")}]`,
  ].filter((part): part is string => Boolean(part));

  const dateInfo = [
    beer.releaseDate ? `Release: ${beer.releaseDate}` : null,
    beer.vinmonopoletLastChangedAt ? `Last changed: ${beer.vinmonopoletLastChangedAt}` : null,
    beer.vinmonopoletStatus ? `Status: ${beer.vinmonopoletStatus}` : null,
  ].filter((part): part is string => part != null);

  let text = `${index + 1}. **${beer.name}** (${beer.producer})\n   ${metadata.join(" | ")}`;
  if (dateInfo.length > 0) {
    text += `\n   ${dateInfo.join(" | ")}`;
  }

  return text;
}

function formatValidationCheck(check: ValidationCheck): string {
  const icon = {
    ok: "OK",
    warning: "WARN",
    error: "ERROR",
    skipped: "SKIP",
  }[check.status];

  return `${icon} ${check.name}: ${check.message}`;
}

function mapVinmonopoletBeerToSearchResult(
  beer: Awaited<ReturnType<typeof vinmonopolet.getUpcomingBeers>>[number],
  source: string,
): BeerSearchResult {
  return {
    name: vinmonopolet.getProductName(beer),
    producer: vinmonopolet.getProductProducer(beer) ?? "Unknown producer",
    style: vinmonopolet.getProductStyle(beer) ?? "Unknown style",
    abv: vinmonopolet.getProductAbv(beer) ?? 0,
    articleNumber: beer.basic.productId,
    sources: [source],
    country: vinmonopolet.getProductCountry(beer) ?? undefined,
    releaseDate: null,
    vinmonopoletLastChangedAt: vinmonopolet.getProductLastChangedAt(beer),
    vinmonopoletStatus:
      beer.availability?.status ?? (source === "vinmonopolet_upcoming" ? "kommende" : null),
  };
}

function parseSearchResultDate(value: string): number | null {
  if (!value) {
    return null;
  }

  const direct = new Date(value).getTime();
  if (!Number.isNaN(direct)) {
    return direct;
  }

  const match = value
    .trim()
    .toLowerCase()
    .match(/^(\d{1,2})\.\s*([a-zæøå]+)\s*(\d{4})$/i);
  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = NORWEGIAN_MONTHS[match[2]];
  const year = Number(match[3]);
  if (month == null) {
    return null;
  }

  return new Date(year, month, day).getTime();
}

function getSearchDateKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const isoDateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDateMatch) {
    return isoDateMatch[1];
  }

  const norwegianMatch = trimmed.toLowerCase().match(/^(\d{1,2})\.\s*([a-zæøå]+)\s*(\d{4})$/i);
  if (!norwegianMatch) {
    return null;
  }

  const day = String(Number(norwegianMatch[1])).padStart(2, "0");
  const month = NORWEGIAN_MONTHS[norwegianMatch[2]];
  const year = norwegianMatch[3];
  if (month == null) {
    return null;
  }

  return `${year}-${String(month + 1).padStart(2, "0")}-${day}`;
}

export function getBeerSearchResultTimestamp(beer: BeerSearchResult): number | null {
  return (
    parseSearchResultDate(beer.releaseDate ?? "") ??
    parseSearchResultDate(beer.vinmonopoletLastChangedAt ?? "")
  );
}

export function filterBeerSearchResultsSince(
  beers: BeerSearchResult[],
  since: string,
): BeerSearchResult[] {
  const sinceTimestamp = parseSearchResultDate(since);
  if (sinceTimestamp == null) {
    return beers;
  }

  return beers.filter((beer) => {
    if (beer.sources.includes("vinmonopolet_upcoming")) {
      return true;
    }

    const timestamp = getBeerSearchResultTimestamp(beer);
    return timestamp == null || timestamp >= sinceTimestamp;
  });
}

export function filterBeerSearchResultsByReleaseDate(
  beers: BeerSearchResult[],
  releaseDate: string,
): BeerSearchResult[] {
  const targetDateKey = getSearchDateKey(releaseDate);
  if (!targetDateKey) {
    return beers;
  }

  return beers.filter((beer) => {
    const resultDateKey =
      getSearchDateKey(beer.releaseDate ?? "") ??
      getSearchDateKey(beer.vinmonopoletLastChangedAt ?? "");
    return resultDateKey === targetDateKey;
  });
}

async function getRecentExternalReleaseItems(releaseLimit = 3) {
  const releases = await releaseFeed.getLatestReleases(releaseLimit);
  const beersByArticleNumber = new Map<string, ExternalRelease["items"][number]>();

  for (const release of releases) {
    for (const beer of release.items) {
      beersByArticleNumber.set(beer.articleNumber, beer);
    }
  }

  return Array.from(beersByArticleNumber.values());
}

async function resolveStoreContext(requestedStoreId?: string): Promise<ResolvedStoreContext> {
  if (requestedStoreId) {
    const store = await vinmonopolet.getStoreById(requestedStoreId);
    if (!store) {
      throw new Error(`Store ${requestedStoreId} was not found in Vinmonopolet's store list.`);
    }

    return {
      storeId: store.storeId,
      storeName: store.storeName,
      resolution: "explicit",
    };
  }

  const configuredStoreId = await getConfigValue("home_store_id");
  if (configuredStoreId) {
    const store = await vinmonopolet.getStoreById(configuredStoreId);
    if (!store) {
      throw new Error(
        `Configured home store ${configuredStoreId} was not found in Vinmonopolet's store list.`,
      );
    }

    return {
      storeId: store.storeId,
      storeName: store.storeName,
      resolution: "home_store",
    };
  }

  const lat = await getConfigValue("home_latitude").then((value) => (value ? Number(value) : null));
  const lon = await getConfigValue("home_longitude").then((value) =>
    value ? Number(value) : null,
  );
  if (lat == null || lon == null) {
    throw new Error(
      "No store specified and no home store/home location configured. Use polvenn_configure to set a home store or home coordinates, or pass a storeId.",
    );
  }

  const [nearestStore] = await vinmonopolet.findNearbyStores(lat, lon, 1);
  if (!nearestStore) {
    throw new Error(
      "Could not resolve a nearby Vinmonopolet store from your configured home location.",
    );
  }

  return {
    storeId: nearestStore.storeId,
    storeName: nearestStore.storeName,
    resolution: "nearest_home_location",
    distanceKm: nearestStore.distanceKm,
  };
}

function applyBeerSearchFilters(
  beers: BeerSearchResult[],
  options: {
    since?: string;
    style?: string;
    releaseDate?: string;
  },
): BeerSearchResult[] {
  let filtered = beers;

  if (options.since) {
    filtered = filterBeerSearchResultsSince(filtered, options.since);
  }

  if (options.releaseDate) {
    filtered = filterBeerSearchResultsByReleaseDate(filtered, options.releaseDate);
  }

  if (options.style) {
    const styleLower = options.style.toLowerCase();
    filtered = filtered.filter((result) => result.style.toLowerCase().includes(styleLower));
  }

  return filtered;
}

function registerSearchNewBeers(server: McpServer): void {
  server.registerTool(
    "polvenn_search_new_beers",
    {
      title: "Search new beers",
      description: `Search for recently released beers on Vinmonopolet via the official API and/or your external release feed.

Args:
  - source ('vinmonopolet' | 'external' | 'both'): Where to search (default: 'both')
  - since (string, optional): Best-effort date filter yyyy-MM-dd using external release dates, otherwise Vinmonopolet lastChanged
  - includeUpcoming (boolean): Also include beers from Vinmonopolet's "Kommende nyheter" web filter
  - style (string, optional): Filter by beer style, e.g. 'IPA', 'Stout'
  - releaseDate (string, optional): Exact release date filter
  - storeId (string, optional): Limit Vinmonopolet-backed results to beers available in one store
  - limit (number): Max results (default: 25)

Returns: List of new beers with name, producer, style, ABV, article number, and release date.`,
      inputSchema: SearchNewBeersSchema,
      outputSchema: SearchNewBeersOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        if (params.storeId && params.source === "external") {
          return createToolError(
            "storeId filtering requires source='vinmonopolet' or source='both'. The external release feed alone cannot confirm store availability.",
          );
        }

        const since =
          params.since ??
          new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
        const resolvedStore = params.storeId ? await resolveStoreContext(params.storeId) : null;
        const includeUpcoming = params.includeUpcoming && resolvedStore == null;
        let upcomingUnavailable = false;

        const resultMap = new Map<string, BeerSearchResult>();

        if (params.source === "vinmonopolet" || params.source === "both") {
          const beers = resolvedStore
            ? await vinmonopolet.getNewBeersForStore(resolvedStore.storeId, MAX_LIMIT)
            : await vinmonopolet.getNewBeers(MAX_LIMIT);
          for (const beer of beers) {
            const next = mergeBeerSearchResults(
              resultMap.get(beer.basic.productId),
              mapVinmonopoletBeerToSearchResult(
                beer,
                resolvedStore ? "vinmonopolet_store" : "vinmonopolet",
              ),
            );
            resultMap.set(beer.basic.productId, next);
          }

          if (includeUpcoming) {
            try {
              const upcomingBeers = await vinmonopolet.getUpcomingBeers(params.limit);
              for (const beer of upcomingBeers) {
                const next = mergeBeerSearchResults(
                  resultMap.get(beer.basic.productId),
                  mapVinmonopoletBeerToSearchResult(beer, "vinmonopolet_upcoming"),
                );
                resultMap.set(beer.basic.productId, next);
              }
            } catch (error: unknown) {
              // The upcoming listing may be unavailable upstream; degrade to a
              // note instead of failing the whole search.
              upcomingUnavailable = true;
              console.error(`polvenn: upcoming listing unavailable: ${(error as Error).message}`);
            }
          }
        }

        if (params.source === "external" || params.source === "both") {
          const beers = await getRecentExternalReleaseItems();
          for (const beer of beers) {
            if (resolvedStore && !resultMap.has(beer.articleNumber)) {
              continue;
            }

            const next = mergeBeerSearchResults(resultMap.get(beer.articleNumber), {
              name: beer.name,
              producer: beer.producer,
              style: beer.style,
              abv: beer.abv,
              articleNumber: beer.articleNumber,
              sources: ["external"],
              country: beer.country ?? undefined,
              releaseDate: beer.releaseDate || null,
              vinmonopoletLastChangedAt: null,
              vinmonopoletStatus: null,
            });
            resultMap.set(beer.articleNumber, next);
          }
        }

        if (params.releaseDate && !getSearchDateKey(params.releaseDate)) {
          return createToolError(
            "releaseDate must be yyyy-MM-dd or a Norwegian date like '1. april 2026'.",
          );
        }

        const results = Array.from(resultMap.values());
        const filtered = applyBeerSearchFilters(results, {
          since,
          style: params.style,
          releaseDate: params.releaseDate,
        });

        const limited = filtered.slice(0, params.limit);
        const textPrefix = [
          resolvedStore ? `Store: ${resolvedStore.storeName} (${resolvedStore.storeId})` : null,
          resolvedStore?.resolution === "nearest_home_location" && resolvedStore.distanceKm != null
            ? `Resolved from your home coordinates (${resolvedStore.distanceKm.toFixed(1)} km away).`
            : null,
          params.includeUpcoming && resolvedStore
            ? "Upcoming beers were skipped because Vinmonopolet's upcoming listing is not store-specific."
            : null,
          upcomingUnavailable
            ? "Upcoming beers were skipped because Vinmonopolet's 'Kommende nyheter' listing is currently unavailable on vinmonopolet.no."
            : null,
        ].filter((part): part is string => part != null);
        const body =
          limited.length === 0
            ? `No new beers found since ${since}${params.style ? ` matching style '${params.style}'` : ""}${params.releaseDate ? ` on '${params.releaseDate}'` : ""}.`
            : limited.map(formatBeerSearchResult).join("\n\n");
        const text = textPrefix.length > 0 ? `${textPrefix.join("\n")}\n\n${body}` : body;

        return createToolResult(
          SearchNewBeersOutputSchema,
          {
            source: params.source,
            since,
            sinceFilterMode: "best_effort_release_date_or_last_changed",
            includeUpcoming,
            requestedUpcoming: params.includeUpcoming,
            style: params.style ?? null,
            releaseDate: params.releaseDate ?? null,
            store: resolvedStore ?? null,
            totalResults: filtered.length,
            results: limited,
          },
          text,
        );
      } catch (error: unknown) {
        return createToolError(`Error searching for new beers: ${(error as Error).message}`);
      }
    },
  );
}

function registerSearchUpcomingBeers(server: McpServer): void {
  server.registerTool(
    "polvenn_search_upcoming_beers",
    {
      title: "Search upcoming beers",
      description: `Search Vinmonopolet's "Kommende nyheter" web listing for upcoming beer releases.

Args:
  - style (string, optional): Filter by beer style, e.g. 'IPA', 'Stout'
  - limit (number): Max results (default: 25)

Returns: List of upcoming beers with name, producer, style, ABV, article number, and current website status.`,
      inputSchema: UpcomingBeersSchema,
      outputSchema: SearchUpcomingBeersOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const beers = await vinmonopolet.getUpcomingBeers(params.limit);
        const results = beers.map((beer) =>
          mapVinmonopoletBeerToSearchResult(beer, "vinmonopolet_upcoming"),
        );
        const styleFilter = params.style?.toLowerCase();
        const filtered = styleFilter
          ? results.filter((beer) => beer.style.toLowerCase().includes(styleFilter))
          : results;
        const limited = filtered.slice(0, params.limit);

        const text =
          limited.length === 0
            ? `No upcoming beers found${params.style ? ` matching style '${params.style}'` : ""}.`
            : limited.map(formatBeerSearchResult).join("\n\n");

        return createToolResult(
          SearchUpcomingBeersOutputSchema,
          {
            style: params.style ?? null,
            totalResults: filtered.length,
            results: limited,
          },
          text,
        );
      } catch (error: unknown) {
        return createToolError(`Error searching for upcoming beers: ${(error as Error).message}`);
      }
    },
  );
}

function registerSearchNewBeersNearStore(server: McpServer): void {
  server.registerTool(
    "polvenn_search_new_beers_near_store",
    {
      title: "Search new beers near your store",
      description: `Search Vinmonopolet's current "Nyheter" listing for beers available in one store.

Args:
  - storeId (string, optional): Store ID. Falls back to your configured home store, then your nearest store from your home coordinates
  - style (string, optional): Filter by beer style, e.g. 'IPA', 'Stout'
  - releaseDate (string, optional): Exact release date filter
  - limit (number): Max results (default: 25)

Returns: New beers currently available in the selected store, enriched with external release dates when recent feed items match.`,
      inputSchema: NewBeersNearStoreSchema,
      outputSchema: SearchNewBeersNearStoreOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        if (params.releaseDate && !getSearchDateKey(params.releaseDate)) {
          return createToolError(
            "releaseDate must be yyyy-MM-dd or a Norwegian date like '1. april 2026'.",
          );
        }

        const resolvedStore = await resolveStoreContext(params.storeId);
        const beers = await vinmonopolet.getNewBeersForStore(resolvedStore.storeId, MAX_LIMIT);
        const resultMap = new Map<string, BeerSearchResult>();

        for (const beer of beers) {
          resultMap.set(
            beer.basic.productId,
            mapVinmonopoletBeerToSearchResult(beer, "vinmonopolet_store"),
          );
        }

        const externalBeers = await getRecentExternalReleaseItems();
        for (const beer of externalBeers) {
          if (!resultMap.has(beer.articleNumber)) {
            continue;
          }

          resultMap.set(
            beer.articleNumber,
            mergeBeerSearchResults(resultMap.get(beer.articleNumber), {
              name: beer.name,
              producer: beer.producer,
              style: beer.style,
              abv: beer.abv,
              articleNumber: beer.articleNumber,
              sources: ["external"],
              country: beer.country ?? undefined,
              releaseDate: beer.releaseDate || null,
              vinmonopoletLastChangedAt: null,
              vinmonopoletStatus: null,
            }),
          );
        }

        const filtered = applyBeerSearchFilters(Array.from(resultMap.values()), {
          style: params.style,
          releaseDate: params.releaseDate,
        });
        const limited = filtered.slice(0, params.limit);

        const intro = [
          `Store: ${resolvedStore.storeName} (${resolvedStore.storeId})`,
          resolvedStore.resolution === "nearest_home_location" && resolvedStore.distanceKm != null
            ? `Resolved from your home coordinates (${resolvedStore.distanceKm.toFixed(1)} km away).`
            : null,
        ]
          .filter((part): part is string => part != null)
          .join("\n");

        const body =
          limited.length === 0
            ? `No new beers found for this store${params.style ? ` matching style '${params.style}'` : ""}${params.releaseDate ? ` on '${params.releaseDate}'` : ""}.`
            : limited.map(formatBeerSearchResult).join("\n\n");

        return createToolResult(
          SearchNewBeersNearStoreOutputSchema,
          {
            store: resolvedStore,
            style: params.style ?? null,
            releaseDate: params.releaseDate ?? null,
            totalResults: filtered.length,
            results: limited,
          },
          `${intro}\n\n${body}`,
        );
      } catch (error: unknown) {
        return createToolError(
          `Error searching for new beers near store: ${(error as Error).message}`,
        );
      }
    },
  );
}

function registerCheckStoreStock(server: McpServer): void {
  server.registerTool(
    "polvenn_check_store_stock",
    {
      title: "Check store stock",
      description: `Check if a specific beer is in stock at a Vinmonopolet store.

Args:
  - articleNumber (string): Vinmonopolet article number
  - storeId (string, optional): Store ID. Defaults to your configured home store.

Returns: Stock status and product details.`,
      inputSchema: CheckStoreStockSchema,
      outputSchema: CheckStoreStockOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const storeId = params.storeId ?? (await getConfigValue("home_store_id"));
        if (!storeId) {
          return createToolError(
            "No store specified and no home store configured. Use polvenn_configure to set a home store, or pass a storeId.",
          );
        }

        const [product, stockCheck] = await Promise.all([
          vinmonopolet.getProductById(params.articleNumber),
          vinmonopolet.checkStoreStock(params.articleNumber, storeId),
        ]);

        const productName = product
          ? vinmonopolet.getProductName(product)
          : `Article ${params.articleNumber}`;
        const producer = product ? vinmonopolet.getProductProducer(product) : null;
        const style = product ? vinmonopolet.getProductStyle(product) : null;
        const availability = product?.availability;

        let text: string;
        if (stockCheck.status === "verified" && (stockCheck.stockLevel ?? 0) > 0) {
          text = `**${productName}** is in stock (${stockCheck.stockLevel} units) at store ${storeId}.`;
          if (stockCheck.stockSource === "website_stock_locator") {
            text += " Verified via vinmonopolet.no store stock locator.";
          }
        } else if (stockCheck.status === "verified") {
          text = `**${productName}** is not in stock at store ${storeId}.`;
          if (stockCheck.stockSource === "website_stock_locator") {
            text += " Verified via vinmonopolet.no store stock locator.";
          }
          text += " Try polvenn_find_nearby_stores to check other locations.";
        } else {
          const detailParts = [
            producer ? `Producer: ${producer}` : null,
            style ? `Style: ${style}` : null,
            availability?.productSelection ? `Selection: ${availability.productSelection}` : null,
            availability?.status ? `Status: ${availability.status}` : null,
            availability?.buyable === true ? "Marked as buyable on vinmonopolet.no" : null,
          ].filter((part): part is string => part != null);

          text = `**${productName}** was found, but store stock is **unknown** for store ${storeId}. ${stockCheck.message ?? "The official Vinmonopolet stock endpoint is unavailable with the current API access."}`;
          if (detailParts.length > 0) {
            text += `\n\n${detailParts.join(" | ")}`;
          }
          text +=
            "\n\nImportant: this is **not** an out-of-stock result. Website metadata such as selection, buyable status, or product page status must not be treated as verified store stock.";
          text +=
            "\n\nTry the product page or another client with stock access if you need store-level confirmation.";
        }

        return createToolResult(
          CheckStoreStockOutputSchema,
          {
            articleNumber: params.articleNumber,
            storeId,
            productName,
            producer,
            style,
            stockStatus: stockCheck.status,
            stockLevel: stockCheck.stockLevel,
            storeStockConclusion: stockCheck.storeStockConclusion,
            stockSource: stockCheck.stockSource,
            inStock:
              stockCheck.storeStockConclusion === "in_stock"
                ? true
                : stockCheck.storeStockConclusion === "out_of_stock"
                  ? false
                  : null,
            websiteAvailabilityIsStoreStock: stockCheck.websiteAvailabilityIsStoreStock,
            assistantGuidance:
              stockCheck.status === "verified"
                ? stockCheck.stockSource === "website_stock_locator"
                  ? "You may report the verified store stock result directly. This was verified via vinmonopolet.no's store stock locator, not inferred from generic product page metadata."
                  : "You may report the verified store stock result directly."
                : "Do not say the product is out of stock. The correct conclusion is that store-level stock is unknown.",
            availability: availability ?? null,
          },
          text,
        );
      } catch (error: unknown) {
        return createToolError(`Error checking stock: ${(error as Error).message}`);
      }
    },
  );
}

function registerFindNearbyStores(server: McpServer): void {
  server.registerTool(
    "polvenn_find_nearby_stores",
    {
      title: "Find nearby Vinmonopolet stores",
      description: `Find the closest Vinmonopolet stores to a given location.

Args:
  - latitude (number, optional): Defaults to configured home location
  - longitude (number, optional): Defaults to configured home location
  - maxResults (number): How many stores to return (default: 5)

Returns: List of nearby stores with address, distance, category, and opening hours.`,
      inputSchema: FindNearbyStoresSchema,
      outputSchema: FindNearbyStoresOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const lat =
          params.latitude ??
          (await getConfigValue("home_latitude").then((value) => (value ? Number(value) : null)));
        const lon =
          params.longitude ??
          (await getConfigValue("home_longitude").then((value) => (value ? Number(value) : null)));

        if (lat == null || lon == null) {
          return createToolError(
            "No location provided and no home location configured. Use polvenn_configure to set homeLatitude/homeLongitude.",
          );
        }

        const maxResults = params.maxResults ?? 5;
        const stores = await vinmonopolet.findNearbyStores(lat, lon, maxResults);
        const storesWithToday = stores.map((store) => ({
          ...store,
          todayOpeningHours: vinmonopolet.getTodaysOpeningHours(store),
        }));
        const text = storesWithToday
          .map((store, index) => {
            const today = store.todayOpeningHours;
            const todayText = today
              ? today.closed
                ? "Closed today"
                : `Open today ${today.openingTime}–${today.closingTime}`
              : null;
            const address = store.address
              ? `${store.address.street ?? ""}, ${store.address.postalCode ?? ""} ${store.address.city ?? ""}`.trim()
              : null;
            return [
              `${index + 1}. **${store.storeName}** (${store.distanceKm.toFixed(1)} km)`,
              address && address.length > 0 ? `   ${address}` : null,
              `   Category: ${store.category} | ID: ${store.storeId}`,
              todayText ? `   ${todayText}` : null,
            ]
              .filter((part): part is string => part != null)
              .join("\n");
          })
          .join("\n\n");

        return createToolResult(
          FindNearbyStoresOutputSchema,
          {
            latitude: lat,
            longitude: lon,
            maxResults,
            stores: storesWithToday,
          },
          text,
        );
      } catch (error: unknown) {
        return createToolError(`Error finding stores: ${(error as Error).message}`);
      }
    },
  );
}

interface ProductSummary {
  articleNumber: string;
  name: string;
  producer: string | null;
  style: string | null;
  category: string | null;
  abv: number | null;
  volume: number | null;
  price: number | null;
  country: string | null;
  status: string | null;
  productPageUrl: string | null;
  imageUrl: string | null;
}

function toProductSummary(product: VinmonopoletProduct): ProductSummary {
  return {
    articleNumber: product.basic.productId,
    name: vinmonopolet.getProductName(product),
    producer: vinmonopolet.getProductProducer(product),
    style: vinmonopolet.getProductStyle(product),
    category: product.classification?.mainProductTypeName ?? null,
    abv: vinmonopolet.getProductAbv(product),
    volume: product.basic.volume ?? null,
    price: product.prices?.salesPrice ?? null,
    country: vinmonopolet.getProductCountry(product),
    status: product.availability?.status ?? product.basic.productStatusSaleName ?? null,
    productPageUrl: product.availability?.productPageUrl ?? null,
    imageUrl: buildProductImageUrl(product.basic.productId),
  };
}

function formatProductSummary(product: ProductSummary, index: number): string {
  const metadata = [
    product.producer,
    product.style,
    product.category !== product.style ? product.category : null,
    product.abv != null ? `${product.abv}%` : null,
    product.volume != null ? `${product.volume} ml` : null,
    product.price != null ? `${product.price} kr` : null,
    product.country,
    product.status,
    `Art.nr: ${product.articleNumber}`,
  ].filter((part): part is string => part != null);

  return `${index + 1}. **${product.name}**\n   ${metadata.join(" | ")}`;
}

function registerSearchProducts(server: McpServer): void {
  server.registerTool(
    "polvenn_search_products",
    {
      title: "Search Vinmonopolet products",
      description: `Search Vinmonopolet's full product catalogue by name, article number, or EAN-13 barcode (not limited to beer).

Searches vinmonopolet.no directly, so no API key is needed; results include prices, styles, and image URLs. The official API is used as a fallback when the website search fails.

Args:
  - query (string): Product name, partial name, exact article number, or EAN-13 barcode
  - beerOnly (boolean): Only return beers (default: false)
  - sort ('relevance' | 'name_asc' | 'name_desc' | 'price_asc' | 'price_desc'): Result ordering
  - limit (number): Max results (default: 25)

Returns: Matching products with producer, style, ABV, volume, price, country, and image URL.`,
      inputSchema: SearchProductsSchema,
      outputSchema: SearchProductsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const trimmedQuery = params.query.trim();
        const apiKey = await getConfigValue("vinmonopolet_api_key");
        let products: VinmonopoletProduct[] = [];
        let source: "official_api" | "website" | "product_lookup" = "website";

        if (/^\d{13}$/.test(trimmedQuery)) {
          // EAN-13 barcode: website-only capability.
          const product = await vinmonopolet.getProductByBarcode(trimmedQuery);
          products = product ? [product] : [];
          source = "product_lookup";
        } else if (/^\d+$/.test(trimmedQuery)) {
          const product = await vinmonopolet.getProductById(trimmedQuery);
          products = product ? [product] : [];
          source = "product_lookup";
        } else {
          // Website search is the primary path: it needs no key and returns
          // richer data than the official API, whose product responses have
          // been slimmed down to basic + lastChanged. The official API is the
          // fallback when the website search fails.
          try {
            products = await vinmonopolet.searchWebsiteProducts(trimmedQuery, {
              maxResults: MAX_LIMIT,
              sort: params.sort,
            });
            source = "website";
          } catch (error) {
            if (!apiKey) {
              throw error;
            }
            products = await vinmonopolet.searchProducts(trimmedQuery, MAX_LIMIT);
            source = "official_api";
          }
        }

        const filtered = params.beerOnly ? products.filter(vinmonopolet.isBeer) : products;
        const limited = filtered.slice(0, params.limit);
        const results = limited.map(toProductSummary);

        const text =
          results.length === 0
            ? `No products found for '${params.query}'${params.beerOnly ? " (beers only)" : ""}.`
            : results.map(formatProductSummary).join("\n\n");

        return createToolResult(
          SearchProductsOutputSchema,
          {
            query: params.query,
            beerOnly: params.beerOnly,
            source,
            totalResults: filtered.length,
            results,
          },
          text,
        );
      } catch (error: unknown) {
        return createToolError(`Error searching products: ${(error as Error).message}`);
      }
    },
  );
}

function registerGetProduct(server: McpServer): void {
  server.registerTool(
    "polvenn_get_product",
    {
      title: "Get product details",
      description: `Get full details for one Vinmonopolet product by article number.

Args:
  - articleNumber (string): Vinmonopolet article number (e.g. '20537202')

Returns: Name, producer, style, country, ABV, volume, price, availability, and tasting notes when available.`,
      inputSchema: GetProductSchema,
      outputSchema: GetProductOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const product = await vinmonopolet.getProductById(params.articleNumber);

        if (!product) {
          return createToolResult(
            GetProductOutputSchema,
            {
              articleNumber: params.articleNumber,
              found: false,
              product: null,
            },
            `No product was found for article number ${params.articleNumber} on Vinmonopolet.`,
          );
        }

        const characteristics = product.description?.characteristics;
        const productDetail = {
          name: vinmonopolet.getProductName(product),
          longName: product.basic.productLongName ?? null,
          producer: vinmonopolet.getProductProducer(product),
          style: vinmonopolet.getProductStyle(product),
          category: product.classification?.mainProductTypeName ?? null,
          country: vinmonopolet.getProductCountry(product),
          abv: vinmonopolet.getProductAbv(product),
          volume: product.basic.volume ?? null,
          vintage: product.basic.vintage ?? null,
          ageLimit: product.basic.ageLimit ?? null,
          price: product.prices?.salesPrice ?? null,
          pricePerLiter: product.prices?.salesPricePrLiter ?? null,
          status: product.availability?.status ?? product.basic.productStatusSaleName ?? null,
          productSelection: product.availability?.productSelection ?? null,
          buyable: product.availability?.buyable ?? null,
          wholesaler: product.logistics?.wholesalerName ?? null,
          colour: characteristics?.colour ?? null,
          odour: characteristics?.odour ?? null,
          taste: characteristics?.taste ?? null,
          productPageUrl:
            product.availability?.productPageUrl ??
            `https://www.vinmonopolet.no/p/${product.basic.productId}`,
          imageUrl: buildProductImageUrl(product.basic.productId),
          imageUrlLarge: buildProductImageUrl(product.basic.productId, 515),
          lastChangedAt: vinmonopolet.getProductLastChangedAt(product),
        };

        const lines = [
          `**${productDetail.name}**`,
          [
            productDetail.producer,
            productDetail.category,
            productDetail.style,
            productDetail.country,
          ]
            .filter((part): part is string => part != null)
            .join(" | "),
          [
            productDetail.abv != null ? `${productDetail.abv}% ABV` : null,
            productDetail.volume != null ? `${productDetail.volume} ml` : null,
            productDetail.price != null ? `${productDetail.price} kr` : null,
            productDetail.productSelection,
            productDetail.status,
          ]
            .filter((part): part is string => part != null)
            .join(" | "),
        ];

        const tasting = [productDetail.colour, productDetail.odour, productDetail.taste].filter(
          (part): part is string => part != null,
        );
        if (tasting.length > 0) {
          lines.push(tasting.join("\n"));
        }
        lines.push(productDetail.productPageUrl ?? "");
        lines.push(productDetail.imageUrl ?? "");

        return createToolResult(
          GetProductOutputSchema,
          {
            articleNumber: params.articleNumber,
            found: true,
            product: productDetail,
          },
          lines.filter(Boolean).join("\n"),
        );
      } catch (error: unknown) {
        return createToolError(`Error fetching product: ${(error as Error).message}`);
      }
    },
  );
}

function registerFindStoresWithStock(server: McpServer): void {
  server.registerTool(
    "polvenn_find_stores_with_stock",
    {
      title: "Find stores with a product in stock",
      description: `Find Vinmonopolet stores that currently have a product in stock, ordered by distance.

Uses vinmonopolet.no's store stock locator, so no Vinmonopolet API key is required. Results are best-effort store-level counts.

Args:
  - articleNumber (string): Vinmonopolet article number
  - latitude / longitude (number, optional): Search origin. Defaults to your configured home location.
  - maxResults (number): How many stores to return (default: 5)

Returns: Stores with the product in stock, with stock levels.`,
      inputSchema: FindStoresWithStockSchema,
      outputSchema: FindStoresWithStockOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const lat =
          params.latitude ??
          (await getConfigValue("home_latitude").then((value) => (value ? Number(value) : null)));
        const lon =
          params.longitude ??
          (await getConfigValue("home_longitude").then((value) => (value ? Number(value) : null)));

        if (lat == null || lon == null) {
          return createToolError(
            "No location provided and no home location configured. Use polvenn_configure to set homeLatitude/homeLongitude, or pass latitude/longitude.",
          );
        }

        const maxResults = params.maxResults ?? 5;
        const [stores, product] = await Promise.all([
          vinmonopolet.findStoresWithProductStock(params.articleNumber, lat, lon, maxResults),
          vinmonopolet.getProductById(params.articleNumber).catch(() => null),
        ]);
        const productName = product ? vinmonopolet.getProductName(product) : null;

        const text =
          stores.length === 0
            ? `No stores with **${productName ?? `article ${params.articleNumber}`}** in stock were found near ${lat.toFixed(2)}, ${lon.toFixed(2)}. The product may be sold out everywhere nearby, or stock data may be unavailable.`
            : [
                `Stores with **${productName ?? `article ${params.articleNumber}`}** in stock (nearest first):`,
                ...stores.map(
                  (store, index) =>
                    `${index + 1}. **${store.storeName}** — ${store.stockLevel} units (ID: ${store.storeId})`,
                ),
              ].join("\n");

        return createToolResult(
          FindStoresWithStockOutputSchema,
          {
            articleNumber: params.articleNumber,
            productName,
            latitude: lat,
            longitude: lon,
            maxResults,
            stores,
          },
          text,
        );
      } catch (error: unknown) {
        return createToolError(`Error finding stores with stock: ${(error as Error).message}`);
      }
    },
  );
}

function registerGetChangedProducts(server: McpServer): void {
  server.registerTool(
    "polvenn_get_changed_products",
    {
      title: "Get recently changed products",
      description: `List products changed on Vinmonopolet since a date, using the official API's changedSince filter.

Requires a configured Vinmonopolet API key. The cutoff defaults to your last sync (or 7 days ago on first run) and the sync marker is updated on success.

Args:
  - since (string, optional): yyyy-MM-dd cutoff. Defaults to your last sync, or 7 days ago.
  - beerOnly (boolean): Only return beers (default: true)
  - limit (number): Max results (default: 25)

Returns: Products changed since the cutoff, with their lastChanged timestamps.`,
      inputSchema: GetChangedProductsSchema,
      outputSchema: GetChangedProductsOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const fallbackSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          .toISOString()
          .split("T")[0];
        const since = params.since ?? (await getConfigValue("last_product_sync")) ?? fallbackSince;

        const products = await vinmonopolet.getProducts({
          changedSince: since,
          maxResults: MAX_LIMIT,
        });
        // Official API responses are slim (basic + lastChanged only); fill in
        // classification/producer from cached or scraped product pages so
        // beer filtering and result details actually have data to work with.
        const enriched = await vinmonopolet.enrichSlimProducts(products);
        const filtered = params.beerOnly ? enriched.filter(vinmonopolet.isBeer) : enriched;
        const limited = filtered.slice(0, params.limit);
        const results = limited.map((product) => ({
          articleNumber: product.basic.productId,
          name: vinmonopolet.getProductName(product),
          producer: vinmonopolet.getProductProducer(product),
          style: vinmonopolet.getProductStyle(product),
          category: product.classification?.mainProductTypeName ?? null,
          lastChangedAt: vinmonopolet.getProductLastChangedAt(product),
        }));

        await setConfig("last_product_sync", new Date().toISOString().split("T")[0]);

        const text =
          results.length === 0
            ? `No ${params.beerOnly ? "beers " : "products "}changed on Vinmonopolet since ${since}.`
            : [
                `${filtered.length} product(s) changed since ${since}${params.beerOnly ? " (beers shown)" : ""}:`,
                ...results.map(
                  (product, index) =>
                    `${index + 1}. **${product.name}**${product.producer ? ` (${product.producer})` : ""}\n   ${[product.style, product.category].filter(Boolean).join(" | ")} | Art.nr: ${product.articleNumber}${product.lastChangedAt ? ` | Changed: ${product.lastChangedAt}` : ""}`,
                ),
              ].join("\n");

        return createToolResult(
          GetChangedProductsOutputSchema,
          {
            since,
            beerOnly: params.beerOnly,
            totalResults: filtered.length,
            results,
          },
          text,
        );
      } catch (error: unknown) {
        return createToolError(`Error fetching changed products: ${(error as Error).message}`);
      }
    },
  );
}

function registerGetFacets(server: McpServer): void {
  server.registerTool(
    "polvenn_get_facets",
    {
      title: "List search facets",
      description: `List the available search filters (facets) from vinmonopolet.no: categories, styles, countries, price ranges, and more, with result counts.

Useful for discovering valid filter values before searching. No API key required.`,
      inputSchema: GetFacetsSchema,
      outputSchema: GetFacetsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const facets = await vinmonopolet.getSearchFacets();
        const text =
          facets.length === 0
            ? "No facets were returned by vinmonopolet.no."
            : facets
                .map((facet) => {
                  const title = facet.displayName ?? facet.name;
                  const values = facet.values
                    .map(
                      (value) => `${value.name}${value.count != null ? ` (${value.count})` : ""}`,
                    )
                    .join(", ");
                  return `**${title}**: ${values || "(no values)"}`;
                })
                .join("\n");

        return createToolResult(GetFacetsOutputSchema, { facets }, text);
      } catch (error: unknown) {
        return createToolError(`Error fetching facets: ${(error as Error).message}`);
      }
    },
  );
}

const STOCK_WATCH_CHECKPOINT_KEY = "stock-watch";

interface StockWatchResult {
  articleNumber: string;
  productName: string | null;
  storeId: string | null;
  storeName: string | null;
  inStock: boolean | null;
  stockLevel: number | null;
  newInStock: boolean;
  stockSource: string | null;
  message: string | null;
}

/**
 * Evaluates 'stock' rules against live store stock at the resolved store.
 * Checkpoint keys only track currently-in-stock articles, so a beer that
 * sells out and returns is reported as new again.
 */
async function evaluateStockRules(articleNumbers: string[]): Promise<StockWatchResult[]> {
  const seenKeys = new Set(await getSeenWatchlistMatchKeys(STOCK_WATCH_CHECKPOINT_KEY));

  let store: ResolvedStoreContext | null = null;
  try {
    store = await resolveStoreContext();
  } catch {
    store = null;
  }

  const results: StockWatchResult[] = [];
  for (const articleNumber of articleNumbers) {
    if (!store) {
      results.push({
        articleNumber,
        productName: null,
        storeId: null,
        storeName: null,
        inStock: null,
        stockLevel: null,
        newInStock: false,
        stockSource: null,
        message:
          "No store could be resolved. Set a home store or home location with polvenn_configure.",
      });
      continue;
    }

    let check: Awaited<ReturnType<typeof vinmonopolet.checkStoreStock>> | null = null;
    let errorMessage: string | null = null;
    try {
      check = await vinmonopolet.checkStoreStock(articleNumber, store.storeId);
    } catch (error: unknown) {
      errorMessage = (error as Error).message;
    }

    const product = await vinmonopolet.getProductById(articleNumber).catch(() => null);
    const inStock =
      check?.storeStockConclusion === "in_stock"
        ? true
        : check?.storeStockConclusion === "out_of_stock"
          ? false
          : null;
    const stockKey = `stock:${articleNumber}:${store.storeId}:in_stock`;

    results.push({
      articleNumber,
      productName: product ? vinmonopolet.getProductName(product) : null,
      storeId: store.storeId,
      storeName: store.storeName,
      inStock,
      stockLevel: check?.stockLevel ?? null,
      newInStock: inStock === true && !seenKeys.has(stockKey),
      stockSource: check?.stockSource ?? null,
      message: errorMessage ?? check?.message ?? null,
    });
  }

  if (store) {
    const currentInStockKeys = results
      .filter((result) => result.inStock === true && result.storeId != null)
      .map((result) => `stock:${result.articleNumber}:${result.storeId}:in_stock`);
    await setSeenWatchlistMatchKeys(STOCK_WATCH_CHECKPOINT_KEY, currentInStockKeys);
  }

  return results;
}

function formatStockResults(results: StockWatchResult[]): string {
  const lines = results.map((result) => {
    const label = result.productName ?? `Article ${result.articleNumber}`;
    const suffix =
      result.inStock === true
        ? `in stock${result.stockLevel != null ? ` (${result.stockLevel} units)` : ""}${result.newInStock ? " — NEW" : ""}`
        : result.inStock === false
          ? "out of stock"
          : `stock unknown${result.message ? `: ${result.message}` : ""}`;
    const icon = result.inStock === true ? "✅" : result.inStock === false ? "❌" : "❔";
    return `- ${icon} ${label} (${result.articleNumber}) — ${suffix}`;
  });

  const storeName = results.find((result) => result.storeName != null)?.storeName ?? "your store";
  return `**Stock watch** (at ${storeName}):\n${lines.join("\n")}`;
}

function registerWatchlist(server: McpServer): void {
  server.registerTool(
    "polvenn_watchlist",
    {
      title: "Beer watchlist",
      description: `Manage your beer watchlist. Track breweries, styles, series, keywords, countries, ABV/price ranges, or watch a single article's stock at your home store.

Args:
  - action ('add' | 'remove' | 'list' | 'check'): What to do
  - type ('brewery' | 'style' | 'series' | 'keyword' | 'country' | 'abv' | 'price' | 'stock'): Rule type (required for 'add')
  - value (string): What to watch for (required for text rules; article number for 'stock'; derived for abv/price)
  - minValue / maxValue (number): Bounds for 'abv'/'price' rules (at least one required)
  - id (number): Entry ID to remove (required for 'remove')

Note: price rules are best-effort — prices are looked up via Vinmonopolet and reported as not evaluated when unavailable. Stock rules check live store stock at your home store during 'check' and report new arrivals.`,
      inputSchema: WatchlistSchema,
      outputSchema: WatchlistOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        switch (params.action) {
          case "add": {
            if (!params.type) {
              return createToolError("'type' is required for 'add' action.");
            }

            let value: string;
            let minValue: number | undefined;
            let maxValue: number | undefined;

            if (params.type === "abv" || params.type === "price") {
              if (params.minValue === undefined && params.maxValue === undefined) {
                return createToolError(
                  `Rules of type '${params.type}' need minValue and/or maxValue.`,
                );
              }
              minValue = params.minValue;
              maxValue = params.maxValue;
              value = formatNumericRuleValue(params.type, minValue, maxValue);
            } else if (params.type === "stock") {
              if (!params.value || !/^\d+$/.test(params.value.trim())) {
                return createToolError(
                  "Stock rules need 'value' set to a numeric Vinmonopolet article number.",
                );
              }
              value = params.value.trim();
            } else {
              if (!params.value) {
                return createToolError("'value' is required for 'add' action with text rules.");
              }
              value = params.value;
            }

            const entry = await addWatchlistEntry(params.type, value, minValue, maxValue);
            notifyWatchlistUpdated(server);
            return createToolResult(
              WatchlistOutputSchema,
              { action: "add", entry },
              `Added watchlist rule #${entry.id}: ${entry.type} = "${entry.value}"`,
            );
          }

          case "remove": {
            if (params.id === undefined) {
              return createToolError(
                "'id' is required for 'remove' action. Use 'list' to see IDs.",
              );
            }
            const removed = await removeWatchlistEntry(params.id);
            notifyWatchlistUpdated(server);
            return createToolResult(
              WatchlistOutputSchema,
              { action: "remove", id: params.id, removed },
              removed
                ? `Removed watchlist rule #${params.id}.`
                : `No rule found with ID ${params.id}.`,
            );
          }

          case "list": {
            const entries = await listWatchlistEntries();
            if (entries.length === 0) {
              return createToolResult(
                WatchlistOutputSchema,
                { action: "list", entries: [], totalRules: 0 },
                "Your watchlist is empty. Use action='add' to add rules.",
              );
            }

            const text = entries
              .map(
                (entry: WatchlistEntry) =>
                  `#${entry.id} [${entry.type}] "${entry.value}" (added ${entry.createdAt})`,
              )
              .join("\n");

            return createToolResult(
              WatchlistOutputSchema,
              { action: "list", entries, totalRules: entries.length },
              `**Your watchlist:**\n${text}`,
            );
          }

          case "check": {
            const entries = await listWatchlistEntries();
            if (entries.length === 0) {
              return createToolResult(
                WatchlistOutputSchema,
                {
                  action: "check",
                  totalRules: 0,
                  totalBeers: 0,
                  newMatches: [],
                  repeatedMatches: [],
                },
                "Your watchlist is empty. Nothing to check.",
              );
            }

            // Stock rules are independent of the release feed, so evaluate
            // them first — a stock check works even when the feed is down.
            const stockArticleNumbers = Array.from(
              new Set(
                entries
                  .filter((entry) => entry.type === "stock")
                  .map((entry) => entry.value.trim()),
              ),
            );
            const stockResults =
              stockArticleNumbers.length > 0
                ? await evaluateStockRules(stockArticleNumbers)
                : undefined;
            const stockText = stockResults ? `\n\n${formatStockResults(stockResults)}` : "";

            const latestRelease = await releaseFeed.getLatestRelease();

            if (!latestRelease) {
              return createToolResult(
                WatchlistOutputSchema,
                {
                  action: "check",
                  totalRules: entries.length,
                  totalBeers: 0,
                  release: null,
                  newMatches: [],
                  repeatedMatches: [],
                  stockResults,
                },
                `No releases were found in the external release feed to check against.${stockText}`,
              );
            }

            const beers = latestRelease.items;

            // Price rules need per-beer prices, which only Vinmonopolet knows.
            // Resolve them up front (cached products make this cheap) so we can
            // honestly report how many beers price rules could not be evaluated for.
            const hasPriceRules = entries.some((entry) => entry.type === "price");
            let unevaluatedPriceBeers = 0;
            let resolvePrice: ((articleNumber: string) => Promise<number | null>) | undefined;

            if (hasPriceRules) {
              const prices = new Map<string, number | null>();
              for (const beer of beers) {
                try {
                  const product = await vinmonopolet.getProductById(beer.articleNumber);
                  prices.set(beer.articleNumber, product?.prices?.salesPrice ?? null);
                } catch {
                  prices.set(beer.articleNumber, null);
                }
              }
              unevaluatedPriceBeers = Array.from(prices.values()).filter(
                (price) => price == null,
              ).length;
              resolvePrice = async (articleNumber) => prices.get(articleNumber) ?? null;
            }

            const matches = await matchWatchlistEntries(beers, entries, { resolvePrice });
            const seenMatchKeys = await getSeenWatchlistMatchKeys(latestRelease.id);
            const { newMatches, repeatedMatches } = splitWatchlistMatches(matches, seenMatchKeys);

            await setSeenWatchlistMatchKeys(latestRelease.id, [
              ...seenMatchKeys,
              ...matches.map(getWatchlistMatchKey),
            ]);

            if (matches.length === 0) {
              const noMatchText = `Checked ${beers.length} beers from latest release — no matches for your ${entries.length} rules.`;
              return createToolResult(
                WatchlistOutputSchema,
                {
                  action: "check",
                  release: latestRelease,
                  totalRules: entries.length,
                  totalBeers: beers.length,
                  totalMatches: 0,
                  unevaluatedPriceBeers,
                  newMatches: [],
                  repeatedMatches: [],
                  stockResults,
                },
                unevaluatedPriceBeers > 0
                  ? `${noMatchText}\n\nNote: price rules could not be evaluated for ${unevaluatedPriceBeers} beer(s) with unknown prices.${stockText}`
                  : `${noMatchText}${stockText}`,
              );
            }

            const formatMatches = (items: WatchlistMatch[]) =>
              items
                .map(
                  (match: WatchlistMatch, index) =>
                    `${index + 1}. **${match.beer.name}** (${match.beer.producer})\n   ${match.beer.style} | ${match.beer.abv}% | Art.nr: ${match.beer.articleNumber}\n   Matched: ${match.matchedRules.map((rule) => `${rule.type}: ${rule.value}`).join(", ")}`,
                )
                .join("\n\n");

            let text = `Checked ${beers.length} beers from **${latestRelease.title}**.`;
            if (newMatches.length > 0) {
              text += `\n\n**${newMatches.length} new matches since your last check:**\n\n${formatMatches(newMatches)}`;
            } else {
              text += "\n\nNo new matches since your last check.";
            }

            if (repeatedMatches.length > 0) {
              text += `\n\nPreviously seen matches in this release: ${repeatedMatches.length}.`;
            }

            if (unevaluatedPriceBeers > 0) {
              text += `\n\nNote: price rules could not be evaluated for ${unevaluatedPriceBeers} beer(s) with unknown prices.`;
            }

            text += stockText;

            return createToolResult(
              WatchlistOutputSchema,
              {
                action: "check",
                release: latestRelease,
                totalRules: entries.length,
                totalBeers: beers.length,
                totalMatches: matches.length,
                unevaluatedPriceBeers,
                newMatches,
                repeatedMatches,
                stockResults,
              },
              text,
            );
          }
        }
      } catch (error: unknown) {
        return createToolError(`Watchlist error: ${(error as Error).message}`);
      }
    },
  );
}

function registerConfigure(server: McpServer): void {
  server.registerTool(
    "polvenn_configure",
    {
      title: "Configure Polvenn",
      description: `Set the release feed URL, API key, home store, and location for the Polvenn MCP server.

Args (all optional — only provided values are updated):
  - releaseFeedUrl: Base URL for your external release feed API
  - vinmonopoletApiKey: Subscription key from api.vinmonopolet.no
  - homeStoreId: Your preferred Vinmonopolet store ID
  - homeLatitude: Home latitude for nearby lookups
  - homeLongitude: Home longitude for nearby lookups

Returns: Current configuration (keys are masked).`,
      inputSchema: ConfigureSchema,
      outputSchema: ConfigureOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        if (params.releaseFeedUrl) await setConfig("release_feed_url", params.releaseFeedUrl);
        if (params.vinmonopoletApiKey)
          await setConfig("vinmonopolet_api_key", params.vinmonopoletApiKey);
        if (params.homeStoreId) await setConfig("home_store_id", params.homeStoreId);
        if (params.homeLatitude !== undefined)
          await setConfig("home_latitude", String(params.homeLatitude));
        if (params.homeLongitude !== undefined)
          await setConfig("home_longitude", String(params.homeLongitude));

        const config = await getAllConfig();
        const mask = (value: string | null): string => {
          if (!value) return "not set";
          if (value.length <= 8) return "****";
          return `${value.slice(0, 4)}...${value.slice(-4)}`;
        };

        const text = [
          "**Polvenn configuration:**",
          `  Release feed URL: ${config.releaseFeedUrl ?? "not set"}`,
          `  Vinmonopolet API key: ${mask(config.vinmonopoletApiKey)}`,
          `  Home store: ${config.homeStoreId ?? "not set"}`,
          `  Home location: ${config.homeLatitude != null ? `${config.homeLatitude}, ${config.homeLongitude}` : "not set"}`,
        ].join("\n");

        return createToolResult(
          ConfigureOutputSchema,
          {
            releaseFeedUrl: config.releaseFeedUrl,
            vinmonopoletApiKeyConfigured: config.vinmonopoletApiKey != null,
            homeStoreId: config.homeStoreId,
            homeLatitude: config.homeLatitude,
            homeLongitude: config.homeLongitude,
          },
          text,
        );
      } catch (error: unknown) {
        return createToolError(`Config error: ${(error as Error).message}`);
      }
    },
  );
}

function registerValidateConfig(server: McpServer): void {
  server.registerTool(
    "polvenn_validate_config",
    {
      title: "Validate Polvenn configuration",
      description: `Validate current Polvenn configuration and run lightweight capability checks against upstream services.

Checks:
  - local config presence
  - external release feed access
  - Vinmonopolet product and store access
  - Vinmonopolet stock endpoint accessibility

Returns: A capability report with pass/warn/fail statuses.`,
      inputSchema: ValidateConfigSchema,
      outputSchema: ValidateConfigOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const config = await getAllConfig();
        const checks: ValidationCheck[] = [];

        checks.push({
          name: "Home store",
          status: config.homeStoreId ? "ok" : "warning",
          message: config.homeStoreId
            ? `Configured as ${config.homeStoreId}.`
            : "Not configured. Stock lookups need an explicit storeId unless you set one.",
        });

        checks.push({
          name: "Home location",
          status: config.homeLatitude != null && config.homeLongitude != null ? "ok" : "warning",
          message:
            config.homeLatitude != null && config.homeLongitude != null
              ? `Configured as ${config.homeLatitude}, ${config.homeLongitude}.`
              : "Not configured. Nearby store lookups need explicit coordinates unless you set them.",
        });

        if (!config.releaseFeedUrl) {
          checks.push({
            name: "Release feed URL",
            status: "error",
            message:
              "Missing. External release lookups and watchlist checks will fail until configured.",
          });
          checks.push({
            name: "External release feed",
            status: "skipped",
            message: "Skipped because the release feed URL is missing.",
          });
        } else {
          checks.push({
            name: "Release feed URL",
            status: "ok",
            message: `Configured as ${config.releaseFeedUrl}.`,
          });

          try {
            const releases = await releaseFeed.getLatestReleases(1);
            checks.push({
              name: "External release feed",
              status: releases.length > 0 ? "ok" : "warning",
              message:
                releases.length > 0
                  ? `Reachable. Latest release: ${releases[0].title}`
                  : "Reachable, but no releases were returned.",
              details: releases[0] ? { latestRelease: releases[0] } : undefined,
            });
          } catch (error: unknown) {
            checks.push({
              name: "External release feed",
              status: "error",
              message: (error as Error).message,
            });
          }
        }

        if (!config.vinmonopoletApiKey) {
          checks.push({
            name: "Vinmonopolet API key",
            status: "error",
            message: "Missing. Product, store, and stock checks will fail until configured.",
          });
          checks.push({
            name: "Vinmonopolet products",
            status: "skipped",
            message: "Skipped because the Vinmonopolet API key is missing.",
          });
          checks.push({
            name: "Vinmonopolet stores",
            status: "skipped",
            message: "Skipped because the Vinmonopolet API key is missing.",
          });
          checks.push({
            name: "Vinmonopolet stock endpoint",
            status: "skipped",
            message: "Skipped because the Vinmonopolet API key is missing.",
          });
        } else {
          checks.push({
            name: "Vinmonopolet API key",
            status: "ok",
            message: "Configured.",
          });

          try {
            const products = await vinmonopolet.getProducts({ maxResults: 1 });
            checks.push({
              name: "Vinmonopolet products",
              status: "ok",
              message: `Product API reachable. Received ${products.length} item(s) in validation probe.`,
            });
          } catch (error: unknown) {
            checks.push({
              name: "Vinmonopolet products",
              status: "error",
              message: (error as Error).message,
            });
          }

          try {
            const stores = await vinmonopolet.getStores();
            checks.push({
              name: "Vinmonopolet stores",
              status: "ok",
              message: `Store API reachable. Received ${stores.length} store(s).`,
            });
          } catch (error: unknown) {
            checks.push({
              name: "Vinmonopolet stores",
              status: "error",
              message: (error as Error).message,
            });
          }

          if (!config.homeStoreId) {
            checks.push({
              name: "Vinmonopolet stock endpoint",
              status: "skipped",
              message: "Skipped live stock probe because no home store is configured.",
            });
          } else {
            try {
              const stockProbe = await vinmonopolet.getStock({
                storeId: config.homeStoreId,
                changedSince: new Date().toISOString().split("T")[0],
              });
              checks.push({
                name: "Vinmonopolet stock endpoint",
                status: "ok",
                message: `Stock endpoint reachable. Probe returned ${stockProbe.length} row(s).`,
              });
            } catch (error: unknown) {
              const message = (error as Error).message;
              checks.push({
                name: "Vinmonopolet stock endpoint",
                status: vinmonopolet.isInvalidApiKeyError(error)
                  ? "error"
                  : vinmonopolet.isStockAccessLimitedError(error)
                    ? "warning"
                    : "error",
                message,
              });
            }
          }
        }

        const summary = {
          ok: checks.filter((check) => check.status === "ok").length,
          warning: checks.filter((check) => check.status === "warning").length,
          error: checks.filter((check) => check.status === "error").length,
          skipped: checks.filter((check) => check.status === "skipped").length,
        };

        const text = [
          "**Polvenn capability report**",
          "",
          `Summary: ${summary.ok} ok, ${summary.warning} warning, ${summary.error} error, ${summary.skipped} skipped`,
          "",
          ...checks.map(formatValidationCheck),
        ].join("\n");

        return createToolResult(
          ValidateConfigOutputSchema,
          {
            summary,
            checks,
            config: {
              releaseFeedUrl: config.releaseFeedUrl,
              vinmonopoletApiKeyConfigured: config.vinmonopoletApiKey != null,
              homeStoreId: config.homeStoreId,
              homeLatitude: config.homeLatitude,
              homeLongitude: config.homeLongitude,
            },
          },
          text,
        );
      } catch (error: unknown) {
        return createToolError(`Validation error: ${(error as Error).message}`);
      }
    },
  );
}
