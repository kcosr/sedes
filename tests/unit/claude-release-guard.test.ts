import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_EXCLUDED_VERSIONS,
  CLAUDE_CODE_MINIMUM_VERSION,
  CLAUDE_CODE_TESTED_THROUGH_VERSION,
  emitClaudeRuntimeNewerVersionWarning,
  isClaudeRuntimeVersionExcluded,
  verifyClaudeRuntimeVersion,
} from "../../src/server/backends/claude/claude-release-guard.js";

describe("Claude runtime release guard", () => {
  it("declares an independent floor, tested-through release, and exclusions", () => {
    expect(CLAUDE_CODE_MINIMUM_VERSION).toBe("2.1.281");
    expect(CLAUDE_CODE_TESTED_THROUGH_VERSION).toBe("2.1.283");
    expect(CLAUDE_CODE_EXCLUDED_VERSIONS).toEqual([]);
  });

  it.each(["2.1.281", "2.1.282", "2.1.283", "2.1.283+vendor.1"])(
    "accepts supported runtime %s without a warning",
    (version) => {
      const onNewerVersion = vi.fn();
      const onVersionAssessment = vi.fn();
      expect(
        verifyClaudeRuntimeVersion(version, {
          onNewerVersion,
          onVersionAssessment,
        }),
      ).toEqual({
        version,
        newerThanTested: false,
      });
      expect(onNewerVersion).not.toHaveBeenCalled();
      expect(onVersionAssessment).toHaveBeenCalledWith({
        version,
        newerThanTested: false,
      });
    },
  );

  it.each(["2.1.284", "2.2.0", "3.0.0", "99.0.0"])(
    "accepts newer stable runtime %s with a warning",
    (version) => {
      const onNewerVersion = vi.fn();
      expect(verifyClaudeRuntimeVersion(version, { onNewerVersion })).toEqual({
        version,
        newerThanTested: true,
      });
      expect(onNewerVersion).toHaveBeenCalledOnce();
      expect(onNewerVersion).toHaveBeenCalledWith({
        testedThroughVersion: "2.1.283",
        observedVersion: version,
      });
    },
  );

  it("ignores build metadata when comparing the audited floor", () => {
    expect(verifyClaudeRuntimeVersion("2.1.281+vendor.1")).toEqual({
      version: "2.1.281+vendor.1",
      newerThanTested: false,
    });
    expect(() => verifyClaudeRuntimeVersion("2.1.280+vendor.1")).toThrow(
      "claude_cli_release_below_minimum",
    );
  });

  it("does not let build metadata bypass a known-bad release exclusion", () => {
    expect(
      isClaudeRuntimeVersionExcluded("2.1.242+vendor.7", ["2.1.242"]),
    ).toBe(true);
    expect(
      isClaudeRuntimeVersionExcluded("2.1.243+vendor.7", ["2.1.242"]),
    ).toBe(false);
  });

  // Before 2.1.280 the startup message reaches the model with the next prompt;
  // 2.1.280 still resumes an interrupted tool call with a hidden prompt.
  it.each(["2.1.240", "2.1.241", "2.1.260", "2.1.273", "2.1.274", "2.1.278", "2.1.280", "1.99.999"])(
    "rejects runtime %s below the compatibility floor",
    (version) => {
      expect(() => verifyClaudeRuntimeVersion(version)).toThrow(
        "claude_cli_release_below_minimum",
      );
    },
  );

  it.each(["2.1.241-rc.1", "2.1.242-beta.1"])(
    "rejects prerelease runtime %s",
    (version) => {
      expect(() => verifyClaudeRuntimeVersion(version)).toThrow(
        "claude_cli_release_prerelease_unsupported",
      );
    },
  );

  it.each(["", "2.1", "v2.1.242", "02.1.242", "2.1.242.0"])(
    "rejects malformed runtime version %j",
    (version) => {
      expect(() => verifyClaudeRuntimeVersion(version)).toThrow(
        "claude_cli_release_invalid",
      );
    },
  );

  it("deduplicates the structured process warning per observed release", () => {
    const emitWarning = vi
      .spyOn(process, "emitWarning")
      .mockImplementation(() => undefined);
    const warning = {
      testedThroughVersion: "2.1.283",
      observedVersion: "2.99.0+test-warning",
    };

    emitClaudeRuntimeNewerVersionWarning(warning);
    emitClaudeRuntimeNewerVersionWarning(warning);

    expect(emitWarning).toHaveBeenCalledOnce();
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("2.99.0+test-warning"),
      {
        code: "SEDES_CLAUDE_RUNTIME_NEWER_THAN_TESTED",
        detail: "testedThrough=2.1.283;observed=2.99.0+test-warning",
      },
    );
    emitWarning.mockRestore();
  });
});
