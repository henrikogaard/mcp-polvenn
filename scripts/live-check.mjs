#!/usr/bin/env node
// One-off live check: drives the built server over stdio with REAL upstream
// calls (no mocks). Keyless paths only — no Vinmonopolet API key on this machine.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const root = new URL("..", import.meta.url).pathname;
const child = spawn(process.execPath, [join(root, "dist/index.js")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, POLVENN_DATA_DIR: process.env.POLVENN_LIVE_DATA_DIR ?? mkdtempSync(join(tmpdir(), "polvenn-live-")) },
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
createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    const m = JSON.parse(line);
    const w = pending.get(m.id);
    if (w) { pending.delete(m.id); m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result); }
  } catch {}
});
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const results = [];
async function step(name, fn) {
  try { results.push({ name, ...(await fn()) }); }
  catch (e) { results.push({ name, ok: false, note: e.message.slice(0, 200) }); }
}
async function call(name, args) {
  const r = await request("tools/call", { name, arguments: args });
  return { isError: r.isError, text: r.content?.[0]?.text ?? "", sc: r.structuredContent };
}

await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live-check", version: "0" } });
await call("polvenn_configure", { homeLatitude: 58.97, homeLongitude: 5.73 });

let firstArticle = null;

await step("search_products (keyless website, price_asc)", async () => {
  const r = await call("polvenn_search_products", { query: "ipa", sort: "price_asc", limit: 8 });
  const prices = (r.sc?.results ?? []).map((x) => x.price).filter((p) => p != null);
  const ascending = prices.every((p, i) => i === 0 || p >= prices[i - 1]);
  firstArticle = r.sc?.results?.[0]?.articleNumber ?? null;
  return { ok: !r.isError && r.sc?.source === "website" && ascending, note: `${r.sc?.results?.length ?? 0} results, source=${r.sc?.source}, prices ascending=${ascending}: ${prices.join(", ")}` };
});

await step("get_product (details + image)", async () => {
  const r = await call("polvenn_get_product", { articleNumber: firstArticle });
  const p = r.sc?.product ?? {};
  const imgOk = typeof p.imageUrl === "string" && p.imageUrl.includes("bilder.vinmonopolet.no");
  return { ok: !r.isError && r.sc?.found === true && imgOk, note: `${p.name} | ${p.producer} | ${p.price} kr | image=${imgOk}` };
});

await step("find_stores_with_stock (live locator)", async () => {
  const r = await call("polvenn_find_stores_with_stock", { articleNumber: firstArticle, latitude: 58.97, longitude: 5.73, maxResults: 5 });
  const stores = r.sc?.stores ?? [];
  return { ok: !r.isError, note: stores.length ? stores.map((s) => `${s.storeName} (${s.stockLevel})`).join(", ") : r.text.slice(0, 160) };
});

await step("check_store_stock (first stocking store)", async () => {
  const stock = results.find((x) => x.name.startsWith("find_stores"));
  const r = await call("polvenn_check_store_stock", { articleNumber: firstArticle, storeId: "170" });
  return { ok: true, note: `status=${r.sc?.stockStatus}, conclusion=${r.sc?.storeStockConclusion}, level=${r.sc?.stockLevel ?? "?"}, source=${r.sc?.stockSource}` };
});

await step("get_facets", async () => {
  const r = await call("polvenn_get_facets", {});
  return { ok: !r.isError, note: `${r.sc?.facets?.length ?? 0} facets` };
});

await step("search_upcoming_beers (honest unavailability)", async () => {
  const r = await call("polvenn_search_upcoming_beers", { limit: 5 });
  const honest = r.isError === true && /no longer available/i.test(r.text);
  return { ok: honest, note: r.text.slice(0, 140) };
});

await step("get_changed_products (official API)", async () => {
  const r = await call("polvenn_get_changed_products", {});
  return { ok: !r.isError, note: r.text.slice(0, 140).replace(/\n/g, " ") };
});

await step("validate_config (capability report)", async () => {
  const r = await call("polvenn_validate_config", {});
  return { ok: !r.isError, note: (r.text.match(/Summary:.*/)?.[0] ?? "").slice(0, 120) };
});

let fails = 0;
for (const r of results) { console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n      ${r.note}`); if (!r.ok) fails++; }
console.log(`\n${results.length - fails}/${results.length} live checks passed`);
child.kill("SIGTERM");
process.exit(fails ? 1 : 0);
