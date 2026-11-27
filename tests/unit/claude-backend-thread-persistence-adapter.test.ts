import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type {
  AgentConnectionProfile,
  BackendCatalog,
} from "../../src/server/backends/contracts.js";
import { ClaudeBackendThreadPersistenceAdapter, resolveDesiredSettings } from "../../src/server/backends/claude/claude-backend-thread-persistence-adapter.js";

const connection: AgentConnectionProfile = {
  id: "claude-local",
  tenantId: "tenant-a",
  ownerPrincipalId: "principal-a",
  templateId: "claude-local",
  kind: "claude_agent_sdk",
  backendInstanceId: "claude-backend",
  executionEnvironmentId: "local",
  label: "Claude Local",
  enabled: true,
  configurationRevision: 1,
};

function catalog(models: BackendCatalog["models"]): BackendCatalog {
  return { models, commands: [], skills: [], notices: [] };
}

describe("Claude desired thread settings", () => {
  it("leaves a new draft unresolved when policy filtering removes the default model", () => {
    expect(
      resolveDesiredSettings(
        connection,
        catalog([
          {
            provider: connection.id,
            id: "claude-opus-5",
            label: "Claude Opus 5",
            inputModalities: ["text"],
            supportedReasoningEfforts: ["high"],
            defaultReasoningEffort: "high",
          },
        ]),
        { permissionMode: "default" },
      ),
    ).toEqual({ model: null, effort: null, permissionMode: "default" });
  });

  it("leaves a new draft unresolved when the default effort is not admitted", () => {
    expect(
      resolveDesiredSettings(
        connection,
        catalog([
          {
            provider: connection.id,
            id: "claude-sonnet-5",
            label: "Claude Sonnet 5",
            inputModalities: ["text"],
            isDefault: true,
            supportedReasoningEfforts: ["low"],
          },
        ]),
        { permissionMode: "default" },
      ),
    ).toEqual({ model: null, effort: null, permissionMode: "default" });
  });

  it("resolves only an admitted authoritative default tuple", () => {
    expect(
      resolveDesiredSettings(
        connection,
        catalog([
          {
            provider: connection.id,
            id: "claude-sonnet-5",
            label: "Claude Sonnet 5",
            inputModalities: ["text"],
            isDefault: true,
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "high",
          },
        ]),
        { permissionMode: "default" },
      ),
    ).toEqual({
      model: "claude-sonnet-5",
      effort: "high",
      permissionMode: "default",
    });
  });

  it("resolves an authoritative default model with no effort axis", () => {
    expect(
      resolveDesiredSettings(
        connection,
        catalog([
          {
            provider: connection.id,
            id: "claude-haiku-4-5",
            label: "Haiku",
            inputModalities: ["text"],
            isDefault: true,
          },
        ]),
        { permissionMode: "default" },
      ),
    ).toEqual({
      model: "claude-haiku-4-5",
      effort: null,
      permissionMode: "default",
    });
  });
});

it("reads the manual title flag only for its own principal, tenant, backend, and thread", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`CREATE TABLE claude_thread_settings (
      tenant_id TEXT, owner_principal_id TEXT, application_thread_id TEXT, backend_instance_id TEXT,
      local_title_override INTEGER, PRIMARY KEY (tenant_id, owner_principal_id, application_thread_id)
    )`);
    const insert = database.prepare("INSERT INTO claude_thread_settings VALUES (?, ?, ?, ?, ?)");
    const owner = { tenantId: connection.tenantId, principalId: connection.ownerPrincipalId };
    const otherScopes = [{ ...owner, tenantId: "tenant-b" }, { ...owner, principalId: "principal-b" }];
    const adapter = (scope: typeof owner, backendInstanceId = connection.backendInstanceId) =>
      new ClaudeBackendThreadPersistenceAdapter({ database, scope, backendInstanceId, resolveConnectionDefaults: () => undefined });
    for (const scope of [owner, ...otherScopes]) {
      insert.run(scope.tenantId, scope.principalId, "manual", connection.backendInstanceId, 1);
    }
    insert.run(owner.tenantId, owner.principalId, "automatic", connection.backendInstanceId, 0);

    const persistence = adapter(owner);
    const targetMismatch = "The Claude connection does not match the thread target.";
    expect(persistence.preservesLocalTitle(owner, "automatic")).toBe(false);
    expect(persistence.preservesLocalTitle(owner, "manual")).toBe(true);
    for (const scope of otherScopes) {
      expect(() => persistence.preservesLocalTitle(scope, "manual")).toThrow(targetMismatch);
      expect(() => adapter(scope).preservesLocalTitle(scope, "automatic")).toThrow(targetMismatch);
    }
    expect(() => adapter(owner, "claude-other").preservesLocalTitle(owner, "manual")).toThrow(targetMismatch);
    expect(() => persistence.preservesLocalTitle(owner, "missing")).toThrow(targetMismatch);
  } finally {
    database.close();
  }
});
