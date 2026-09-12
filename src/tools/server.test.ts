import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStateForTests, setConfig } from "../db/database.js";
import { registerPrompts } from "../prompts/index.js";
import { registerResources } from "../resources/index.js";
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
    // All tests in this file share one per-file db; start each test clean.
    await resetStateForTests();

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

  it("searches the product catalogue with an optional beer filter", async () => {
    await setConfig("vinmonopolet_api_key", "dummy-key");
    stubFetchRoutes([
      {
        match: (url) =>
          url.startsWith("https://apis.vinmonopolet.no/products/v0/details-normal") &&
          url.includes("productShortNameContains="),
        body: [
          detailedProduct,
          {
            basic: { productId: "407", productShortName: "Gilmour Vin Norrøn Cider" },
            classification: { mainProductTypeId: "9", mainProductTypeName: "Cider" },
          },
        ],
      },
    ]);

    const all = await callTool("polvenn_search_products", { query: "norrøn" });
    expect(all.structuredContent).toMatchObject({ query: "norrøn", totalResults: 2 });
    expect((all.structuredContent as { results: unknown[] }).results).toHaveLength(2);

    const beersOnly = await callTool("polvenn_search_products", {
      query: "norrøn",
      beerOnly: true,
    });
    expect(beersOnly.structuredContent).toMatchObject({ beerOnly: true, totalResults: 1 });
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
});
