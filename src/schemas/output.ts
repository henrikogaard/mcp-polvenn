import { z } from "zod";

// Output schemas for every tool's structured payload. Declaring these as the
// tool's outputSchema makes structuredContent contractual: strict MCP clients
// can rely on the shape, and the SDK validates outgoing payloads against it.

const BeerSearchResultSchema = z.object({
  name: z.string(),
  producer: z.string(),
  style: z.string(),
  abv: z.number(),
  articleNumber: z.string(),
  country: z.string().optional(),
  sources: z.array(z.string()),
  releaseDate: z.string().nullable(),
  vinmonopoletLastChangedAt: z.string().nullable(),
  vinmonopoletStatus: z.string().nullable(),
});

export const ResolvedStoreContextSchema = z.object({
  storeId: z.string(),
  storeName: z.string(),
  resolution: z.enum(["explicit", "home_store", "nearest_home_location"]),
  distanceKm: z.number().optional(),
});

const SearchMetaSchema = z.object({
  style: z.string().nullable(),
  releaseDate: z.string().nullable(),
  totalResults: z.number().int(),
  results: z.array(BeerSearchResultSchema),
});

export const SearchNewBeersOutputSchema = z.object({
  source: z.enum(["vinmonopolet", "external", "both"]),
  since: z.string(),
  sinceFilterMode: z.string(),
  includeUpcoming: z.boolean(),
  requestedUpcoming: z.boolean(),
  store: ResolvedStoreContextSchema.nullable(),
  ...SearchMetaSchema.shape,
});

export const SearchUpcomingBeersOutputSchema = SearchMetaSchema;

export const SearchNewBeersNearStoreOutputSchema = z.object({
  store: ResolvedStoreContextSchema,
  ...SearchMetaSchema.shape,
});

const ProductAvailabilitySchema = z.object({
  buyable: z.boolean().nullable().optional(),
  productSelection: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  productPageUrl: z.string().nullable().optional(),
});

export const CheckStoreStockOutputSchema = z.object({
  articleNumber: z.string(),
  storeId: z.string(),
  productName: z.string(),
  producer: z.string().nullable(),
  style: z.string().nullable(),
  stockStatus: z.enum(["verified", "unverified"]),
  stockLevel: z.number().nullable(),
  storeStockConclusion: z.enum(["in_stock", "out_of_stock", "unknown"]),
  stockSource: z.enum(["official_api", "website_stock_locator", "unverified"]),
  inStock: z.boolean().nullable(),
  websiteAvailabilityIsStoreStock: z.boolean(),
  assistantGuidance: z.string(),
  availability: ProductAvailabilitySchema.nullable(),
});

const OpeningHoursEntrySchema = z.object({
  dayOfTheWeek: z.string(),
  openingTime: z.string(),
  closingTime: z.string(),
  closed: z.boolean(),
});

const NearbyStoreSchema = z.object({
  storeId: z.string(),
  storeName: z.string(),
  status: z.string().optional(),
  address: z
    .object({
      street: z.string().optional(),
      postalCode: z.string().optional(),
      city: z.string().optional(),
      gpsCoord: z.string().optional(),
      globalLocationNumber: z.string().optional(),
      organisationNumber: z.string().optional(),
    })
    .optional(),
  telephone: z.string().optional(),
  email: z.string().optional(),
  category: z.string().optional(),
  openingHours: z
    .object({
      regularHours: z.array(OpeningHoursEntrySchema).optional(),
    })
    .optional(),
  todayOpeningHours: OpeningHoursEntrySchema.nullable().optional(),
  distanceKm: z.number(),
});

export const FindNearbyStoresOutputSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  maxResults: z.number().int(),
  stores: z.array(NearbyStoreSchema),
});

const WatchlistRuleTypeSchema = z.enum([
  "brewery",
  "style",
  "series",
  "keyword",
  "country",
  "abv",
  "price",
  "stock",
]);

const WatchlistEntrySchema = z.object({
  id: z.number().int(),
  type: WatchlistRuleTypeSchema,
  value: z.string(),
  minValue: z.number().nullable().optional(),
  maxValue: z.number().nullable().optional(),
  createdAt: z.string(),
});

const ExternalReleaseItemSchema = z.object({
  country: z.string().nullable(),
  articleNumber: z.string(),
  producer: z.string(),
  name: z.string(),
  style: z.string(),
  abv: z.number(),
  releaseDate: z.string(),
});

const ExternalReleaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: z.string(),
  publishedAt: z.string(),
  url: z.string().nullable(),
  items: z.array(ExternalReleaseItemSchema),
});

const WatchlistMatchSchema = z.object({
  beer: ExternalReleaseItemSchema,
  matchedRules: z.array(WatchlistEntrySchema),
});

