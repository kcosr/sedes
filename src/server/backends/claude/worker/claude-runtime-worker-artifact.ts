import { CLAUDE_RUNTIME_WORKER_MINIMUM_NODE_VERSION } from "./claude-runtime-host-support.js";
import {
  loadManagedWorkerArtifact,
  registerManagedWorkerKind,
  type ManagedWorkerArtifactRegistration,
} from "../../../managed-workers/artifact.js";

export const CLAUDE_RUNTIME_WORKER_ARTIFACT_ID =
  "openai.sedes.claude-runtime-worker";
export const CLAUDE_RUNTIME_WORKER_FILENAME =
  "sedes-claude-runtime-worker.mjs";
export const CLAUDE_RUNTIME_WORKER_MAXIMUM_ARTIFACT_BYTES = 16 * 1_024 * 1_024;

export const CLAUDE_RUNTIME_WORKER_KIND = registerManagedWorkerKind({
  artifactId: CLAUDE_RUNTIME_WORKER_ARTIFACT_ID,
  filename: CLAUDE_RUNTIME_WORKER_FILENAME,
  modes: ["claude_runtime"],
  stateNamespace: "claude_runtime",
  inheritedEnvironmentNames: ["CLAUDE_CONFIG_DIR"],
  minimumNodeVersion: CLAUDE_RUNTIME_WORKER_MINIMUM_NODE_VERSION,
  maximumArtifactBytes: CLAUDE_RUNTIME_WORKER_MAXIMUM_ARTIFACT_BYTES,
  launchArguments: (identity) => [
    "supervise",
    "--carrier-generation",
    String(identity.carrierGeneration),
    "--session-nonce",
    identity.sessionNonce,
  ],
});

export function loadClaudeRuntimeWorkerArtifact(
  manifestPath: string,
): Promise<ManagedWorkerArtifactRegistration> {
  return loadManagedWorkerArtifact(CLAUDE_RUNTIME_WORKER_KIND, manifestPath);
}
