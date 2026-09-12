import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAllConfig, listWatchlistEntries } from "../db/database.js";

function maskSecret(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
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
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ rules: await listWatchlistEntries() }, null, 2),
        },
      ],
    }),
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
      const payload = {
        releaseFeedUrl: config.releaseFeedUrl,
        vinmonopoletApiKey: maskSecret(config.vinmonopoletApiKey),
        homeStoreId: config.homeStoreId,
        homeLatitude: config.homeLatitude,
        homeLongitude: config.homeLongitude,
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );
}
