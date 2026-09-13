import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";

// This file must create a legacy (pre-migration) database on disk BEFORE any
// function from database.js runs, so getDb() picks it up and migrates it.

async function writeLegacyDatabase(): Promise<void> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  // v1 schema exactly as the pre-migration code created it.
  db.run(`
    CREATE TABLE watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('brewery', 'style', 'series', 'keyword')),
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(type, value)
    )
  `);
  db.run(`
    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.run("INSERT INTO watchlist (type, value) VALUES ('brewery', 'amundsen')");
  db.run("INSERT INTO watchlist (type, value) VALUES ('style', 'sour')");
  db.run("INSERT INTO config (key, value) VALUES ('home_store_id', '170')");
  // user_version stays 0, as in legacy databases.

  const dbPath = path.join(process.env.POLVENN_DATA_DIR ?? ".", "polvenn.db");
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

describe("legacy database migration", () => {
  it("upgrades a v1 database to the latest version, preserving rows and accepting new rule types", async () => {
    await writeLegacyDatabase();

    const { getDb, listWatchlistEntries, getConfigValue, addWatchlistEntry } = await import(
      "./database.js"
    );

    const db = await getDb();
    const version = Number(db.exec("PRAGMA user_version")[0].values[0][0]);
    expect(version).toBe(3);

    // Existing rows survived the table rebuild.
    const entries = await listWatchlistEntries();
    expect(entries.map((entry) => entry.value).sort()).toEqual(["amundsen", "sour"]);
    expect(entries.every((entry) => entry.minValue == null && entry.maxValue == null)).toBe(true);

    // Config survived untouched.
    expect(await getConfigValue("home_store_id")).toBe("170");

    // The rebuilt table accepts the new rule types with numeric bounds.
    const added = await addWatchlistEntry("price", "price <= 200", undefined, 200);
    expect(added.minValue).toBeNull();
    expect(added.maxValue).toBe(200);

    // ...including the v3 'stock' rule type.
    await addWatchlistEntry("stock", "20162402");

    const after = await listWatchlistEntries();
    expect(after).toHaveLength(4);
  });
});
