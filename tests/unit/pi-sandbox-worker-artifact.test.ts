import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPiSandboxWorkerArtifact,
  PI_SANDBOX_WORKER_ARTIFACT_ID,
  PI_SANDBOX_WORKER_FILENAME,
  PI_SANDBOX_WORKER_MINIMUM_NODE_VERSION,
} from "../../src/server/pi-sandbox/pi-sandbox-worker-artifact.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Pi sandbox worker artifact", () => {
  it("loads only the exact owner-mode bundle and strict manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-pi-worker-"));
    roots.push(root);
    const artifact = Buffer.from("#!/usr/bin/env node\n", "utf8");
    const executablePath = path.join(root, PI_SANDBOX_WORKER_FILENAME);
    await writeFile(executablePath, artifact);
    await chmod(executablePath, 0o500);
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        artifactId: PI_SANDBOX_WORKER_ARTIFACT_ID,
        filename: PI_SANDBOX_WORKER_FILENAME,
        sha256: createHash("sha256").update(artifact).digest("hex"),
        bytes: artifact.byteLength,
        buildId: "fixture-build",
        minimumNodeVersion: PI_SANDBOX_WORKER_MINIMUM_NODE_VERSION,
      }),
    );
    await expect(
      loadPiSandboxWorkerArtifact(manifestPath),
    ).resolves.toMatchObject({
      executablePath,
      bytes: artifact.byteLength,
      buildId: "fixture-build",
    });
    await chmod(executablePath, 0o700);
    await expect(loadPiSandboxWorkerArtifact(manifestPath)).rejects.toThrow(
      "pi_sandbox_worker_artifact_invalid",
    );
  });

  it("rejects additive manifest authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-pi-worker-"));
    roots.push(root);
    const artifact = Buffer.from("x");
    const executablePath = path.join(root, PI_SANDBOX_WORKER_FILENAME);
    await writeFile(executablePath, artifact);
    await chmod(executablePath, 0o500);
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        artifactId: PI_SANDBOX_WORKER_ARTIFACT_ID,
        filename: PI_SANDBOX_WORKER_FILENAME,
        sha256: createHash("sha256").update(artifact).digest("hex"),
        bytes: artifact.byteLength,
        buildId: "fixture-build",
        minimumNodeVersion: PI_SANDBOX_WORKER_MINIMUM_NODE_VERSION,
        extraMount: "/home",
      }),
    );
    await expect(loadPiSandboxWorkerArtifact(manifestPath)).rejects.toThrow(
      "pi_sandbox_worker_manifest_invalid",
    );
  });

  it("rejects an exact-shape manifest when the worker digest does not match", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-pi-worker-"));
    roots.push(root);
    const artifact = Buffer.from("#!/usr/bin/env node\n", "utf8");
    const executablePath = path.join(root, PI_SANDBOX_WORKER_FILENAME);
    await writeFile(executablePath, artifact);
    await chmod(executablePath, 0o500);
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        artifactId: PI_SANDBOX_WORKER_ARTIFACT_ID,
        filename: PI_SANDBOX_WORKER_FILENAME,
        sha256: createHash("sha256").update("different worker").digest("hex"),
        bytes: artifact.byteLength,
        buildId: "fixture-build",
        minimumNodeVersion: PI_SANDBOX_WORKER_MINIMUM_NODE_VERSION,
      }),
    );

    await expect(loadPiSandboxWorkerArtifact(manifestPath)).rejects.toThrow(
      "pi_sandbox_worker_digest_mismatch",
    );
  });
});
