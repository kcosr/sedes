import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ClaudeBackendThreadPersistenceAdapter } from "../../src/server/backends/claude/claude-backend-thread-persistence-adapter.js";
import { ClaudeSavedAgentBackendAdapter } from "../../src/server/backends/claude/claude-saved-agent-adapter.js";
import { ClaudeSavedAgentConfiguration } from "../../src/server/backends/claude/claude-saved-agent-configuration.js";
import type { AgentConnectionProfile } from "../../src/server/backends/contracts.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { ConversationCreationTransaction } from "../../src/server/backends/saved-agent-adapter.js";

const connection: AgentConnectionProfile = {
  id: "claude-connection",
  tenantId: "tenant",
  ownerPrincipalId: "principal",
  templateId: "claude-template",
  kind: "claude_agent_sdk",
  backendInstanceId: "claude-backend",
  executionEnvironmentId: "environment",
  label: "Claude",
  enabled: true,
  configurationRevision: 0,
};

const catalog = {
  models: [
    {
      provider: connection.id,
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      inputModalities: ["text"] as const,
      isDefault: true as const,
      supportedReasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "high",
    },
  ],
  commands: [],
  skills: [],
  notices: [],
};

describe("Claude SavedAgent configuration", () => {
  it("resolves canonical model and effort overrides", () => {
    const configuration = configurationWithModes([
      "default",
      "acceptEdits",
      "dontAsk",
    ]);
    const result = configuration.resolve({
      connection,
      catalog,
      defaults: {
        model: "claude-sonnet-5",
        effort: "high",
        permissionMode: "default",
      },
      overrides: [
        { id: "reasoning_effort", value: "low" },
        { id: "permission_mode", value: "acceptEdits" },
      ],
    });
    expect(result.settings).toEqual({
      model: "claude-sonnet-5",
      effort: "low",
      permissionMode: "acceptEdits",
    });
    expect(result.fields.map(({ id }) => id)).toEqual([
      "model",
      "reasoning_effort",
      "permission_mode",
    ]);
    expect(result.fields[2]).toMatchObject({
      defaultValue: "default",
      resolvedValue: "acceptEdits",
      options: [
        { value: "default", available: true },
        { value: "acceptEdits", available: true },
        { value: "dontAsk", available: true },
        { value: "auto", available: false },
        { value: "bypassPermissions", available: false },
      ],
    });
  });

  it("rejects unsupported, duplicate, or unavailable overrides", () => {
    const configuration = configurationWithModes(["default"]);
    expect(() =>
      configuration.validateOverrides([
        { id: "model", value: "claude-sonnet-5" },
        { id: "model", value: "claude-sonnet-5" },
      ]),
    ).toThrow(/invalid/i);
    expect(() =>
      configuration.resolve({
        connection,
        catalog,
        defaults: { permissionMode: "default" },
        overrides: [{ id: "reasoning_effort", value: "max" }],
      }),
    ).toThrow(/unavailable/i);
    expect(() =>
      configuration.validateOverrides([
        { id: "permission_mode", value: "plan" },
      ]),
    ).toThrow(/invalid/i);
    expect(() =>
      configuration.resolve({
        connection,
        catalog,
        defaults: { permissionMode: "default" },
        overrides: [{ id: "permission_mode", value: "acceptEdits" }],
      }),
    ).toThrow(/unavailable/i);
    expect(() =>
      configurationWithModes(["acceptEdits"]).resolve({
        connection,
        catalog,
        defaults: { permissionMode: "default" },
        overrides: [],
      }),
    ).toThrow(/default Claude permission mode is unavailable/i);
  });

  it("treats allowlisted bypass as an ordinary explicit override", () => {
    const result = configurationWithModes([
      "default",
      "bypassPermissions",
    ]).resolve({
      connection,
      catalog,
      defaults: { permissionMode: "default" },
      overrides: [{ id: "permission_mode", value: "bypassPermissions" }],
    });

    expect(result.settings.permissionMode).toBe("bypassPermissions");
    expect(result.fields[2]).toMatchObject({
      resolvedValue: "bypassPermissions",
    });
  });

  it("resolves an effortless model without fabricating an effort override", () => {
    const effortlessCatalog = {
      ...catalog,
      models: [
        {
          provider: connection.id,
          id: "claude-haiku-4-5",
          label: "Haiku",
          inputModalities: ["text"] as const,
          isDefault: true as const,
        },
      ],
    };
    const result = configurationWithModes(["default"]).resolve({
      connection,
      catalog: effortlessCatalog,
      defaults: { permissionMode: "default" },
      overrides: [],
    });

    expect(result.settings).toEqual({
      model: "claude-haiku-4-5",
      effort: null,
      permissionMode: "default",
    });
    expect(result.fields[1]).toMatchObject({
      resolvedValue: null,
      options: [],
    });
  });

  it("repairs a stale default with an explicit admitted model and effort tuple", () => {
    const configuration = new ClaudeSavedAgentConfiguration({
      permissionPolicy: { allowedModes: ["default"] },
      modelPolicy: compileBackendModelPolicy(
        {
          type: "allowlist",
          allowed: [
            {
              modelIds: ["claude-sonnet-5"],
              reasoningEfforts: ["low"],
            },
          ],
        },
        "model_effort",
      ),
    });

    expect(
      configuration.resolve({
        connection,
        catalog: {
          ...catalog,
          models: [
            {
              ...catalog.models[0]!,
              isDefault: undefined,
              supportedReasoningEfforts: ["low"],
              defaultReasoningEffort: undefined,
            },
          ],
        },
        defaults: {
          model: "stale-model",
          effort: "high",
          permissionMode: "default",
        },
        overrides: [
          { id: "model", value: "claude-sonnet-5" },
          { id: "reasoning_effort", value: "low" },
        ],
      }).settings,
    ).toEqual({
      model: "claude-sonnet-5",
      effort: "low",
      permissionMode: "default",
    });
  });

  it("captures and revision-fences the complete desired Claude tuple", () => {
    const database = new Database(":memory:");
    let settings = {
      tenantId: connection.tenantId,
      ownerPrincipalId: connection.ownerPrincipalId,
      applicationThreadId: "thread-source",
      backendInstanceId: connection.backendInstanceId,
      connectionProfileId: connection.id,
      executionEnvironmentId: connection.executionEnvironmentId,
      model: "claude-sonnet-5",
      effort: "medium",
      permissionMode: "acceptEdits" as const,
      effectiveModel: null,
      effectiveModelState: "unconfirmed" as const,
      effectiveModelGeneration: null,
      effectiveEffort: null,
      effectiveEffortState: "unconfirmed" as const,
      effectiveEffortGeneration: null,
      effectivePermissionMode: null,
      effectivePermissionClassification: null,
      effectivePermissionState: "unconfirmed" as const,
      effectivePermissionGeneration: null,
      revision: 4,
      createdAt: 1,
      updatedAt: 1,
    };
    const persistence = {
      database,
      readDesiredSettings: () => settings,
    } as unknown as ClaudeBackendThreadPersistenceAdapter;
    const adapter = new ClaudeSavedAgentBackendAdapter({
      persistence,
      permissionPolicy: { allowedModes: ["default", "acceptEdits"] },
      modelPolicy: compileBackendModelPolicy(
        { type: "catalog" },
        "model_effort",
      ),
      resolveConnectionDefaults: () => ({ permissionMode: "default" }),
    });
    try {
      const capture = adapter.captureThreadConfiguration({
        scope: {
          tenantId: connection.tenantId,
          principalId: connection.ownerPrincipalId,
        },
        applicationThreadId: "thread-source",
        connection,
      });
      expect(capture).toEqual({
        backendTypeId: "claude",
        schemaVersion: 2,
        settingsRevision: 4,
        overrides: [
          { id: "model", value: "claude-sonnet-5" },
          { id: "permission_mode", value: "acceptEdits" },
          { id: "reasoning_effort", value: "medium" },
        ],
      });
      expect(() =>
        database.transaction(() =>
          adapter.assertThreadConfigurationCapture({
            transaction:
              ConversationCreationTransaction.fromActiveDatabase(database),
            scope: {
              tenantId: connection.tenantId,
              principalId: connection.ownerPrincipalId,
            },
            applicationThreadId: "thread-source",
            connection,
            capture,
          }),
        )(),
      ).not.toThrow();
      settings = { ...settings, revision: 5 };
      expect(() =>
        database.transaction(() =>
          adapter.assertThreadConfigurationCapture({
            transaction:
              ConversationCreationTransaction.fromActiveDatabase(database),
            scope: {
              tenantId: connection.tenantId,
              principalId: connection.ownerPrincipalId,
            },
            applicationThreadId: "thread-source",
            connection,
            capture,
          }),
        )(),
      ).toThrow("source Claude settings changed");
      settings = { ...settings, model: null as never };
      expect(() =>
        adapter.captureThreadConfiguration({
          scope: {
            tenantId: connection.tenantId,
            principalId: connection.ownerPrincipalId,
          },
          applicationThreadId: "thread-source",
          connection,
        }),
      ).toThrow("Choose complete Claude settings");
    } finally {
      database.close();
    }
  });
});

function configurationWithModes(
  allowedModes: readonly (
    "default" | "acceptEdits" | "dontAsk" | "auto" | "bypassPermissions"
  )[],
): ClaudeSavedAgentConfiguration {
  return new ClaudeSavedAgentConfiguration({
    permissionPolicy: { allowedModes },
    modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "model_effort"),
  });
}