// The MCP SDK requires outputSchema to be an object schema (top-level
// structured content is always an object), so the per-action variants are
// expressed as optional fields rather than a discriminated union.
export const WatchlistOutputSchema = z.object({
  action: z.enum(["add", "remove", "list", "check"]),
  entry: WatchlistEntrySchema.optional(),
  id: z.number().int().optional(),
  removed: z.boolean().optional(),
  entries: z.array(WatchlistEntrySchema).optional(),
  release: ExternalReleaseSchema.nullable().optional(),
  totalRules: z.number().int().optional(),
  totalBeers: z.number().int().optional(),
  totalMatches: z.number().int().optional(),
  // Beers that had price rules but no resolvable price — reported instead of guessed.
  unevaluatedPriceBeers: z.number().int().optional(),
  newMatches: z.array(WatchlistMatchSchema).optional(),
  repeatedMatches: z.array(WatchlistMatchSchema).optional(),
  // Live results for 'stock' rules (one article watched at the home store).
  stockResults: z
    .array(
      z.object({
        articleNumber: z.string(),
        productName: z.string().nullable(),
        storeId: z.string().nullable(),
        storeName: z.string().nullable(),
        inStock: z.boolean().nullable(),
        stockLevel: z.number().nullable(),
        newInStock: z.boolean(),
        stockSource: z.string().nullable(),
        message: z.string().nullable(),
      }),
    )
    .optional(),
});

const ProductSummarySchema = z.object({
  articleNumber: z.string(),
  name: z.string(),
  producer: z.string().nullable(),
  style: z.string().nullable(),
  category: z.string().nullable(),
  abv: z.number().nullable(),
  volume: z.number().nullable(),
  price: z.number().nullable(),
  country: z.string().nullable(),
  status: z.string().nullable(),
  productPageUrl: z.string().nullable(),
  imageUrl: z.string().nullable(),
});

export const SearchProductsOutputSchema = z.object({
  query: z.string(),
  beerOnly: z.boolean(),
  source: z.enum(["official_api", "website", "product_lookup"]),
  totalResults: z.number().int(),
  results: z.array(ProductSummarySchema),
});

export const GetProductOutputSchema = z.object({
  articleNumber: z.string(),
  found: z.boolean(),
  product: z
    .object({
      name: z.string(),
      longName: z.string().nullable().optional(),
      producer: z.string().nullable(),
      style: z.string().nullable(),
      category: z.string().nullable(),
      country: z.string().nullable(),
      abv: z.number().nullable(),
      volume: z.number().nullable(),
      vintage: z.number().nullable().optional(),
      ageLimit: z.string().nullable().optional(),
      price: z.number().nullable(),
      pricePerLiter: z.number().nullable().optional(),
      status: z.string().nullable(),
      productSelection: z.string().nullable().optional(),
      buyable: z.boolean().nullable().optional(),
      wholesaler: z.string().nullable().optional(),
      colour: z.string().nullable().optional(),
      odour: z.string().nullable().optional(),
      taste: z.string().nullable().optional(),
      productPageUrl: z.string().nullable().optional(),
      imageUrl: z.string().nullable().optional(),
      imageUrlLarge: z.string().nullable().optional(),
      lastChangedAt: z.string().nullable().optional(),
    })
    .nullable(),
});

export const FindStoresWithStockOutputSchema = z.object({
  articleNumber: z.string(),
  productName: z.string().nullable(),
  latitude: z.number(),
  longitude: z.number(),
  maxResults: z.number().int(),
  stores: z.array(
    z.object({
      storeId: z.string(),
      storeName: z.string(),
      stockLevel: z.number(),
    }),
  ),
});

export const GetChangedProductsOutputSchema = z.object({
  since: z.string(),
  beerOnly: z.boolean(),
  totalResults: z.number().int(),
  results: z.array(
    z.object({
      articleNumber: z.string(),
      name: z.string(),
      producer: z.string().nullable(),
      style: z.string().nullable(),
      category: z.string().nullable(),
      lastChangedAt: z.string().nullable(),
    }),
  ),
});

export const GetFacetsOutputSchema = z.object({
  facets: z.array(
    z.object({
      name: z.string(),
      displayName: z.string().nullable(),
      values: z.array(
        z.object({
          name: z.string(),
          count: z.number().nullable(),
        }),
      ),
    }),
  ),
});

const ConfigSummarySchema = z.object({
  releaseFeedUrl: z.string().nullable(),
  vinmonopoletApiKeyConfigured: z.boolean(),
  homeStoreId: z.string().nullable(),
  homeLatitude: z.number().nullable(),
  homeLongitude: z.number().nullable(),
});

export const ConfigureOutputSchema = ConfigSummarySchema;

export const ValidateConfigOutputSchema = z.object({
  summary: z.object({
    ok: z.number().int(),
    warning: z.number().int(),
    error: z.number().int(),
    skipped: z.number().int(),
  }),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["ok", "warning", "error", "skipped"]),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  config: ConfigSummarySchema,
});
