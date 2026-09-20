import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { PiSandboxWorkerArtifact } from "./contracts.js";

export const PI_SANDBOX_WORKER_ARTIFACT_ID =
  "openai.sedes.pi-sandbox-worker" as const;
export const PI_SANDBOX_WORKER_FILENAME = "sedes-pi-sandbox-worker.mjs";
export const PI_SANDBOX_WORKER_MINIMUM_NODE_VERSION = "24.18.0" as const;
const MAXIMUM_ARTIFACT_BYTES = 32 * 1024 * 1024;

export interface PiSandboxWorkerArtifactRegistration
  extends PiSandboxWorkerArtifact {
  readonly artifactId: typeof PI_SANDBOX_WORKER_ARTIFACT_ID;
  readonly bytes: number;
  readonly minimumNodeVersion: typeof PI_SANDBOX_WORKER_MINIMUM_NODE_VERSION;
}

export async function loadPiSandboxWorkerArtifact(
  manifestPath: string,
): Promise<PiSandboxWorkerArtifactRegistration> {
  if (!path.isAbsolute(manifestPath) || path.resolve(manifestPath) !== manifestPath) {
    throw new Error("pi_sandbox_worker_manifest_path_invalid");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  if (
    Object.keys(manifest).sort().join("\0") !==
      [
        "artifactId",
        "buildId",
        "bytes",
        "filename",
        "minimumNodeVersion",
        "schemaVersion",
        "sha256",
      ]
        .sort()
        .join("\0") ||
    manifest.schemaVersion !== 1 ||
    manifest.artifactId !== PI_SANDBOX_WORKER_ARTIFACT_ID ||
    manifest.filename !== PI_SANDBOX_WORKER_FILENAME ||
    manifest.minimumNodeVersion !== PI_SANDBOX_WORKER_MINIMUM_NODE_VERSION ||
    typeof manifest.buildId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(manifest.buildId) ||
    typeof manifest.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.bytes) ||
    (manifest.bytes as number) <= 0 ||
    (manifest.bytes as number) > MAXIMUM_ARTIFACT_BYTES
  ) {
    throw new Error("pi_sandbox_worker_manifest_invalid");
  }
  const executablePath = path.join(path.dirname(manifestPath), PI_SANDBOX_WORKER_FILENAME);
  const metadata = await lstat(executablePath).catch(() => undefined);
  if (
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o500 ||
    metadata.size !== manifest.bytes ||
    (await realpath(executablePath).catch(() => "")) !== executablePath
  ) {
    throw new Error("pi_sandbox_worker_artifact_invalid");
  }
  const bytes = await readFile(executablePath);
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
    throw new Error("pi_sandbox_worker_digest_mismatch");
  }
  return Object.freeze({
    artifactId: PI_SANDBOX_WORKER_ARTIFACT_ID,
    executablePath,
    buildId: manifest.buildId,
    sha256: manifest.sha256,
    bytes: manifest.bytes as number,
    minimumNodeVersion: PI_SANDBOX_WORKER_MINIMUM_NODE_VERSION,
  });
}
