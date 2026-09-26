/**
 * Sticky runtime floor for the one reviewed Claude SDK protocol profile.
 * Earlier releases resume after an interrupted tool call with a hidden
 * "Continue" prompt and fail SDK turns after plain-string assistant content
 * (both fixed in 2.1.281).
 */
export const CLAUDE_CODE_MINIMUM_VERSION = "2.1.281";
/** Newest Claude Code release exercised against this profile. */
export const CLAUDE_CODE_TESTED_THROUGH_VERSION = "2.1.283";
/** Stable releases with known contract defects, independent of ordering. */
export const CLAUDE_CODE_EXCLUDED_VERSIONS: readonly string[] = Object.freeze(
  [],
);

const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const CLAUDE_RUNTIME_RELEASE_FAILURE_CODES = new Set([
  "claude_cli_release_invalid",
  "claude_cli_release_prerelease_unsupported",
  "claude_cli_release_excluded",
  "claude_cli_release_below_minimum",
]);

export type ClaudeRuntimeVersionWarning = {
  readonly testedThroughVersion: string;
  readonly observedVersion: string;
};

export interface VerifiedClaudeRuntimeVersion {
  readonly version: string;
  readonly newerThanTested: boolean;
}

export type ClaudeRuntimeVersionAssessment =
  VerifiedClaudeRuntimeVersion | undefined;

const emittedRuntimeWarnings = new Set<string>();

/**
 * Accept a stable operator-installed Claude Code runtime at or above the
 * reviewed floor. The pinned Agent SDK and typed provider boundary stay exact,
 * and a newer runtime never selects another parser or capability set.
 */
export function verifyClaudeRuntimeVersion(
  version: string,
  options?: {
    readonly onNewerVersion?: (warning: ClaudeRuntimeVersionWarning) => void;
    readonly onVersionAssessment?: (
      assessment: VerifiedClaudeRuntimeVersion,
    ) => void;
  },
): VerifiedClaudeRuntimeVersion {
  let parsedVersion: SemanticVersion;
  try {
    parsedVersion = parseSemanticVersion(version);
  } catch {
    throw new Error("claude_cli_release_invalid");
  }
  if (parsedVersion.prerelease) {
    throw new Error("claude_cli_release_prerelease_unsupported");
  }
  if (isClaudeRuntimeVersionExcluded(version)) {
    throw new Error("claude_cli_release_excluded");
  }
  if (compareSemanticVersions(version, CLAUDE_CODE_MINIMUM_VERSION) < 0) {
    throw new Error("claude_cli_release_below_minimum");
  }
  const newerThanTested =
    compareSemanticVersions(version, CLAUDE_CODE_TESTED_THROUGH_VERSION) > 0;
  const assessment = Object.freeze({ version, newerThanTested });
  options?.onVersionAssessment?.(assessment);
  if (newerThanTested) {
    options?.onNewerVersion?.({
      testedThroughVersion: CLAUDE_CODE_TESTED_THROUGH_VERSION,
      observedVersion: version,
    });
  }
  return assessment;
}

/** Compare exclusions by SemVer core so build metadata cannot bypass one. */
export function isClaudeRuntimeVersionExcluded(
  version: string,
  exclusions: readonly string[] = CLAUDE_CODE_EXCLUDED_VERSIONS,
): boolean {
  const core = semanticVersionCore(parseSemanticVersion(version));
  return exclusions.some(
    (excluded) => semanticVersionCore(parseSemanticVersion(excluded)) === core,
  );
}

export function isClaudeRuntimeReleaseFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    CLAUDE_RUNTIME_RELEASE_FAILURE_CODES.has(error.message)
  );
}

/** Emit at most one installation-process warning for each observed release. */
export function emitClaudeRuntimeNewerVersionWarning(
  warning: ClaudeRuntimeVersionWarning,
): void {
  const key = `${warning.testedThroughVersion}\0${warning.observedVersion}`;
  if (emittedRuntimeWarnings.has(key)) return;
  emittedRuntimeWarnings.add(key);
  process.emitWarning(
    `Claude Code runtime ${warning.observedVersion} is newer than the tested-through ${warning.testedThroughVersion} release.`,
    {
      code: "SEDES_CLAUDE_RUNTIME_NEWER_THAN_TESTED",
      detail: `testedThrough=${warning.testedThroughVersion};observed=${warning.observedVersion}`,
    },
  );
}

function compareSemanticVersions(left: string, right: string): number {
  const leftVersion = parseSemanticVersion(left);
  const rightVersion = parseSemanticVersion(right);
  for (const part of ["major", "minor", "patch"] as const) {
    if (leftVersion[part] < rightVersion[part]) return -1;
    if (leftVersion[part] > rightVersion[part]) return 1;
  }
  if (!leftVersion.prerelease && !rightVersion.prerelease) return 0;
  if (!leftVersion.prerelease) return 1;
  if (!rightVersion.prerelease) return -1;
  const maximumIdentifiers = Math.max(
    leftVersion.prerelease.length,
    rightVersion.prerelease.length,
  );
  for (let index = 0; index < maximumIdentifiers; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

interface SemanticVersion {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
  readonly prerelease?: readonly string[];
}

function parseSemanticVersion(value: string): SemanticVersion {
  const match = SEMANTIC_VERSION_PATTERN.exec(value);
  if (!match) throw new Error("claude_cli_release_invalid");
  return Object.freeze({
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    ...(match[4] ? { prerelease: Object.freeze(match[4].split(".")) } : {}),
  });
}

function semanticVersionCore(version: SemanticVersion): string {
  return `${version.major}.${version.minor}.${version.patch}${
    version.prerelease ? `-${version.prerelease.join(".")}` : ""
  }`;
}
