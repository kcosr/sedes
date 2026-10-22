import { describe, expect, it } from "vitest";
import { CODEX_SPEED_REF, speedArgumentsValue, speedArgumentsWireSchema, speedStateSchema, speedStateWireSchema, speedResultWireSchema } from "../../src/shared/provider-features/codex-speed.js";
import { compiledProviderFeatureRegistry } from "../../src/server/provider-features/compiled-provider-feature-registry.js";
import { boundValue } from "../../src/server/conversations/payload-policy.js";
import { codexTurnSettingsUpdateMethod } from "../../src/server/backends/codex/codex-active-speed-protocol.js";
import { codexRuntimeMethod } from "../../src/server/backends/codex/runtime/codex-runtime-protocol.js";

describe("codex.fast_mode@3", () => {
  const state = { saved: { selection: "fast", desiredRevision: 4 }, offered: [{ selection: "standard" }, { selection: "fast" }], currentRun: null, lastChange: null };
  it("has one action, separate revision authority, and no support on other backends", () => {
    const capability = compiledProviderFeatureRegistry.capability(CODEX_SPEED_REF, "codex_app_server", { revision: 9, mutationRevision: 4, availability: "available" });
    expect(capability).toMatchObject({ revision: 9, mutationRevision: 4 });
    expect(capability.operations.map(action => action.actionId)).toEqual(["set_speed"]);
    for (const backend of ["pi", "claude_agent_sdk", "grok_build", "opencode"] as const) {
      expect(compiledProviderFeatureRegistry.refs(backend).some(ref => ref.featureId === CODEX_SPEED_REF.featureId)).toBe(false);
    }
    expect(() => compiledProviderFeatureRegistry.capability({ ...CODEX_SPEED_REF, schemaVersion: 2 }, "codex_app_server", { revision: 1, mutationRevision: 1, availability: "available" })).toThrow();
  });
  it("requires a complete normalized target and one strict bounded shape", () => {
    const args = { selection: "ultrafast" as const, currentRunTarget: { turnId: "application-turn", activationId: "activation" } };
    expect(speedArgumentsWireSchema.parse(speedArgumentsValue(args))).toEqual(args);
    expect(speedArgumentsWireSchema.safeParse(args).success).toBe(false);
    for (const bad of [null, { selection: "fast" }, { selection: "priority", currentRunTarget: null }, { ...args, turnId: "native" }, { ...args, currentRunTarget: { turnId: "t" } }]) {
      expect(speedArgumentsWireSchema.safeParse(boundValue(bad)).success).toBe(false);
    }
    expect(speedStateWireSchema.parse(boundValue(state))).toEqual(state);
    expect(speedStateWireSchema.safeParse({ kind: "object", entries: [], truncation: { truncated: true, retainedBytes: 0, reason: "byte_limit" } }).success).toBe(false);
    expect(speedArgumentsWireSchema.safeParse({ kind: "object", entries: [
      { key: { text: "selection" }, value: { text: "fast" } }, { key: { text: "selection" }, value: { text: "standard" } },
      { key: { text: "currentRunTarget" }, value: null },
    ] }).success).toBe(false);
  });
  it("rejects partial, duplicated, and out-of-order offered speeds", () => {
    for (const offered of [[], [{ selection: "fast" }], [{ selection: "standard" }, { selection: "fast" }, { selection: "fast" }],
      [{ selection: "standard" }, { selection: "ultrafast" }, { selection: "fast" }]]) {
      expect(speedStateSchema.safeParse({ ...state, offered }).success).toBe(false);
    }
    const result = { operationId: "op", receiptRevision: 3, saved: { status: "saved", ...state.saved }, currentRun: { status: "not_requested" } };
    expect(speedResultWireSchema.parse(boundValue(result))).toEqual(result);
    expect(speedResultWireSchema.safeParse(boundValue({ ...result, currentRun: { status: "published" } })).success).toBe(false);
  });
  it("enforces the same three-key native subset locally and on the execution host", () => {
    for (const method of [codexTurnSettingsUpdateMethod, codexRuntimeMethod("turn/settings/update")]) {
      expect(method.encodeParams({ threadId: "t", turnId: "r", serviceTier: "priority" })).toEqual({ threadId: "t", turnId: "r", serviceTier: "priority" });
      for (const bad of [{ threadId: "t", turnId: "r" }, { threadId: "t", turnId: "r", serviceTier: null },
        { threadId: "t", turnId: "r", serviceTier: "priority", model: "other" },
        { threadId: "t", turnId: "r", serviceTier: "priority", effort: "high" }]) expect(() => method.encodeParams(bad as never)).toThrow();
      expect(method.decodeResult({ status: "applied" })).toEqual({ status: "applied" });
      expect(() => method.decodeResult({ status: "applied", extra: true })).toThrow();
    }
  });
});
