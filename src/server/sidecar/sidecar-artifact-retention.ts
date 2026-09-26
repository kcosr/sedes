import path from "node:path";
import { pruneUnreferencedBuilds } from "../runtime/artifact-retention.js";

/** Superseded sidecar builds kept for rollback beside the running one. */
const RETAINED_PREVIOUS_SIDECAR_BUILDS = 3;
const SIDECAR_BUILD_MINIMUM_PRUNE_AGE_MILLISECONDS = 60 * 60 * 1_000;

/**
 * Called once the daemon records itself running from the account's artifact
 * store. Every service scope and carrier on the account shares that store, so
 * a build is removed only when it is not the running build, not among the
 * newest retained builds, not recently installed, and not named by any live
 * process command line. A daemon started from outside the store prunes nothing.
 */
export async function pruneSupersededSidecarArtifacts(input: {
  readonly stateRoot: string;
  readonly executablePath: string;
  readonly artifactSha256: string;
}): Promise<readonly string[]> {
  const root = path.join(input.stateRoot, "artifacts", "sha256");
  if (!/^[0-9a-f]{64}$/u.test(input.artifactSha256) ||
      path.dirname(input.executablePath) !== path.join(root, input.artifactSha256)) {
    return [];
  }
  return await pruneUnreferencedBuilds({
    root,
    keep: new Set([input.artifactSha256]),
    retain: RETAINED_PREVIOUS_SIDECAR_BUILDS,
    minimumAgeMilliseconds: SIDECAR_BUILD_MINIMUM_PRUNE_AGE_MILLISECONDS,
    namePattern: /^[0-9a-f]{64}$/u,
  });
}
