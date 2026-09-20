import { describe, expect, it } from "vitest";
import { GrokSavedAgentConfiguration } from "../../src/server/backends/grok/grok-saved-agent-configuration.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";

const connection = {
  id: "grok-connection",
  tenantId: "tenant-1",
  ownerPrincipalId: "principal-1",
  templateId: "grok-target",
  kind: "grok_acp" as const,
  backendInstanceId: "grok-backend",
  executionEnvironmentId: "environment-1",
  label: "Grok",
  enabled: true,
  configurationRevision: 0,
};

const catalog = {
  models: [
    {
      provider: connection.id,
      id: "grok-build",
      label: "Grok Build",
      inputModalities: ["text" as const],
      isDefault: true as const,
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
    },
    {
      provider: connection.id,
      id: "grok-fast",
      label: "Grok Fast",
      inputModalities: ["text" as const],
      supportedReasoningEfforts: ["low"],
      defaultReasoningEffort: "low",
    },
  ],
  commands: [],
  skills: [],
  notices: [],
};

const defaults = {
  model: { type: "catalogDefault" as const },
  reasoningEffort: { type: "modelDefault" as const },
};

describe("Grok Saved Agent configuration", () => {
  it("describes and resolves normalized model and effort overrides", () => {
    const configuration = new GrokSavedAgentConfiguration(
      compileBackendModelPolicy({ type: "catalog" }, "model_effort"),
    );
    expect(
      configuration.describe({ connection, catalog, defaults, overrides: [] }),
    ).toMatchObject([
      { id: "model", resolvedValue: "grok-build" },
      { id: "reasoning_effort", resolvedValue: "low" },
    ]);
    expect(
      configuration.resolve({
        connection,
        catalog,
        defaults,
        overrides: [
          { id: "model", value: "grok-fast" },
          { id: "reasoning_effort", value: "low" },
        ],
      }).settings,
    ).toEqual({ model: "grok-fast", effort: "low" });
  });

  it("fails closed when an override is filtered by installation policy", () => {
    const configuration = new GrokSavedAgentConfiguration(
      compileBackendModelPolicy(
        {
          type: "allowlist",
          allowed: [{ modelIds: ["grok-build"], reasoningEfforts: ["low"] }],
        },
        "model_effort",
      ),
    );
    expect(() =>
      configuration.resolve({
        connection,
        catalog,
        defaults,
        overrides: [
          { id: "model", value: "grok-fast" },
          { id: "reasoning_effort", value: "low" },
        ],
      }),
    ).toThrow(/configuration is unavailable/u);
    expect(
      configuration.describe({
        connection,
        catalog,
        defaults,
        overrides: [],
      })[0]?.options,
    ).toEqual([{ value: "grok-build", label: "Grok Build", available: true }]);
  });
});
