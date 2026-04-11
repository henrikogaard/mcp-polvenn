import test from "node:test";
import assert from "node:assert/strict";
import {
  checkStoreStock,
  getProductAbv,
  getProductCountry,
  getProductLastChangedAt,
  getProductName,
  getProductProducer,
  getProductStyle,
  isInvalidApiKeyError,
  isStockAccessLimitedError,
  parseProductFromProductPageHtml,
} from "./vinmonopolet.js";
import type { VinmonopoletProduct } from "../types.js";
import { setConfig } from "../db/database.js";

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

test("parseProductFromProductPageHtml extracts product details from embedded JSON", () => {
  const product = parseProductFromProductPageHtml(
    productPageHtml,
    "https://www.vinmonopolet.no/p/20273702",
  );

  assert.equal(getProductName(product), "Salikatt Skyhook");
  assert.equal(getProductProducer(product), "Salikatt Bryggeri");
  assert.equal(getProductStyle(product), "India pale ale");
  assert.equal(getProductAbv(product), 7.5);
  assert.equal(getProductCountry(product), "Norge");
  assert.equal(product.prices?.salesPrice, 98.5);
  assert.equal(product.availability?.productSelection, "Basisutvalget");
  assert.equal(product.availability?.productPageUrl, "https://www.vinmonopolet.no/p/20273702");
});

test("product helpers tolerate sparse API responses", () => {
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

  assert.equal(getProductName(product), "Salikatt Skyhook");
  assert.equal(getProductProducer(product), null);
  assert.equal(getProductStyle(product), null);
  assert.equal(getProductAbv(product), null);
  assert.equal(getProductCountry(product), null);
  assert.equal(getProductLastChangedAt(product), "2025-12-09T07:52:39");
});

test("isStockAccessLimitedError classifies Open-access stock failures as limited access", () => {
  assert.equal(
    isStockAccessLimitedError(new Error("Vinmonopolet API error 404: Not Found. {\"message\":\"Resource not found\"}")),
    true,
  );
  assert.equal(
    isStockAccessLimitedError(new Error("Vinmonopolet API error 403: Forbidden.")),
    true,
  );
  assert.equal(
    isStockAccessLimitedError(new Error("Vinmonopolet API error 500: Internal Server Error.")),
    false,
  );
});

test("isInvalidApiKeyError classifies invalid subscription key responses", () => {
  assert.equal(
    isInvalidApiKeyError(new Error("Vinmonopolet API error 401: Unauthorized. {\"message\":\"Access denied due to invalid subscription key.\"}")),
    true,
  );
  assert.equal(
    isInvalidApiKeyError(new Error("Vinmonopolet API error 404: Not Found. {\"message\":\"Resource not found\"}")),
    false,
  );
});

test("checkStoreStock falls back to vinmonopolet.no stock locator when official stock lookup fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.startsWith("https://apis.vinmonopolet.no/products/v0/accumulated-stock")) {
      return new Response(
        JSON.stringify({ message: "Resource not found" }),
        { status: 404, statusText: "Not Found", headers: { "Content-Type": "application/json" } },
      );
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
  };

  try {
    await setConfig("vinmonopolet_api_key", "dummy-key");

    const result = await checkStoreStock("123456", "116");
    assert.equal(result.status, "verified");
    assert.equal(result.storeStockConclusion, "in_stock");
    assert.equal(result.stockLevel, 7);
    assert.equal(result.stockSource, "website_stock_locator");
    assert.equal(result.websiteAvailabilityIsStoreStock, false);
    assert.match(result.message ?? "", /stock locator/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checkStoreStock returns unknown when both official and website stock lookups fail", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.startsWith("https://apis.vinmonopolet.no/products/v0/accumulated-stock")) {
      return new Response(
        JSON.stringify({ message: "Access denied due to invalid subscription key." }),
        { status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "https://www.vinmonopolet.no/vmpws/v2/vmp/stores/116?fields=FULL") {
      return new Response(
        JSON.stringify({ errors: [{ message: "Det har oppstått en feil." }] }),
        { status: 500, statusText: "Internal Server Error", headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };

  try {
    await setConfig("vinmonopolet_api_key", "dummy-key");

    const result = await checkStoreStock("123456", "116");
    assert.equal(result.status, "unverified");
    assert.equal(result.storeStockConclusion, "unknown");
    assert.equal(result.stockLevel, null);
    assert.equal(result.stockSource, "unverified");
    assert.match(result.message ?? "", /invalid/i);
    assert.match(result.message ?? "", /fallback failed/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
