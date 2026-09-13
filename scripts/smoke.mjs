#!/usr/bin/env node
// Spawns the built server over stdio and performs a real MCP handshake,
// then asserts that tools, resources, and prompts are registered.
// Runs entirely offline — no tool handlers are invoked.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const EXPECTED_MIN_TOOLS = 13;
const EXPECTED_MIN_RESOURCES = 2;
const EXPECTED_MIN_PROMPTS = 3;
const TIMEOUT_MS = 15_000;

const child = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    // Never touch the developer's real data directory, even accidentally.
    POLVENN_DATA_DIR: mkdtempSync(join(tmpdir(), "polvenn-smoke-")),
  },
});

const pending = new Map();
let nextId = 1;

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
}

const timeout = setTimeout(() => {
  console.error("Smoke test timed out");
  child.kill("SIGKILL");
  process.exit(1);
}, TIMEOUT_MS);

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.error("Smoke test received non-JSON line:", line.slice(0, 200));
    return;
  }

  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) {
    waiter.reject(new Error(`${waiter.method} failed: ${JSON.stringify(message.error)}`));
  } else {
    waiter.resolve(message.result);
  }
});

child.on("exit", (code) => {
  console.error(`Server exited unexpectedly with code ${code}`);
  process.exit(1);
});

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "polvenn-smoke", version: "0.0.0" },
  });
  console.log(`Initialized: ${init.serverInfo.name} v${init.serverInfo.version}`);

  notify("notifications/initialized");

  const tools = await request("tools/list", {});
  const resourceUris = init.capabilities?.resources
    ? (await request("resources/list", {})).resources.map((resource) => resource.uri)
    : [];
  const promptNames = init.capabilities?.prompts
    ? (await request("prompts/list", {})).prompts.map((prompt) => prompt.name)
    : [];

  const toolNames = tools.tools.map((tool) => tool.name);

  const failures = [];
  if (toolNames.length < EXPECTED_MIN_TOOLS) {
    failures.push(`expected >= ${EXPECTED_MIN_TOOLS} tools, got ${toolNames.length}`);
  }
  if (resourceUris.length < EXPECTED_MIN_RESOURCES) {
    failures.push(`expected >= ${EXPECTED_MIN_RESOURCES} resources, got ${resourceUris.length}`);
  }
  if (promptNames.length < EXPECTED_MIN_PROMPTS) {
    failures.push(`expected >= ${EXPECTED_MIN_PROMPTS} prompts, got ${promptNames.length}`);
  }

  console.log(`Tools (${toolNames.length}): ${toolNames.join(", ")}`);
  console.log(`Resources (${resourceUris.length}): ${resourceUris.join(", ") || "(none)"}`);
  console.log(`Prompts (${promptNames.length}): ${promptNames.join(", ") || "(none)"}`);

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }

  console.log("Smoke test passed");
  clearTimeout(timeout);
  child.stdin.end();
  child.kill("SIGTERM");
  process.exit(0);
} catch (error) {
  console.error(`Smoke test failed: ${error instanceof Error ? error.message : error}`);
  clearTimeout(timeout);
  child.kill("SIGKILL");
  process.exit(1);
}
