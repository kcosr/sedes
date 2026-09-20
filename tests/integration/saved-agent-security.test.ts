import { describe, expect, it } from "vitest";
import { SavedAgentBackendAdapterRegistry } from "../../src/server/backends/saved-agent-adapter-registry.js";
import type { SavedAgentBackendAdapter } from "../../src/server/backends/saved-agent-adapter.js";
import { SavedAgentRepository } from "../../src/server/db/repositories/saved-agent-repository.js";
import type { DomainError } from "../../src/server/domain/errors.js";
import { SavedAgentService } from "../../src/server/domain/saved-agent-service.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const sharedAgentId = "11111111-1111-4111-8111-111111111111";

function domainError(code: DomainError["code"]) {
  return expect.objectContaining<Partial<DomainError>>({ code });
}

function addPrincipal(
  database: ReturnType<typeof savedAgentDatabase>["database"],
  input: RequestScope,
): void {
  database
    .prepare("INSERT OR IGNORE INTO tenants(id, created_at) VALUES (?, ?)")
    .run(input.tenantId, 1_000);
  database
    .prepare(
      "INSERT INTO principals(tenant_id, id, kind, created_at) VALUES (?, ?, 'local_human', ?)",
    )
    .run(input.tenantId, input.principalId, 1_000);
}

function createScopedAgent(
  repository: SavedAgentRepository,
  scope: RequestScope,
  name: string,
) {
  return repository.create(scope, {
    id: sharedAgentId,
    name,
    description: "",
    backendTypeId: "pi",
    backendOverridesSchemaVersion: 1,
    backendOverrides: [{ id: "model", value: "grok" }],
    sedesTools: null,
    now: 1_000,
  });
}

function strictAdapter(): SavedAgentBackendAdapter {
  return {
    typeId: "pi",
    backendKind: "pi",
    overrideSchemaVersion: 1,
    presentation: { typeId: "pi", label: { text: "Pi" }, brand: "pi" },
    validateOverrides({ overrides }) {
      if (overrides.some(({ id }) => id !== "model")) {
        throw new Error("test_saved_agent_override_invalid");
      }
      return {
        backendTypeId: "pi",
        schemaVersion: 1,
        overrides: [...overrides],
      };
    },
    prepareResolutionContext() {
      throw new Error("not_used");
    },
    describeEditor() {
      throw new Error("not_used");
    },
    resolve() {
      throw new Error("not_used");
    },
    captureThreadConfiguration() {
      throw new Error("not_used");
    },
    assertThreadConfigurationCapture() {
      throw new Error("not_used");
    },
    initializeNewThread() {
      throw new Error("not_used");
    },
  };
}

