import { describe, expect, it } from "vitest";
import { assessPiRuntimeVersion, decodePiRuntimeVersionProbe } from "../../src/server/backends/pi/native/runtime-release.js";

describe("native Pi runtime admission", () => {
  it.each(["1.4.0", "1.4.12", "1.5.0", "1.5.0+build.1"])("accepts qualified stable %s", version => {
    expect(assessPiRuntimeVersion(version)).toEqual({ version, newerThanTested: false });
  });
  it.each(["1.5.1", "1.6.0", "2.0.0", "100000000000000000000.0.0+build"])("admits newer stable %s with a warning assessment", version => {
    expect(assessPiRuntimeVersion(version)).toEqual({ version, newerThanTested: true });
  });
  it.each(["1.3.99", "0.86.0", "1.5.0-beta.1", "v1.5.0", "1.5", "01.5.0", "1.5.0 ", "1.5.0\n", "1.5.0+", "9".repeat(129)])("rejects unsupported or ambiguous %s", version => {
    expect(() => assessPiRuntimeVersion(version)).toThrow("pi_native_version_unsupported");
  });
  it("requires one exact version line and silent stderr", () => {
    expect(decodePiRuntimeVersionProbe("1.5.0\r\n", "")).toEqual({ version: "1.5.0", newerThanTested: false });
    for (const output of [" 1.5.0\n", "1.5.0\nextra\n", "1.5.0\n\n", "1.5.0\0"]) {
      expect(() => decodePiRuntimeVersionProbe(output, "")).toThrow("pi_native_version_unsupported");
    }
    expect(() => decodePiRuntimeVersionProbe("1.5.0\n", "warning")).toThrow("pi_native_version_unsupported");
  });
});
