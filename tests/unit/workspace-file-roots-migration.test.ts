import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { workspaceFileRootsMigration } from "../../src/server/db/migrations/030-workspace-file-roots.js";

describe("workspace file-roots migration", () => {
  it("creates supplemental-only, workspace-owned durable storage", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      database.exec(`
        CREATE TABLE principals (
          tenant_id TEXT NOT NULL,
          id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, id)
        ) STRICT;
        CREATE TABLE workspaces (
          tenant_id TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, id)
        ) STRICT;
        INSERT INTO principals VALUES ('tenant', 'principal');
        INSERT INTO workspaces VALUES ('tenant', 'principal', 'workspace');
      `);
      database.exec(workspaceFileRootsMigration.sql);
      database
        .prepare(
          `
            INSERT INTO workspace_file_roots(
              tenant_id, owner_principal_id, workspace_id, root_id,
              canonical_path, display_label, sort_order, availability,
              revision, created_at, updated_at
            ) VALUES ('tenant', 'principal', 'workspace', 'supplemental',
              '/context', 'Context', 0, 'available', 1, 1, 1)
          `,
        )
        .run();
      expect(() =>
        database
          .prepare(
            `
              INSERT INTO workspace_file_roots(
                tenant_id, owner_principal_id, workspace_id, root_id,
                canonical_path, display_label, sort_order, availability,
                revision, created_at, updated_at
              ) VALUES ('tenant', 'principal', 'workspace', 'primary',
                '/primary', 'Primary', 1, 'available', 1, 1, 1)
            `,
          )
          .run(),
      ).toThrow(/CHECK|constraint/i);
      expect(() =>
        database
          .prepare(
            `
              INSERT INTO workspace_file_roots(
                tenant_id, owner_principal_id, workspace_id, root_id,
                canonical_path, display_label, sort_order, availability,
                revision, created_at, updated_at
              ) VALUES ('tenant', 'other', 'workspace', 'wrong-owner',
                '/other', 'Other', 1, 'available', 1, 1, 1)
            `,
          )
          .run(),
      ).toThrow(/FOREIGN KEY|constraint/i);
    } finally {
      database.close();
    }
  });
});
