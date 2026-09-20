import { describe, expect, it } from "vitest";
import { SavedAgentRepository } from "../../src/server/db/repositories/saved-agent-repository.js";
import type { DomainError } from "../../src/server/domain/errors.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const backendTypeId = "pi";

function errorCode(code: DomainError["code"]) {
  return expect.objectContaining({ code });
}

describe("SavedAgentRepository", () => {
  it("creates canonical rows, permits duplicate names, and pages deterministically", () => {
    const current = savedAgentDatabase();
    try {
      const repository = new SavedAgentRepository(current.database);
      const first = repository.create(current.scope, {
        name: "Same name",
        description: "First",
        backendTypeId,
        backendOverridesSchemaVersion: 3,
        backendOverrides: [
          { id: "thinking", value: "high" },
          { id: "model", value: "grok" },
        ],
        sedesTools: {
          enabled: true,
          enabledToolIds: ["thread.status", "agent.context"],
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "unrestricted",
        },
        now: 1_000,
      });
      const second = repository.create(current.scope, {
        name: "Same name",
        description: "Second",
        backendTypeId,
        backendOverridesSchemaVersion: 3,
        backendOverrides: [],
        sedesTools: null,
        now: 2_000,
      });
      expect(first.backendOverrides.map(({ id }) => id)).toEqual([
        "model",
        "thinking",
      ]);
      expect(first.sedesTools?.enabledToolIds).toEqual([
        "agent.context",
        "thread.status",
      ]);
      expect(first.sedesTools?.accessBoundary).toEqual("unrestricted");
      expect(
        current.database
          .prepare(
            `SELECT sedes_tools_json AS sedesToolsJson
             FROM saved_agents
             WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
          )
          .get(current.scope.tenantId, current.scope.principalId, first.id),
      ).toEqual({
        sedesToolsJson:
          '{"enabled":true,"enabledToolIds":["agent.context","thread.status"],"presentation":{"surface":"native","mode":"progressive"},"accessBoundary":"unrestricted"}',
      });
      const page = repository.listPage(current.scope, { pageSize: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBeDefined();
      const next = repository.listPage(current.scope, {
        pageSize: 1,
        cursor: page.nextCursor,
      });
      expect([page.items[0]!.id, next.items[0]!.id].sort()).toEqual(
        [first.id, second.id].sort(),
      );
      expect(() =>
        repository.listPage(current.scope, {
          pageSize: 2,
          cursor: page.nextCursor,
        }),
      ).toThrow(errorCode("cursor_invalid"));
    } finally {
      current.database.close();
    }
  });

  it("replaces nested values atomically and enforces revisioned update/delete", () => {
    const current = savedAgentDatabase();
    try {
      const repository = new SavedAgentRepository(current.database);
      const created = repository.create(current.scope, {
        name: "Reviewer",
        description: "Old",
        backendTypeId,
        backendOverridesSchemaVersion: 1,
        backendOverrides: [{ id: "model", value: "old" }],
        sedesTools: {
          enabled: false,
          enabledToolIds: [],
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "environment",
        },
        now: 1_000,
      });
      const updated = repository.update(current.scope, created.id, {
        expectedRevision: 0,
        description: "New",
        backendOverrides: {
          schemaVersion: 2,
          values: [{ id: "thinking", value: "low" }],
        },
        sedesTools: null,
        now: 2_000,
      });
      expect(updated).toMatchObject({
        description: "New",
        backendOverridesSchemaVersion: 2,
        backendOverrides: [{ id: "thinking", value: "low" }],
        sedesTools: null,
        revision: 1,
      });
      expect(() =>
        repository.update(current.scope, created.id, {
          expectedRevision: 0,
          name: "Stale",
          now: 3_000,
        }),
      ).toThrow(errorCode("conflict"));
      expect(() =>
        repository.delete(current.scope, created.id, { expectedRevision: 0 }),
      ).toThrow(errorCode("conflict"));
      repository.delete(current.scope, created.id, { expectedRevision: 1 });
      expect(repository.find(current.scope, created.id)).toBeUndefined();
    } finally {
      current.database.close();
    }
  });

  it("rejects invalid timestamps and refuses to advance the maximum revision", () => {
    const current = savedAgentDatabase();
    try {
      const repository = new SavedAgentRepository(current.database);
      expect(() =>
        repository.create(current.scope, {
          name: "Invalid clock",
          description: "",
          backendTypeId,
          backendOverridesSchemaVersion: 1,
          backendOverrides: [],
          sedesTools: null,
          now: Number.MAX_SAFE_INTEGER,
        }),
      ).toThrow("saved_agent_timestamp_invalid");

      const created = repository.create(current.scope, {
        name: "Maximum revision",
        description: "",
        backendTypeId,
        backendOverridesSchemaVersion: 1,
        backendOverrides: [],
        sedesTools: null,
        now: 1_000,
      });
      current.database
        .prepare(
          "UPDATE saved_agents SET revision = ? WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?",
        )
        .run(
          Number.MAX_SAFE_INTEGER,
          current.scope.tenantId,
          current.scope.principalId,
          created.id,
        );
      expect(() =>
        repository.update(current.scope, created.id, {
          expectedRevision: Number.MAX_SAFE_INTEGER,
          name: "Cannot advance",
          now: 2_000,
        }),
      ).toThrow(errorCode("conflict"));
    } finally {
      current.database.close();
    }
  });

  it("does not enumerate another principal and fails closed on noncanonical durable state", () => {
    const current = savedAgentDatabase();
    try {
      const repository = new SavedAgentRepository(current.database);
      const created = repository.create(current.scope, {
        name: "Scoped",
        description: "",
        backendTypeId,
        backendOverridesSchemaVersion: 1,
        backendOverrides: [{ id: "model", value: "one" }],
        sedesTools: null,
        now: 1_000,
      });
      const foreignScope = {
        tenantId: current.scope.tenantId,
        principalId: "foreign-principal",
      };
      current.database
        .prepare(
          "INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', ?)",
        )
        .run(foreignScope.tenantId, foreignScope.principalId, 1_000);
      expect(repository.find(foreignScope, created.id)).toBeUndefined();
      expect(() => repository.get(foreignScope, created.id)).toThrow(
        errorCode("not_found"),
      );

      current.database
        .prepare(
          "UPDATE saved_agents SET backend_overrides_json = ? WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?",
        )
        .run(
          '[ {"id":"model","value":"one"} ]',
          current.scope.tenantId,
          current.scope.principalId,
          created.id,
        );
      expect(() => repository.get(current.scope, created.id)).toThrow(
        "saved_agent_durable_state_invalid",
      );
    } finally {
      current.database.close();
    }
  });
});
