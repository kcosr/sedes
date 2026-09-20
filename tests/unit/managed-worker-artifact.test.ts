import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertManagedWorkerArtifact,
  loadManagedWorkerArtifact,
  managedWorkerLaunchArguments,
  registerManagedWorkerKind,
  type ManagedWorkerArtifactRegistration,
} from "../../src/server/managed-workers/artifact.js";

const directories: string[] = [];
const kind = registerManagedWorkerKind({
  artifactId: "openai.sedes.test-worker",
  filename: "test-worker.mjs",
  modes: ["test_stdio"],
  stateNamespace: "test-worker",
  minimumNodeVersion: "24.18.0",
  maximumArtifactBytes: 1024,
  launchArguments: ({ carrierGeneration, sessionNonce }) => [
    "serve", "--stdio", "--session-nonce", sessionNonce,
    "--carrier-generation", String(carrierGeneration),
  ],
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((value) =>
    rm(value, { recursive: true, force: true })));
});

describe("managed worker artifact", () => {
  it("loads only an exact owner-mode digest-verified manifest", async () => {
    const artifact = await fixture();
    expect(artifact).toMatchObject({
      kind,
      artifactBytes: 20,
      buildId: "sedes-test",
    });
    expect(() => assertManagedWorkerArtifact(artifact)).not.toThrow();
  });

  it("rejects structurally forged registrations", () => {
    expect(() => assertManagedWorkerArtifact({} as ManagedWorkerArtifactRegistration))
      .toThrow("managed_worker_artifact_unregistered");
  });

  it("derives closed launch arguments only from generation identity", () => {
    expect(managedWorkerLaunchArguments(kind, {
      carrierGeneration: 7,
      sessionNonce: "abcdefghijklmnopqrstuvwxyz_0123456789",
    })).toEqual([
      "serve", "--stdio", "--session-nonce",
      "abcdefghijklmnopqrstuvwxyz_0123456789", "--carrier-generation", "7",
    ]);
  });

  it("rejects digest drift", async () => {
    const artifact = await fixture();
    await chmod(artifact.executablePath, 0o600);
    await writeFile(artifact.executablePath, "changed");
    await chmod(artifact.executablePath, 0o500);
    await expect(loadManagedWorkerArtifact(
      kind,
      path.join(artifact.executableDirectory, "manifest.json"),
    )).rejects.toThrow(/managed_worker_artifact_(invalid|digest_mismatch)/u);
  });
});

async function fixture(): Promise<ManagedWorkerArtifactRegistration> {
  const directory = await mkdtemp(path.join(tmpdir(), "managed-worker-"));
  directories.push(directory);
  const bytes = Buffer.from("#!/usr/bin/env node\n");
  const executablePath = path.join(directory, kind.filename);
  await writeFile(executablePath, bytes, { mode: 0o500 });
  await chmod(executablePath, 0o500);
  const manifestPath = path.join(directory, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    artifactId: kind.artifactId,
    filename: kind.filename,
    modes: kind.modes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength,
    buildId: "sedes-test",
    minimumNodeVersion: kind.minimumNodeVersion,
  })}\n`, { mode: 0o400 });
  await chmod(manifestPath, 0o400);
  return await loadManagedWorkerArtifact(kind, manifestPath);
}
