import { describe, expect, it } from "vitest";
import { buildProductImageUrl } from "./images.js";

describe("buildProductImageUrl", () => {
  it("builds a 300x300 CDN URL for an article number", () => {
    expect(buildProductImageUrl("20162402")).toBe(
      "https://bilder.vinmonopolet.no/cache/300x300-0/20162402-1.jpg",
    );
  });

  it("strips leading zeros from article numbers", () => {
    expect(buildProductImageUrl("007123")).toBe(
      "https://bilder.vinmonopolet.no/cache/300x300-0/7123-1.jpg",
    );
  });

  it("supports standard sizes and falls back to 300 for others", () => {
    expect(buildProductImageUrl("20162402", 515)).toContain("515x515-0");
    expect(buildProductImageUrl("20162402", 1200)).toContain("1200x1200-0");
    expect(buildProductImageUrl("20162402", 999)).toContain("300x300-0");
  });

  it("keeps the article number when it is all zeros", () => {
    expect(buildProductImageUrl("000")).toContain("/000-1.jpg");
  });
});
