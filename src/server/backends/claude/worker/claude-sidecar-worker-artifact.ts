import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ManagedWorkerArtifactRegistration } from "../../../managed-workers/artifact.js";
import {
  CLAUDE_RUNTIME_WORKER_FILENAME,
  CLAUDE_RUNTIME_WORKER_MAXIMUM_ARTIFACT_BYTES,
  loadClaudeRuntimeWorkerArtifact,
} from "./claude-runtime-worker-artifact.js";

declare const __SEDES_CLAUDE_WORKER_SOURCE__: string;
declare const __SEDES_CLAUDE_WORKER_MANIFEST__: string;

/** The sidecar digest covers this separately built, source-audited worker.
 * It remains a subprocess: SDK account configuration is process-global. */
export async function installEmbeddedClaudeWorker(serviceDirectory: string): Promise<ManagedWorkerArtifactRegistration> {
  return await installClaudeWorkerBundle(serviceDirectory, {
    source: __SEDES_CLAUDE_WORKER_SOURCE__,
    manifest: __SEDES_CLAUDE_WORKER_MANIFEST__,
  });
}

/** Only installation-owned build bytes enter this function, never wire input. */
export async function installClaudeWorkerBundle(
  serviceDirectory: string,
  bundle: { readonly source: string; readonly manifest: string },
): Promise<ManagedWorkerArtifactRegistration> {
  await assertPrivateDirectory(serviceDirectory);
  const bytes = Buffer.from(bundle.source, "utf8");
  if (bytes.length === 0 || bytes.length > CLAUDE_RUNTIME_WORKER_MAXIMUM_ARTIFACT_BYTES) {
    throw new Error("claude_sidecar_worker_bundle_invalid");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifest = JSON.parse(bundle.manifest) as Record<string, unknown>;
  if (manifest.sha256 !== digest || manifest.bytes !== bytes.length) {
    throw new Error("claude_sidecar_worker_bundle_invalid");
  }
  const root = path.join(serviceDirectory, "claude-workers");
  await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await assertPrivateDirectory(root);
  const destination = path.join(root, digest);
  const manifestPath = path.join(destination, "manifest.json");
  if (await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  })) return await verifyInstalled();

  const staging = await mkdtemp(path.join(root, ".install-"));
  try {
    await chmod(staging, 0o700);
    await writeFile(path.join(staging, CLAUDE_RUNTIME_WORKER_FILENAME), bytes, { flag: "wx", mode: 0o500 });
    await writeFile(path.join(staging, "manifest.json"), bundle.manifest, { flag: "wx", mode: 0o400 });
    // Validate the complete manifest before publishing this artifact directory.
    await loadClaudeRuntimeWorkerArtifact(path.join(staging, "manifest.json"));
    await rename(staging, destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    });
    return await verifyInstalled();
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  async function verifyInstalled(): Promise<ManagedWorkerArtifactRegistration> {
    await assertPrivateDirectory(destination);
    const artifact = await loadClaudeRuntimeWorkerArtifact(manifestPath);
    if (artifact.artifactSha256 !== digest || await readFile(manifestPath, "utf8") !== bundle.manifest) {
      throw new Error("claude_sidecar_worker_bundle_mismatch");
    }
    return artifact;
  }
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory ||
      !metadata.isDirectory() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o700 || metadata.uid !== process.getuid?.() ||
      await realpath(directory) !== directory) {
    throw new Error("claude_sidecar_worker_directory_invalid");
  }
}
