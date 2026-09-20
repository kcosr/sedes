import { describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import {
  SAVED_AGENT_SEDES_TOOLS_MAX_BYTES,
  SAVED_AGENT_OVERRIDES_MAX_BYTES,
} from "../../src/shared/protocol/saved-agents.js";
import { SavedAgentRepository } from "../../src/server/db/repositories/saved-agent-repository.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

describe("saved agents migration", () => {
  it("rewrites legacy explicit tool policies into canonical strict bytes", () => {
    const current = savedAgentDatabase(55);
    try {
      const id = "77777777-7777-4777-8777-777777777777";
      const cliOnlyId = "88888888-8888-4888-8888-888888888888";
      const implicitPiId = "66666666-6666-4666-8666-666666666666";
      current.database
        .prepare(
          `INSERT INTO saved_agents(
            tenant_id, owner_principal_id, id, name, description,
            backend_type_id, backend_overrides_schema_version,
            backend_overrides_json, harness_tools_json, revision,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, '', 'pi', 1, '[]', ?, 0, 100, 100)`,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          id,
          "Legacy tools",
          '{"enabled":true,"enabledToolIds":["agent.context","thread.status"],"presentationMode":"native_progressive"}',
        );
      current.database
        .prepare(
          `INSERT INTO saved_agents(
            tenant_id, owner_principal_id, id, name, description,
            backend_type_id, backend_overrides_schema_version,
            backend_overrides_json, harness_tools_json, revision,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, '', 'codex', 1, '[]', ?, 0, 100, 100)`,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          cliOnlyId,
          "Legacy CLI tools",
          '{"enabled":true,"enabledToolIds":["agent.context"]}',
        );
      current.database
        .prepare(
          `INSERT INTO saved_agents(
            tenant_id, owner_principal_id, id, name, description,
            backend_type_id, backend_overrides_schema_version,
            backend_overrides_json, harness_tools_json, revision,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, '', 'pi', 1, '[]', ?, 0, 100, 100)`,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          implicitPiId,
          "Legacy implicit Pi tools",
          '{"enabled":true,"enabledToolIds":["agent.context"]}',
        );

      applyDatabaseMigrations(current.database, backendNormalizedMigrations);

      expect(
        new SavedAgentRepository(current.database).get(current.scope, id),
      ).toMatchObject({
        sedesTools: {
          enabled: true,
          enabledToolIds: ["agent.context", "thread.status"],
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "environment",
        },
      });
      expect(
        current.database
          .prepare(
            "SELECT sedes_tools_json AS sedesToolsJson FROM saved_agents WHERE id = ?",
          )
          .get(id),
      ).toEqual({
        sedesToolsJson:
          '{"enabled":true,"enabledToolIds":["agent.context","thread.status"],"presentation":{"surface":"native","mode":"progressive"},"accessBoundary":"environment"}',
      });
      expect(
        new SavedAgentRepository(current.database).get(
          current.scope,
          cliOnlyId,
        ),
      ).toMatchObject({
        sedesTools: {
          enabled: true,
          enabledToolIds: ["agent.context"],
          presentation: { surface: "cli", mode: "progressive" },
          accessBoundary: "environment",
        },
      });
      expect(
        current.database
          .prepare(
            "SELECT sedes_tools_json AS sedesToolsJson FROM saved_agents WHERE id = ?",
          )
          .get(cliOnlyId),
      ).toEqual({
        sedesToolsJson:
          '{"enabled":true,"enabledToolIds":["agent.context"],"presentation":{"surface":"cli","mode":"progressive"},"accessBoundary":"environment"}',
      });
      expect(
        new SavedAgentRepository(current.database).get(
          current.scope,
          implicitPiId,
        ),
      ).toMatchObject({
        sedesTools: {
          enabled: true,
          enabledToolIds: ["agent.context"],
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "environment",
        },
      });
      expect(
        current.database
          .prepare(
            "SELECT sedes_tools_json AS sedesToolsJson FROM saved_agents WHERE id = ?",
          )
          .get(implicitPiId),
      ).toEqual({
        sedesToolsJson:
          '{"enabled":true,"enabledToolIds":["agent.context"],"presentation":{"surface":"native","mode":"progressive"},"accessBoundary":"environment"}',
      });
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
      expect(current.database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      current.database.close();
    }
  });

  it("renames the pre-Sedes policy column without losing stored JSON", () => {
    const current = savedAgentDatabase(78);
    try {
      expect(
        current.database
          .prepare(
            `SELECT version, checksum FROM schema_migrations
             WHERE version IN (15, 44, 48, 49, 63, 69)
             ORDER BY version`,
          )
          .all(),
      ).toEqual([
        {
          version: 15,
          checksum:
            "d78d45ae64dc62a760d770a0dd7c052b431d5e023c37205c9f256ac02ac1d1a4",
        },
        {
          version: 44,
          checksum:
            "c0d7433279f29406aee0bdf9b36a4cc9cd90416efc63e6450e27c0a6b9c155d4",
        },
        {
          version: 48,
          checksum:
            "caebc7a1703755728204973ff233469e112381d8d1a6958a49bff5e8ec6deec6",
        },
        {
          version: 49,
          checksum:
            "5f4d92ae534baa9fd2ac5facebd6c9f353afddb1d6ca387b116f1368b0d1565f",
        },
        {
          version: 63,
          checksum:
            "d48f87c20785ecf000d541bbe76f34407c2e1ff5ea14e78ef0f082cd6c245981",
        },
        {
          version: 69,
          checksum:
            "4b88240e7ed29b22725b963854838dd70d9493ab5644bd7b2436c000d0a0d8ef",
        },
      ]);
      const id = "99999999-9999-4999-8999-999999999999";
      const policy =
        '{"enabled":true,"enabledToolIds":["agent.context"],"environmentAccess":{"otherEnvironments":"ask"}}';
      current.database
        .prepare(
          `INSERT INTO saved_agents(
            tenant_id, owner_principal_id, id, name, description,
            backend_type_id, backend_overrides_schema_version,
            backend_overrides_json, harness_tools_json, revision,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'Upgrade fixture', '', 'codex', 1, '[]', ?, 0, 100, 100)`,
        )
        .run(current.scope.tenantId, current.scope.principalId, id, policy);

      applyDatabaseMigrations(current.database, backendNormalizedMigrations);

      expect(
        current.database
          .prepare(
            "SELECT name FROM pragma_table_info('saved_agents') ORDER BY cid",
          )
          .all(),
      ).toContainEqual({ name: "sedes_tools_json" });
      expect(
        current.database
          .prepare(
            "SELECT name FROM pragma_table_info('saved_agents') WHERE name = 'harness_tools_json'",
          )
          .get(),
      ).toBeUndefined();
      expect(
        current.database
          .prepare(
            "SELECT sedes_tools_json AS sedesToolsJson FROM saved_agents WHERE id = ?",
          )
          .get(id),
      ).toEqual({
        sedesToolsJson:
          '{"enabled":true,"enabledToolIds":["agent.context"],"presentation":{"surface":"cli","mode":"progressive"},"accessBoundary":"environment"}',
      });
      expect(
        new SavedAgentRepository(current.database).get(current.scope, id),
      ).toMatchObject({
        sedesTools: {
          enabled: true,
          enabledToolIds: ["agent.context"],
          presentation: { surface: "cli", mode: "progressive" },
          accessBoundary: "environment",
        },
      });
      expect(
        current.database
          .prepare("SELECT name FROM schema_migrations WHERE version = 79")
          .get(),
      ).toEqual({ name: "rename_saved_agent_tools" });
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
      expect(current.database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      current.database.close();
    }
  });

  it("maps omitted legacy Pi presentation to native progressive", () => {
    const current = savedAgentDatabase(82);
    try {
      const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      current.database
        .prepare(
          `INSERT INTO saved_agents(
            tenant_id, owner_principal_id, id, name, description,
            backend_type_id, backend_overrides_schema_version,
            backend_overrides_json, sedes_tools_json, revision,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'Malformed Pi policy', '', 'pi', 1, '[]', ?, 0, 100, 100)`,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          agentId,
          '{"enabled":true,"enabledToolIds":["agent.context"],"environmentAccess":{"otherEnvironments":"ask"}}',
        );

      applyDatabaseMigrations(current.database, backendNormalizedMigrations);

      expect(
        current.database
          .prepare(
            "SELECT sedes_tools_json AS sedesToolsJson FROM saved_agents WHERE id = ?",
          )
          .get(agentId),
      ).toEqual({
        sedesToolsJson:
          '{"enabled":true,"enabledToolIds":["agent.context"],"presentation":{"surface":"native","mode":"progressive"},"accessBoundary":"environment"}',
      });
      expect(
        new SavedAgentRepository(current.database).get(current.scope, agentId),
      ).toMatchObject({
        sedesTools: {
          presentation: { surface: "native", mode: "progressive" },
        },
      });
    } finally {
      current.database.close();
    }
  });

  it("upgrades schema 47 while keeping Agent origin out of thread columns", () => {
    const current = savedAgentDatabase(47);
    try {
      expect(
        current.database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'saved_agents'",
          )
          .get(),
      ).toBeUndefined();

      applyDatabaseMigrations(current.database, backendNormalizedMigrations);

      expect(
        current.database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'saved_agents'",
          )
          .get(),
      ).toEqual({ name: "saved_agents" });
      expect(
        current.database
          .prepare(
            "SELECT 1 FROM pragma_table_info('application_threads') WHERE name LIKE '%agent%'",
          )
          .all(),
      ).toEqual([]);
      expect(
        current.database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_saved_agent_origins'",
          )
          .get(),
      ).toEqual({ name: "thread_saved_agent_origins" });
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
      expect(current.database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      current.database.close();
    }
  });

  it("enforces strict scalar and serialized storage bounds", () => {
    const current = savedAgentDatabase();
    try {
      const base = [
        current.scope.tenantId,
        current.scope.principalId,
        "11111111-1111-4111-8111-111111111111",
        "Agent",
        "",
        "pi",
        1,
        "[]",
        null,
        0,
        100,
        100,
      ] as const;
      const insert = current.database.prepare(
        `INSERT INTO saved_agents(
          tenant_id, owner_principal_id, id, name, description,
          backend_type_id, backend_overrides_schema_version,
          backend_overrides_json, sedes_tools_json, revision,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      expect(() => insert.run(...base)).not.toThrow();
      expect(() =>
        insert.run(...base.slice(0, 2), "not-a-uuid", ...base.slice(3)),
      ).toThrow();
      expect(() =>
        insert.run(
          ...base.slice(0, 2),
          "22222222-2222-4222-8222-222222222222",
          "Agent 2",
          "",
          "PI BAD",
          1,
          "[]",
          null,
          0,
          100,
          100,
        ),
      ).toThrow();
      expect(() =>
        insert.run(
          ...base.slice(0, 2),
          "33333333-3333-4333-8333-333333333333",
          "Agent 3",
          "",
          "pi",
          1,
          "{}",
          null,
          0,
          100,
          100,
        ),
      ).toThrow();
      expect(() =>
        insert.run(
          current.scope.tenantId,
          current.scope.principalId,
          "44444444-4444-4444-8444-444444444444",
          "Oversized overrides",
          "",
          "pi",
          1,
          JSON.stringify([
            { value: "x".repeat(SAVED_AGENT_OVERRIDES_MAX_BYTES) },
          ]),
          null,
          0,
          100,
          100,
        ),
      ).toThrow();
      expect(() =>
        insert.run(
          current.scope.tenantId,
          current.scope.principalId,
          "55555555-5555-4555-8555-555555555555",
          "Too many overrides",
          "",
          "pi",
          1,
          JSON.stringify(
            Array.from({ length: 33 }, (_, index) => ({ id: `field${index}` })),
          ),
          null,
          0,
          100,
          100,
        ),
      ).toThrow();
      expect(() =>
        insert.run(
          current.scope.tenantId,
          current.scope.principalId,
          "66666666-6666-4666-8666-666666666666",
          "Oversized tools",
          "",
          "pi",
          1,
          "[]",
          JSON.stringify({
            padding: "x".repeat(SAVED_AGENT_SEDES_TOOLS_MAX_BYTES),
          }),
          0,
          100,
          100,
        ),
      ).toThrow();
    } finally {
      current.database.close();
    }
  });
});
