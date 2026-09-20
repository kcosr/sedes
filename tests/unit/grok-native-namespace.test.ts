import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  effectiveGrokNativeHome,
  grokNativeNamespaceKey,
} from "../../src/server/backends/grok/grok-native-namespace.js";

describe("Grok provider-native discovery namespace", () => {
  it("uses ambient GROK_HOME or the normal HOME/.grok location without inspecting it", () => {
    expect(effectiveGrokNativeHome({ HOME: "/home/operator" })).toBe(
      "/home/operator/.grok",
    );
    expect(
      effectiveGrokNativeHome({
        HOME: "/home/operator",
        GROK_HOME: "/state/native-grok",
      }),
    ).toBe("/state/native-grok");
  });

  it("binds the opaque key to execution environment and effective native home", () => {
    const first = grokNativeNamespaceKey("environment-1", {
      HOME: "/home/operator",
    });
    expect(first).toBe("grok:T1X1RF3yOSbc9ZuU2KEoYpOtcLqlxOu6lVyDisetTXk");
    expect(first).toBe(
      grokNativeNamespaceKey("environment-1", {
        HOME: "/home/operator",
        GROK_HOME: "/home/operator/.grok",
      }),
    );
    expect(first).not.toBe(
      grokNativeNamespaceKey("environment-2", { HOME: "/home/operator" }),
    );
    expect(first).not.toBe(
      grokNativeNamespaceKey("environment-1", { HOME: "/home/other" }),
    );
  });

  it("rejects non-canonical or control-bearing paths and invalid scope", () => {
    expect(() =>
      effectiveGrokNativeHome({
        HOME: "/home/operator",
        GROK_HOME: path.join("relative", ".grok"),
      }),
    ).toThrow("grok_native_home_invalid");
    expect(() =>
      effectiveGrokNativeHome({ GROK_HOME: "/home/operator/../other" }),
    ).toThrow("grok_native_home_invalid");
    expect(() =>
      grokNativeNamespaceKey("bad\nidentity", { HOME: "/home/operator" }),
    ).toThrow("grok_native_namespace_scope_invalid");
  });
});
