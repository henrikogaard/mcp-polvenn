import test from "node:test";
import assert from "node:assert/strict";
import { haversineDistanceKm } from "./geo.js";

test("haversineDistanceKm returns zero for identical coordinates", () => {
  assert.equal(haversineDistanceKm(58.97, 5.73, 58.97, 5.73), 0);
});

test("haversineDistanceKm returns a realistic distance", () => {
  const distance = haversineDistanceKm(59.91, 10.75, 60.39, 5.32);
  assert.ok(distance > 290 && distance < 320);
});
