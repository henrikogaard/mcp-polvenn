import test from "node:test";
import assert from "node:assert/strict";
import {
  getWatchlistMatchKey,
  matchWatchlistEntries,
  splitWatchlistMatches,
} from "./watchlist.js";
import type { ExternalReleaseItem, WatchlistEntry } from "../types.js";

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

test("matchWatchlistEntries matches brewery, series, and keyword rules", () => {
  const rules: WatchlistEntry[] = [
    { id: 1, type: "brewery", value: "amundsen", createdAt: "2026-04-07T10:00:00.000Z" },
    { id: 2, type: "series", value: "darkening", createdAt: "2026-04-07T10:00:00.000Z" },
    { id: 3, type: "keyword", value: "pastry", createdAt: "2026-04-07T10:00:00.000Z" },
  ];

  const matches = matchWatchlistEntries(beers, rules);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].beer.articleNumber, "20162402");
  assert.deepEqual(
    matches[0].matchedRules.map((rule) => rule.id),
    [1, 2, 3],
  );
});

test("matchWatchlistEntries matches styles independently", () => {
  const rules: WatchlistEntry[] = [
    { id: 4, type: "style", value: "india pale ale", createdAt: "2026-04-07T10:00:00.000Z" },
  ];

  const matches = matchWatchlistEntries(beers, rules);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].beer.articleNumber, "17436502");
});

test("splitWatchlistMatches separates new and repeated matches", () => {
  const rules: WatchlistEntry[] = [
    { id: 1, type: "brewery", value: "amundsen", createdAt: "2026-04-07T10:00:00.000Z" },
  ];

  const matches = matchWatchlistEntries(beers, rules);
  const seenKeys = [getWatchlistMatchKey(matches[0])];
  const split = splitWatchlistMatches(matches, seenKeys);

  assert.equal(split.newMatches.length, 0);
  assert.equal(split.repeatedMatches.length, 1);
  assert.equal(split.repeatedMatches[0].beer.articleNumber, "20162402");
});
