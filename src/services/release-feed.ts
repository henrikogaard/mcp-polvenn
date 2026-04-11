import { z } from "zod";
import { RELEASE_FEED_LATEST_PATH, USER_AGENT } from "../constants.js";
import { getConfigValue } from "../db/database.js";
import type { ExternalRelease, ExternalReleaseItem } from "../types.js";
import { fetchWithRetry } from "../utils/http.js";

const ReleaseItemSchema = z.object({
  country: z.string().nullable().optional(),
  articleNumber: z.string().min(1),
  producer: z.string().min(1),
  name: z.string().min(1),
  style: z.string().optional().default(""),
  abv: z.number().optional().default(0),
  releaseDate: z.string().optional().default(""),
}).transform((item): ExternalReleaseItem => ({
  country: item.country ?? null,
  articleNumber: item.articleNumber,
  producer: item.producer,
  name: item.name,
  style: item.style,
  abv: item.abv,
  releaseDate: item.releaseDate,
}));

const ReleaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  source: z.string().min(1),
  publishedAt: z.string().min(1),
  url: z.string().url().nullable().optional(),
  items: z.array(ReleaseItemSchema),
}).transform((release): ExternalRelease => ({
  id: release.id,
  title: release.title,
  source: release.source,
  publishedAt: release.publishedAt,
  url: release.url ?? null,
  items: release.items,
}));

const LatestReleasesResponseSchema = z.object({
  releases: z.array(ReleaseSchema),
});

function buildReleaseFeedUrl(baseUrl: string, limit: number): string {
  const url = new URL(RELEASE_FEED_LATEST_PATH, baseUrl);
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

async function getReleaseFeedBaseUrl(): Promise<string> {
  const configuredUrl = await getConfigValue("release_feed_url");
  if (!configuredUrl) {
    throw new Error("Release feed URL not configured. Use polvenn_configure to set releaseFeedUrl.");
  }

  try {
    return new URL(configuredUrl).toString();
  } catch {
    throw new Error("Configured release feed URL is invalid. Use polvenn_configure to set a valid absolute URL.");
  }
}

export async function getLatestReleases(limit = 3): Promise<ExternalRelease[]> {
  const baseUrl = await getReleaseFeedBaseUrl();
  const response = await fetchWithRetry(buildReleaseFeedUrl(baseUrl, limit), {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Release feed error ${response.status}: ${response.statusText}. ${body}`);
  }

  const payload = LatestReleasesResponseSchema.parse(await response.json());
  return payload.releases;
}

export async function getLatestRelease(): Promise<ExternalRelease | null> {
  const [latestRelease] = await getLatestReleases(1);
  return latestRelease ?? null;
}
