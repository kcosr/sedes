import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPreMigrationBackup,
  prunePreMigrationBackups,
} from "../../src/server/db/pre-migration-backup.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("pre-migration backup", () => {
  it("checkpoints, copies, verifies, and preserves the source snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-backup-"));
    roots.push(root);
    const databasePath = path.join(root, "overlay.sqlite");
    const database = new Database(databasePath);
    database.pragma("journal_mode = WAL");
    database.exec(
      `
        CREATE TABLE schema_migrations(
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        ) STRICT;
        INSERT INTO schema_migrations VALUES (9, 'current', 'checksum', 1);
        CREATE TABLE probe(value TEXT NOT NULL) STRICT;
        INSERT INTO probe VALUES ('before');
      `,
    );

    try {
      const backupPath = await createPreMigrationBackup({
        database,
        stateDirectory: root,
        sourceSchemaVersion: 9,
        now: 1_700_000_000_000,
      });
      database.prepare("UPDATE probe SET value = 'after'").run();

      const backup = new Database(backupPath, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(
          backup.prepare("SELECT value FROM probe").get(),
        ).toEqual({ value: "before" });
        expect(backup.pragma("integrity_check")).toEqual([
          { integrity_check: "ok" },
        ]);
      } finally {
        backup.close();
      }
    } finally {
      database.close();
    }
  });

  it("rejects a caller-supplied schema version that differs from SQLite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-backup-version-"));
    roots.push(root);
    const database = new Database(path.join(root, "overlay.sqlite"));
    database.exec(`
      CREATE TABLE schema_migrations(
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations VALUES (9, 'current', 'checksum', 1);
    `);
    try {
      await expect(
        createPreMigrationBackup({
          database,
          stateDirectory: root,
          sourceSchemaVersion: 8,
        }),
      ).rejects.toThrow(/schema mismatch/i);
    } finally {
      database.close();
    }
  });

  it("retains the newest five, young backups, and one per source version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-retention-"));
    roots.push(root);
    const directory = path.join(root, "backups");
    const now = 2_000_000_000_000;
    const old = now - 40 * 24 * 60 * 60 * 1_000;
    const filenames = [
      `overlay-schema-v8-${old - 2}-00000000-0000-0000-0000-000000000001.sqlite`,
      `overlay-schema-v8-${old - 1}-00000000-0000-0000-0000-000000000002.sqlite`,
      `overlay-schema-v9-${old}-00000000-0000-0000-0000-000000000003.sqlite`,
      ...Array.from({ length: 6 }, (_, index) =>
        `overlay-schema-v10-${now - index}-00000000-0000-0000-0000-${String(index).padStart(12, "0")}.sqlite`,
      ),
    ];
    await mkdir(directory, { recursive: true });
    await Promise.all(
      filenames.map((filename) => writeFile(path.join(directory, filename), "")),
    );

    const removed = await prunePreMigrationBackups(root, {
      now,
      minimumNewest: 5,
      maximumAgeMilliseconds: 30 * 24 * 60 * 60 * 1_000,
    });
    expect(removed.map((pathname) => path.basename(pathname))).toEqual([
      filenames[0],
    ]);
  });
});
