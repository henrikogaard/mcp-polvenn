import { afterEach, describe, expect, it, vi } from "vitest";
import { setConfig } from "../db/database.js";
import { getLatestReleases } from "./release-feed.js";

const validPayload = {
  releases: [
    {
      id: "release-1",
      title: "Week 42 releases",
      source: "vinmonopolet-news",
      publishedAt: "2026-09-10T08:00:00Z",
      items: [
        {
          country: "Norge",
          articleNumber: "20162402",
          producer: "Amundsen Bryggeri",
          name: "Amundsen The Darkening Imp",
          style: "Porter & stout",
          abv: 12,
          releaseDate: "14. januar 2026",
        },
      ],
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getLatestReleases", () => {
  it("parses a valid release feed payload", async () => {
    await setConfig("release_feed_url", "https://releases.example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(validPayload), { status: 200 })),
    );

    const releases = await getLatestReleases(3);

    expect(releases).toHaveLength(1);
    expect(releases[0].id).toBe("release-1");
    expect(releases[0].items[0]).toMatchObject({
      articleNumber: "20162402",
      producer: "Amundsen Bryggeri",
      abv: 12,
    });
  });

  it("applies defaults for optional item fields", async () => {
    await setConfig("release_feed_url", "https://releases.example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            releases: [
              {
                id: "release-2",
                title: "Sparse",
                source: "test",
                publishedAt: "2026-09-10T08:00:00Z",
                items: [{ articleNumber: "1", producer: "P", name: "N" }],
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const [release] = await getLatestReleases(1);

    expect(release.items[0].style).toBe("");
    expect(release.items[0].abv).toBe(0);
    expect(release.items[0].releaseDate).toBe("");
    expect(release.items[0].country).toBeNull();
  });

  it("throws on malformed payloads", async () => {
    await setConfig("release_feed_url", "https://releases.example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ nope: true }), { status: 200 })),
    );

    await expect(getLatestReleases(1)).rejects.toThrow();
  });

  it("throws with status details on non-ok responses", async () => {
    await setConfig("release_feed_url", "https://releases.example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("gateway exploded", { status: 502 })),
    );

    await expect(getLatestReleases(1)).rejects.toThrow(/502/);
  });

  it("throws when the feed URL is not configured", async () => {
    // Earlier tests in this file configured a URL; clear it for this case.
    await setConfig("release_feed_url", "");
    await expect(getLatestReleases(1)).rejects.toThrow(/not configured/i);
  });
});
