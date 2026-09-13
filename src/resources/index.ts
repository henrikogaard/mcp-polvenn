import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAllConfig, listWatchlistEntries } from "../db/database.js";
import * as vinmonopolet from "../services/vinmonopolet.js";
import { buildProductImageUrl } from "../utils/images.js";

function maskSecret(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function jsonContent(uri: string, payload: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    "watchlist",
    "polvenn://watchlist",
    {
      title: "Polvenn watchlist",
      description: "Your saved beer watchlist rules as JSON",
      mimeType: "application/json",
    },
    async (uri) => jsonContent(uri.href, { rules: await listWatchlistEntries() }),
  );

  server.registerResource(
    "config",
    "polvenn://config",
    {
      title: "Polvenn configuration",
      description: "Current Polvenn configuration as JSON (the Vinmonopolet API key is masked)",
      mimeType: "application/json",
    },
    async (uri) => {
      const config = await getAllConfig();
      return jsonContent(uri.href, {
        releaseFeedUrl: config.releaseFeedUrl,
        vinmonopoletApiKey: maskSecret(config.vinmonopoletApiKey),
        homeStoreId: config.homeStoreId,
        homeLatitude: config.homeLatitude,
        homeLongitude: config.homeLongitude,
      });
    },
  );

  server.registerResource(
    "product",
    new ResourceTemplate("polvenn://product/{articleNumber}", { list: undefined }),
    {
      title: "Vinmonopolet product",
      description: "One Vinmonopolet product as JSON, by article number (null when not found)",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const articleNumber = String(variables.articleNumber ?? "").trim();
      const product = articleNumber
        ? await vinmonopolet.getProductById(articleNumber).catch(() => null)
        : null;
      return jsonContent(
        uri.href,
        product
          ? {
              ...product,
              imageUrl: buildProductImageUrl(product.basic.productId),
            }
          : { found: false, articleNumber },
      );
    },
  );

  server.registerResource(
    "store",
    new ResourceTemplate("polvenn://store/{storeId}", { list: undefined }),
    {
      title: "Vinmonopolet store",
      description: "One Vinmonopolet store as JSON, by store ID (null when not found)",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const storeId = String(variables.storeId ?? "").trim();
      const store = storeId ? await vinmonopolet.getStoreById(storeId).catch(() => null) : null;
      return jsonContent(
        uri.href,
        store
          ? { ...store, todayOpeningHours: vinmonopolet.getTodaysOpeningHours(store) }
          : { found: false, storeId },
      );
    },
  );
}
