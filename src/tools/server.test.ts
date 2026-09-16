import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStateForTests, setConfig } from "../db/database.js";
import { registerPrompts } from "../prompts/index.js";
import { registerResources } from "../resources/index.js";
import { resetStoreListCacheForTests } from "../services/vinmonopolet.js";
import { registerAllTools } from "./index.js";

interface FetchRoute {
  match: (url: string) => boolean;
  body: unknown;
  status?: number;
}

function stubFetchRoutes(routes: FetchRoute[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;

      for (const route of routes) {
        if (route.match(url)) {
          const status = route.status ?? 200;
          return new Response(JSON.stringify(route.body), {
            status,
            statusText: status === 200 ? "OK" : "Error",
          });
        }
      }

      throw new Error(`Unexpected fetch in test: ${url}`);
    }),
  );
}

const releaseFeedRoute: FetchRoute = {
  match: (url) => url.startsWith("https://feed.test/releases/latest"),
  body: {
    releases: [
      {
        id: "release-1",
        title: "Week 37 releases",
        source: "vinmonopolet-news",
        publishedAt: "2026-09-10T08:00:00Z",
        items: [
          {
            country: "Norge",
            articleNumber: "20162402",
            producer: "Amundsen Bryggeri",
            name: "Amundsen The Darkening Imp Pastry Stout",
            style: "Porter & stout",
            abv: 12,
            releaseDate: "10. september 2026",
          },
          {
            country: "Latvia",
            articleNumber: "17436502",
            producer: "Arpus Brewing Co.",
            name: "Arpus TDH Mosaic DIPA",
            style: "India pale ale",
            abv: 8,
            releaseDate: "10. september 2026",
          },
        ],
      },
    ],
  },
};

const detailedProduct = {
  basic: {
    productId: "20162402",
    productShortName: "Amundsen The Darkening Imp",
    alcoholContent: 12,
    volume: 0.33,
  },
  lastChanged: { date: "2026-09-10", time: "08:00:00" },
  classification: {
    mainProductTypeId: "10",
    mainProductTypeName: "Øl",
    subProductTypeName: "Porter & stout",
  },
  origins: {
    origin: { country: "Norge" },
    productionOrigin: { producerName: "Amundsen Bryggeri" },
  },
  prices: { salesPrice: 129.9 },
  availability: { buyable: true, status: "aktiv", productSelection: "Bestillingsutvalget" },
};

const storesRoute: FetchRoute = {
  match: (url) => url.startsWith("https://apis.vinmonopolet.no/stores/v0/details"),
  body: [
    {
      storeId: "170",
      storeName: "Stavanger, Klubbgata",
      status: "open",
      address: {
        street: "Klubbgata 1",
        postalCode: "4006",
        city: "Stavanger",
        gpsCoord: "58.970389;5.733810",
      },
      category: "Klasse D",
      openingHours: {
        regularHours: [
          { dayOfTheWeek: "Monday", openingTime: "10:00", closingTime: "18:00", closed: false },
        ],
      },
    },
    {
      storeId: "116",
      storeName: "Sandnes, Kvadrat",
      status: "open",
      address: {
        street: "Kvadrat Storsenter",
        postalCode: "4306",
        city: "Sandnes",
        gpsCoord: "58.876707;5.721903",
      },
      category: "Klasse D",
    },
  ],
};

