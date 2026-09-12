import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { DATA_DIR_ENV_VAR, DATA_DIRNAME, DB_FILENAME } from "../constants.js";
import type { PolvennConfig, WatchlistEntry } from "../types.js";

function getDbPath(): string {
  const explicitDataDir = process.env[DATA_DIR_ENV_VAR];
  if (explicitDataDir) {
    return path.join(explicitDataDir, DB_FILENAME);
  }

  const dataDir = path.join(os.homedir(), DATA_DIRNAME);
  return path.join(dataDir, DB_FILENAME);
}

let _db: SqlJsDatabase | null = null;
let _dbPath: string | null = null;

export async function getDb(): Promise<SqlJsDatabase> {
  if (_db) return _db;

  const dbPath = getDbPath();
  _dbPath = dbPath;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const SQL = await initSqlJs();
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    _db = new SQL.Database(buffer);
  } else {
    _db = new SQL.Database();
  }

  runMigrations(_db);
  saveDb();
  return _db;
}

function saveDb(): void {
  if (!_db || !_dbPath) return;
  const data = _db.export();
  fs.writeFileSync(_dbPath, Buffer.from(data));
}

export function persistDb(): void {
  saveDb();
}

export function closeDb(): void {
  if (!_db) return;
  saveDb();
  _db.close();
  _db = null;
}

interface Migration {
  /** Target PRAGMA user_version after this migration has been applied. */
  version: number;
  up: (db: SqlJsDatabase) => void;
}

function getUserVersion(db: SqlJsDatabase): number {
  const result = db.exec("PRAGMA user_version");
  return Number(result[0]?.values[0]?.[0] ?? 0);
}

const MIGRATIONS: Migration[] = [
  {
    // v1: the original schema. CREATE IF NOT EXISTS makes this a no-op
    // stamp for databases created before the migration runner existed.
    version: 1,
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS watchlist (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK(type IN ('brewery', 'style', 'series', 'keyword')),
          value TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(type, value)
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS beer_cache (
          article_number TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('vinmonopolet', 'external')),
          cached_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS release_checkpoints (
          release_key TEXT PRIMARY KEY,
          seen_match_keys TEXT NOT NULL,
          checked_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    },
  },
  {
    // v2: watchlist gains country/abv/price rule types plus numeric bounds.
    // SQLite cannot ALTER a CHECK constraint, so the table is rebuilt.
    version: 2,
    up: (db) => {
      db.run(`
        CREATE TABLE watchlist_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK(type IN ('brewery', 'style', 'series', 'keyword', 'country', 'abv', 'price')),
          value TEXT NOT NULL,
          min_value REAL,
          max_value REAL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(type, value)
        )
      `);
      db.run(`
        INSERT INTO watchlist_new (id, type, value, min_value, max_value, created_at)
        SELECT id, type, value, NULL, NULL, created_at FROM watchlist
      `);
      db.run("DROP TABLE watchlist");
      db.run("ALTER TABLE watchlist_new RENAME TO watchlist");
    },
  },
];

function runMigrations(db: SqlJsDatabase): void {
  const current = getUserVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    migration.up(db);
    db.run(`PRAGMA user_version = ${migration.version}`);
  }
}

export async function addWatchlistEntry(
  type: WatchlistEntry["type"],
  value: string,
  minValue?: number | null,
  maxValue?: number | null,
): Promise<WatchlistEntry> {
  const db = await getDb();
  const normalised = value.toLowerCase().trim();
  db.run("INSERT INTO watchlist (type, value, min_value, max_value) VALUES (?, ?, ?, ?)", [
    type,
    normalised,
    minValue ?? null,
    maxValue ?? null,
  ]);
  const result = db.exec("SELECT last_insert_rowid() as id");
  const id = result[0]?.values[0]?.[0] as number;
  saveDb();
  return {
    id,
    type,
    value: normalised,
    minValue: minValue ?? null,
    maxValue: maxValue ?? null,
    createdAt: new Date().toISOString(),
  };
}

export async function removeWatchlistEntry(id: number): Promise<boolean> {
  const db = await getDb();
  db.run("DELETE FROM watchlist WHERE id = ?", [id]);
  const changes = db.getRowsModified();
  saveDb();
  return changes > 0;
}

/** Test hook: forget all watchlist rules and release checkpoints. */
export async function resetStateForTests(): Promise<void> {
  const db = await getDb();
  db.run("DELETE FROM watchlist");
  db.run("DELETE FROM release_checkpoints");
  saveDb();
}

export async function listWatchlistEntries(): Promise<WatchlistEntry[]> {
  const db = await getDb();
  const result = db.exec(
    "SELECT id, type, value, min_value, max_value, created_at as createdAt FROM watchlist ORDER BY type, value",
  );
  if (result.length === 0) return [];
  return result[0].values.map((row) => ({
    id: row[0] as number,
    type: row[1] as WatchlistEntry["type"],
    value: row[2] as string,
    minValue: (row[3] as number | null) ?? null,
    maxValue: (row[4] as number | null) ?? null,
    createdAt: row[5] as string,
  }));
}

export async function getSeenWatchlistMatchKeys(releaseKey: string): Promise<string[]> {
  const db = await getDb();
  const result = db.exec("SELECT seen_match_keys FROM release_checkpoints WHERE release_key = ?", [
    releaseKey,
  ]);

  const raw = result[0]?.values[0]?.[0];
  if (typeof raw !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

export async function setSeenWatchlistMatchKeys(
  releaseKey: string,
  matchKeys: string[],
): Promise<void> {
  const db = await getDb();
  const uniqueKeys = Array.from(new Set(matchKeys)).sort();
  db.run(
    `
      INSERT OR REPLACE INTO release_checkpoints (release_key, seen_match_keys, checked_at)
      VALUES (?, ?, datetime('now'))
    `,
    [releaseKey, JSON.stringify(uniqueKeys)],
  );
  saveDb();
}

export async function getCachedBeer(articleNumber: string): Promise<string | null> {
  const db = await getDb();
  const result = db.exec(
    "SELECT data FROM beer_cache WHERE article_number = ? AND cached_at > datetime('now', '-1 day')",
    [articleNumber],
  );
  return (result[0]?.values[0]?.[0] as string) ?? null;
}

export async function setCachedBeer(
  articleNumber: string,
  data: string,
  source: string,
): Promise<void> {
  const db = await getDb();
  db.run(
    "INSERT OR REPLACE INTO beer_cache (article_number, data, source, cached_at) VALUES (?, ?, ?, datetime('now'))",
    [articleNumber, data, source],
  );
  saveDb();
}

export async function getConfigValue(key: string): Promise<string | null> {
  const db = await getDb();
  const result = db.exec("SELECT value FROM config WHERE key = ?", [key]);
  return (result[0]?.values[0]?.[0] as string) ?? null;
}

export async function setConfig(key: string, value: string): Promise<void> {
  const db = await getDb();
  db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [key, value]);
  saveDb();
}

export async function getAllConfig(): Promise<PolvennConfig> {
  const releaseFeedUrl = await getConfigValue("release_feed_url");
  const vinmonopoletApiKey = await getConfigValue("vinmonopolet_api_key");
  const homeStoreId = await getConfigValue("home_store_id");
  const homeLat = await getConfigValue("home_latitude");
  const homeLon = await getConfigValue("home_longitude");

  return {
    releaseFeedUrl,
    vinmonopoletApiKey,
    homeStoreId,
    homeLatitude: homeLat ? Number(homeLat) : null,
    homeLongitude: homeLon ? Number(homeLon) : null,
  };
}
