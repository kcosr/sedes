import { describe, expect, it } from "vitest";
import { supportsClaudeRuntimeHost } from "../../src/server/backends/claude/worker/claude-runtime-host-support.js";

describe("Claude runtime host support", () => {
  it.each(["linux", "darwin"])("requires the worker Node floor on %s", platform => {
    for (const version of ["24.18.0", "24.18.1", "24.19.0", "25.0.0"]) {
      expect(supportsClaudeRuntimeHost(platform, version)).toBe(true);
    }
    for (const version of ["22.19.0", "24.17.99", "23.99.99", "24.18", "v24.18.0", "24.18.0-rc.1", "24.018.0", "99999999999999999999.0.0", "25.-1.0"]) {
      expect(supportsClaudeRuntimeHost(platform, version)).toBe(false);
    }
  });
  it.each(["win32", "freebsd", "unknown"])("does not claim POSIX worker support on %s", platform => {
    expect(supportsClaudeRuntimeHost(platform, "24.18.0")).toBe(false);
  });
});
