import { describe, expect, it } from "vitest";
import type { ExternalReleaseItem, WatchlistEntry } from "../types.js";
import {
  formatNumericRuleValue,
  getWatchlistMatchKey,
  matchWatchlistEntries,
  splitWatchlistMatches,
} from "./watchlist.js";

const beers: ExternalReleaseItem[] = [
  {
    country: "Norge",
    articleNumber: "20162402",
    producer: "Amundsen Bryggeri",
    name: "Amundsen The Darkening Imp Pastry Stout",
    style: "Porter & stout",
    abv: 12,
    releaseDate: "14. januar 2026",
  },
  {
    country: "Latvia",
    articleNumber: "17436502",
    producer: "Arpus Brewing Co.",
    name: "Arpus TDH Mosaic x Citra x Galaxy DIPA",
    style: "India pale ale",
    abv: 8,
    releaseDate: "14. januar 2026",
  },
];

function rule(entry: Omit<WatchlistEntry, "createdAt">): WatchlistEntry {
  return { ...entry, createdAt: "2026-04-07T10:00:00.000Z" };
}

describe("matchWatchlistEntries", () => {
  it("matches brewery, series, and keyword rules", async () => {
    const rules: WatchlistEntry[] = [
      rule({ id: 1, type: "brewery", value: "amundsen" }),
      rule({ id: 2, type: "series", value: "darkening" }),
      rule({ id: 3, type: "keyword", value: "pastry" }),
    ];

    const matches = await matchWatchlistEntries(beers, rules);

    expect(matches).toHaveLength(1);
    expect(matches[0].beer.articleNumber).toBe("20162402");
    expect(matches[0].matchedRules.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("matches styles independently", async () => {
    const rules: WatchlistEntry[] = [rule({ id: 4, type: "style", value: "india pale ale" })];

    const matches = await matchWatchlistEntries(beers, rules);

    expect(matches).toHaveLength(1);
    expect(matches[0].beer.articleNumber).toBe("17436502");
  });

  it("matches country rules against the beer's country", async () => {
    const rules: WatchlistEntry[] = [rule({ id: 5, type: "country", value: "norge" })];

    const matches = await matchWatchlistEntries(beers, rules);

    expect(matches).toHaveLength(1);
    expect(matches[0].beer.articleNumber).toBe("20162402");
  });

  it("matches abv rules within numeric bounds and ignores unknown ABV", async () => {
    const rules: WatchlistEntry[] = [
      rule({ id: 6, type: "abv", value: "abv >= 10", minValue: 10, maxValue: null }),
    ];

    const matches = await matchWatchlistEntries(beers, rules);
    expect(matches.map((m) => m.beer.articleNumber)).toEqual(["20162402"]);

    const unknownAbv: ExternalReleaseItem[] = [
      { ...beers[0], abv: 0 }, // feed default means unknown
    ];
    const unknownMatches = await matchWatchlistEntries(unknownAbv, rules);
    expect(unknownMatches).toHaveLength(0);
  });

  it("matches price rules via the resolver and skips unknown prices", async () => {
    const rules: WatchlistEntry[] = [
      rule({ id: 7, type: "price", value: "price 100–150", minValue: 100, maxValue: 150 }),
    ];
    const prices: Record<string, number | null> = {
      "20162402": 129.9,
      "17436502": null, // price unknown — must not match
    };

    const matches = await matchWatchlistEntries(beers, rules, {
      resolvePrice: (articleNumber) => Promise.resolve(prices[articleNumber] ?? null),
    });

    expect(matches).toHaveLength(1);
    expect(matches[0].beer.articleNumber).toBe("20162402");
  });

  it("never matches price rules when no price can be resolved at all", async () => {
    const rules: WatchlistEntry[] = [
      rule({ id: 8, type: "price", value: "price <= 200", minValue: null, maxValue: 200 }),
    ];

    const matches = await matchWatchlistEntries(beers, rules, {
      resolvePrice: () => Promise.resolve(null),
    });

    expect(matches).toHaveLength(0);
  });
});

describe("formatNumericRuleValue", () => {
  it("derives readable values for bound combinations", () => {
    expect(formatNumericRuleValue("abv", 8, 12)).toBe("abv 8–12");
    expect(formatNumericRuleValue("abv", 8)).toBe("abv >= 8");
    expect(formatNumericRuleValue("price", undefined, 200)).toBe("price <= 200");
  });
});

describe("splitWatchlistMatches", () => {
  it("separates new and repeated matches", async () => {
    const rules: WatchlistEntry[] = [rule({ id: 1, type: "brewery", value: "amundsen" })];

    const matches = await matchWatchlistEntries(beers, rules);
    const seenKeys = [getWatchlistMatchKey(matches[0])];
    const split = splitWatchlistMatches(matches, seenKeys);

    expect(split.newMatches).toHaveLength(0);
    expect(split.repeatedMatches).toHaveLength(1);
    expect(split.repeatedMatches[0].beer.articleNumber).toBe("20162402");
  });
});
