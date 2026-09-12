import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function userMessage(text: string) {
  return {
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text },
      },
    ],
  };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "polvenn_check_watchlist",
    {
      title: "Check beer watchlist",
      description: "Check the beer watchlist for new matches since the last check",
    },
    () =>
      userMessage(
        "Use the polvenn_watchlist tool with action='check' and summarize the new matches. " +
          "If there are no new matches, say so briefly.",
      ),
  );

  server.registerPrompt(
    "polvenn_whats_new",
    {
      title: "What's new",
      description: "Find new beer releases on Vinmonopolet, optionally filtered",
      argsSchema: {
        style: z.string().optional().describe("Beer style filter, e.g. 'IPA', 'Stout'"),
        storeId: z.string().optional().describe("Only beers available in this store"),
      },
    },
    ({ style, storeId }) => {
      const parts = ["Use polvenn_search_new_beers to find new beer releases"];
      if (storeId) {
        parts.push(`limited to store ${storeId}`);
      }
      if (style) {
        parts.push(`matching style '${style}'`);
      }
      parts.push(
        "Summarize the most interesting ones with name, brewery, style, ABV, and article number.",
      );
      return userMessage(parts.join(" ").concat("."));
    },
  );

  server.registerPrompt(
    "polvenn_stock_check",
    {
      title: "Check store stock",
      description: "Check whether a specific article number is in stock at a store",
      argsSchema: {
        articleNumber: z.string().describe("Vinmonopolet article number"),
        storeId: z.string().optional().describe("Store ID (defaults to your home store)"),
      },
    },
    ({ articleNumber, storeId }) => {
      const storePart = storeId ? ` at store ${storeId}` : " at your home store";
      return userMessage(
        `Use polvenn_check_store_stock to check whether article ${articleNumber} is in stock${storePart}. ` +
          "Report the verified stock conclusion; if stock is unknown, say it is unknown rather than out of stock.",
      );
    },
  );
}
