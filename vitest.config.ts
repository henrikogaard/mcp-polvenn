import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run from src only — compiled copies in dist/ would run as duplicates.
    include: ["src/**/*.test.ts"],
    // Each test file gets a fresh module registry, so the lazy db singleton
    // never leaks state between files. The setup file points POLVENN_DATA_DIR
    // at a throwaway directory before any module (and therefore the db) loads.
    setupFiles: ["src/test/setup.ts"],
    environment: "node",
  },
});
