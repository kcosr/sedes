import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { piSandboxAllocationsMigration } from "../../src/server/db/migrations/067-pi-sandbox-allocations.js";
import { piSandboxWorkspaceAccessMigration } from "../../src/server/db/migrations/068-pi-sandbox-workspace-access.js";

describe("Pi sandbox workspace access migration", () => {
  it("classifies existing allocations as writable clones and constrains new modes", () => {
    const database = new Database(":memory:");
    try {
      database.pragma("foreign_keys = OFF");
      database.exec(piSandboxAllocationsMigration.sql);
      database.exec(`INSERT INTO pi_sandbox_allocations(
        tenant_id, owner_principal_id, application_thread_id, allocation_id,
        execution_environment_id, source_workspace_id, source_canonical_path,
        allocation_root_path, home_path, workspace_path, network_profile,
        state, retention, created_at, updated_at
      ) VALUES (
        'tenant', 'principal', 'thread',
        '00000000-0000-4000-8000-000000000001', 'environment', 'workspace',
        '/source', '/alloc/id', '/alloc/id/home', '/alloc/id/home/workspace',
        'isolated', 'reserved', 'active', 1, 1
      )`);

      database.exec(piSandboxWorkspaceAccessMigration.sql);
      expect(
        database
          .prepare("SELECT workspace_access AS workspaceAccess FROM pi_sandbox_allocations")
          .get(),
      ).toEqual({ workspaceAccess: "writable_clone" });
      database
        .prepare("UPDATE pi_sandbox_allocations SET workspace_access = 'read_only'")
        .run();
      expect(() =>
        database
          .prepare("UPDATE pi_sandbox_allocations SET workspace_access = 'overlay'")
          .run(),
      ).toThrow(/constraint/i);
    } finally {
      database.close();
    }
  });
});
