import { describe, expect, it } from "vitest";
import type { WatchlistRuleType } from "../types.js";
import {
  addWatchlistEntry,
  getCachedBeer,
  getConfigValue,
  getDb,
  getSeenWatchlistMatchKeys,
  listWatchlistEntries,
  removeWatchlistEntry,
  resetStateForTests,
  setCachedBeer,
  setConfig,
  setSeenWatchlistMatchKeys,
} from "./database.js";

describe("watchlist storage", () => {
  it("adds, lists, and removes rules including numeric bounds", async () => {
    await resetStateForTests();

    await addWatchlistEntry("brewery", "Amundsen ");
    await addWatchlistEntry("abv", "abv 8–12", 8, 12);

    const entries = await listWatchlistEntries();
    expect(entries).toHaveLength(2);

    const brewery = entries.find((entry) => entry.type === "brewery");
    expect(brewery?.value).toBe("amundsen"); // normalised
    expect(brewery?.minValue).toBeNull();
    expect(brewery?.maxValue).toBeNull();
    expect(brewery).toBeDefined();
    const breweryId: number = brewery?.id ?? -1;

    const abv = entries.find((entry) => entry.type === "abv");
    expect(abv?.minValue).toBe(8);
    expect(abv?.maxValue).toBe(12);

    expect(await removeWatchlistEntry(breweryId)).toBe(true);
    expect(await removeWatchlistEntry(breweryId)).toBe(false); // already gone
    expect(await listWatchlistEntries()).toHaveLength(1);
  });

  it("rejects unknown rule types via the schema CHECK constraint", async () => {
    await resetStateForTests();

    await expect(addWatchlistEntry("grape" as WatchlistRuleType, "whatever")).rejects.toThrow();
  });
});

describe("config storage", () => {
  it("round-trips values", async () => {
    await setConfig("home_store_id", "170");
    expect(await getConfigValue("home_store_id")).toBe("170");

    await setConfig("home_store_id", "116");
    expect(await getConfigValue("home_store_id")).toBe("116");

    expect(await getConfigValue("never_set")).toBeNull();
  });
});

describe("beer cache", () => {
  it("round-trips cached payloads", async () => {
    await setCachedBeer(
      "20162402",
      JSON.stringify({ basic: { productId: "20162402" } }),
      "vinmonopolet",
    );
    const cached = await getCachedBeer("20162402");
    expect(cached).not.toBeNull();
    const parsed = JSON.parse(cached ?? "{}") as { basic: { productId: string } };
    expect(parsed.basic.productId).toBe("20162402");

    expect(await getCachedBeer("unknown")).toBeNull();
  });
});

describe("release checkpoints", () => {
  it("stores and reads seen match keys", async () => {
    expect(await getSeenWatchlistMatchKeys("release-x")).toEqual([]);

    await setSeenWatchlistMatchKeys("release-x", ["a|b", "a|c", "a|b"]);
    expect(await getSeenWatchlistMatchKeys("release-x")).toEqual(["a|b", "a|c"]);
  });
});

describe("schema migrations", () => {
  it("stamps a fresh database at the latest version", async () => {
    const db = await getDb();
    const version = db.exec("PRAGMA user_version")[0].values[0][0];
    expect(Number(version)).toBe(2);
  });
});
