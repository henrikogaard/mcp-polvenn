#!/usr/bin/env node
// Live probe: exercises every upstream data source with real requests and
// records the raw responses under fixtures/live/ as reference fixtures.
// Opt-in (not part of CI) — run it after `npm run build`:
//
//   npm run probe
//
// Uses your real configuration from ~/.polvenn (or POLVENN_DATA_DIR), so a
// Vinmonopolet API key makes the official-API probes meaningful. Website
// probes need no key. Fixture files are gitignored; they exist to let you
// eyeball upstream shape drift (AGENTS.md "known limitations" #3).

import fs from "node:fs";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const fixturesDir = path.join(root, "fixtures", "live");
fs.mkdirSync(fixturesDir, { recursive: true });

const { getAllConfig } = await import(path.join(root, "dist/db/database.js"));
const vinmonopolet = await import(path.join(root, "dist/services/vinmonopolet.js"));

const config = await getAllConfig();
const results = [];

async function probe(name, fn) {
  try {
    const data = await fn();
    results.push({ name, ok: true, summary: data?.summary ?? "ok" });
    if (data?.fixture !== undefined) {
      fs.writeFileSync(
        path.join(fixturesDir, `${name}.json`),
        `${JSON.stringify(data.fixture, null, 2)}\n`,
      );
    }
  } catch (error) {
    results.push({ name, ok: false, summary: error instanceof Error ? error.message : String(error) });
  }
}

console.log(`Polvenn live probe — api key: ${config.vinmonopoletApiKey ? "configured" : "NOT configured"}\n`);

// --- Official API probes (need a key) ---
if (config.vinmonopoletApiKey) {
  await probe("official-products", async () => {
    const products = await vinmonopolet.getProducts({ maxResults: 3 });
    return { fixture: products, summary: `${products.length} product(s)` };
  });

  await probe("official-stores", async () => {
    const stores = await vinmonopolet.getStores();
    return { fixture: stores.slice(0, 3), summary: `${stores.length} store(s)` };
  });

  if (config.homeStoreId) {
    await probe("official-stock", async () => {
      const rows = await vinmonopolet.getStock({
        storeId: config.homeStoreId,
        changedSince: new Date().toISOString().split("T")[0],
      });
      return { fixture: rows.slice(0, 5), summary: `${rows.length} stock row(s)` };
    });
  }
} else {
  console.log("Skipping official API probes (no API key configured).\n");
}

// --- Website probes (no key) ---
await probe("website-upcoming-beers", async () => {
  const beers = await vinmonopolet.getUpcomingBeers(5);
  return { fixture: beers, summary: `${beers.length} upcoming beer(s)` };
});

await probe("website-search", async () => {
  const products = await vinmonopolet.searchWebsiteProducts("ipa", { maxResults: 5 });
  return { fixture: products, summary: `${products.length} product(s)` };
});

await probe("website-facets", async () => {
  const facets = await vinmonopolet.getSearchFacets();
  return {
    fixture: facets,
    summary: `${facets.length} facet(s): ${facets.slice(0, 5).map((f) => f.name).join(", ")}`,
  };
});

if (config.homeLatitude != null && config.homeLongitude != null) {
  await probe("website-nearby-stores", async () => {
    const stores = await vinmonopolet.findNearbyStores(config.homeLatitude, config.homeLongitude, 3);
    return {
      fixture: stores,
      summary: stores.map((store) => `${store.storeName} (${store.distanceKm.toFixed(1)} km)`).join(", "),
    };
  });
}

if (config.homeLatitude != null && config.homeLongitude != null) {
  await probe("website-stock-locator", async () => {
    // Find some beer article first so the locator has a real product.
    // (The Nyheter listing — the upcoming listing is gone upstream.)
    const beers = await vinmonopolet.getNewBeers(1);
    const articleNumber = beers[0]?.basic?.productId;
    if (!articleNumber) {
      return { summary: "no new beer article available to probe" };
    }
    const stores = await vinmonopolet.findStoresWithProductStock(
      articleNumber,
      config.homeLatitude,
      config.homeLongitude,
      5,
    );
    return {
      fixture: { articleNumber, stores },
      summary: stores.length > 0
        ? stores.map((store) => `${store.storeName} (${store.stockLevel})`).join(", ")
        : "no stocking stores returned (may be sold out or restricted)",
    };
  });
}

// --- Report ---
let failures = 0;
for (const result of results) {
  const icon = result.ok ? "OK  " : "FAIL";
  console.log(`${icon} ${result.name}: ${result.summary}`);
  if (!result.ok) {
    failures += 1;
  }
}

console.log(
  `\n${results.length - failures}/${results.length} probes passed. Fixtures written to fixtures/live/ (gitignored).`,
);
process.exit(failures > 0 ? 1 : 0);
