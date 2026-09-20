import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SIDECAR_MINIMUM_NODE_VERSION,
  supportsSidecarNodeVersion,
} from "../../src/internal/sidecar-protocol/sidecar-runtime-version.js";
import {
  loadSidecarArtifactRegistration,
  readVerifiedSidecarArtifact,
  readVerifiedSidecarArtifactPayload,
  validSidecarNativeAssets,
} from "../../src/server/sidecar/sidecar-artifact.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("sidecar artifact registration", () => {
  it("loads and rechecks a bundle with no native asset for this release", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-sidecar-artifact-"));
    roots.push(root);
    const artifact = Buffer.from("#!/usr/bin/env node\n", "utf8");
    const filename = "sedes";
    await writeFile(path.join(root, filename), artifact);
    await chmod(path.join(root, filename), 0o500);
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 6,
        artifactId: "openai.sedes.sidecar",
        filename,
        modes: ["agent_tools_cli", "persistent_service"],
        nativeAssets: [],
        sha256: createHash("sha256").update(artifact).digest("hex"),
        bytes: artifact.byteLength,
        buildId: "fixture-build",
        minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION,
      }),
    );
    const registration = await loadSidecarArtifactRegistration(manifestPath);
    expect(registration).toMatchObject({
      modes: ["agent_tools_cli", "persistent_service"],
      executableDirectory: root,
      executablePath: path.join(root, "sedes"),
    });
    await expect(readVerifiedSidecarArtifact(registration)).resolves.toEqual(
      artifact,
    );
    await chmod(path.join(root, filename), 0o600);
    await writeFile(path.join(root, filename), "changed");
    await expect(readVerifiedSidecarArtifact(registration)).rejects.toThrow(
      /sidecar_artifact_(?:file_invalid|digest_mismatch)/u,
    );
  });

  it("verifies and uploads native bytes in exact manifest order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-sidecar-native-"));
    roots.push(root);
    const executable = Buffer.from("bundle");
    const native = Buffer.alloc(128, 7);
    const nativePath = path.join(root, "native/linux-x64/pty.node");
    await mkdir(path.dirname(nativePath), { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, "sedes"), executable, { mode: 0o500 });
    await writeFile(nativePath, native, { mode: 0o500 });
    const manifest = {
      schemaVersion: 6,
      artifactId: "openai.sedes.sidecar",
      filename: "sedes",
      modes: ["agent_tools_cli", "persistent_service"],
      sha256: createHash("sha256").update(executable).digest("hex"),
      bytes: executable.length,
      buildId: "native-build",
      minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION,
      nativeAssets: [
        {
          platform: "linux",
          architecture: "x64",
          nodeModuleVersion: "137",
          minimumGlibcVersion: "2.28",
          files: [
            {
              relativePath: "native/linux-x64/pty.node",
              sha256: createHash("sha256").update(native).digest("hex"),
              size: native.length,
              mode: 0o500,
            },
          ],
        },
      ],
    };
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const registration = await loadSidecarArtifactRegistration(manifestPath);
    await expect(
      readVerifiedSidecarArtifactPayload(registration),
    ).resolves.toEqual(Buffer.concat([executable, native]));
    await chmod(nativePath, 0o700);
    await writeFile(nativePath, Buffer.alloc(native.length, 8));
    await chmod(nativePath, 0o500);
    await expect(
      readVerifiedSidecarArtifactPayload(registration),
    ).rejects.toThrow("sidecar_native_artifact_digest_mismatch");
    await rm(nativePath);
    await symlink(path.join(root, "sedes"), nativePath);
    await expect(loadSidecarArtifactRegistration(manifestPath)).rejects.toThrow(
      "sidecar_native_artifact_file_invalid",
    );
    manifest.nativeAssets[0]!.files[0]!.relativePath = "../outside.node";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(loadSidecarArtifactRegistration(manifestPath)).rejects.toThrow(
      "sidecar_artifact_manifest_invalid",
    );
  });

  it.each(["darwin", "win32"] as const)(
    "admits all required %s files and rejects missing or reordered helpers",
    async (platform) => {
      const root = await mkdtemp(path.join(tmpdir(), "h-sidecar-portable-"));
      roots.push(root);
      const executable = Buffer.from("bundle");
      await writeFile(path.join(root, "sedes"), executable, { mode: 0o500 });
      const names =
        platform === "darwin"
          ? ["pty.node", "spawn-helper"]
          : [
              "conpty.node",
              "conpty_console_list.node",
              "conout-worker.cjs",
              "console-list-agent.cjs",
            ];
      const payloads = names.map((_, index) => Buffer.alloc(128, index + 1));
      const files = names.map((name, index) => ({
        relativePath: `native/${platform}-arm64/${name}`,
        sha256: createHash("sha256").update(payloads[index]!).digest("hex"),
        size: 128,
        mode: 0o500,
      }));
      for (const [index, file] of files.entries()) {
        const filename = path.join(root, file.relativePath);
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        await writeFile(filename, payloads[index]!, { mode: 0o500 });
      }
      const asset = {
        platform,
        architecture: "arm64",
        nodeApiVersion: 8,
        files,
      };
      expect(validSidecarNativeAssets([asset])).toBe(true);
      expect(validSidecarNativeAssets([asset, asset])).toBe(false);
      expect(
        validSidecarNativeAssets([{ ...asset, files: files.slice(0, -1) }]),
      ).toBe(false);
      expect(
        validSidecarNativeAssets([{ ...asset, files: [...files].reverse() }]),
      ).toBe(false);
      expect(validSidecarNativeAssets([{ ...asset, nodeApiVersion: 0 }])).toBe(
        false,
      );
      expect(
        validSidecarNativeAssets([{ ...asset, nodeModuleVersion: "137" }]),
      ).toBe(false);
      const manifestPath = path.join(root, "manifest.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: 6,
          artifactId: "openai.sedes.sidecar",
          filename: "sedes",
          modes: ["agent_tools_cli", "persistent_service"],
          nativeAssets: [asset],
          sha256: createHash("sha256").update(executable).digest("hex"),
          bytes: executable.length,
          buildId: "portable-test",
          minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION,
        }),
      );
      const registration = await loadSidecarArtifactRegistration(manifestPath);
      expect(await readVerifiedSidecarArtifactPayload(registration)).toEqual(
        Buffer.concat([executable, ...payloads]),
      );
      const helper = path.join(root, files[files.length - 1]!.relativePath);
      await chmod(helper, 0o700);
      await writeFile(helper, Buffer.alloc(128, 9));
      await chmod(helper, 0o500);
      await expect(
        readVerifiedSidecarArtifactPayload(registration),
      ).rejects.toThrow("sidecar_native_artifact_digest_mismatch");
    },
  );

  it("admits the exact Node 22.19 floor and newer releases", () => {
    expect(supportsSidecarNodeVersion("22.18.9")).toBe(false);
    expect(supportsSidecarNodeVersion("22.19.0")).toBe(true);
    expect(supportsSidecarNodeVersion("22.22.1")).toBe(true);
    expect(supportsSidecarNodeVersion("24.18.0")).toBe(true);
    expect(supportsSidecarNodeVersion("22.19.0-nightly")).toBe(false);
    expect(supportsSidecarNodeVersion("invalid")).toBe(false);
  });

  it("rejects an obsolete manifest schema", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-sidecar-artifact-"));
    roots.push(root);
    const artifact = Buffer.from("#!/usr/bin/env node\n", "utf8");
    await writeFile(path.join(root, "sedes"), artifact);
    await chmod(path.join(root, "sedes"), 0o500);
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 4,
        artifactId: "openai.sedes.sidecar",
        filename: "sedes",
        sha256: createHash("sha256").update(artifact).digest("hex"),
        bytes: artifact.byteLength,
        buildId: "fixture-build",
        minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION,
      }),
    );

    await expect(loadSidecarArtifactRegistration(manifestPath)).rejects.toThrow(
      "sidecar_artifact_manifest_invalid",
    );
  });
});
