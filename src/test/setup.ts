import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs before test files load, so the lazy db in src/db/database.ts resolves
// to a throwaway file instead of the developer's real ~/.polvenn/polvenn.db.
process.env.POLVENN_DATA_DIR = mkdtempSync(join(tmpdir(), "polvenn-test-"));
