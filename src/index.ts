#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME } from "./constants.js";
import { closeDb, persistDb } from "./db/database.js";
import { registerAllTools } from "./tools/index.js";

const server = new McpServer({
  name: SERVER_NAME,
  version: "0.1.0",
});

registerAllTools(server);

let isShuttingDown = false;

function installShutdownHandlers(): void {
  const shutdown = (signal: string) => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;

    try {
      closeDb();
    } catch (error: unknown) {
      console.error(`Error while shutting down after ${signal}:`, error);
    } finally {
      process.exit(0);
    }
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("beforeExit", () => {
    persistDb();
  });
}

async function main(): Promise<void> {
  installShutdownHandlers();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Polvenn MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
