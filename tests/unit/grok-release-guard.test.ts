import { describe, expect, it } from "vitest";
import {
  admitGrokRuntimeVersion,
  admittedGrokRuntimeSupportsImageInput,
  assertGrokProductionProfileAdmitted,
  decodeGrokVersionEvidence,
  GROK_RUNTIME_EXCLUDED_RELEASES,
  grokRuntimeIncompatibilityCode,
} from "../../src/server/backends/grok/grok-release-guard.js";

describe("Grok release guard", () => {
  it("admits the reviewed floor and later stable releases", () => {
    expect(admitGrokRuntimeVersion("1.0.4", "d846eb93d9")).toMatchObject({
      compatibilityRelease: "1.x",
      reviewedProfile: "grok-acp/1.0.4",
      newerThanTested: false,
      assessment: {
        observedVersion: "1.0.4",
        minimumVersion: "1.0.4",
        testedThroughVersion: "1.0.4",
        newerThanTested: false,
      },
    });
    expect(admitGrokRuntimeVersion("1.0.4", "abcdef1").version).toBe("1.0.4");
    expect(admitGrokRuntimeVersion("1.0.5", "abcdef1")).toMatchObject({
      version: "1.0.5",
      newerThanTested: true,
      assessment: {
        observedVersion: "1.0.5",
        minimumVersion: "1.0.4",
        testedThroughVersion: "1.0.4",
        newerThanTested: true,
      },
    });
    expect(
      admitGrokRuntimeVersion("1.7.0+rebuild.2", "0123456789abcdef"),
    ).toMatchObject({
      version: "1.7.0+rebuild.2",
      newerThanTested: true,
    });
    expect(admitGrokRuntimeVersion("2.0.0", "abcdef1")).toMatchObject({
      version: "2.0.0",
      newerThanTested: true,
    });
    expect(admitGrokRuntimeVersion("99.0.0", "abcdef1")).toMatchObject({
      version: "99.0.0",
      newerThanTested: true,
    });
  });

  it("binds native image input to admitted stable runtimes", () => {
    expect(
      admittedGrokRuntimeSupportsImageInput(
        admitGrokRuntimeVersion("1.0.4", "d846eb93d9"),
      ),
    ).toBe(true);
    expect(
      admittedGrokRuntimeSupportsImageInput(
        admitGrokRuntimeVersion("1.7.0", "0123456789abcdef"),
      ),
    ).toBe(true);
    expect(
      admittedGrokRuntimeSupportsImageInput({
        ...admitGrokRuntimeVersion("1.0.4", "d846eb93d9"),
        version: "1.0.3",
      }),
    ).toBe(false);
  });

  it("rejects older, prerelease, malformed, and invalid-build runtimes", () => {
    for (const [version, build] of [
      ["1.0.3", "abcdef1"],
      ["0.99.0", "abcdef1"],
      ["1.1.0-beta.1", "abcdef1"],
      ["v1.1.0", "abcdef1"],
      ["1.1.0", "not-a-build"],
    ]) {
      expect(() => admitGrokRuntimeVersion(version!, build!)).toThrow();
    }
  });

  it("applies exact release exclusions to every build of that semantic release", () => {
    const exclusions = GROK_RUNTIME_EXCLUDED_RELEASES as Set<string>;
    exclusions.add("1.8.0");
    try {
      expect(() => admitGrokRuntimeVersion("1.8.0", "abcdef1")).toThrow(
        "grok_runtime_version_excluded",
      );
      expect(() =>
        admitGrokRuntimeVersion("1.8.0+rebuild.2", "abcdef1"),
      ).toThrow("grok_runtime_version_excluded");
    } finally {
      exclusions.delete("1.8.0");
    }
  });

  it("projects consumed version fields and ignores additive evidence fields", () => {
    const admitted = decodeGrokVersionEvidence(
      Buffer.from(
        JSON.stringify({
          currentVersion: "1.0.4 (d846eb93d9)",
          channel: "stable",
          futureField: { never: "retained" },
        }),
      ),
      new Uint8Array(),
    );
    expect(admitted.version).toBe("1.0.4");
    expect(admitted.newerThanTested).toBe(false);
    expect(admitted).not.toHaveProperty("futureField");
  });

  it("admits the exact reviewed production profile", () => {
    expect(() => assertGrokProductionProfileAdmitted()).not.toThrow();
  });

  it("classifies every deterministic runtime admission failure", () => {
    for (const code of [
      "grok_runtime_platform_incompatible",
      "grok_runtime_version_invalid",
      "grok_runtime_version_incompatible",
      "grok_runtime_version_excluded",
      "grok_runtime_build_invalid",
      "grok_runtime_version_probe_output_invalid",
      "grok_runtime_version_probe_unexpected_stderr",
      "grok_runtime_version_probe_nonzero_exit",
      "grok_runtime_version_probe_output_too_large",
      "grok_runtime_executable_invalid",
    ]) {
      expect(grokRuntimeIncompatibilityCode(new Error(code))).toBe(code);
    }
    expect(
      grokRuntimeIncompatibilityCode(
        new Error("grok_runtime_version_probe_timeout"),
      ),
    ).toBeUndefined();
  });

  it("classifies malformed JSON values without exposing provider data or validation issues", () => {
    const marker = "provider-secret-marker";
    let error: unknown;
    try {
      decodeGrokVersionEvidence(
        Buffer.from(JSON.stringify({ currentVersion: { marker } })),
        new Uint8Array(),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "grok_runtime_version_probe_output_invalid",
    );
    expect(JSON.stringify(error)).not.toContain(marker);
    expect((error as Error).cause).toBeUndefined();
  });
});
