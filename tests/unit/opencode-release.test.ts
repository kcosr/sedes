import { describe, expect, it } from "vitest";
import { admitOpenCodeRelease, assessOpenCodeRuntimeVersion, decodeOpenCodeReleaseProbe,
  haveSameOpenCodeRuntimeVersionPrecedence, isOpenCodeRuntimeReleaseExcluded,
  OPENCODE_RELEASE, OPENCODE_RUNTIME_MINIMUM_SUPPORTED_RELEASE, OPENCODE_RUNTIME_TESTED_THROUGH_RELEASE } from "../../src/server/backends/opencode/opencode-release.js";
import { openCodeRuntimeInfoSchema, openCodeRuntimeOperations } from "../../src/server/backends/opencode/opencode-runtime-wire.js";

describe("OpenCode runtime compatibility policy", () => {
  it("keeps the compiled protocol profile separate from runtime admission evidence", () => {
    expect(OPENCODE_RELEASE).toBe("2.0.32");
    expect(OPENCODE_RUNTIME_MINIMUM_SUPPORTED_RELEASE).toBe("2.0.29");
    expect(OPENCODE_RUNTIME_TESTED_THROUGH_RELEASE).toBe("2.0.32");
  });
  it.each(["2.0.29", "2.0.29+vendor.7", "2.0.30", "2.0.31", "2.0.32", "2.0.32+vendor.7"])("admits reviewed stable runtime %s", version => {
    expect(admitOpenCodeRelease(version)).toBe(version);
    expect(assessOpenCodeRuntimeVersion(version)).toEqual({ version, newerThanTested: false });
  });
  it.each(["2.0.33", "2.1.0", "2.10.0+build.1", "3.0.0", "900719925474099300.0.0"])("admits newer stable runtime %s with an advisory", version => {
    expect(assessOpenCodeRuntimeVersion(version)).toEqual({ version, newerThanTested: true });
  });
  it.each([undefined, null, 20029, "1.18.30", "2.0.18", "2.0.28", "2.0.28+vendor.7", "2.0.29-rc.1", "2.0.33-beta", "v2.0.29", "2.0.29 ", "2.00.29", "2.0.29+", "2.0.29+a..b", "2.0", "2.0.29\n", "9".repeat(65)])("rejects malformed, prerelease, and below-floor runtime %s", version => {
    expect(() => admitOpenCodeRelease(version)).toThrow("opencode_release_incompatible");
  });
  it("compares stable precedence and applies exclusions independently of build metadata", () => {
    expect(haveSameOpenCodeRuntimeVersionPrecedence("2.0.29+executable.1", "2.0.29+daemon.2")).toBe(true);
    expect(haveSameOpenCodeRuntimeVersionPrecedence("2.0.29", "2.0.30")).toBe(false);
    expect(haveSameOpenCodeRuntimeVersionPrecedence("2.0.29-rc.1", "2.0.29")).toBe(false);
    expect(isOpenCodeRuntimeReleaseExcluded("2.0.29+vendor.7", ["2.0.29"])).toBe(true);
    expect(isOpenCodeRuntimeReleaseExcluded("2.0.30+vendor.7", ["2.0.29"])).toBe(false);
  });
  it("decodes only the exact OpenCode v2 CLI identity and one optional line ending", () => {
    for (const ending of ["", "\n", "\r\n"]) expect(decodeOpenCodeReleaseProbe(`opencode v2.0.29+build.1${ending}`)).toBe("2.0.29+build.1");
    for (const output of ["2.0.29\n", "opencode 2.0.29\n", "opencode v1.18.30\n", "opencode v2.0.29\nextra\n", "opencode v2.0.29\n\n", " opencode v2.0.29\n", "opencode v2.0.29 \n", "opencode v2.0.29\0\n"]) {
      expect(() => decodeOpenCodeReleaseProbe(output)).toThrow("opencode_release_incompatible");
    }
  });
  it("requires compatible observed version evidence for ready remote hosts and fences older carriers", () => {
    const info = { runtimeId: "runtime", nativeNamespaceKey: "a".repeat(64), snapshot: {
      state: "ready", ownership: "owned", generation: "generation", references: 0,
    } };
    expect(openCodeRuntimeInfoSchema.safeParse(info).success).toBe(false);
    for (const runtimeVersion of ["2.0.29", "2.0.32", "2.0.33", "3.0.0+build.1"]) {
      expect(openCodeRuntimeInfoSchema.parse({ ...info, snapshot: { ...info.snapshot, runtimeVersion } }).snapshot.runtimeVersion).toBe(runtimeVersion);
    }
    for (const runtimeVersion of ["1.18.30", "2.0.18", "2.0.28", "2.0.29-rc.1", "2.0.29 credential"]) {
      expect(openCodeRuntimeInfoSchema.safeParse({ ...info, snapshot: { ...info.snapshot, runtimeVersion } }).success).toBe(false);
    }
    expect(openCodeRuntimeOperations.every(operation => operation.majorVersion === 3)).toBe(true);
  });
});
