import { describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

describe("migration 069 mutable backend protocol release", () => {
  it("preserves backend relationships while removing provider release pins", () => {
    const value = savedAgentDatabase(68);
    try {
      const beforeBackend = value.database
        .prepare("SELECT * FROM agent_backend_instances ORDER BY id")
        .all();
      const beforeProfile = value.database
        .prepare("SELECT * FROM agent_connection_profiles ORDER BY id")
        .all();

      applyDatabaseMigrations(
        value.database,
        backendNormalizedMigrations.filter(({ version }) => version <= 69),
      );

      expect(
        value.database
          .prepare("SELECT * FROM agent_backend_instances ORDER BY id")
          .all(),
      ).toEqual(beforeBackend);
      expect(
        value.database
          .prepare("SELECT * FROM agent_connection_profiles ORDER BY id")
          .all(),
      ).toEqual(beforeProfile);
      expect(
        value.database
          .prepare("SELECT max(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 69 });

      const backendTable = value.database
        .prepare(
          `SELECT sql FROM sqlite_master
           WHERE type = 'table' AND name = 'agent_backend_instances'`,
        )
        .get() as { readonly sql: string };
      expect(backendTable.sql).not.toContain("protocol_release = '0.83.0'");
      expect(backendTable.sql).not.toContain("protocol_release = '0.3.226'");
      expect(backendTable.sql).not.toContain("protocol_release = '1.x'");

      const insertBackend = value.database.prepare(`
        INSERT INTO agent_backend_instances(
          tenant_id, id, kind, label, enabled, protocol_release,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, 200, 200)
      `);
      expect(() =>
        insertBackend.run(
          value.scope.tenantId,
          "future-pi",
          "pi",
          "Future Pi",
          "2.0.0",
        ),
      ).not.toThrow();
      expect(() =>
        insertBackend.run(
          value.scope.tenantId,
          "future-claude",
          "claude_agent_sdk",
          "Future Claude",
          "0.5.0",
        ),
      ).not.toThrow();
      expect(() =>
        insertBackend.run(
          value.scope.tenantId,
          "future-grok",
          "grok_build",
          "Future Grok",
          "2.x",
        ),
      ).not.toThrow();
      expect(() =>
        insertBackend.run(
          value.scope.tenantId,
          "empty-release",
          "codex_app_server",
          "Empty release",
          "",
        ),
      ).toThrow(/constraint/i);
      expect(() =>
        insertBackend.run(
          value.scope.tenantId,
          "unknown-kind",
          "unknown",
          "Unknown kind",
          "1.0.0",
        ),
      ).toThrow(/constraint/i);
      expect(value.database.pragma("foreign_key_check")).toEqual([]);
      expect(value.database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      value.database.close();
    }
  });
});
