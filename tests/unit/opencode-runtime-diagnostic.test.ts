import { describe, expect, it } from "vitest";
import { openCodeRuntimeDiagnostic, openCodeStoreRecoveryCodes } from "../../src/server/backends/opencode/opencode-runtime-diagnostic.js";
import { encodeOpenCodeNativeFailure, decodeOpenCodeNativeFailure } from "../../src/server/backends/opencode/opencode-native-codecs.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";

describe("OpenCode safe Settings diagnostics", () => {
  it.each(openCodeStoreRecoveryCodes)("preserves %s over the private wire and gives host recovery guidance", code => {
    const failure = decodeOpenCodeNativeFailure(encodeOpenCodeNativeFailure(new OpenCodeRuntimeError(code), false));
    const wrapped = new Error("secret path, token, native stderr", { cause: failure });
    const diagnostic = openCodeRuntimeDiagnostic(wrapped);
    expect(diagnostic?.connectionState).toBe("recovery_required");
    expect(diagnostic?.message).toContain("sedes opencode-owner inspect --store PATH");
    expect(diagnostic?.message).not.toContain("secret");
    expect(diagnostic?.message.length).toBeLessThan(1_024);
  });
  it("identifies supported-host and release requirements without claiming the carrier is unreachable", () => {
    expect(openCodeRuntimeDiagnostic(new OpenCodeRuntimeError("opencode_runtime_capability_unavailable"))).toMatchObject({
      connectionState: "unknown", message: expect.stringContaining("Linux execution host"),
    });
    expect(openCodeRuntimeDiagnostic(decodeOpenCodeNativeFailure(encodeOpenCodeNativeFailure(new OpenCodeRuntimeError("opencode_release_incompatible"), false)))?.message).toContain("opencode2 2.0.18");
  });
  it("does not accept raw error messages, arbitrary codes, cyclic or unbounded causes", () => {
    for (const error of [new Error("opencode_native_store_already_owned"), new OpenCodeRuntimeError("secret"), { code: "opencode_native_store_already_owned" }]) {
      expect(openCodeRuntimeDiagnostic(error)).toBeUndefined();
    }
    const cycle = new Error("cycle"); cycle.cause = cycle;
    expect(openCodeRuntimeDiagnostic(cycle)).toBeUndefined();
    let deep: Error = new OpenCodeRuntimeError("opencode_native_store_already_owned");
    for (let i = 0; i < 8; i++) deep = new Error("wrapper", { cause: deep });
    expect(openCodeRuntimeDiagnostic(deep)).toBeUndefined();
  });
  it("keeps private classification in the owning module and leaves other backends' default diagnostics intact", () => {
    const error = new OpenCodeRuntimeError("opencode_native_store_already_owned");
    expect(compiledBackendModuleCatalog.requireModule("opencode").runtimeDiagnostic?.(error)?.connectionState).toBe("recovery_required");
    for (const kind of ["pi", "codex_app_server", "claude_agent_sdk", "grok_build"] as const) {
      expect(compiledBackendModuleCatalog.requireModule(kind).runtimeDiagnostic?.(error)).toBeUndefined();
    }
  });
});
