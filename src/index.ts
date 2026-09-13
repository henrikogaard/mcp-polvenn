#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { closeDb, persistDb } from "./db/database.js";
import { registerPrompts } from "./prompts/index.js";
import { registerResources } from "./resources/index.js";
import { registerAllTools } from "./tools/index.js";
import { setDiagnosticsListener } from "./utils/diagnostics.js";

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// Surface runtime degradation (e.g. dropped malformed upstream entries) as MCP
// logging notifications in addition to stderr. Notification failures (e.g. no
// client connected yet) must never affect behavior.
setDiagnosticsListener((message) => {
  server.sendLoggingMessage({ level: "warning", data: `polvenn: ${message}` }).catch(() => {});
});

registerAllTools(server);
registerResources(server);
registerPrompts(server);

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
