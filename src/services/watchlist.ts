import type { ExternalReleaseItem, WatchlistEntry, WatchlistMatch } from "../types.js";

function normalise(value: string): string {
  return value.toLowerCase().trim();
}

function matchesNumericBounds(value: number | null, entry: WatchlistEntry): boolean {
  if (value == null) {
    return false;
  }

  if (entry.minValue != null && value < entry.minValue) {
    return false;
  }
  if (entry.maxValue != null && value > entry.maxValue) {
    return false;
  }
  return true;
}

function getMatchedRules(
  beer: ExternalReleaseItem,
  entries: WatchlistEntry[],
  beerPrice: number | null,
): WatchlistEntry[] {
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
        return normalise(beer.name).includes(rule) || normalise(beer.producer).includes(rule);
      case "country":
        return beer.country != null && normalise(beer.country).includes(rule);
      case "abv":
        // A zero ABV from the feed means "unknown", never a match.
        return beer.abv > 0 && matchesNumericBounds(beer.abv, entry);
      case "price":
        return matchesNumericBounds(beerPrice, entry);
      case "stock":
        // Stock rules watch a single article at the home store; they are
        // evaluated against live stock in the watchlist check, never against
        // release feed items.
        return false;
      default:
        return false;
    }
  });
}

export interface MatchWatchlistOptions {
  /**
   * Resolves a best-effort sales price (NOK) for an article number, e.g. from
   * Vinmonopolet product data. Only called when price rules exist; a null
   * return means the price could not be evaluated for that beer.
   */
  resolvePrice?: (articleNumber: string) => Promise<number | null>;
}

export async function matchWatchlistEntries(
  beers: ExternalReleaseItem[],
  entries: WatchlistEntry[],
  options: MatchWatchlistOptions = {},
): Promise<WatchlistMatch[]> {
  const hasPriceRules = entries.some((entry) => entry.type === "price");

  const prices = new Map<string, number | null>();
  if (hasPriceRules && options.resolvePrice) {
    for (const beer of beers) {
      prices.set(beer.articleNumber, await options.resolvePrice(beer.articleNumber));
    }
  }

  return beers.flatMap((beer) => {
    const beerPrice = prices.has(beer.articleNumber)
      ? (prices.get(beer.articleNumber) ?? null)
      : null;
    const matchedRules = getMatchedRules(beer, entries, beerPrice);
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

/** Derives the display value for numeric rules, e.g. "abv 8–12" or "price <= 200". */
export function formatNumericRuleValue(
  type: "abv" | "price",
  minValue?: number,
  maxValue?: number,
): string {
  if (minValue != null && maxValue != null) {
    return `${type} ${minValue}–${maxValue}`;
  }
  if (minValue != null) {
    return `${type} >= ${minValue}`;
  }
  return `${type} <= ${maxValue ?? "?"}`;
}
