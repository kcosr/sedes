import { describe, expect, it, vi } from "vitest";
import { OpenCodeInstallationAdvisorySource } from "../../src/server/backends/opencode/opencode-installation-advisories.js";
import { assessOpenCodeRuntimeVersion } from "../../src/server/backends/opencode/opencode-release.js";

describe("OpenCode installation advisory source", () => {
  it("publishes admitted versions above tested evidence and clears after returning to a reviewed runtime", () => {
    const source = new OpenCodeInstallationAdvisorySource(), listener = vi.fn();
    source.subscribe(listener);
    source.observe(assessOpenCodeRuntimeVersion("2.0.29+vendor.1"));
    expect(source.active()).toEqual([]);
    source.observe(assessOpenCodeRuntimeVersion("2.0.33"));
    expect(source.active()).toEqual([{ id: "runtime-newer-than-tested", tone: "warning",
      title: { text: "OpenCode is newer than tested" }, message: { text: "Running 2.0.33; Sedes is tested through 2.0.32." } }]);
    source.observe(assessOpenCodeRuntimeVersion("2.0.33"));
    expect(listener).toHaveBeenCalledOnce();
    source.observe(assessOpenCodeRuntimeVersion("2.0.32+vendor.1"));
    expect(source.active()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
  it("isolates observers and clears the advisory on retirement without duplicate notifications", () => {
    const source = new OpenCodeInstallationAdvisorySource(), listener = vi.fn();
    source.subscribe(() => { throw new Error("observer failure"); });
    const unsubscribe = source.subscribe(listener);
    expect(() => source.observe(assessOpenCodeRuntimeVersion("3.0.0"))).not.toThrow();
    source.clear(); source.clear();
    expect(source.active()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    source.observe(assessOpenCodeRuntimeVersion("3.0.0"));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