describe("SavedAgent security boundaries", () => {
  it("isolates identical Agent IDs across both principal and tenant scope", () => {
    const current = savedAgentDatabase();
    try {
      const repository = new SavedAgentRepository(current.database);
      const otherPrincipal = {
        tenantId: current.scope.tenantId,
        principalId: "other-principal",
      };
      const otherTenant = {
        tenantId: "other-tenant",
        principalId: current.scope.principalId,
      };
      const emptyPrincipal = {
        tenantId: current.scope.tenantId,
        principalId: "empty-principal",
      };
      for (const scope of [otherPrincipal, otherTenant, emptyPrincipal]) {
        addPrincipal(current.database, scope);
      }

      createScopedAgent(repository, current.scope, "Current scope");
      createScopedAgent(repository, otherPrincipal, "Other principal");
      createScopedAgent(repository, otherTenant, "Other tenant");

      expect(repository.get(current.scope, sharedAgentId).name).toBe(
        "Current scope",
      );
      expect(repository.get(otherPrincipal, sharedAgentId).name).toBe(
        "Other principal",
      );
      expect(repository.get(otherTenant, sharedAgentId).name).toBe(
        "Other tenant",
      );
      expect(repository.listPage(emptyPrincipal, { pageSize: 10 }).items).toEqual(
        [],
      );
      expect(() => repository.get(emptyPrincipal, sharedAgentId)).toThrow(
        domainError("not_found"),
      );
      expect(() =>
        repository.update(emptyPrincipal, sharedAgentId, {
          expectedRevision: 0,
          name: "Foreign mutation",
          now: 2_000,
        }),
      ).toThrow(domainError("not_found"));
      expect(() =>
        repository.delete(emptyPrincipal, sharedAgentId, {
          expectedRevision: 0,
        }),
      ).toThrow(domainError("not_found"));

      repository.update(current.scope, sharedAgentId, {
        expectedRevision: 0,
        name: "Updated current scope",
        now: 2_000,
      });
      expect(repository.get(otherPrincipal, sharedAgentId).name).toBe(
        "Other principal",
      );
      expect(repository.get(otherTenant, sharedAgentId).name).toBe(
        "Other tenant",
      );
    } finally {
      current.database.close();
    }
  });

  it("rejects semantic durable corruption before committing a metadata update", () => {
    const current = savedAgentDatabase();
    try {
      const repository = new SavedAgentRepository(current.database);
      const service = new SavedAgentService(
        repository,
        new SavedAgentBackendAdapterRegistry([
          { backendInstanceId: "pi-primary", adapter: strictAdapter() },
        ]),
      );
      const created = service.create(
        current.scope,
        {
          name: "Valid before corruption",
          backendTypeId: "pi",
          backendOverrides: [{ id: "model", value: "grok" }],
        },
        1_000,
      );
      current.database
        .prepare(
          `UPDATE saved_agents
           SET backend_overrides_json = ?
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(
          '[{"id":"native_secret","value":"must-not-pass"}]',
          current.scope.tenantId,
          current.scope.principalId,
          created.id,
        );

      expect(() =>
        service.update(
          current.scope,
          created.id,
          { expectedRevision: 0, name: "Must not commit" },
          2_000,
        ),
      ).toThrow("test_saved_agent_override_invalid");
      expect(
        current.database
          .prepare(
            `SELECT name, revision, updated_at AS updatedAt
             FROM saved_agents
             WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
          )
          .get(current.scope.tenantId, current.scope.principalId, created.id),
      ).toEqual({
        name: "Valid before corruption",
        revision: 0,
        updatedAt: 1_000,
      });
    } finally {
      current.database.close();
    }
  });

  it("fails closed at revision and timestamp boundaries without mutating rows", () => {
    const current = savedAgentDatabase();
    try {
      const repository = new SavedAgentRepository(current.database);
      const created = createScopedAgent(repository, current.scope, "Bounded");
      current.database
        .prepare(
          `UPDATE saved_agents SET revision = ?
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
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
          name: "Overflow",
          now: 2_000,
        }),
      ).toThrow(domainError("conflict"));
      expect(repository.get(current.scope, created.id)).toMatchObject({
        name: "Bounded",
        revision: Number.MAX_SAFE_INTEGER,
      });

      expect(() =>
        current.database
          .prepare(
            `UPDATE saved_agents SET updated_at = ?
             WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
          )
          .run(
            8_640_000_000_000_001,
            current.scope.tenantId,
            current.scope.principalId,
            created.id,
          ),
      ).toThrow(
        /updated_at BETWEEN created_at AND 8640000000000000/u,
      );
    } finally {
      current.database.close();
    }
  });

  it("keeps immutable thread origin independent of the live Agent row", () => {
    const current = savedAgentDatabase();
    try {
      expect(
        current.database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'thread_saved_agent_origins'`,
          )
          .get(),
      ).toEqual({ name: "thread_saved_agent_origins" });
      expect(
        current.database
          .prepare(
            `SELECT "table", "from", "to"
             FROM pragma_foreign_key_list('thread_saved_agent_origins')
             WHERE "table" = 'saved_agents'`,
          )
          .all(),
      ).toEqual([]);
      expect(
        current.database
          .prepare(
            `SELECT "table", "from", "to"
             FROM pragma_foreign_key_list('application_threads')
             WHERE "table" = 'saved_agents'`,
          )
          .all(),
      ).toEqual([]);
    } finally {
      current.database.close();
    }
  });
});
