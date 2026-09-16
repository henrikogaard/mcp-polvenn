import { afterEach, describe, expect, it, vi } from "vitest";
import { setCachedBeer, setConfig } from "../db/database.js";
import type { VinmonopoletProduct } from "../types.js";
import {
  checkStoreStock,
  enrichSlimProducts,
  findStoresWithProductStock,
  getProductAbv,
  getProductByBarcode,
  getProductCountry,
  getProductLastChangedAt,
  getProductName,
  getProductProducer,
  getProductStyle,
  getSearchFacets,
  getStores,
  getTodaysOpeningHours,
  getUpcomingBeers,
  isInvalidApiKeyError,
  isStockAccessLimitedError,
  parseProductFromProductPageHtml,
  resetStoreListCacheForTests,
  searchWebsiteProducts,
} from "./vinmonopolet.js";

const productPageHtml = `
  <html>
    <body>
      <main>
        <script type="application/json">
          {
            "product": {
              "code": "20273702",
              "name": "Salikatt Skyhook",
              "ageLimit": 18,
              "buyable": true,
              "status": "aktiv",
              "product_selection": "Basisutvalget",
              "price": { "value": 98.5 },
              "volume": { "value": 44 },
              "main_category": { "name": "Øl" },
              "main_sub_category": { "name": "India pale ale" },
              "main_producer": { "name": "Salikatt Bryggeri" },
              "main_wholesaler": { "name": "Salikatt Bryggeri AS" },
              "country": { "name": "Norge" },
              "content": {
                "traits": [
                  { "name": "Alkohol", "readableValue": "7,5%" }
                ]
              },
              "characteristics": {
                "color": "Skyet, middels dyp strågul.",
                "odor": "Sitrus, tropisk frukt.",
                "taste": "Fruktig, frisk."
              }
            }
          }
        </script>
      </main>
    </body>
  </html>
`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseProductFromProductPageHtml", () => {
  it("extracts product details from embedded JSON", () => {
    const product = parseProductFromProductPageHtml(
      productPageHtml,
      "https://www.vinmonopolet.no/p/20273702",
    );

    expect(getProductName(product)).toBe("Salikatt Skyhook");
    expect(getProductProducer(product)).toBe("Salikatt Bryggeri");
    expect(getProductStyle(product)).toBe("India pale ale");
    expect(getProductAbv(product)).toBe(7.5);
    expect(getProductCountry(product)).toBe("Norge");
    expect(product.prices?.salesPrice).toBe(98.5);
    expect(product.availability?.productSelection).toBe("Basisutvalget");
    expect(product.availability?.productPageUrl).toBe("https://www.vinmonopolet.no/p/20273702");
  });
});

describe("product helpers", () => {
  it("tolerate sparse API responses", () => {
    const product: VinmonopoletProduct = {
      basic: {
        productId: "20273702",
        productShortName: "Salikatt Skyhook",
      },
      lastChanged: {
        date: "2025-12-09",
        time: "07:52:39",
      },
    };

    expect(getProductName(product)).toBe("Salikatt Skyhook");
    expect(getProductProducer(product)).toBeNull();
    expect(getProductStyle(product)).toBeNull();
    expect(getProductAbv(product)).toBeNull();
    expect(getProductCountry(product)).toBeNull();
    expect(getProductLastChangedAt(product)).toBe("2025-12-09T07:52:39");
  });
});

describe("error classification", () => {
  it("classifies Open-access stock failures as limited access", () => {
    expect(
      isStockAccessLimitedError(
        new Error('Vinmonopolet API error 404: Not Found. {"message":"Resource not found"}'),
      ),
    ).toBe(true);
    expect(isStockAccessLimitedError(new Error("Vinmonopolet API error 403: Forbidden."))).toBe(
      true,
    );
    expect(
      isStockAccessLimitedError(new Error("Vinmonopolet API error 500: Internal Server Error.")),
    ).toBe(false);
  });

  it("classifies invalid subscription key responses", () => {
    expect(
      isInvalidApiKeyError(
        new Error(
          'Vinmonopolet API error 401: Unauthorized. {"message":"Access denied due to invalid subscription key."}',
        ),
      ),
    ).toBe(true);
    expect(
      isInvalidApiKeyError(
        new Error('Vinmonopolet API error 404: Not Found. {"message":"Resource not found"}'),
      ),
    ).toBe(false);
  });
});

