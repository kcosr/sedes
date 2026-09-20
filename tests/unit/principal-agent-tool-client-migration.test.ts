import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

function insertClient(
  database: ReturnType<typeof savedAgentDatabase>["database"],
  scope: ReturnType<typeof savedAgentDatabase>["scope"],
  input: {
    readonly id?: string;
    readonly requestId?: string;
    readonly name?: string;
    readonly verifier?: Buffer;
    readonly generation?: number;
  } = {},
) {
  const environmentId = (
    database
      .prepare(
        `SELECT id FROM execution_environments
         WHERE tenant_id = ? AND owner_principal_id = ? ORDER BY id LIMIT 1`,
      )
      .get(scope.tenantId, scope.principalId) as { readonly id: string }
  ).id;
  const id = input.id ?? randomUUID();
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO principal_agent_tool_clients(
           tenant_id, owner_principal_id, id, creation_request_id, name,
           enabled, default_environment_id, policy_revision,
           credential_generation, credential_verifier, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?, ?, 100, 100)`,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        id,
        input.requestId ?? randomUUID(),
        input.name ?? "Migration client",
        environmentId,
        input.generation ?? 1,
        input.verifier ?? Buffer.alloc(32, 7),
      );
    database
      .prepare(
        `INSERT INTO principal_agent_tool_client_environments(
           tenant_id, owner_principal_id, client_id, environment_id
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(scope.tenantId, scope.principalId, id, environmentId);
  }).immediate();
  return { id, environmentId };
}

