import { z } from "zod";

export const SearchNewBeersSchema = z.object({
  source: z.enum(["vinmonopolet", "external", "both"])
    .default("both")
    .describe("Where to look for new beers: Vinmonopolet API, your external release feed, or both"),
  since: z.string()
    .optional()
    .describe("Best-effort date filter (yyyy-MM-dd). Uses external release dates when available, otherwise Vinmonopolet lastChanged. Defaults to 30 days ago."),
  includeUpcoming: z.boolean()
    .default(false)
    .describe("Also include upcoming Vinmonopolet web releases from the 'Kommende nyheter' filter when available."),
  style: z.string()
    .optional()
    .describe("Filter by beer style, e.g. 'IPA', 'Stout', 'Sour'"),
  releaseDate: z.string()
    .optional()
    .describe("Exact release date filter. Accepts yyyy-MM-dd or a Norwegian date like '1. april 2026'."),
  storeId: z.string()
    .optional()
    .describe("Filter Vinmonopolet-backed results to beers available in a specific store. Defaults to your configured home store when omitted in store-aware flows."),
  limit: z.number()
    .int().min(1).max(100)
    .default(25)
    .describe("Maximum results to return"),
}).strict();

export const UpcomingBeersSchema = z.object({
  style: z.string()
    .optional()
    .describe("Filter by beer style, e.g. 'IPA', 'Stout', 'Sour'"),
  limit: z.number()
    .int().min(1).max(100)
    .default(25)
    .describe("Maximum results to return"),
}).strict();

export const NewBeersNearStoreSchema = z.object({
  storeId: z.string()
    .optional()
    .describe("Store ID to search. Falls back to your configured home store, then your nearest store from your configured home coordinates."),
  style: z.string()
    .optional()
    .describe("Filter by beer style, e.g. 'IPA', 'Stout', 'Sour'"),
  releaseDate: z.string()
    .optional()
    .describe("Exact release date filter. Accepts yyyy-MM-dd or a Norwegian date like '1. april 2026'."),
  limit: z.number()
    .int().min(1).max(100)
    .default(25)
    .describe("Maximum results to return"),
}).strict();

export const CheckStoreStockSchema = z.object({
  articleNumber: z.string()
    .min(1)
    .describe("Vinmonopolet article number (e.g. '20537202')"),
  storeId: z.string()
    .optional()
    .describe("Specific store ID. If omitted, uses your configured home store."),
}).strict();

export const FindNearbyStoresSchema = z.object({
  latitude: z.number()
    .min(-90).max(90)
    .optional()
    .describe("Latitude. Defaults to your configured home location."),
  longitude: z.number()
    .min(-180).max(180)
    .optional()
    .describe("Longitude. Defaults to your configured home location."),
  maxResults: z.number()
    .int().min(1).max(20)
    .default(5)
    .describe("Number of stores to return"),
}).strict();

export const WatchlistSchema = z.object({
  action: z.enum(["add", "remove", "list", "check"])
    .describe("Watchlist action: add a rule, remove by ID, list all rules, or check for matches"),
  type: z.enum(["brewery", "style", "series", "keyword"])
    .optional()
    .describe("Type of watch rule (required for 'add')"),
  value: z.string()
    .optional()
    .describe("Value to watch for (required for 'add')"),
  id: z.number()
    .int()
    .optional()
    .describe("Watchlist entry ID (required for 'remove')"),
}).strict();

export const ConfigureSchema = z.object({
  releaseFeedUrl: z.string()
    .url()
    .optional()
    .describe("Base URL for your external release feed API"),
  vinmonopoletApiKey: z.string()
    .optional()
    .describe("Vinmonopolet API subscription key"),
  homeStoreId: z.string()
    .optional()
    .describe("Your preferred Vinmonopolet store ID"),
  homeLatitude: z.number()
    .optional()
    .describe("Home latitude for nearby store lookups"),
  homeLongitude: z.number()
    .optional()
    .describe("Home longitude for nearby store lookups"),
}).strict();

export const ValidateConfigSchema = z.object({}).strict();
