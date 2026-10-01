import { describe, expect, it } from "vitest";
import { openCodeRuntimeDiagnostic, openCodeOwnerRecoveryCodes } from "../../src/server/backends/opencode/opencode-runtime-diagnostic.js";
import { encodeOpenCodeNativeFailure, decodeOpenCodeNativeFailure } from "../../src/server/backends/opencode/opencode-native-codecs.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";

describe("OpenCode safe Settings diagnostics", () => {
  it.each(openCodeOwnerRecoveryCodes)("preserves %s over the private wire and gives host recovery guidance", code => {
    const failure = decodeOpenCodeNativeFailure(encodeOpenCodeNativeFailure(new OpenCodeRuntimeError(code), false));
    const wrapped = new Error("secret path, token, native stderr", { cause: failure });
    const diagnostic = openCodeRuntimeDiagnostic(wrapped);
    expect(diagnostic?.connectionState).toBe("recovery_required");
    expect(diagnostic?.recoveryAction).toBeUndefined();
    expect(diagnostic?.message).toContain("sedes opencode-owner inspect --authority-key KEY");
    expect(diagnostic?.message).toContain("Connect or Start to retry startup");
    expect(diagnostic?.message).not.toContain("secret");
    expect(diagnostic?.message.length).toBeLessThan(1_024);
  });
  it("identifies supported-host and release requirements without claiming the carrier is unreachable", () => {
    expect(openCodeRuntimeDiagnostic(new OpenCodeRuntimeError("opencode_runtime_capability_unavailable"))).toMatchObject({
      connectionState: "unknown", message: expect.stringContaining("Linux execution host"),
    });
    expect(openCodeRuntimeDiagnostic(decodeOpenCodeNativeFailure(encodeOpenCodeNativeFailure(new OpenCodeRuntimeError("opencode_release_incompatible"), false)))?.message).toContain("opencode2 2.0.18");
  });
  it.each([
    ["opencode_executable_unavailable", "Advanced executable path", "startup PATH"],
    ["opencode_runtime_owner_directory_invalid", "HOME/XDG_STATE_HOME", "mode 0700"],
  ])("preserves %s over the private wire with safe setup guidance", (code, first, second) => {
    const failure = decodeOpenCodeNativeFailure(encodeOpenCodeNativeFailure(new OpenCodeRuntimeError(code), false));
    expect(failure.code).toBe(code);
    const diagnostic = openCodeRuntimeDiagnostic(new Error("secret native path", { cause: failure }));
    expect(diagnostic).toMatchObject({ connectionState: "unknown", message: expect.stringContaining(first) });
    expect(diagnostic?.message).toContain(second);
    expect(diagnostic?.message).toContain("Connect or Start");
    expect(diagnostic?.message).not.toContain("secret");
    expect(diagnostic!.message.length).toBeLessThan(1_024);
  });
  it("prioritizes proved cleanup before retrying a failed launch, including nested private-wire aggregates", () => {
    const cleanup = decodeOpenCodeNativeFailure(encodeOpenCodeNativeFailure(new OpenCodeRuntimeError("opencode_owned_cleanup_unproved"), false));
    expect(cleanup.code).toBe("opencode_owned_cleanup_unproved");
    const failure = new AggregateError([
      new OpenCodeRuntimeError("opencode_executable_unavailable"),
      new Error("secret cleanup stderr", { cause: new AggregateError([cleanup], "secret native path") }),
    ], "secret startup path");
    const diagnostic = compiledBackendModuleCatalog.requireModule("opencode").runtimeDiagnostic?.(failure);
    expect(diagnostic).toMatchObject({ connectionState: "recovery_required", recoveryAction: "stop", message: expect.stringContaining("Use backend Stop to retry cleanup before using Start") });
    expect(diagnostic?.message).not.toContain("secret");
    expect(diagnostic?.message).not.toContain("startup PATH");
    expect(diagnostic!.message.length).toBeLessThan(1_024);
  });
  it("bounds cyclic, deep and wide aggregates and never invokes error accessors", () => {
    const cleanup = new OpenCodeRuntimeError("opencode_owned_cleanup_unproved");
    const cyclic = new AggregateError([], "cycle"); cyclic.errors.push(cyclic, cleanup);
    expect(openCodeRuntimeDiagnostic(cyclic)?.message).toContain("Use backend Stop");
    let deep: Error = cleanup;
    for (let i = 0; i < 8; i++) deep = new AggregateError([deep], "wrapper");
    expect(openCodeRuntimeDiagnostic(deep)).toBeUndefined();
    const wide = new AggregateError([...Array.from({ length: 32 }, () => new Error("unknown")), cleanup], "wide");
    expect(openCodeRuntimeDiagnostic(wide)).toBeUndefined();
    const accessors = new AggregateError([], "accessor");
    for (const key of ["cause", "errors"]) Object.defineProperty(accessors, key, { get() { throw new Error("must not be read"); } });
    expect(openCodeRuntimeDiagnostic(accessors)).toBeUndefined();
  });
  it("does not accept raw error messages, arbitrary codes, cyclic or unbounded causes", () => {
    for (const error of [new Error("opencode_runtime_owner_already_owned"), new OpenCodeRuntimeError("secret"), { code: "opencode_runtime_owner_already_owned" }]) {
      expect(openCodeRuntimeDiagnostic(error)).toBeUndefined();
    }
    const cycle = new Error("cycle"); cycle.cause = cycle;
    expect(openCodeRuntimeDiagnostic(cycle)).toBeUndefined();
    let deep: Error = new OpenCodeRuntimeError("opencode_runtime_owner_already_owned");
    for (let i = 0; i < 8; i++) deep = new Error("wrapper", { cause: deep });
    expect(openCodeRuntimeDiagnostic(deep)).toBeUndefined();
  });
  it("keeps private classification in the owning module and leaves other backends' default diagnostics intact", () => {
    const error = new OpenCodeRuntimeError("opencode_runtime_owner_already_owned");
    expect(compiledBackendModuleCatalog.requireModule("opencode").runtimeDiagnostic?.(error)?.connectionState).toBe("recovery_required");
    for (const kind of ["pi", "codex_app_server", "claude_agent_sdk", "grok_build"] as const) {
      expect(compiledBackendModuleCatalog.requireModule(kind).runtimeDiagnostic?.(error)).toBeUndefined();
    }
  });
});
