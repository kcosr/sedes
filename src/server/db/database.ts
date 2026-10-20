import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrateDatabase } from "./migrate.js";

export type OpenOverlayDatabaseOptions = {
  migrate?: boolean;
};

export function openOverlayDatabaseConnection(filename: string): Database.Database {
  const directory = path.dirname(filename);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Some supported filesystems do not expose POSIX modes.
  }

  const database = new Database(filename);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");

  try {
    chmodSync(filename, 0o600);
  } catch {
    // Some supported filesystems do not expose POSIX modes.
  }

  return database;
}

export function openOverlayDatabase(
  filename: string,
  options: OpenOverlayDatabaseOptions = {},
): Database.Database {
  const database = openOverlayDatabaseConnection(filename);
  if (options.migrate !== false) {
    migrateDatabase(database);
  }
  return database;
}

/** SQLite's recommended bound on the rows each optimize-driven ANALYZE examines per index. */
const OPTIMIZE_ANALYSIS_LIMIT = 1_000;
export const DATABASE_OPTIMIZE_INTERVAL_MILLISECONDS = 60 * 60 * 1_000;

/**
 * Keeps query-planner statistics current for a long-lived connection, as
 * SQLite recommends: examine every table once the connection is open and
 * migrated, then periodically and before closing analyze only the tables its
 * queries showed may benefit. Each analysis is bounded. Statistics only guide
 * plan choice; durability settings are unchanged.
 */
export function optimizeDatabase(
  database: Database.Database,
  phase: "opened" | "periodic" | "closing",
): void {
  if (phase === "opened") {
    database.pragma(`analysis_limit = ${OPTIMIZE_ANALYSIS_LIMIT}`);
    database.pragma("optimize = 0x10002");
    return;
  }
  database.pragma("optimize");
}
