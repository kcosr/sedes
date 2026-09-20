import { z } from "zod";

export const GROK_ACP_COMPATIBILITY_RELEASE = "1.x" as const;
export const GROK_ACP_REVIEWED_PROFILE = "grok-acp/1.0.4" as const;
export const GROK_ACP_REVIEWED_PROFILE_FLOOR = "1.0.4" as const;
/** Newest Grok runtime release exercised against the pinned ACP profile. */
export const GROK_RUNTIME_TESTED_THROUGH_VERSION = "1.0.4" as const;
export const GROK_ACP_IMAGE_INPUT_PROFILE = GROK_ACP_REVIEWED_PROFILE;
export const GROK_ACP_IMAGE_INPUT_FLOOR = GROK_ACP_REVIEWED_PROFILE_FLOOR;
/** Reviewed incompatible stable releases; intentionally empty at this gate. */
export const GROK_RUNTIME_EXCLUDED_RELEASES: ReadonlySet<string> = new Set();

const grokRuntimeIncompatibilityCodes: ReadonlySet<string> = new Set([
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
]);

const stableSemanticVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

const grokVersionEvidenceSchema = z
  .object({
    currentVersion: z.string().min(1).max(160),
    channel: z.string().min(1).max(80).optional(),
  })
  .passthrough();

export interface AdmittedGrokRuntimeVersion {
  readonly version: string;
  readonly build: string;
  readonly compatibilityRelease: typeof GROK_ACP_COMPATIBILITY_RELEASE;
  readonly reviewedProfile: typeof GROK_ACP_REVIEWED_PROFILE;
  readonly newerThanTested: boolean;
  readonly assessment: GrokRuntimeCompatibilityAssessment;
}

export interface GrokRuntimeCompatibilityAssessment {
  readonly observedVersion: string;
  readonly minimumVersion: typeof GROK_ACP_REVIEWED_PROFILE_FLOOR;
  readonly testedThroughVersion: typeof GROK_RUNTIME_TESTED_THROUGH_VERSION;
  readonly newerThanTested: boolean;
}

export function grokRuntimeIncompatibilityCode(
  error: unknown,
): string | undefined {
  return error instanceof Error &&
    grokRuntimeIncompatibilityCodes.has(error.message)
    ? error.message
    : undefined;
}

/**
 * The private dialect was established at the 1.0.4 compatibility floor. Stable
 * releases at or above that floor are admitted unless an exact release has
 * been excluded after review. Build identifiers remain bounded evidence, not a
 * compatibility key: rebuilding a compatible release must not disable the
 * configured backend.
 */
export function admitGrokRuntimeVersion(
  version: string,
  build: string,
): AdmittedGrokRuntimeVersion {
  const match = stableSemanticVersion.exec(version);
  if (!match) throw new Error("grok_runtime_version_invalid");
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    compareStableRuntimeVersions(version, GROK_ACP_REVIEWED_PROFILE_FLOOR) < 0
  ) {
    throw new Error("grok_runtime_version_incompatible");
  }
  const semanticCoreVersion = `${major}.${minor}.${patch}`;
  if (GROK_RUNTIME_EXCLUDED_RELEASES.has(semanticCoreVersion)) {
    throw new Error("grok_runtime_version_excluded");
  }
  if (!/^[0-9a-f]{7,64}$/u.test(build)) {
    throw new Error("grok_runtime_build_invalid");
  }
  const newerThanTested =
    compareStableRuntimeVersions(version, GROK_RUNTIME_TESTED_THROUGH_VERSION) >
    0;
  const assessment = Object.freeze({
    observedVersion: version,
    minimumVersion: GROK_ACP_REVIEWED_PROFILE_FLOOR,
    testedThroughVersion: GROK_RUNTIME_TESTED_THROUGH_VERSION,
    newerThanTested,
  });
  return Object.freeze({
    version,
    build,
    compatibilityRelease: GROK_ACP_COMPATIBILITY_RELEASE,
    reviewedProfile: GROK_ACP_REVIEWED_PROFILE,
    newerThanTested,
    assessment,
  });
}

/**
 * The reviewed standard-ACP image path begins at the stable 1.0.4 floor.
 * Runtime admission remains the authority for stable-release compatibility.
 */
export function admittedGrokRuntimeSupportsImageInput(
  runtime: AdmittedGrokRuntimeVersion,
): boolean {
  return (
    runtime.reviewedProfile === GROK_ACP_IMAGE_INPUT_PROFILE &&
    runtime.compatibilityRelease === GROK_ACP_COMPATIBILITY_RELEASE &&
    stableRuntimeAtLeast(runtime.version, GROK_ACP_IMAGE_INPUT_FLOOR)
  );
}

function stableRuntimeAtLeast(version: string, floor: string): boolean {
  return compareStableRuntimeVersions(version, floor) >= 0;
}

function compareStableRuntimeVersions(left: string, right: string): number {
  const candidate = stableSemanticVersion.exec(left);
  const minimum = stableSemanticVersion.exec(right);
  if (!candidate || !minimum) {
    throw new Error("grok_runtime_version_invalid");
  }
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(candidate[index]) - Number(minimum[index]);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export function decodeGrokVersionEvidence(
  stdout: Uint8Array,
  stderr: Uint8Array,
): AdmittedGrokRuntimeVersion {
  if (stdout.byteLength === 0 || stdout.byteLength > 4_096) {
    throw new Error("grok_runtime_version_probe_output_invalid");
  }
  if (stderr.byteLength !== 0) {
    throw new Error("grok_runtime_version_probe_unexpected_stderr");
  }
  const text = Buffer.from(stdout).toString("utf8");
  if (text.includes("\0")) {
    throw new Error("grok_runtime_version_probe_output_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("grok_runtime_version_probe_output_invalid");
  }
  const decoded = grokVersionEvidenceSchema.safeParse(value);
  if (!decoded.success) {
    throw new Error("grok_runtime_version_probe_output_invalid");
  }
  const evidence = decoded.data;
  const match = /^(\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?) \(([0-9a-f]+)\)$/u.exec(
    evidence.currentVersion,
  );
  if (!match) throw new Error("grok_runtime_version_probe_output_invalid");
  return admitGrokRuntimeVersion(match[1]!, match[2]!);
}

/**
 * The 1.0.4 floor established the dialect profile used for structural
 * admission for configured stable releases at or above that floor.
 */
export function assertGrokProductionProfileAdmitted(): void {
  // Static assertion keeps production composition coupled to the reviewed
  // profile constants without introducing a mutable runtime flag.
  if (
    GROK_ACP_REVIEWED_PROFILE !== "grok-acp/1.0.4" ||
    GROK_ACP_REVIEWED_PROFILE_FLOOR !== "1.0.4" ||
    GROK_RUNTIME_TESTED_THROUGH_VERSION !== "1.0.4"
  ) {
    throw new Error("grok_production_profile_admission_invalid");
  }
}