describe("migration 060 principal agent-tool clients", () => {
  it("applies as the reserved strict migration with clean integrity", () => {
    const value = savedAgentDatabase(59);
    try {
      applyDatabaseMigrations(
        value.database,
        backendNormalizedMigrations.filter(({ version }) => version <= 60),
      );
      expect(
        value.database
          .prepare(`SELECT max(version) AS version FROM schema_migrations`)
          .get(),
      ).toEqual({ version: 60 });
      expect(
        value.database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'principal_agent_tool_client%'
             ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: "principal_agent_tool_client_entries" },
        { name: "principal_agent_tool_client_environments" },
        { name: "principal_agent_tool_clients" },
      ]);
      expect(value.database.pragma("foreign_key_check")).toEqual([]);
      expect(value.database.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      value.database.close();
    }
  });

  it("enforces verifier, generation, name, default membership, and terminal revocation", () => {
    const value = savedAgentDatabase();
    try {
      expect(() =>
        insertClient(value.database, value.scope, {
          verifier: Buffer.alloc(31),
        }),
      ).toThrow();
      expect(() =>
        insertClient(value.database, value.scope, { generation: 0 }),
      ).toThrow();
      expect(() =>
        insertClient(value.database, value.scope, { name: ` ${"x".repeat(240)}` }),
      ).toThrow();

      const client = insertClient(value.database, value.scope);
      value.database
        .prepare(
          `INSERT INTO principal_agent_tool_client_entries(
             tenant_id, owner_principal_id, client_id, tool_id
           ) VALUES (?, ?, ?, 'thread.status')`,
        )
        .run(value.scope.tenantId, value.scope.principalId, client.id);
      expect(() =>
        value.database
          .prepare(
            `UPDATE principal_agent_tool_clients
             SET enabled = 0, default_environment_id = NULL,
               credential_verifier = NULL, revoked_at = 200, updated_at = 200
             WHERE id = ?`,
          )
          .run(client.id),
      ).toThrow();
      value.database.transaction(() => {
        value.database
          .prepare(
            `DELETE FROM principal_agent_tool_client_entries
             WHERE client_id = ?`,
          )
          .run(client.id);
        value.database
          .prepare(
            `DELETE FROM principal_agent_tool_client_environments
             WHERE client_id = ?`,
          )
          .run(client.id);
        value.database
          .prepare(
            `UPDATE principal_agent_tool_clients
             SET enabled = 0, default_environment_id = NULL,
               credential_verifier = NULL, revoked_at = 200, updated_at = 200
             WHERE id = ?`,
          )
          .run(client.id);
      }).immediate();
      expect(() =>
        value.database
          .prepare(
            `INSERT INTO principal_agent_tool_client_environments(
               tenant_id, owner_principal_id, client_id, environment_id
             ) VALUES (?, ?, ?, ?)`,
          )
          .run(
            value.scope.tenantId,
            value.scope.principalId,
            client.id,
            client.environmentId,
          ),
      ).toThrow();
      expect(() =>
        value.database
          .prepare(
            `UPDATE principal_agent_tool_clients
             SET revoked_at = NULL, credential_verifier = ?,
               default_environment_id = ?, enabled = 1
             WHERE id = ?`,
          )
          .run(Buffer.alloc(32), client.environmentId, client.id),
      ).toThrow();
    } finally {
      value.database.close();
    }
  });

  it("enforces exact entry bounds and duplicate-free policy sets", () => {
    const value = savedAgentDatabase();
    try {
      const client = insertClient(value.database, value.scope);
      const insert = value.database.prepare(
        `INSERT INTO principal_agent_tool_client_entries(
           tenant_id, owner_principal_id, client_id, tool_id
         ) VALUES (?, ?, ?, ?)`,
      );
      for (let index = 0; index < 256; index += 1) {
        insert.run(
          value.scope.tenantId,
          value.scope.principalId,
          client.id,
          `tool.${index}`,
        );
      }
      expect(() =>
        insert.run(
          value.scope.tenantId,
          value.scope.principalId,
          client.id,
          "tool.overflow",
        ),
      ).toThrow();
      expect(() =>
        insert.run(
          value.scope.tenantId,
          value.scope.principalId,
          client.id,
          "tool.1",
        ),
      ).toThrow();
    } finally {
      value.database.close();
    }
  });

  it("enforces live, retained, and environment-entry bounds", () => {
    const live = savedAgentDatabase();
    try {
      for (let index = 0; index < 64; index += 1) {
        insertClient(live.database, live.scope, { name: `Live client ${index}` });
      }
      expect(() => insertClient(live.database, live.scope)).toThrow(
        "Principal agent-tool client limit exceeded",
      );
    } finally {
      live.database.close();
    }

    const retained = savedAgentDatabase();
    try {
      const insertRevoked = retained.database.prepare(
        `INSERT INTO principal_agent_tool_clients(
           tenant_id, owner_principal_id, id, creation_request_id, name,
           enabled, default_environment_id, policy_revision,
           credential_generation, credential_verifier, created_at, updated_at,
           revoked_at
         ) VALUES (?, ?, ?, ?, 'Retained client', 0, NULL, 1, 1, NULL,
           100, 100, 100)`,
      );
      for (let index = 0; index < 1_024; index += 1) {
        insertRevoked.run(
          retained.scope.tenantId,
          retained.scope.principalId,
          randomUUID(),
          randomUUID(),
        );
      }
      expect(() =>
        insertRevoked.run(
          retained.scope.tenantId,
          retained.scope.principalId,
          randomUUID(),
          randomUUID(),
        ),
      ).toThrow("Principal agent-tool client limit exceeded");
    } finally {
      retained.database.close();
    }

    const environments = savedAgentDatabase();
    try {
      const client = insertClient(environments.database, environments.scope);
      const insertEnvironment = environments.database.prepare(
        `INSERT INTO execution_environments(
           tenant_id, owner_principal_id, id, kind, label, availability,
           diagnostic_code, revision, configuration_revision,
           configuration_fingerprint, created_at, updated_at,
           operations_configuration_revision,
           operations_configuration_fingerprint
         ) VALUES (?, ?, ?, 'ssh', ?, 'available', NULL, 0, 0, ?,
           100, 100, 0, ?)`,
      );
      const addEnvironment = environments.database.prepare(
        `INSERT INTO principal_agent_tool_client_environments(
           tenant_id, owner_principal_id, client_id, environment_id
         ) VALUES (?, ?, ?, ?)`,
      );
      const extraEnvironmentIds = Array.from({ length: 16 }, (_, index) => {
        const environmentId = randomUUID();
        insertEnvironment.run(
          environments.scope.tenantId,
          environments.scope.principalId,
          environmentId,
          `Remote ${index}`,
          `${index.toString(16).padStart(64, "0")}`,
          `${(index + 1).toString(16).padStart(64, "0")}`,
        );
        return environmentId;
      });
      for (const environmentId of extraEnvironmentIds.slice(0, 15)) {
        addEnvironment.run(
          environments.scope.tenantId,
          environments.scope.principalId,
          client.id,
          environmentId,
        );
      }
      expect(() =>
        addEnvironment.run(
          environments.scope.tenantId,
          environments.scope.principalId,
          client.id,
          extraEnvironmentIds[15],
        ),
      ).toThrow("Principal agent-tool client environment policy is invalid");
    } finally {
      environments.database.close();
    }
  });
});
