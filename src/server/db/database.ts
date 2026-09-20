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
