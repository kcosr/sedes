import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { workspaceEnvironmentAuthorityMigration } from "../../src/server/db/migrations/032-workspace-environment-authority.js";

describe("workspace environment authority migration", () => {
  it("binds existing workspaces to the environment configuration revision present at migration", () => {
    const database = new Database(":memory:");
    try {
      database.exec(`
        CREATE TABLE execution_environments (
          tenant_id TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          id TEXT NOT NULL,
          configuration_revision INTEGER NOT NULL,
          PRIMARY KEY (tenant_id, id)
        ) STRICT;
        CREATE TABLE workspaces (
          tenant_id TEXT NOT NULL,
          owner_principal_id TEXT NOT NULL,
          environment_id TEXT NOT NULL,
          id TEXT NOT NULL,
          PRIMARY KEY (tenant_id, environment_id, id)
        ) STRICT;
        INSERT INTO execution_environments VALUES
          ('tenant', 'principal', 'local', 3),
          ('tenant', 'principal', 'ssh', 8);
        INSERT INTO workspaces VALUES
          ('tenant', 'principal', 'local', 'workspace-local'),
          ('tenant', 'principal', 'ssh', 'workspace-ssh');
      `);

      database.exec(workspaceEnvironmentAuthorityMigration.sql);

      expect(
        database
          .prepare(
            `
              SELECT id,
                environment_configuration_revision AS authorityRevision
              FROM workspaces
              ORDER BY id
            `,
          )
          .all(),
      ).toEqual([
        { id: "workspace-local", authorityRevision: 3 },
        { id: "workspace-ssh", authorityRevision: 8 },
      ]);
    } finally {
      database.close();
    }
  });
});
