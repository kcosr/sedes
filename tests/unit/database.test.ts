import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyDatabaseMigrations,
  type DatabaseMigration,
} from "../../src/server/db/migrate.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function migration(
  version: number,
  name: string,
  sql: string,
): DatabaseMigration {
  return { version, name, sql };
}

function appliedVersions(database: Database.Database): number[] {
  return (
    database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>
  ).map(({ version }) => version);
}

describe("database migrations and storage", () => {
  it("applies migrations once in strict version order", () => {
    const database = new Database(":memory:");
    try {
      const plan = [
        migration(
          1,
          "create_order_log",
          "CREATE TABLE order_log(position INTEGER NOT NULL) STRICT;",
        ),
        migration(3, "record_first", "INSERT INTO order_log VALUES (1);"),
        migration(8, "record_second", "INSERT INTO order_log VALUES (2);"),
      ];

      applyDatabaseMigrations(database, plan);
      applyDatabaseMigrations(database, plan);

      expect(appliedVersions(database)).toEqual([1, 3, 8]);
      expect(
        database
          .prepare("SELECT position FROM order_log ORDER BY rowid")
          .all(),
      ).toEqual([{ position: 1 }, { position: 2 }]);
    } finally {
      database.close();
    }
  });

  it("rejects applied migration name and checksum mismatches", () => {
    const plan = [
      migration(
        1,
        "create_integrity_probe",
        "CREATE TABLE integrity_probe(id INTEGER PRIMARY KEY) STRICT;",
      ),
    ];

    const nameDatabase = new Database(":memory:");
    try {
      applyDatabaseMigrations(nameDatabase, plan);
      nameDatabase
        .prepare("UPDATE schema_migrations SET name = ? WHERE version = 1")
        .run("renamed_migration");
      expect(() => applyDatabaseMigrations(nameDatabase, plan)).toThrow(
        "Database migration 1 does not match this build.",
      );
    } finally {
      nameDatabase.close();
    }

    const checksumDatabase = new Database(":memory:");
    try {
      applyDatabaseMigrations(checksumDatabase, plan);
      checksumDatabase
        .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
        .run("0".repeat(64));
      expect(() => applyDatabaseMigrations(checksumDatabase, plan)).toThrow(
        "Database migration 1 does not match this build.",
      );
    } finally {
      checksumDatabase.close();
    }
  });

  it("rejects unknown and future applied versions", () => {
    const plan = [
      migration(
        1,
        "create_version_probe",
        "CREATE TABLE version_probe(id INTEGER PRIMARY KEY) STRICT;",
      ),
      migration(3, "known_later_version", "SELECT 1;"),
    ];

    const unknownDatabase = new Database(":memory:");
    try {
      applyDatabaseMigrations(unknownDatabase, plan);
      unknownDatabase
        .prepare(
          `
            INSERT INTO schema_migrations(version, name, checksum, applied_at)
            VALUES (?, ?, ?, ?)
          `,
        )
        .run(2, "unknown_middle_version", "0".repeat(64), 0);
      expect(() => applyDatabaseMigrations(unknownDatabase, plan)).toThrow(
        "Database contains unknown migration version 2.",
      );
    } finally {
      unknownDatabase.close();
    }

    const futureDatabase = new Database(":memory:");
    try {
      applyDatabaseMigrations(futureDatabase, plan);
      futureDatabase
        .prepare(
          `
            INSERT INTO schema_migrations(version, name, checksum, applied_at)
            VALUES (?, ?, ?, ?)
          `,
        )
        .run(4, "future_version", "0".repeat(64), 0);
      expect(() => applyDatabaseMigrations(futureDatabase, plan)).toThrow(
        "Database schema version 4 is newer than supported version 3.",
      );
    } finally {
      futureDatabase.close();
    }
  });

  it("rolls back a failed migration and does not record it", () => {
    const database = new Database(":memory:");
    try {
      const plan = [
        migration(
          1,
          "create_stable_probe",
          "CREATE TABLE stable_probe(id INTEGER PRIMARY KEY) STRICT;",
        ),
      ];
      applyDatabaseMigrations(database, plan);

      expect(() =>
        applyDatabaseMigrations(database, [
          ...plan,
          migration(
            2,
            "failed_atomic_change",
            `
              CREATE TABLE rollback_probe(id INTEGER PRIMARY KEY) STRICT;
              INSERT INTO table_that_does_not_exist VALUES (1);
            `,
          ),
        ]),
      ).toThrow();

      expect(appliedVersions(database)).toEqual([1]);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rollback_probe'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("restores foreign-key enforcement after a disabled-FK migration fails", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      const plan = [
        migration(
          1,
          "create_foreign_key_probe",
          `
            CREATE TABLE parent_probe(id INTEGER PRIMARY KEY) STRICT;
            CREATE TABLE child_probe(
              parent_id INTEGER NOT NULL REFERENCES parent_probe(id)
            ) STRICT;
          `,
        ),
      ];
      applyDatabaseMigrations(database, plan);

      expect(() =>
        applyDatabaseMigrations(database, [
          ...plan,
          {
            version: 2,
            name: "failed_disabled_fk_change",
            requiresForeignKeysDisabled: true,
            verifyDatabaseIntegrity: true,
            sql: `
              CREATE TABLE rollback_disabled_fk_probe(
                id INTEGER PRIMARY KEY
              ) STRICT;
              INSERT INTO table_that_does_not_exist VALUES (1);
            `,
          },
        ]),
      ).toThrow();

      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(appliedVersions(database)).toEqual([1]);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rollback_disabled_fk_probe'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it.runIf(process.platform !== "win32")(
    "enforces 0700 state-directory and 0600 database modes on POSIX",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sedes-db-"));
      roots.push(root);
      const stateDirectory = path.join(root, "state");
      await mkdir(stateDirectory, { mode: 0o777 });
      const filename = path.join(stateDirectory, "overlay.sqlite");
      const database = openOverlayDatabase(filename);
      database.close();

      expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
    },
  );
});
