import test from "node:test";
import assert from "node:assert/strict";
import type { BeerSearchResult } from "./index.js";
import {
  filterBeerSearchResultsByReleaseDate,
  filterBeerSearchResultsSince,
  mergeBeerSearchResults,
} from "./index.js";

test("mergeBeerSearchResults preserves both external release dates and Vinmonopolet lastChanged timestamps", () => {
  const vinmonopoletOnly: BeerSearchResult = {
    name: "Elmeleven Atlantis Black Berries Orange and Ginger Pulp Sour",
    producer: "Elmeleven",
    style: "Surøl",
    abv: 5,
    articleNumber: "20401702",
    country: "Sverige",
    sources: ["vinmonopolet"],
    releaseDate: null,
    vinmonopoletLastChangedAt: "2026-03-31T07:57:54",
    vinmonopoletStatus: "aktiv",
  };

  const externalOnly: BeerSearchResult = {
    name: "Elmeleven Atlantis Black Berries Orange and Ginger Pulp Sour",
    producer: "Elmeleven",
    style: "Surøl",
    abv: 5,
    articleNumber: "20401702",
    country: "Sverige",
    sources: ["external"],
    releaseDate: "1. april 2026",
    vinmonopoletLastChangedAt: null,
    vinmonopoletStatus: null,
  };

  const merged = mergeBeerSearchResults(vinmonopoletOnly, externalOnly);

  assert.deepEqual(merged.sources, ["vinmonopolet", "external"]);
  assert.equal(merged.releaseDate, "1. april 2026");
  assert.equal(merged.vinmonopoletLastChangedAt, "2026-03-31T07:57:54");
  assert.equal(merged.vinmonopoletStatus, "aktiv");
});

test("filterBeerSearchResultsSince prefers external release dates, falls back to lastChanged, and keeps upcoming results", () => {
  const beers: BeerSearchResult[] = [
    {
      name: "Beer A",
      producer: "Producer A",
      style: "Surøl",
      abv: 6,
      articleNumber: "1",
      sources: ["external"],
      releaseDate: "1. april 2026",
      vinmonopoletLastChangedAt: null,
      vinmonopoletStatus: null,
    },
    {
      name: "Beer B",
      producer: "Producer B",
      style: "IPA",
      abv: 7,
      articleNumber: "2",
      sources: ["vinmonopolet"],
      releaseDate: null,
      vinmonopoletLastChangedAt: "2026-03-31T07:57:54",
      vinmonopoletStatus: "aktiv",
    },
    {
      name: "Beer C",
      producer: "Producer C",
      style: "Stout",
      abv: 10,
      articleNumber: "3",
      sources: ["vinmonopolet_upcoming"],
      releaseDate: null,
      vinmonopoletLastChangedAt: null,
      vinmonopoletStatus: "kommende",
    },
    {
      name: "Beer D",
      producer: "Producer D",
      style: "Pils",
      abv: 4.7,
      articleNumber: "4",
      sources: ["vinmonopolet"],
      releaseDate: null,
      vinmonopoletLastChangedAt: "2026-02-01T07:57:54",
      vinmonopoletStatus: "aktiv",
    },
  ];

  const filtered = filterBeerSearchResultsSince(beers, "2026-03-01");

  assert.deepEqual(filtered.map((beer) => beer.articleNumber), ["1", "2", "3"]);
});

test("filterBeerSearchResultsByReleaseDate matches both external release dates and Vinmonopolet ISO timestamps", () => {
  const beers: BeerSearchResult[] = [
    {
      name: "Beer A",
      producer: "Producer A",
      style: "Surøl",
      abv: 6,
      articleNumber: "1",
      sources: ["external"],
      releaseDate: "1. april 2026",
      vinmonopoletLastChangedAt: null,
      vinmonopoletStatus: null,
    },
    {
      name: "Beer B",
      producer: "Producer B",
      style: "IPA",
      abv: 7,
      articleNumber: "2",
      sources: ["vinmonopolet"],
      releaseDate: null,
      vinmonopoletLastChangedAt: "2026-04-01T07:57:54",
      vinmonopoletStatus: "aktiv",
    },
    {
      name: "Beer C",
      producer: "Producer C",
      style: "Stout",
      abv: 10,
      articleNumber: "3",
      sources: ["vinmonopolet_upcoming"],
      releaseDate: null,
      vinmonopoletLastChangedAt: null,
      vinmonopoletStatus: "kommende",
    },
  ];

  const filtered = filterBeerSearchResultsByReleaseDate(beers, "2026-04-01");

  assert.deepEqual(filtered.map((beer) => beer.articleNumber), ["1", "2"]);
});
