/** Product from Vinmonopolet API */
export interface VinmonopoletProduct {
  basic: {
    productId: string;
    productShortName: string;
    productLongName?: string | null;
    volume?: number | null;
    alcoholContent?: number | null;
    vintage?: number | null;
    ageLimit?: string | null;
    packagingMaterialId?: string | null;
    packagingMaterial?: string | null;
    volumeType?: string | null;
    corkType?: string | null;
    bottlePerSalesUnit?: number | null;
    introductionDate?: string | null;
    productStatusSaleName?: string | null;
    productStatusSaleCode?: string | null;
    isNewProduct?: boolean;
  };
  lastChanged?: {
    date: string;
    time: string;
  };
  classification?: {
    mainProductTypeId: string;
    mainProductTypeName: string;
    subProductTypeId?: string | null;
    subProductTypeName?: string | null;
    productGroupId?: string | null;
    productGroupName?: string | null;
  };
  origins?: {
    origin: {
      country?: string | null;
      countryId?: string | null;
      regionId: string | null;
      region: string | null;
      subRegionId: string | null;
      subRegion: string | null;
    };
    productionOrigin: {
      producerId?: string | null;
      producerName?: string | null;
    };
  };
  logistics?: {
    wholesalerId?: string | null;
    wholesalerName?: string | null;
    vendorId?: string | null;
    vendorName?: string | null;
  };
  prices?: {
    salesPrice?: number | null;
    salesPricePrLiter?: number | null;
    bottleReturnValue?: number | null;
  };
  availability?: {
    buyable?: boolean;
    productSelection?: string | null;
    status?: string | null;
    productPageUrl?: string | null;
  };
  description?: {
    characteristics?: {
      colour: string | null;
      odour: string | null;
      taste: string | null;
    };
    freshness?: number | null;
    fullness?: number | null;
    bitterness?: number | null;
    sweetness?: number | null;
    tannins?: number | null;
    recommendedFood?: string[];
  };
}

export interface VinmonopoletStockRow {
  productId: string;
  storeId: string;
  stock: number;
}

export interface VinmonopoletStockCheck {
  status: "verified" | "unverified";
  stockLevel: number | null;
  rows: VinmonopoletStockRow[];
  storeStockConclusion: "in_stock" | "out_of_stock" | "unknown";
  stockSource: "official_api" | "website_stock_locator" | "unverified";
  websiteAvailabilityIsStoreStock: false;
  message?: string;
}

/** Store from Vinmonopolet API */
export interface VinmonopoletStore {
  storeId: string;
  storeName: string;
  status: string;
  address: {
    street: string;
    postalCode: string;
    city: string;
    gpsCoord: string;
    globalLocationNumber: string;
    organisationNumber: string;
  };
  telephone: string;
  email: string;
  category: string;
  openingHours: {
    regularHours: Array<{
      dayOfTheWeek: string;
      openingTime: string;
      closingTime: string;
      closed: boolean;
    }>;
  };
}

/** Release item from an external release feed */
export interface ExternalReleaseItem {
  country: string | null;
  articleNumber: string;
  producer: string;
  name: string;
  style: string;
  abv: number;
  releaseDate: string;
}

export interface ExternalRelease {
  id: string;
  title: string;
  source: string;
  publishedAt: string;
  url: string | null;
  items: ExternalReleaseItem[];
}

/**
 * Watchlist rule types. String rules match by substring; abv/price rules match
 * numeric bounds; stock rules watch a single article's stock at the home store.
 */
export type WatchlistRuleType =
  | "brewery"
  | "style"
  | "series"
  | "keyword"
  | "country"
  | "abv"
  | "price"
  | "stock";

/** Watchlist entry stored in local DB */
export interface WatchlistEntry {
  id: number;
  type: WatchlistRuleType;
  value: string;
  minValue?: number | null;
  maxValue?: number | null;
  createdAt: string;
}

/** A matched new release from watchlist check */
export interface WatchlistMatch {
  beer: ExternalReleaseItem;
  matchedRules: WatchlistEntry[];
}

/** Config stored per-user */
export interface PolvennConfig {
  releaseFeedUrl: string | null;
  vinmonopoletApiKey: string | null;
  homeStoreId: string | null;
  homeLatitude: number | null;
  homeLongitude: number | null;
}
