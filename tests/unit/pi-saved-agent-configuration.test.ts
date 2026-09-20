import { describe, expect, it, vi } from "vitest";
import type { AgentConnectionProfile } from "../../src/server/backends/contracts.js";
import {
  PiSavedAgentConfiguration,
  type PiSavedAgentResolutionContext,
} from "../../src/server/backends/pi/pi-saved-agent-configuration.js";
import { encodePiModelSetting } from "../../src/server/backends/pi/pi-thread-presentation-provider.js";
import type { ConnectionSettingPreferenceRepository } from "../../src/server/db/repositories/connection-setting-preference-repository.js";

const scope = Object.freeze({ tenantId: "tenant", principalId: "principal" });
const connection: AgentConnectionProfile = Object.freeze({
  id: "pi-target",
  tenantId: scope.tenantId,
  ownerPrincipalId: scope.principalId,
  templateId: "pi-template",
  kind: "pi_sdk",
  backendInstanceId: "pi-backend",
  executionEnvironmentId: "local",
  label: "Pi",
  enabled: true,
  configurationRevision: 1,
});
const catalog = Object.freeze({
  models: Object.freeze([
    Object.freeze({
      provider: "xai",
      id: "grok-4.5",
      label: "xAI / Grok 4.5",
      inputModalities: Object.freeze(["text"] as const),
      supportedReasoningEfforts: Object.freeze(["off", "low", "high"]),
    }),
    Object.freeze({
      provider: "anthropic",
      id: "claude-test",
      label: "Anthropic / Claude Test",
      inputModalities: Object.freeze(["text"] as const),
      supportedReasoningEfforts: Object.freeze(["off", "medium"]),
    }),
  ]),
  commands: Object.freeze([]),
  skills: Object.freeze([]),
  notices: Object.freeze([]),
});

function configuration(
  values: Partial<Record<"model" | "thinking_level", string>> = {},
): PiSavedAgentConfiguration {
  const find = vi.fn(
    (
      receivedScope: typeof scope,
      connectionProfileId: string,
      settingId: "model" | "thinking_level" | "tool_access",
    ) => {
      expect(receivedScope).toEqual(scope);
      expect(connectionProfileId).toBe(connection.id);
      const value = values[settingId as keyof typeof values];
      return value === undefined ? undefined : { value, revision: 3 };
    },
  );
  return new PiSavedAgentConfiguration({
    find,
  } as unknown as ConnectionSettingPreferenceRepository);
}

describe("Pi SavedAgent configuration", () => {
  it("preloads principal-scoped connection preferences outside pure resolution", () => {
    const model = encodePiModelSetting("xai", "grok-4.5");
    expect(
      configuration({ model, thinking_level: "low" }).prepare(
        scope,
        connection,
      ),
    ).toEqual({
      modelPreference: { value: model, revision: 3 },
      thinkingLevelPreference: { value: "low", revision: 3 },
    });
  });

  it("canonicalizes the closed sparse override set", () => {
    const target = configuration();
    expect(
      target.validateOverrides([
        { id: "tool_access", value: "ask" },
        { id: "model", value: encodePiModelSetting("xai", "grok-4.5") },
      ]),
    ).toEqual([
      { id: "model", value: encodePiModelSetting("xai", "grok-4.5") },
      { id: "tool_access", value: "ask" },
    ]);
    expect(() =>
      target.validateOverrides([
        { id: "tool_access", value: "ask" },
        { id: "tool_access", value: "full" },
      ]),
    ).toThrow("overrides are invalid");
    expect(() =>
      target.validateOverrides([{ id: "provider", value: "xai" }]),
    ).toThrow("overrides are invalid");
  });

  it("inherits valid preferences and produces a complete resolved preview", () => {
    const model = encodePiModelSetting("xai", "grok-4.5");
    const target = configuration({ model, thinking_level: "low" });
    const context = target.prepare(scope, connection);

    expect(
      target.resolve({
        scope,
        connection,
        catalog,
        context,
        overrides: [],
      }),
    ).toMatchObject({
      model: { provider: "xai", id: "grok-4.5" },
      thinkingLevel: "low",
      toolAccess: "full",
      fields: [
        { id: "model", defaultValue: model, resolvedValue: model },
        {
          id: "thinking_level",
          defaultValue: "low",
          resolvedValue: "low",
        },
        {
          id: "tool_access",
          defaultValue: "full",
          resolvedValue: "full",
        },
      ],
    });
  });

  it("applies explicit model, thinking, and provider tool-access overrides once", () => {
    const target = configuration({
      model: encodePiModelSetting("xai", "grok-4.5"),
      thinking_level: "high",
    });
    const resolved = target.resolve({
      scope,
      connection,
      catalog,
      context: target.prepare(scope, connection),
      overrides: [
        {
          id: "model",
          value: encodePiModelSetting("anthropic", "claude-test"),
        },
        { id: "thinking_level", value: "medium" },
        { id: "tool_access", value: "read_only" },
      ],
    });

    expect(resolved).toMatchObject({
      model: { provider: "anthropic", id: "claude-test" },
      thinkingLevel: "medium",
      toolAccess: "read_only",
    });
    expect(
      resolved.fields
        .find(({ id }) => id === "thinking_level")
        ?.options.find(({ value }) => value === "high"),
    ).toMatchObject({ available: false });
  });

  it("fails closed for incomplete defaults or unsupported explicit values", () => {
    const target = configuration();
    const context: PiSavedAgentResolutionContext = {
      modelPreference: null,
      thinkingLevelPreference: null,
    };
    expect(() =>
      target.resolve({ scope, connection, catalog, context, overrides: [] }),
    ).toThrow("has no available saved model preference");

    expect(() =>
      target.resolve({
        scope,
        connection,
        catalog,
        context,
        overrides: [
          { id: "model", value: encodePiModelSetting("xai", "grok-4.5") },
          { id: "thinking_level", value: "max" },
        ],
      }),
    ).toThrow("thinking level is unavailable");
  });

  it("describes model choices when an incomplete target has no saved model preference", () => {
    const target = configuration();
    const projected = target.describe({
      scope,
      connection,
      catalog,
      context: {
        modelPreference: null,
        thinkingLevelPreference: null,
      },
      overrides: [],
    });

    expect(projected).not.toHaveProperty("model");
    expect(projected.fields).toMatchObject([
      {
        id: "model",
        defaultValue: null,
        resolvedValue: null,
        options: [
          { label: "xAI / Grok 4.5", available: true },
          { label: "Anthropic / Claude Test", available: true },
        ],
      },
      {
        id: "thinking_level",
        defaultValue: null,
        resolvedValue: null,
      },
      {
        id: "tool_access",
        defaultValue: "full",
        resolvedValue: "full",
      },
    ]);
    expect(
      projected.fields
        .find(({ id }) => id === "thinking_level")
        ?.options.every(({ available }) => available),
    ).toBe(true);
  });

  it("ignores a stale inherited thinking preference without discarding explicit values", () => {
    const target = configuration({
      model: encodePiModelSetting("anthropic", "claude-test"),
      thinking_level: "high",
    });
    const prepared = {
      scope,
      connection,
      catalog,
      context: target.prepare(scope, connection),
      overrides: [],
    };
    expect(
      target.describe(prepared),
    ).not.toHaveProperty("thinkingLevel");
    expect(() =>
      target.resolve({
        ...prepared,
      }),
    ).toThrow("Choose a Pi thinking level");
  });
});
