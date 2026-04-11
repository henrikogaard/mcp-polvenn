import type { ExternalReleaseItem, WatchlistEntry, WatchlistMatch } from "../types.js";

function normalise(value: string): string {
  return value.toLowerCase().trim();
}

function getMatchedRules(beer: ExternalReleaseItem, entries: WatchlistEntry[]): WatchlistEntry[] {
  return entries.filter((entry) => {
    const rule = normalise(entry.value);

    switch (entry.type) {
      case "brewery":
        return normalise(beer.producer).includes(rule);
      case "style":
        return normalise(beer.style).includes(rule);
      case "series":
        return normalise(beer.name).includes(rule);
      case "keyword":
        return (
          normalise(beer.name).includes(rule)
          || normalise(beer.producer).includes(rule)
        );
    }
  });
}

export function matchWatchlistEntries(
  beers: ExternalReleaseItem[],
  entries: WatchlistEntry[],
): WatchlistMatch[] {
  return beers.flatMap((beer) => {
    const matchedRules = getMatchedRules(beer, entries);
    return matchedRules.length > 0 ? [{ beer, matchedRules }] : [];
  });
}

export function getWatchlistMatchKey(match: WatchlistMatch): string {
  const ruleKey = match.matchedRules
    .map((rule) => `${rule.type}:${rule.value}`)
    .sort()
    .join("|");

  return `${match.beer.articleNumber}|${ruleKey}`;
}

export function splitWatchlistMatches(
  matches: WatchlistMatch[],
  seenMatchKeys: string[],
): {
  newMatches: WatchlistMatch[];
  repeatedMatches: WatchlistMatch[];
} {
  const seen = new Set(seenMatchKeys);

  return matches.reduce<{
    newMatches: WatchlistMatch[];
    repeatedMatches: WatchlistMatch[];
  }>(
    (acc, match) => {
      const key = getWatchlistMatchKey(match);
      if (seen.has(key)) {
        acc.repeatedMatches.push(match);
      } else {
        acc.newMatches.push(match);
      }
      return acc;
    },
    { newMatches: [], repeatedMatches: [] },
  );
}
