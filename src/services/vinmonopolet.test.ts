import { afterEach, describe, expect, it, vi } from "vitest";
import { setConfig } from "../db/database.js";
import type { VinmonopoletProduct } from "../types.js";
import {
  checkStoreStock,
  getProductAbv,
  getProductCountry,
  getProductLastChangedAt,
  getProductName,
  getProductProducer,
  getProductStyle,
  getStores,
  isInvalidApiKeyError,
  isStockAccessLimitedError,
  parseProductFromProductPageHtml,
  resetStoreListCacheForTests,
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