describe("checkStoreStock", () => {
  it("falls back to vinmonopolet.no stock locator when official stock lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;

        if (url.startsWith("https://apis.vinmonopolet.no/products/v0/accumulated-stock")) {
          return new Response(JSON.stringify({ message: "Resource not found" }), {
            status: 404,
            statusText: "Not Found",
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url === "https://www.vinmonopolet.no/vmpws/v2/vmp/stores/116?fields=FULL") {
          return new Response(
            JSON.stringify({
              id: "116",
              name: "116",
              displayName: "Sandnes, Kvadrat",
              geoPoint: {
                latitude: 58.876707,
                longitude: 5.721903,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (url.startsWith("https://www.vinmonopolet.no/vmpws/v2/vmp/products/123456/stock?")) {
          return new Response(
            JSON.stringify({
              stores: [
                {
                  pointOfService: {
                    id: "116",
                    name: "116",
                    displayName: "Sandnes, Kvadrat",
                  },
                  stockInfo: {
                    stockLevel: 7,
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        throw new Error(`Unexpected fetch URL in test: ${url}`);
      }),
    );

    await setConfig("vinmonopolet_api_key", "dummy-key");

    const result = await checkStoreStock("123456", "116");
    expect(result.status).toBe("verified");
    expect(result.storeStockConclusion).toBe("in_stock");
    expect(result.stockLevel).toBe(7);
    expect(result.stockSource).toBe("website_stock_locator");
    expect(result.websiteAvailabilityIsStoreStock).toBe(false);
    expect(result.message ?? "").toMatch(/stock locator/i);
  });

  it("returns unknown when both official and website stock lookups fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as Request).url;

        if (url.startsWith("https://apis.vinmonopolet.no/products/v0/accumulated-stock")) {
          return new Response(
            JSON.stringify({ message: "Access denied due to invalid subscription key." }),
            {
              status: 401,
              statusText: "Unauthorized",
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        if (url === "https://www.vinmonopolet.no/vmpws/v2/vmp/stores/116?fields=FULL") {
          return new Response(
            JSON.stringify({ errors: [{ message: "Det har oppstått en feil." }] }),
            {
              status: 500,
              statusText: "Internal Server Error",
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        throw new Error(`Unexpected fetch URL in test: ${url}`);
      }),
    );

    await setConfig("vinmonopolet_api_key", "dummy-key");

    const result = await checkStoreStock("123456", "116");
    expect(result.status).toBe("unverified");
    expect(result.storeStockConclusion).toBe("unknown");
    expect(result.stockLevel).toBeNull();
    expect(result.stockSource).toBe("unverified");
    expect(result.message ?? "").toMatch(/invalid/i);
    expect(result.message ?? "").toMatch(/fallback failed/i);
  });
});

describe("getStores caching", () => {
  it("fetches the store list once and reuses it within the TTL", async () => {
    const storeListJson = JSON.stringify([
      {
        storeId: "170",
        storeName: "Stavanger, Klubbgata",
        address: { gpsCoord: "58.970389;5.733810" },
      },
      {
        storeId: "116",
        storeName: "Sandnes, Kvadrat",
        address: { gpsCoord: "58.876707;5.721903" },
      },
      // malformed entry without identifiers gets dropped, not fatal
      { oops: true },
    ]);
    // A fresh Response per call — a Response body can only be read once.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(storeListJson, { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    await setConfig("vinmonopolet_api_key", "dummy-key");

    const first = await getStores();
    const second = await getStores();

    expect(first).toHaveLength(2);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After forgetting the cache (test hook), a new fetch happens.
    resetStoreListCacheForTests();
    const third = await getStores();
    expect(third).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

function stubJsonRoute(match: (url: string) => boolean, body: unknown, status = 200) {
  return { match, body, status };
}

function routeFetch(
  routes: Array<{ match: (url: string) => boolean; body: unknown; status?: number }>,
) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    for (const route of routes) {
      if (route.match(url)) {
        const status = route.status ?? 200;
        return new Response(JSON.stringify(route.body), { status });
      }
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const websiteSearchRoute = (products: unknown[], pagination?: unknown) =>
  stubJsonRoute(
    (url) => url.startsWith("https://www.vinmonopolet.no/vmpws/v2/vmp/products/search"),
    { products, pagination },
  );

describe("website product search", () => {
  it("searches free text with a sort segment and maps prices", async () => {
    const fetchMock = routeFetch([
      websiteSearchRoute([
        {
          code: "20162402",
          name: "Testbeer",
          price: { value: 129.9 },
          volume: { value: 33 },
          alcohol: { value: 12 },
          main_category: { name: "Øl" },
          main_producer: { name: "Bryggeriet" },
        },
      ]),
    ]);

    const products = await searchWebsiteProducts("testbeer", {
      maxResults: 10,
      sort: "price_asc",
    });

    expect(products).toHaveLength(1);
    expect(products[0].basic.productId).toBe("20162402");
    expect(products[0].prices?.salesPrice).toBe(129.9);
    expect(products[0].basic.volume).toBe(33);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain(encodeURIComponent("testbeer:price-asc"));
  });

  it("looks up products by EAN-13 barcode", async () => {
    routeFetch([
      stubJsonRoute((url) => url.includes("/vmpws/v2/vmp/products/barCodeSearch/7040514300215"), {
        code: "1234501",
        name: "Barcode Beer",
      }),
    ]);

    const product = await getProductByBarcode("7040514300215");
    expect(product?.basic.productId).toBe("1234501");
    expect(product?.basic.productShortName).toBe("Barcode Beer");
  });

  it("throws when the website signals an error inside a 200 body", async () => {
    routeFetch([
      stubJsonRoute((url) => url.includes("/vmpws/v2/vmp/products/barCodeSearch/"), {
        errors: [{ message: "Ukjent strekkode" }],
      }),
    ]);

    await expect(getProductByBarcode("7040514300215")).rejects.toThrow(/body/i);
  });
});

describe("enrichSlimProducts", () => {
  const slimProduct: VinmonopoletProduct = {
    basic: { productId: "18550102", productShortName: "Tøsse Oster IPA" },
    lastChanged: { date: "2026-09-12", time: "08:00:00" },
  };

  it("fills classification from cached product pages and keeps complete products", async () => {
    await setCachedBeer(
      "18550102",
      JSON.stringify({
        basic: { productId: "18550102", productShortName: "Tøsse Oster IPA" },
        classification: { mainProductTypeId: "10", mainProductTypeName: "Øl" },
        prices: { salesPrice: 79.9 },
      }),
      "vinmonopolet",
    );

    const complete: VinmonopoletProduct = {
      ...slimProduct,
      classification: { mainProductTypeId: "9", mainProductTypeName: "Cider" },
    };

    const enriched = await enrichSlimProducts([slimProduct, complete]);

    expect(enriched[0].classification?.mainProductTypeName).toBe("Øl");
    expect(enriched[0].prices?.salesPrice).toBe(79.9);
    // Already-complete products pass through untouched.
    expect(enriched[1]).toBe(complete);
  });

  it("leaves slim products unchanged when no cache and the product page fails", async () => {
    routeFetch([
      stubJsonRoute(
        (url) => url.startsWith("https://www.vinmonopolet.no/p/99999999"),
        { not: "html" },
        500,
      ),
    ]);

    const slim: VinmonopoletProduct = {
      basic: { productId: "99999999", productShortName: "Unknown Beer" },
    };

    const enriched = await enrichSlimProducts([slim]);
    expect(enriched[0].classification).toBeUndefined();
    expect(enriched[0].basic.productId).toBe("99999999");
  });
});

describe("website listing pagination", () => {
  it("collects candidates across pages until enough are gathered", async () => {
    const fetchMock = routeFetch([
      stubJsonRoute(
        (url) =>
          url.startsWith("https://www.vinmonopolet.no/vmpws/v2/vmp/products/search") &&
          url.includes("currentPage=0"),
        {
          products: [
            { code: "1", name: "Beer 1", main_category: { name: "Øl" } },
            { code: "2", name: "Beer 2", main_category: { name: "Øl" } },
          ],
          facets: [{ code: "upcomingProduct" }],
          pagination: { totalPages: 2, totalResults: 4 },
        },
      ),
      stubJsonRoute(
        (url) =>
          url.startsWith("https://www.vinmonopolet.no/vmpws/v2/vmp/products/search") &&
          url.includes("currentPage=1"),
        {
          products: [
            { code: "3", name: "Beer 3", main_category: { name: "Øl" } },
            { code: "4", name: "Beer 4", main_category: { name: "Øl" } },
          ],
          pagination: { totalPages: 2, totalResults: 4 },
        },
      ),
      stubJsonRoute(
        (url) => url.startsWith("https://apis.vinmonopolet.no/products/v0/details-normal"),
        [],
      ),
    ]);
    await setConfig("vinmonopolet_api_key", "dummy-key");

    const beers = await getUpcomingBeers(4);

    expect(beers.map((beer) => beer.basic.productId)).toEqual(["1", "2", "3", "4"]);
    const searchCalls = fetchMock.mock.calls.filter((call) =>
      (call[0] as string).includes("vmpws/v2/vmp/products/search"),
    );
    // One availability probe + two listing pages.
    expect(searchCalls).toHaveLength(3);
  });

  it("reports the upcoming listing as unavailable when the facet is gone", async () => {
    routeFetch([
      stubJsonRoute(
        (url) => url.startsWith("https://www.vinmonopolet.no/vmpws/v2/vmp/products/search"),
        { products: [], facets: [{ code: "newProducts" }], pagination: { totalPages: 0 } },
      ),
    ]);

    await expect(getUpcomingBeers(5)).rejects.toThrow(/Kommende nyheter.*no longer available/i);
  });
});

describe("stock locator pagination", () => {
  const storeCoordsRoute = stubJsonRoute(
    (url) => url === "https://www.vinmonopolet.no/vmpws/v2/vmp/stores/170?fields=FULL",
    { id: "170", name: "170", geoPoint: { latitude: 58.97, longitude: 5.73 } },
  );

  it("finds stocking stores across multiple pages", async () => {
    routeFetch([
      storeCoordsRoute,
      stubJsonRoute(
        (url) => url.includes("/products/20162402/stock") && url.includes("currentPage=0"),
        {
          stores: [
            {
              pointOfService: { id: "170", displayName: "Stavanger, Klubbgata" },
              stockInfo: { stockLevel: 3 },
            },
          ],
          pagination: { totalPages: 2 },
        },
      ),
      stubJsonRoute(
        (url) => url.includes("/products/20162402/stock") && url.includes("currentPage=1"),
        {
          stores: [
            {
              pointOfService: { id: "116", displayName: "Sandnes, Kvadrat" },
              stockInfo: { stockLevel: 7 },
            },
            // zero-stock stores are listed but excluded from results
            {
              pointOfService: { id: "200", displayName: "Somewhere" },
              stockInfo: { stockLevel: 0 },
            },
          ],
          pagination: { totalPages: 2 },
        },
      ),
    ]);

    const stores = await findStoresWithProductStock("20162402", 58.97, 5.73, 10);

    expect(stores).toEqual([
      { storeId: "170", storeName: "Stavanger, Klubbgata", stockLevel: 3 },
      { storeId: "116", storeName: "Sandnes, Kvadrat", stockLevel: 7 },
    ]);
  });

  it("does not miss a store that first appears on a later page", async () => {
    routeFetch([
      storeCoordsRoute,
      stubJsonRoute(
        (url) => url.includes("/products/20162402/stock") && url.includes("currentPage=0"),
        {
          stores: [
            { pointOfService: { id: "111" }, stockInfo: { stockLevel: 5 } },
            { pointOfService: { id: "222" }, stockInfo: { stockLevel: 0 } },
          ],
          pagination: { totalPages: 2 },
        },
      ),
      stubJsonRoute(
        (url) => url.includes("/products/20162402/stock") && url.includes("currentPage=1"),
        {
          stores: [{ pointOfService: { id: "170" }, stockInfo: { stockLevel: 2 } }],
          pagination: { totalPages: 2 },
        },
      ),
    ]);

    const result = await checkStoreStock("20162402", "170");
    expect(result.status).toBe("verified");
    expect(result.storeStockConclusion).toBe("in_stock");
    expect(result.stockLevel).toBe(2);
    expect(result.stockSource).toBe("website_stock_locator");
  });
});

describe("getSearchFacets", () => {
  it("maps the facet tree leniently from the search response", async () => {
    routeFetch([
      stubJsonRoute(
        (url) => url.startsWith("https://www.vinmonopolet.no/vmpws/v2/vmp/products/search"),
        {
          products: [],
          facets: [
            {
              code: "mainCategory",
              name: "Varegruppe",
              values: [
                { code: "øl", name: "Øl", count: 1234 },
                { name: "Cider", count: 99 },
                "not-an-object",
              ],
            },
            { noCodeHere: true },
          ],
          pagination: { totalPages: 1 },
        },
      ),
    ]);

    const facets = await getSearchFacets();

    expect(facets).toHaveLength(1);
    expect(facets[0]).toMatchObject({ name: "mainCategory", displayName: "Varegruppe" });
    expect(facets[0].values).toEqual([
      { name: "Øl", count: 1234 },
      { name: "Cider", count: 99 },
    ]);
  });
});

describe("getTodaysOpeningHours", () => {
  const store = {
    storeId: "170",
    storeName: "Stavanger",
    status: "open",
    address: { gpsCoord: "1;2" },
    telephone: "",
    email: "",
    category: "D",
    openingHours: {
      regularHours: [
        { dayOfTheWeek: "Mandag", openingTime: "10:00", closingTime: "17:00", closed: false },
        { dayOfTheWeek: "Sunday", openingTime: "00:00", closingTime: "00:00", closed: true },
      ],
    },
  } as unknown as Parameters<typeof getTodaysOpeningHours>[0];

  it("matches Norwegian day names", () => {
    const monday = new Date("2026-09-14T12:00:00"); // a Monday
    expect(getTodaysOpeningHours(store, monday)).toMatchObject({
      dayOfTheWeek: "Mandag",
      openingTime: "10:00",
      closed: false,
    });
  });

  it("matches English day names and reports closed days", () => {
    const sunday = new Date("2026-09-13T12:00:00"); // a Sunday
    expect(getTodaysOpeningHours(store, sunday)).toMatchObject({
      dayOfTheWeek: "Sunday",
      closed: true,
    });
  });

  it("returns null when no entry matches", () => {
    const tuesday = new Date("2026-09-15T12:00:00");
    expect(getTodaysOpeningHours(store, tuesday)).toBeNull();
  });
});
