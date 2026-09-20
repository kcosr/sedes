import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_MINIMUM_VERSION,
  CLAUDE_CODE_TESTED_THROUGH_VERSION,
  verifyClaudeRuntimeVersion,
} from "../../src/server/backends/claude/claude-release-guard.js";
import {
  CODEX_RUNTIME_MINIMUM_SUPPORTED_RELEASE,
  CODEX_RUNTIME_TESTED_THROUGH_RELEASE,
  verifyCodexRuntimeVersion,
} from "../../src/server/backends/codex/codex-release-guard.js";
import {
  GROK_ACP_REVIEWED_PROFILE_FLOOR,
  GROK_RUNTIME_TESTED_THROUGH_VERSION,
  admitGrokRuntimeVersion,
} from "../../src/server/backends/grok/grok-release-guard.js";

interface CompatibilityPolicyFixture {
  readonly backend: "codex" | "claude" | "grok";
  readonly minimum: string;
  readonly belowMinimum: string;
  readonly testedThrough: string;
  readonly compatibleNewer: string;
  assess(version: string): {
    readonly observedVersion: string;
    readonly newerThanTested: boolean;
  };
}

const fixtures: readonly CompatibilityPolicyFixture[] = [
  {
    backend: "codex",
    minimum: CODEX_RUNTIME_MINIMUM_SUPPORTED_RELEASE,
    belowMinimum: "0.148.999",
    testedThrough: CODEX_RUNTIME_TESTED_THROUGH_RELEASE,
    compatibleNewer: "0.155.0",
    assess(version) {
      const verified = verifyCodexRuntimeVersion(version);
      return {
        observedVersion: verified.version,
        newerThanTested: verified.newerThanTested,
      };
    },
  },
  {
    backend: "claude",
    minimum: CLAUDE_CODE_MINIMUM_VERSION,
    belowMinimum: "2.1.240",
    testedThrough: CLAUDE_CODE_TESTED_THROUGH_VERSION,
    compatibleNewer: "2.1.275",
    assess(version) {
      const verified = verifyClaudeRuntimeVersion(version);
      return {
        observedVersion: verified.version,
        newerThanTested: verified.newerThanTested,
      };
    },
  },
  {
    backend: "grok",
    minimum: GROK_ACP_REVIEWED_PROFILE_FLOOR,
    belowMinimum: "1.0.3",
    testedThrough: GROK_RUNTIME_TESTED_THROUGH_VERSION,
    compatibleNewer: "1.0.5",
    assess(version) {
      const admitted = admitGrokRuntimeVersion(version, "abcdef0");
      return {
        observedVersion: admitted.assessment.observedVersion,
        newerThanTested: admitted.assessment.newerThanTested,
      };
    },
  },
] as const;

describe("operator runtime compatibility policy", () => {
  it.each(fixtures)(
    "$backend admits the floor without an advisory and flags a compatible newer runtime",
    (fixture) => {
      expect(fixture.assess(fixture.minimum)).toEqual({
        observedVersion: fixture.minimum,
        newerThanTested: false,
      });
      expect(fixture.assess(`${fixture.minimum}+vendor.1`)).toEqual({
        observedVersion: `${fixture.minimum}+vendor.1`,
        newerThanTested: false,
      });
      expect(fixture.assess(fixture.compatibleNewer)).toEqual({
        observedVersion: fixture.compatibleNewer,
        newerThanTested: true,
      });
    },
  );

  it.each(fixtures)(
    "$backend rejects malformed, below-floor, and prerelease versions",
    (fixture) => {
      expect(() => fixture.assess("not-a-version")).toThrow();
      expect(() => fixture.assess(fixture.belowMinimum)).toThrow();
      expect(() => fixture.assess(`${fixture.minimum}-preview.1`)).toThrow();
    },
  );
});
