import { describe, expect, it } from "vitest";
import { AntigravityModeCatalog } from "../../src/server/backends/antigravity/mode-catalog.js";
import { ANTIGRAVITY_MODE_FEATURE_REF } from "../../src/server/backends/antigravity/mode-feature.js";
import { compiledProviderFeatureRegistry } from "../../src/server/provider-features/compiled-provider-feature-registry.js";
import { antigravityCapabilities } from "../../src/server/backends/antigravity/catalog.js";
import type { AntigravitySetup } from "../../src/server/backends/antigravity/port.js";

const setup: AntigravitySetup = { initialize: { protocolVersion: 1 }, session: { configOptions: [{
  id: "opaque-mode-id", category: "mode", name: "Mode", type: "select", currentValue: "default",
  options: [{ value: "default", name: "Default" }, { value: "auto", name: "Auto" }, { value: "plan", name: "Plan" }, { value: "unsupported", name: "Future" }],
}] } };
describe("Antigravity native mode feature", () => {
  it("advertises only qualified native identifiers without inferring normalized tool access", () => {
    const catalog = new AntigravityModeCatalog();
    expect(catalog.modes).toEqual([]);
    catalog.observe(setup);
    expect(catalog.modes).toEqual(["default", "auto", "plan"]);
    expect(catalog.revision).toBe(1);
    catalog.observe(setup); expect(catalog.revision).toBe(1);
    catalog.observe({ initialize: { protocolVersion: 1 }, session: {} });
    expect(catalog.modes).toEqual([]); expect(catalog.revision).toBe(2);
    expect(antigravityCapabilities(setup, "connection").effectiveSettings).not.toHaveProperty("toolAccess");
  });
  it("registers closed null-argument actions only for Antigravity", () => {
    expect(compiledProviderFeatureRegistry.refs("antigravity")).toEqual([ANTIGRAVITY_MODE_FEATURE_REF]);
    const validate = (actionId: string, args: unknown = null) => compiledProviderFeatureRegistry.validateAction({
      ref: ANTIGRAVITY_MODE_FEATURE_REF, backendKind: "antigravity", actionId, arguments: args,
    });
    expect(validate("set_mode_plan").definition.effects).toEqual({ application: "write", modelUsage: "none", external: "none" });
    expect(() => validate("set_mode_plan", { mode: "plan" })).toThrow("arguments_invalid");
    expect(() => validate("arbitrary_native_mode")).toThrow("action_not_registered");
    expect(() => compiledProviderFeatureRegistry.module(ANTIGRAVITY_MODE_FEATURE_REF, "claude_agent_sdk")).toThrow("backend_mismatch");
    expect(() => compiledProviderFeatureRegistry.module({ ...ANTIGRAVITY_MODE_FEATURE_REF, schemaVersion: 2 }, "antigravity")).toThrow("feature_version_unsupported");
  });
});