describe("MCP server (end-to-end over in-memory transport)", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    // All tests in this file share one per-file db and module registry;
    // start each test clean (db state + in-memory store-list cache).
    await resetStateForTests();
    resetStoreListCacheForTests();

    server = new McpServer({ name: "polvenn-test", version: "0.0.0" });
    registerAllTools(server);
    registerResources(server);
    registerPrompts(server);

    client = new Client({ name: "polvenn-test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    vi.unstubAllGlobals();
  });

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    return result as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
    };
  }

  it("exposes every tool with a declared output schema", async () => {
    const { tools } = await client.listTools();

    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "polvenn_check_store_stock",
      "polvenn_configure",
      "polvenn_find_nearby_stores",
      "polvenn_find_stores_with_stock",
      "polvenn_get_changed_products",
      "polvenn_get_facets",
      "polvenn_get_product",
      "polvenn_search_new_beers",
      "polvenn_search_new_beers_near_store",
      "polvenn_search_products",
      "polvenn_search_upcoming_beers",
      "polvenn_validate_config",
      "polvenn_watchlist",
    ]);
    for (const tool of tools) {
      // Every tool must advertise its structured output contract.
      expect(tool.outputSchema, `${tool.name} missing outputSchema`).toBeTruthy();
    }
  });

  it("exposes watchlist and config resources", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      "polvenn://config",
      "polvenn://watchlist",
    ]);

    await callTool("polvenn_watchlist", { action: "add", type: "brewery", value: "amundsen" });

    const read = await client.readResource({ uri: "polvenn://watchlist" });
    const text = (read.contents[0] as { text: string }).text;
    expect(JSON.parse(text).rules).toHaveLength(1);
  });

  it("exposes prompts with arguments", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      "polvenn_check_watchlist",
      "polvenn_stock_check",
      "polvenn_whats_new",
    ]);

    const prompt = await client.getPrompt({
      name: "polvenn_whats_new",
      arguments: { style: "IPA" },
    });
    expect(prompt.messages).toHaveLength(1);
    expect((prompt.messages[0].content as { text: string }).text).toContain("IPA");
  });

  it("returns validated structured content for a watchlist add/list/check round trip", async () => {
    await setConfig("release_feed_url", "https://feed.test");
    stubFetchRoutes([releaseFeedRoute]);

    const add = await callTool("polvenn_watchlist", {
      action: "add",
      type: "brewery",
      value: "amundsen",
    });
    expect(add.isError).toBeFalsy();
    expect(add.structuredContent).toMatchObject({ action: "add" });

    const list = await callTool("polvenn_watchlist", { action: "list" });
    expect(list.structuredContent).toMatchObject({ action: "list", totalRules: 1 });

    const firstCheck = await callTool("polvenn_watchlist", { action: "check" });
    expect(firstCheck.structuredContent).toMatchObject({
      action: "check",
      totalBeers: 2,
      totalMatches: 1,
    });
    expect((firstCheck.structuredContent as { newMatches: unknown[] }).newMatches).toHaveLength(1);

    // Second check of the same release sees the match as repeated.
    const secondCheck = await callTool("polvenn_watchlist", { action: "check" });
    expect((secondCheck.structuredContent as { newMatches: unknown[] }).newMatches).toHaveLength(0);
    expect(
      (secondCheck.structuredContent as { repeatedMatches: unknown[] }).repeatedMatches,
    ).toHaveLength(1);
  });

  it("checks store stock via the official API and returns structured content", async () => {
    await setConfig("vinmonopolet_api_key", "dummy-key");
    stubFetchRoutes([
      {
        match: (url) =>
          url.startsWith("https://apis.vinmonopolet.no/products/v0/details-normal") &&
          url.includes("productId=20162402"),
        body: [detailedProduct],
      },
      {
        match: (url) =>
          url.startsWith("https://apis.vinmonopolet.no/products/v0/accumulated-stock"),
        body: [{ productId: "20162402", storeId: "170", stock: 4 }],
      },
    ]);

    const result = await callTool("polvenn_check_store_stock", {
      articleNumber: "20162402",
      storeId: "170",
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      stockStatus: "verified",
      storeStockConclusion: "in_stock",
      stockSource: "official_api",
      inStock: true,
      stockLevel: 4,
    });
  });

  it("finds nearby stores sorted by distance", async () => {
    await setConfig("vinmonopolet_api_key", "dummy-key");
    stubFetchRoutes([storesRoute]);

    const result = await callTool("polvenn_find_nearby_stores", {
      latitude: 58.97,
      longitude: 5.73,
      maxResults: 2,
    });

    const stores = (result.structuredContent as { stores: Array<{ storeId: string }> }).stores;
    expect(stores.map((store) => store.storeId)).toEqual(["170", "116"]);
  });

  it("returns external feed results for source=external searches", async () => {
    await setConfig("release_feed_url", "https://feed.test");
    stubFetchRoutes([releaseFeedRoute]);

    const result = await callTool("polvenn_search_new_beers", { source: "external" });

    expect(result.structuredContent).toMatchObject({
      source: "external",
      totalResults: 2,
    });
    expect((result.structuredContent as { results: unknown[] }).results).toHaveLength(2);
  });

  it("reports errors without structured content for invalid release dates", async () => {
    await setConfig("release_feed_url", "https://feed.test");
    stubFetchRoutes([releaseFeedRoute]);

    const result = await callTool("polvenn_search_new_beers", {
      source: "external",
      releaseDate: "not-a-date",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toContain("releaseDate must be");
  });

  it("configures and validates the full setup against live-shaped stubs", async () => {
    stubFetchRoutes([
      releaseFeedRoute,
      {
        match: (url) => url.startsWith("https://apis.vinmonopolet.no/products/v0/details-normal"),
        body: [detailedProduct],
      },
      storesRoute,
      {
        match: (url) =>
          url.startsWith("https://apis.vinmonopolet.no/products/v0/accumulated-stock"),
        body: [{ productId: "20162402", storeId: "170", stock: 4 }],
      },
    ]);

    const configure = await callTool("polvenn_configure", {
      releaseFeedUrl: "https://feed.test",
      vinmonopoletApiKey: "test-subscription-key",
      homeStoreId: "170",
      homeLatitude: 58.97,
      homeLongitude: 5.73,
    });
    expect(configure.structuredContent).toMatchObject({
      releaseFeedUrl: "https://feed.test",
      vinmonopoletApiKeyConfigured: true,
      homeStoreId: "170",
    });

    const validate = await callTool("polvenn_validate_config", {});
    const summary = (validate.structuredContent as { summary: Record<string, number> }).summary;
    expect(summary.error).toBe(0);
    expect(summary.ok).toBeGreaterThan(0);
  });

  it("searches the product catalogue website-first with an optional beer filter", async () => {
    await setConfig("vinmonopolet_api_key", "dummy-key");
    stubFetchRoutes([
      {
        match: (url) => url.startsWith("https://www.vinmonopolet.no/vmpws/v2/vmp/products/search"),
        body: {
          products: [
            {
              code: "20162402",
              name: "Norrøn Øl",
              main_category: { name: "Øl" },
              main_producer: { name: "Bryggeriet" },
            },
            {
              code: "407",
              name: "Gilmour Vin Norrøn Cider",
              main_category: { name: "Cider" },
            },
          ],
          pagination: { totalPages: 1 },
        },
      },
    ]);

    const all = await callTool("polvenn_search_products", { query: "norrøn" });
    expect(all.structuredContent).toMatchObject({
      query: "norrøn",
      source: "website",
      totalResults: 2,
    });
    expect((all.structuredContent as { results: unknown[] }).results).toHaveLength(2);

    const beersOnly = await callTool("polvenn_search_products", {
      query: "norrøn",
      beerOnly: true,
    });
    expect(beersOnly.structuredContent).toMatchObject({ beerOnly: true, totalResults: 1 });
  });

  it("falls back to the official API when the website search fails and a key exists", async () => {
    await setConfig("vinmonopolet_api_key", "dummy-key");
    stubFetchRoutes([
      {
        match: (url) => url.startsWith("https://www.vinmonopolet.no/vmpws/v2/vmp/products/search"),
        body: { errors: [{ message: " Exploded" }] },
      },
      {
        match: (url) =>
          url.startsWith("https://apis.vinmonopolet.no/products/v0/details-normal") &&
          url.includes("productShortNameContains="),
        body: [detailedProduct],
      },
    ]);

    const result = await callTool("polvenn_search_products", { query: "norrøn" });
    expect(result.structuredContent).toMatchObject({ source: "official_api", totalResults: 1 });
  });

  it("resolves a numeric article query via get_product", async () => {
    await setConfig("vinmonopolet_api_key", "dummy-key");
    stubFetchRoutes([
      {
        match: (url) =>
          url.startsWith("https://apis.vinmonopolet.no/products/v0/details-normal") &&
          url.includes("productId=20162402"),
        body: [detailedProduct],
      },
    ]);

    const result = await callTool("polvenn_search_products", { query: "20162402" });
    expect(result.structuredContent).toMatchObject({ totalResults: 1 });

    const details = await callTool("polvenn_get_product", { articleNumber: "20162402" });
    expect(details.structuredContent).toMatchObject({
      found: true,
      articleNumber: "20162402",
    });
    const product = (details.structuredContent as { product: Record<string, unknown> }).product;
    expect(product.name).toBe("Amundsen The Darkening Imp");
    expect(product.price).toBe(129.9);
    expect(product.producer).toBe("Amundsen Bryggeri");
  });

  it("reports a missing product honestly", async () => {
    await setConfig("vinmonopolet_api_key", "dummy-key");
    stubFetchRoutes([
      {
        // Official API finds nothing; the website product page also fails.
        match: (url) => url.startsWith("https://apis.vinmonopolet.no/products/v0/details-normal"),
        body: [],
      },
      {
        match: (url) => url.startsWith("https://www.vinmonopolet.no/p/"),
        body: { error: "not found" },
        status: 404,
      },
    ]);

    const result = await callTool("polvenn_get_product", { articleNumber: "99999999" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ found: false, product: null });
  });

  it("supports abv and price watch rules end to end", async () => {
    await setConfig("release_feed_url", "https://feed.test");
    await setConfig("vinmonopolet_api_key", "dummy-key");
    stubFetchRoutes([
      releaseFeedRoute,
      {
        // Every product lookup resolves to the same priced product.
        match: (url) =>
          url.startsWith("https://apis.vinmonopolet.no/products/v0/details-normal") &&
          url.includes("productId="),
        body: [detailedProduct],
      },
    ]);

    const abvAdd = await callTool("polvenn_watchlist", {
      action: "add",
      type: "abv",
      minValue: 10,
    });
    const abvEntry = (abvAdd.structuredContent as { entry: Record<string, unknown> }).entry;
    expect(abvEntry.value).toBe("abv >= 10");
    expect(abvEntry.minValue).toBe(10);

    const priceAdd = await callTool("polvenn_watchlist", {
      action: "add",
      type: "price",
      minValue: 100,
      maxValue: 150,
    });
    expect((priceAdd.structuredContent as { entry: Record<string, unknown> }).entry.value).toBe(
      "price 100–150",
    );

    // The check enriches prices from Vinmonopolet: both beers resolve to
    // 129.9 kr, so the price rule matches both, and the abv rule (>= 10)
    // matches only the 12% stout.
    const check = await callTool("polvenn_watchlist", { action: "check" });
    expect(check.structuredContent).toMatchObject({
      action: "check",
      totalBeers: 2,
      totalMatches: 2,
      unevaluatedPriceBeers: 0,
    });

    const list = await callTool("polvenn_watchlist", { action: "list" });
    expect(list.structuredContent).toMatchObject({ totalRules: 2 });
  });

  it("rejects numeric rule adds without bounds", async () => {
    const result = await callTool("polvenn_watchlist", {
      action: "add",
      type: "abv",
      value: "whatever",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("minValue");
  });

  it("reports stock rules with new arrivals during check", async () => {
    await setConfig("release_feed_url", "https://feed.test");
    await setConfig("vinmonopolet_api_key", "dummy-key");
    await setConfig("home_store_id", "170");
    stubFetchRoutes([
      releaseFeedRoute,
      storesRoute,
      {
        match: (url) =>
          url.startsWith("https://apis.vinmonopolet.no/products/v0/accumulated-stock"),
        body: [{ productId: "20162402", storeId: "170", stock: 6 }],
      },
      {
        match: (url) =>
          url.startsWith("https://apis.vinmonopolet.no/products/v0/details-normal") &&
          url.includes("productId="),
        body: [detailedProduct],
      },
    ]);

    const add = await callTool("polvenn_watchlist", {
      action: "add",
      type: "stock",
      value: "20162402",
    });
    expect(add.structuredContent).toMatchObject({
      action: "add",
      entry: { type: "stock", value: "20162402" },
    });

    const firstCheck = await callTool("polvenn_watchlist", { action: "check" });
    const stockResults = (
      firstCheck.structuredContent as {
        stockResults: Array<{
          articleNumber: string;
          inStock: boolean | null;
          newInStock: boolean;
        }>;
      }
    ).stockResults;
    expect(stockResults).toHaveLength(1);
    expect(stockResults[0]).toMatchObject({
      articleNumber: "20162402",
      inStock: true,
      newInStock: true,
    });
    expect(firstCheck.content[0].text).toContain("Stock watch");

    // Second check sees the same in-stock state as not new.
    const secondCheck = await callTool("polvenn_watchlist", { action: "check" });
    const secondResults = (
      secondCheck.structuredContent as { stockResults: Array<{ newInStock: boolean }> }
    ).stockResults;
    expect(secondResults[0].newInStock).toBe(false);
  });

  it("rejects stock rules without a numeric article number", async () => {
    const result = await callTool("polvenn_watchlist", {
      action: "add",
      type: "stock",
      value: "not-a-number",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("article number");
  });

  it("finds stores with a product in stock via the website locator", async () => {
    stubFetchRoutes([
      {
        match: (url) => url === "https://www.vinmonopolet.no/vmpws/v2/vmp/stores/170?fields=FULL",
        body: { id: "170", name: "170", geoPoint: { latitude: 58.97, longitude: 5.73 } },
      },
      {
        match: (url) => url.includes("/vmpws/v2/vmp/products/20162402/stock"),
        body: {
          stores: [
            {
              pointOfService: { id: "170", displayName: "Stavanger, Klubbgata" },
              stockInfo: { stockLevel: 4 },
            },
            {
              pointOfService: { id: "116", displayName: "Sandnes, Kvadrat" },
              stockInfo: { stockLevel: 2 },
            },
          ],
          pagination: { totalPages: 1 },
        },
      },
      {
        match: (url) =>
          url.startsWith("https://apis.vinmonopolet.no/products/v0/details-normal") &&
          url.includes("productId=20162402"),
        body: [detailedProduct],
      },
    ]);

    const result = await callTool("polvenn_find_stores_with_stock", {
      articleNumber: "20162402",
      latitude: 58.97,
      longitude: 5.73,
      maxResults: 5,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      articleNumber: "20162402",
      productName: "Amundsen The Darkening Imp",
      stores: [
        { storeId: "170", storeName: "Stavanger, Klubbgata", stockLevel: 4 },
        { storeId: "116", storeName: "Sandnes, Kvadrat", stockLevel: 2 },
      ],
    });
  });

  it("lists products changed since a date via the official API", async () => {
    await setConfig("vinmonopolet_api_key", "dummy-key");
    stubFetchRoutes([
      {
        match: (url) =>
          url.startsWith("https://apis.vinmonopolet.no/products/v0/details-normal") &&
          url.includes("changedSince=2026-09-01"),
        body: [detailedProduct],
      },
    ]);

    const result = await callTool("polvenn_get_changed_products", {
      since: "2026-09-01",
      beerOnly: true,
    });

    expect(result.structuredContent).toMatchObject({
      since: "2026-09-01",
      beerOnly: true,
      totalResults: 1,
    });
    expect(
      (result.structuredContent as { results: Array<{ articleNumber: string }> }).results,
    ).toEqual([expect.objectContaining({ articleNumber: "20162402" })]);
  });

  it("lists search facets from the website", async () => {
    stubFetchRoutes([
      {
        match: (url) => url.startsWith("https://www.vinmonopolet.no/vmpws/v2/vmp/products/search"),
        body: {
          products: [],
          facets: [
            {
              code: "mainCategory",
              name: "Varegruppe",
              values: [{ code: "øl", name: "Øl", count: 1000 }],
            },
          ],
          pagination: { totalPages: 1 },
        },
      },
    ]);

    const result = await callTool("polvenn_get_facets", {});
    expect(result.structuredContent).toMatchObject({
      facets: [
        { name: "mainCategory", displayName: "Varegruppe", values: [{ name: "Øl", count: 1000 }] },
      ],
    });
  });

  it("falls back to keyless website search when no API key is configured", async () => {
    await setConfig("vinmonopolet_api_key", "");
    stubFetchRoutes([
      {
        match: (url) => url.startsWith("https://www.vinmonopolet.no/vmpws/v2/vmp/products/search"),
        body: {
          products: [
            {
              code: "20162402",
              name: "Website Beer",
              price: { value: 99 },
              main_category: { name: "Øl" },
            },
          ],
          pagination: { totalPages: 1 },
        },
      },
    ]);

    const result = await callTool("polvenn_search_products", { query: "website beer" });

    expect(result.structuredContent).toMatchObject({
      source: "website",
      totalResults: 1,
    });
    expect(
      (result.structuredContent as { results: Array<{ imageUrl: string }> }).results[0].imageUrl,
    ).toContain("bilder.vinmonopolet.no");
  });

  it("resolves products by EAN-13 barcode", async () => {
    stubFetchRoutes([
      {
        match: (url) => url.includes("/vmpws/v2/vmp/products/barCodeSearch/7040514300215"),
        body: { code: "1234501", name: "Barcode Beer", main_category: { name: "Øl" } },
      },
    ]);

    const result = await callTool("polvenn_search_products", { query: "7040514300215" });

    expect(result.structuredContent).toMatchObject({
      source: "product_lookup",
      totalResults: 1,
    });
    expect(
      (result.structuredContent as { results: Array<{ articleNumber: string }> }).results[0]
        .articleNumber,
    ).toBe("1234501");
  });

  it("includes product image URLs in get_product", async () => {
    await setConfig("vinmonopolet_api_key", "dummy-key");
    stubFetchRoutes([
      {
        match: (url) =>
          url.startsWith("https://apis.vinmonopolet.no/products/v0/details-normal") &&
          url.includes("productId=20162402"),
        body: [detailedProduct],
      },
    ]);

    const details = await callTool("polvenn_get_product", { articleNumber: "20162402" });
    const product = (details.structuredContent as { product: Record<string, unknown> }).product;
    expect(product.imageUrl).toBe("https://bilder.vinmonopolet.no/cache/300x300-0/20162402-1.jpg");
    expect(product.imageUrlLarge).toContain("515x515-0");
  });

  it("exposes product and store resource templates", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual([
      "polvenn://product/{articleNumber}",
      "polvenn://store/{storeId}",
    ]);

    await setConfig("vinmonopolet_api_key", "dummy-key");
    stubFetchRoutes([
      {
        match: (url) =>
          url.startsWith("https://apis.vinmonopolet.no/products/v0/details-normal") &&
          url.includes("productId=20162402"),
        body: [detailedProduct],
      },
    ]);

    const read = await client.readResource({ uri: "polvenn://product/20162402" });
    const payload = JSON.parse((read.contents[0] as { text: string }).text);
    expect(payload.basic.productId).toBe("20162402");
    expect(payload.imageUrl).toContain("bilder.vinmonopolet.no");
  });

  it("includes today's opening hours for nearby stores", async () => {
    await setConfig("vinmonopolet_api_key", "dummy-key");
    const today = new Date().toLocaleDateString("en-US", { weekday: "long" });
    stubFetchRoutes([
      {
        match: (url) => url.startsWith("https://apis.vinmonopolet.no/stores/v0/details"),
        body: [
          {
            storeId: "170",
            storeName: "Stavanger, Klubbgata",
            status: "open",
            address: {
              street: "Klubbgata 1",
              postalCode: "4006",
              city: "Stavanger",
              gpsCoord: "58.970389;5.733810",
            },
            category: "Klasse D",
            openingHours: {
              regularHours: [
                { dayOfTheWeek: today, openingTime: "10:00", closingTime: "17:00", closed: false },
              ],
            },
          },
        ],
      },
    ]);

    const result = await callTool("polvenn_find_nearby_stores", {
      latitude: 58.97,
      longitude: 5.73,
      maxResults: 1,
    });

    const stores = (
      result.structuredContent as {
        stores: Array<{ todayOpeningHours: { closed: boolean } | null }>;
      }
    ).stores;
    expect(stores[0].todayOpeningHours).toMatchObject({ closed: false });
    expect(result.content[0].text).toContain("Open today 10:00–17:00");
  });
});
