import { describe, expect, it } from "vitest";
import type {
  AgentConnectionProfile,
  BackendCatalog,
} from "../../src/server/backends/contracts.js";
import { CodexSavedAgentConfiguration } from "../../src/server/backends/codex/codex-saved-agent-configuration.js";
import {
  compileBackendModelPolicy,
  type BackendModelPolicy,
} from "../../src/server/backends/model-policy.js";
import type { CodexExecutionPolicyAllowlist } from "../../src/server/backends/codex/codex-execution-policy.js";

const connection = {
  id: "codex-target-a",
  tenantId: "tenant-a",
  ownerPrincipalId: "principal-a",
  templateId: "codex-template",
  kind: "codex_app_server",
  backendInstanceId: "codex-backend",
  executionEnvironmentId: "local",
  label: "Codex A",
  enabled: true,
  configurationRevision: 4,
} as const satisfies AgentConnectionProfile;

const catalog = {
  models: [
    {
      provider: connection.id,
      id: "gpt-default",
      label: "GPT Default",
      inputModalities: ["text"],
      isDefault: true,
      supportedReasoningEfforts: ["low", "medium"],
      defaultReasoningEffort: "medium",
    },
    {
      provider: connection.id,
      id: "gpt-fast",
      label: "GPT Fast",
      inputModalities: ["text"],
      supportedReasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
      fastMode: { supported: true, defaultSelection: "fast" },
    },
  ],
  commands: [],
  skills: [],
  notices: [],
} as const satisfies BackendCatalog;

const defaults = {
  model: { type: "catalogDefault" },
  sandboxMode: "read-only",
  networkAccess: "disabled",
  approvalPolicy: "on-request",
  approvalReviewer: "user",
} as const;

const executionPolicy = {
  allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"],
  allowedNetworkAccess: ["disabled", "enabled"],
  allowedApprovalPolicies: ["untrusted", "on-request", "never"],
  allowedApprovalReviewers: ["user", "auto_review"],
} as const;

function subject(
  input: {
    readonly modelPolicy?: BackendModelPolicy;
    readonly policy?: CodexExecutionPolicyAllowlist;
  } = {},
) {
  return new CodexSavedAgentConfiguration({
    executionPolicy: input.policy ?? executionPolicy,
    modelPolicy: compileBackendModelPolicy(
      input.modelPolicy ?? { type: "catalog" },
      "model_effort",
    ),
    resolveConnectionDefaults: (candidate) =>
      candidate.templateId === connection.templateId ? defaults : undefined,
  });
}

describe("Codex SavedAgent configuration", () => {
  it("repairs a denied advertised default with an explicit admitted effort", () => {
    const filteredCatalog: BackendCatalog = {
      models: [
        {
          provider: connection.id,
          id: "gpt-default",
          label: "GPT Default",
          inputModalities: ["text"],
          supportedReasoningEfforts: ["low"],
        },
      ],
      commands: [],
      skills: [],
      notices: [],
    };
    const resolved = subject({
      modelPolicy: {
        type: "allowlist",
        allowed: [
          { modelIds: ["gpt-default"], reasoningEfforts: ["low"] },
        ],
      },
    }).resolve({
      connection,
      catalog: filteredCatalog,
      overrides: [
        { id: "model", value: "gpt-default" },
        { id: "reasoning_effort", value: "low" },
      ],
    });
    expect(resolved.settings).toMatchObject({
      model: "gpt-default",
      reasoningEffort: "low",
    });
  });

  it("completes sparse overrides from target defaults and publishes descriptors", () => {
    const resolved = subject().resolve({
      connection,
      catalog,
      overrides: [
        { id: "network_access", value: "enabled" },
        { id: "approval_reviewer", value: "auto_review" },
      ],
    });

    expect(resolved).toMatchObject({
      model: { provider: connection.id, id: "gpt-default" },
      settings: {
        model: "gpt-default",
        reasoningEffort: "medium",
        serviceTier: "standard",
        sandboxMode: "read-only",
        networkAccess: "enabled",
        approvalPolicy: "on-request",
        approvalReviewer: "auto_review",
      },
    });
    expect(resolved.fields.map(({ id }) => id)).toEqual([
      "model",
      "reasoning_effort",
      "service_tier",
      "sandbox_mode",
      "network_access",
      "approval_policy",
      "approval_reviewer",
    ]);
    expect(resolved.fields.find(({ id }) => id === "model")).toMatchObject({
      defaultValue: "gpt-default",
      resolvedValue: "gpt-default",
    });
  });

  it("rebinds a portable model ID and derives dependent defaults on another target", () => {
    const otherConnection = { ...connection, id: "codex-target-b" };
    const otherCatalog: BackendCatalog = {
      ...catalog,
      models: catalog.models.map((model) => ({
        ...model,
        provider: otherConnection.id,
      })),
    };
    const resolved = subject().resolve({
      connection: otherConnection,
      catalog: otherCatalog,
      overrides: [{ id: "model", value: "gpt-fast" }],
    });

    expect(resolved.model).toEqual({
      provider: otherConnection.id,
      id: "gpt-fast",
    });
    expect(resolved.settings).toMatchObject({
      model: "gpt-fast",
      reasoningEffort: "low",
      serviceTier: "fast",
    });
  });

  it("rejects duplicate, unknown, catalog-invalid, and model-policy overrides", () => {
    expect(
      subject().validateOverrides([
        { id: "service_tier", value: "standard" },
        { id: "model", value: "gpt-default" },
        { id: "approval_policy", value: "never" },
      ]),
    ).toEqual([
      { id: "approval_policy", value: "never" },
      { id: "model", value: "gpt-default" },
      { id: "service_tier", value: "standard" },
    ]);
    expect(() =>
      subject().validateOverrides([
        { id: "model", value: "gpt-default" },
        { id: "model", value: "gpt-fast" },
      ]),
    ).toThrow(/overrides are invalid/i);
    expect(() =>
      subject().validateOverrides([{ id: "native_policy", value: "raw" }]),
    ).toThrow(/overrides are invalid/i);
    expect(() =>
      subject().resolve({
        connection,
        catalog,
        overrides: [{ id: "reasoning_effort", value: "xhigh" }],
      }),
    ).toThrow(/reasoning effort is unavailable/i);
    expect(() =>
      subject({
        modelPolicy: { type: "allowlist", allowed: [{ modelIds: ["gpt-default"] }] },
      }).resolve({
        connection,
        catalog,
        overrides: [{ id: "model", value: "gpt-fast" }],
      }),
    ).toThrow(/model is unavailable/i);
  });

  it("rejects service-tier and full execution-policy incompatibilities", () => {
    expect(() =>
      subject().resolve({
        connection,
        catalog,
        overrides: [{ id: "service_tier", value: "fast" }],
      }),
    ).toThrow(/service tier is unavailable/i);
    expect(() =>
      subject().resolve({
        connection,
        catalog,
        overrides: [
          { id: "sandbox_mode", value: "danger-full-access" },
          { id: "network_access", value: "disabled" },
        ],
      }),
    ).toThrow(/execution policy is unavailable/i);
    expect(() =>
      subject({
        policy: { ...executionPolicy, allowedApprovalReviewers: ["user"] },
      }).resolve({
        connection,
        catalog,
        overrides: [{ id: "approval_reviewer", value: "auto_review" }],
      }),
    ).toThrow(/execution policy is unavailable/i);
  });
});
