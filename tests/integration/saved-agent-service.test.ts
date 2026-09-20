import { describe, expect, it } from "vitest";
import type { SavedAgentBackendAdapter } from "../../src/server/backends/saved-agent-adapter.js";
import { SavedAgentBackendAdapterRegistry } from "../../src/server/backends/saved-agent-adapter-registry.js";
import { SavedAgentRepository } from "../../src/server/db/repositories/saved-agent-repository.js";
import { SavedAgentService } from "../../src/server/domain/saved-agent-service.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

function adapter(): SavedAgentBackendAdapter {
  return {
    typeId: "pi",
    backendKind: "pi",
    overrideSchemaVersion: 7,
    presentation: { typeId: "pi", label: { text: "Pi" }, brand: "pi" },
    validateOverrides({ overrides }) {
      for (const override of overrides) {
        if (!(["model", "thinking"] as const).includes(override.id as never)) {
          throw new Error("test_override_invalid");
        }
      }
      return {
        backendTypeId: "pi",
        schemaVersion: 7,
        overrides: [...overrides].sort((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
        ),
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

describe("SavedAgentService", () => {
  it("registers runtime-bound adapters per backend instance with one stable type contract", () => {
    const first = adapter();
    const second = adapter();
    const registry = new SavedAgentBackendAdapterRegistry([
      { backendInstanceId: "pi-primary", adapter: first },
      { backendInstanceId: "pi-secondary", adapter: second },
    ]);

    expect(registry.list()).toEqual([first]);
    expect(registry.requireByTypeId("pi")).toBe(first);
    expect(registry.requireByBackendInstanceId("pi-primary")).toBe(first);
    expect(registry.requireByBackendInstanceId("pi-secondary")).toBe(second);

    const conflicting = adapter();
    Object.defineProperty(conflicting, "overrideSchemaVersion", { value: 8 });
    expect(
      () =>
        new SavedAgentBackendAdapterRegistry([
          { backendInstanceId: "pi-primary", adapter: first },
          { backendInstanceId: "pi-secondary", adapter: conflicting },
        ]),
    ).toThrow("saved_agent_backend_type_contract_conflict");
  });

  it("stamps backend schema metadata and presents stable type identity", () => {
    const current = savedAgentDatabase();
    try {
      const repository = new SavedAgentRepository(current.database);
      const service = new SavedAgentService(
        repository,
        new SavedAgentBackendAdapterRegistry([
          { backendInstanceId: "pi-primary", adapter: adapter() },
        ]),
      );
      const created = service.create(
        current.scope,
        {
          name: "Careful reviewer",
          backendTypeId: "pi",
          backendOverrides: [
            { id: "thinking", value: "high" },
            { id: "model", value: "grok" },
          ],
        },
        1_000,
      );
      expect(created).toMatchObject({
        backendTypeId: "pi",
        backend: { typeId: "pi", label: { text: "Pi" }, brand: "pi" },
        backendOverrides: [
          { id: "model", value: "grok" },
          { id: "thinking", value: "high" },
        ],
        revision: 0,
      });
      expect(repository.get(current.scope, created.id)).toMatchObject({
        backendOverridesSchemaVersion: 7,
      });
      expect(service.list(current.scope).items[0]).toMatchObject({
        id: created.id,
        overrideCount: 2,
        backend: { brand: "pi" },
      });
    } finally {
      current.database.close();
    }
  });

  it("uses whole replacements, permits metadata repair, and enforces CAS delete", () => {
    const current = savedAgentDatabase();
    try {
      const repository = new SavedAgentRepository(current.database);
      const service = new SavedAgentService(
        repository,
        new SavedAgentBackendAdapterRegistry([
          { backendInstanceId: "pi-primary", adapter: adapter() },
        ]),
      );
      const created = service.create(
        current.scope,
        {
          name: "Agent",
          description: "Description",
          backendTypeId: "pi",
          backendOverrides: [{ id: "model", value: "one" }],
          sedesTools: {
            enabled: true,
            enabledToolIds: ["thread.status"],
            presentation: { surface: "native", mode: "progressive" },
            accessBoundary: "unrestricted",
          },
        },
        1_000,
      );
      const updated = service.update(
        current.scope,
        created.id,
        {
          expectedRevision: 0,
          description: null,
          backendOverrides: [{ id: "thinking", value: "low" }],
          sedesTools: null,
        },
        2_000,
      );
      expect(updated.description).toBeUndefined();
      expect(updated.backendOverrides).toEqual([
        { id: "thinking", value: "low" },
      ]);
      expect(updated.sedesTools).toBeUndefined();
      expect(() => service.delete(current.scope, created.id, 0)).toThrow();
      expect(service.delete(current.scope, created.id, 1)).toEqual({
        deleted: true,
        agentId: created.id,
      });
    } finally {
      current.database.close();
    }
  });

  it("fails closed for unsupported backend types and schema-version drift", () => {
    const current = savedAgentDatabase();
    try {
      const repository = new SavedAgentRepository(current.database);
      const service = new SavedAgentService(
        repository,
        new SavedAgentBackendAdapterRegistry([
          { backendInstanceId: "pi-primary", adapter: adapter() },
        ]),
      );
      expect(() =>
        service.create(current.scope, {
          name: "Missing",
          backendTypeId: "unknown",
          backendOverrides: [],
        }),
      ).toThrow();
      const created = service.create(current.scope, {
        name: "Versioned",
        backendTypeId: "pi",
        backendOverrides: [],
      });
      current.database
        .prepare(
          "UPDATE saved_agents SET backend_overrides_schema_version = 6 WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?",
        )
        .run(current.scope.tenantId, current.scope.principalId, created.id);
      expect(() => service.get(current.scope, created.id)).toThrow(
        "saved_agent_backend_schema_version_unsupported",
      );
    } finally {
      current.database.close();
    }
  });
});
