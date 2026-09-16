import { describe, expect, it } from "vitest";
import { haversineDistanceKm } from "./geo.js";

describe("haversineDistanceKm", () => {
  it("returns zero for identical coordinates", () => {
    expect(haversineDistanceKm(58.97, 5.73, 58.97, 5.73)).toBe(0);
  });

  it("returns a realistic distance", () => {
    const distance = haversineDistanceKm(59.91, 10.75, 60.39, 5.32);
    expect(distance).toBeGreaterThan(290);
    expect(distance).toBeLessThan(320);
  });
});
