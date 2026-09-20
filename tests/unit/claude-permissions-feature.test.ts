import { describe, expect, it } from "vitest";
import {
  CLAUDE_PERMISSION_ACTION_BY_MODE,
  CLAUDE_PERMISSIONS_FEATURE_REF,
  claudePermissionActionIds,
  claudePermissionModeForAction,
  claudePermissionsStateV1Schema,
} from "../../src/server/backends/claude/claude-permissions-feature.js";
import { compiledProviderFeatureRegistry } from "../../src/server/provider-features/compiled-provider-feature-registry.js";
import { ProviderFeatureRegistryError } from "../../src/server/provider-features/provider-feature-registry.js";

describe("claude.permissions@1 feature contract", () => {
  it("registers only for Claude with five fixed no-confirmation actions", () => {
    const capability = compiledProviderFeatureRegistry.capability(
      CLAUDE_PERMISSIONS_FEATURE_REF,
      "claude_agent_sdk",
      { revision: 3, availability: "available" },
    );

    expect(capability.presentationSlots).toEqual(["thread_details"]);
    expect(capability.operations.map(({ actionId }) => actionId)).toEqual([
      "set_permission_default",
      "set_permission_accept_edits",
      "set_permission_dont_ask",
      "set_permission_auto",
      "set_permission_bypass",
    ]);
    expect(capability.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confirmation: "none",
          execution: "inline",
          effects: {
            application: "write",
            modelUsage: "none",
            external: "none",
          },
        }),
      ]),
    );
    for (const backendKind of ["pi", "codex_app_server"] as const) {
      expect(
        compiledProviderFeatureRegistry
          .refs(backendKind)
          .some(({ featureId }) => featureId === "claude.permissions"),
      ).toBe(false);
      expect(() =>
        compiledProviderFeatureRegistry.module(
          CLAUDE_PERMISSIONS_FEATURE_REF,
          backendKind,
        ),
      ).toThrow(ProviderFeatureRegistryError);
    }
  });

  it("accepts only null action arguments and a registered action", () => {
    expect(
      compiledProviderFeatureRegistry.validateAction({
        ref: CLAUDE_PERMISSIONS_FEATURE_REF,
        backendKind: "claude_agent_sdk",
        actionId: "set_permission_auto",
        arguments: null,
      }).arguments,
    ).toBeNull();
    expect(() =>
      compiledProviderFeatureRegistry.validateAction({
        ref: CLAUDE_PERMISSIONS_FEATURE_REF,
        backendKind: "claude_agent_sdk",
        actionId: "set_permission_auto",
        arguments: { kind: "object", entries: [] },
      }),
    ).toThrow(ProviderFeatureRegistryError);
    expect(() =>
      compiledProviderFeatureRegistry.validateAction({
        ref: CLAUDE_PERMISSIONS_FEATURE_REF,
        backendKind: "claude_agent_sdk",
        actionId: "set_permission_plan",
        arguments: null,
      }),
    ).toThrow(ProviderFeatureRegistryError);
  });

  it("projects only the exact desired/effective/effectiveState shape", () => {
    const envelope = compiledProviderFeatureRegistry.stateEnvelope({
      ref: CLAUDE_PERMISSIONS_FEATURE_REF,
      backendKind: "claude_agent_sdk",
      revision: 8,
      providerState: {
        desired: "acceptEdits",
        effective: "default",
        effectiveState: "confirmed",
      },
    });
    expect(envelope).toMatchObject({
      ref: CLAUDE_PERMISSIONS_FEATURE_REF,
      revision: 8,
    });
    expect(() =>
      claudePermissionsStateV1Schema.parse({
        desired: "plan",
        effective: null,
        effectiveState: "unconfirmed",
      }),
    ).toThrow();
    expect(() =>
      claudePermissionsStateV1Schema.parse({
        desired: "default",
        effective: "default",
        effectiveState: "confirmed",
        nativeRules: [],
      }),
    ).toThrow();
  });

  it("maps policy subsets to registered fixed actions", () => {
    expect(claudePermissionActionIds(["default", "bypassPermissions"])).toEqual(
      ["set_permission_default", "set_permission_bypass"],
    );
    expect(claudePermissionModeForAction("set_permission_dont_ask")).toBe(
      "dontAsk",
    );
    expect(
      claudePermissionModeForAction("set_permission_plan"),
    ).toBeUndefined();
    expect(CLAUDE_PERMISSION_ACTION_BY_MODE.auto).toBe("set_permission_auto");
  });
});
