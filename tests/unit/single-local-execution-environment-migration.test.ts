import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { singleLocalExecutionEnvironmentMigration } from "../../src/server/db/migrations/033-single-local-execution-environment.js";

describe("single local execution-environment migration", () => {
  it("rejects a second local environment while allowing multiple SSH environments", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE principals (
          tenant_id TEXT NOT NULL,
          id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, id)
        ) STRICT;
        CREATE TABLE execution_environments (
          tenant_id TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('local', 'ssh')),
          PRIMARY KEY (tenant_id, id),
          FOREIGN KEY (tenant_id, owner_principal_id)
            REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
        ) STRICT;
        INSERT INTO principals VALUES
          ('tenant', 'principal'),
          ('tenant', 'other-principal');
        INSERT INTO execution_environments VALUES
          ('tenant', 'principal', 'local-a', 'local'),
          ('tenant', 'principal', 'ssh-a', 'ssh');
      `);

      database.exec(singleLocalExecutionEnvironmentMigration.sql);

      expect(() =>
        database
          .prepare(
            `INSERT INTO execution_environments VALUES
               ('tenant', 'principal', 'local-b', 'local')`,
          )
          .run(),
      ).toThrow(/UNIQUE|constraint/i);

      database
        .prepare(
          `INSERT INTO execution_environments VALUES
             ('tenant', 'principal', 'ssh-b', 'ssh')`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO execution_environments VALUES
             ('tenant', 'other-principal', 'local-other', 'local')`,
        )
        .run();
      expect(
        database
          .prepare(
            `SELECT id, kind FROM execution_environments ORDER BY id`,
          )
          .all(),
      ).toEqual([
        { id: "local-a", kind: "local" },
        { id: "local-other", kind: "local" },
        { id: "ssh-a", kind: "ssh" },
        { id: "ssh-b", kind: "ssh" },
      ]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      database.close();
    }
  });

  it("fails closed when duplicate local environments predate the migration", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE execution_environments (
          tenant_id TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('local', 'ssh')),
          PRIMARY KEY (tenant_id, id)
        ) STRICT;
        INSERT INTO execution_environments VALUES
          ('tenant', 'principal', 'local-a', 'local'),
          ('tenant', 'principal', 'local-b', 'local');
      `);

      expect(() =>
        database.exec(singleLocalExecutionEnvironmentMigration.sql),
      ).toThrow(/UNIQUE|constraint/i);
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_master
             WHERE type = 'index'
               AND name = 'execution_environments_single_local_owner'`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
