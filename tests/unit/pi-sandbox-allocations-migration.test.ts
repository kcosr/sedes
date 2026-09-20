import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { piSandboxAllocationsMigration } from "../../src/server/db/migrations/067-pi-sandbox-allocations.js";

function fixture(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE principals(
      tenant_id TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY(tenant_id, id)
    ) STRICT;
    CREATE TABLE execution_environments(
      tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY(tenant_id, id),
      UNIQUE(tenant_id, owner_principal_id, id)
    ) STRICT;
    CREATE TABLE workspaces(
      tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL,
      environment_id TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY(tenant_id, id),
      UNIQUE(tenant_id, owner_principal_id, environment_id, id)
    ) STRICT;
    CREATE TABLE application_threads(
      tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY(tenant_id, id),
      UNIQUE(tenant_id, owner_principal_id, id)
    ) STRICT;
    INSERT INTO principals VALUES ('tenant', 'principal');
    INSERT INTO execution_environments VALUES ('tenant', 'principal', 'environment');
    INSERT INTO workspaces VALUES ('tenant', 'principal', 'environment', 'workspace');
    INSERT INTO application_threads VALUES ('tenant', 'principal', 'thread');
  `);
  database.exec(piSandboxAllocationsMigration.sql);
  return database;
}

const insert = `INSERT INTO pi_sandbox_allocations(
  tenant_id, owner_principal_id, application_thread_id, allocation_id,
  execution_environment_id, source_workspace_id, source_canonical_path,
  allocation_root_path, home_path, workspace_path, network_profile,
  state, retention, created_at, updated_at
) VALUES (
  'tenant', 'principal', 'thread', '00000000-0000-4000-8000-000000000001',
  'environment', 'workspace', '/source', '/alloc/id', '/alloc/id/home',
  '/alloc/id/home/workspace', 'isolated', 'reserved', 'active', 1, 1
)`;

describe("Pi sandbox allocations migration", () => {
  it("creates a strict scoped allocation table with lifecycle constraints", () => {
    const database = fixture();
    try {
      database.exec(insert);
      expect(
        database.prepare("SELECT state, retention, revision FROM pi_sandbox_allocations").get(),
      ).toEqual({ state: "reserved", retention: "active", revision: 0 });
      expect(() =>
        database.prepare("UPDATE pi_sandbox_allocations SET state = 'ready'").run(),
      ).toThrow(/constraint/i);
      expect(() =>
        database
          .prepare("UPDATE pi_sandbox_allocations SET network_profile = 'open'")
          .run(),
      ).toThrow(/constraint/i);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects cross-scope parents and cascades with its owning thread", () => {
    const database = fixture();
    try {
      expect(() =>
        database
          .prepare(insert.replace("'principal', 'thread'", "'other', 'thread'"))
          .run(),
      ).toThrow(/foreign key/i);
      database.exec(insert);
      database.prepare("DELETE FROM application_threads WHERE id = 'thread'").run();
      expect(
        database.prepare("SELECT count(*) AS count FROM pi_sandbox_allocations").get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
