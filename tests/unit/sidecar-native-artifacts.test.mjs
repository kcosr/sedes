import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectSidecarNativeArtifacts,
  sidecarNodePtyPlugin,
} from "../../scripts/sidecar-native-artifacts.mjs";
import { inspectSidecarPortableNative } from "../../scripts/sidecar-native-portable.mjs";
import { inspectSidecarNativeElf } from "../../scripts/sidecar-native-elf.mjs";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const temporary = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-native-"));
  temporary.push(root);
  return root;
}
async function fixture() {
  const root = await directory();
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "node-pty", version: "1.1.0" }),
  );
  return root;
}
function elf(architecture, version = "2.28") {
  const names = Buffer.from(`\0libc.so.6\0GLIBC_2.2.5\0GLIBC_${version}\0`);
  const bytes = Buffer.alloc(384);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(architecture === "x64" ? 62 : 183, 18);
  bytes.writeBigUInt64LE(64n, 40);
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt16LE(3, 60);
  bytes.writeUInt32LE(3, 128 + 4);
  bytes.writeBigUInt64LE(256n, 128 + 24);
  bytes.writeBigUInt64LE(BigInt(names.length), 128 + 32);
  bytes.writeUInt32LE(0x6ffffffe, 192 + 4);
  bytes.writeBigUInt64LE(336n, 192 + 24);
  bytes.writeBigUInt64LE(48n, 192 + 32);
  bytes.writeUInt32LE(1, 192 + 40);
  bytes.set(names, 256);
  bytes.writeUInt16LE(1, 336);
  bytes.writeUInt16LE(2, 338);
  bytes.writeUInt32LE(1, 340);
  bytes.writeUInt32LE(16, 344);
  bytes.writeUInt32LE(names.indexOf("GLIBC_2.2.5"), 360);
  bytes.writeUInt32LE(16, 364);
  bytes.writeUInt32LE(names.indexOf(`GLIBC_${version}`), 376);
  return bytes;
}
async function prebuild(root, architecture, bytes = elf(architecture)) {
  const location = path.join(root, "prebuilds", `linux-${architecture}`);
  await mkdir(location, { recursive: true });
  await writeFile(path.join(location, "pty.node"), bytes);
  await writeFile(
    path.join(location, "sidecar-native.json"),
    JSON.stringify({ nodeModuleVersion: "137" }),
  );
  return location;
}

describe("persistent sidecar native packaging", () => {
  it("describes available architectures deterministically without leaking build paths into the manifest", async () => {
    const root = await fixture();
    await prebuild(root, "arm64");
    await prebuild(root, "x64");
    const result = await collectSidecarNativeArtifacts({ nodePtyRoot: root });
    expect(result.nativeAssets.map((asset) => asset.architecture)).toEqual([
      "x64",
      "arm64",
    ]);
    expect(result.nativeAssets[0]).toEqual({
      platform: "linux",
      architecture: "x64",
      nodeModuleVersion: "137",
      minimumGlibcVersion: "2.28",
      files: [
        {
          relativePath: "native/linux-x64/pty.node",
          sha256: createHash("sha256").update(elf("x64")).digest("hex"),
          size: elf("x64").length,
          mode: 0o500,
        },
      ],
    });
    expect(JSON.stringify(result.nativeAssets)).not.toContain(root);
    expect(result.sources[0].contents).toEqual(elf("x64"));
    expect(await collectSidecarNativeArtifacts({ nodePtyRoot: root })).toEqual(
      result,
    );
  });

  it("binds native payload bytes and available platforms into the JavaScript artifact digest", async () => {
    const root = await fixture();
    const location = await prebuild(root, "x64");
    const bundleDigest = async () => {
      const { nativeAssets } = await collectSidecarNativeArtifacts({
        nodePtyRoot: root,
      });
      const result = await build({
        stdin: {
          contents: "export { spawn } from 'node-pty';",
          resolveDir: process.cwd(),
        },
        bundle: true,
        platform: "node",
        format: "esm",
        write: false,
        plugins: [sidecarNodePtyPlugin(nativeAssets)],
      });
      return createHash("sha256")
        .update(result.outputFiles[0].contents)
        .digest("hex");
    };
    const initial = await bundleDigest();
    expect(await bundleDigest()).toBe(initial);
    const changed = elf("x64");
    changed[32] ^= 1; // Different native bytes, same valid architecture/ELF requirements.
    await writeFile(path.join(location, "pty.node"), changed);
    const changedNative = await bundleDigest();
    expect(changedNative).not.toBe(initial);
    await prebuild(root, "arm64");
    expect(await bundleDigest()).not.toBe(changedNative);
  });

  it("does not substitute a different architecture when an artifact is absent", async () => {
    const root = await fixture();
    expect(await collectSidecarNativeArtifacts({ nodePtyRoot: root })).toEqual({
      nativeAssets: [],
      sources: [],
    });
    await prebuild(root, "arm64");
    expect(
      (
        await collectSidecarNativeArtifacts({ nodePtyRoot: root })
      ).nativeAssets.map((asset) => asset.architecture),
    ).toEqual(["arm64"]);
  });

  it("rejects architecture spoofing, source symlinks, and missing cross-build ABI metadata", async () => {
    const root = await fixture();
    const location = await prebuild(root, "arm64", elf("x64"));
    await expect(
      collectSidecarNativeArtifacts({ nodePtyRoot: root }),
    ).rejects.toThrow("sidecar_native_architecture_invalid");
    await rm(path.join(location, "pty.node"));
    const outside = path.join(await directory(), "pty.node");
    await writeFile(outside, elf("arm64"));
    await symlink(outside, path.join(location, "pty.node"));
    await expect(
      collectSidecarNativeArtifacts({ nodePtyRoot: root }),
    ).rejects.toThrow("sidecar_native_source_invalid");
    await rm(path.join(location, "pty.node"));
    await writeFile(path.join(location, "pty.node"), elf("arm64"));
    await writeFile(path.join(location, "sidecar-native.json"), "{}");
    await expect(
      collectSidecarNativeArtifacts({ nodePtyRoot: root }),
    ).rejects.toThrow("sidecar_native_node_version_invalid");
  });

  it.each(["darwin", "win32"])(
    "packages real %s prebuilds with their inspected Node API and required helpers",
    async (platform) => {
      const nodePtyRoot = path.dirname(
        require.resolve("node-pty/package.json"),
      );
      const result = await collectSidecarNativeArtifacts({ nodePtyRoot });
      for (const architecture of ["x64", "arm64"]) {
        const asset = result.nativeAssets.find(
          (asset) =>
            asset.platform === platform && asset.architecture === architecture,
        );
        expect(asset.nodeApiVersion).toBe(8);
        expect(asset).not.toHaveProperty("nodeModuleVersion");
        expect(asset).not.toHaveProperty("minimumGlibcVersion");
        expect(
          asset.files.map((file) => path.basename(file.relativePath)),
        ).toEqual(
          platform === "darwin"
            ? ["pty.node", "spawn-helper"]
            : [
                "conpty.node",
                "conpty_console_list.node",
                "conout-worker.cjs",
                "console-list-agent.cjs",
              ],
        );
        for (const file of asset.files) {
          const source = result.sources.find(
            (source) => source.relativePath === file.relativePath,
          );
          expect(
            createHash("sha256").update(source.contents).digest("hex"),
          ).toBe(file.sha256);
          expect(file.mode).toBe(0o500);
        }
      }
      expect(() => sidecarNodePtyPlugin(result.nativeAssets)).not.toThrow();
    },
  );

  it.each(["darwin", "win32"])(
    "rejects mislabeled or truncated %s payloads",
    async (platform) => {
      const root = path.dirname(require.resolve("node-pty/package.json"));
      const bytes = await readFile(
        path.join(
          root,
          "prebuilds",
          `${platform}-x64`,
          platform === "darwin" ? "pty.node" : "conpty.node",
        ),
      );
      expect(() =>
        inspectSidecarPortableNative(bytes, platform, "arm64"),
      ).toThrow("sidecar_native_architecture_invalid");
      expect(() =>
        inspectSidecarPortableNative(bytes.subarray(0, 64), platform, "x64"),
      ).toThrow("sidecar_native_binary_invalid");
      const invalid = Buffer.from(bytes);
      invalid[0] ^= 1;
      expect(() =>
        inspectSidecarPortableNative(invalid, platform, "x64"),
      ).toThrow("sidecar_native_binary_invalid");
    },
  );

  it("fails packaging an incomplete Darwin helper pair", async () => {
    const root = await fixture();
    const destination = path.join(root, "prebuilds", "darwin-arm64");
    await mkdir(destination, { recursive: true });
    await copyFile(
      path.join(
        path.dirname(require.resolve("node-pty/package.json")),
        "prebuilds",
        "darwin-arm64",
        "pty.node",
      ),
      path.join(destination, "pty.node"),
    );
    await expect(
      collectSidecarNativeArtifacts({ nodePtyRoot: root }),
    ).rejects.toThrow("sidecar_native_payload_incomplete");
  });

  it("rejects remote path injection before bundling", () => {
    expect(() =>
      sidecarNodePtyPlugin([
        {
          platform: "linux",
          architecture: "x64",
          nodeModuleVersion: "137",
          minimumGlibcVersion: "2.28",
          files: [
            {
              relativePath: "../../pty.node",
              sha256: "a".repeat(64),
              size: 80,
              mode: 0o500,
            },
          ],
        },
      ]),
    ).toThrow("sidecar_native_manifest_invalid");
  });

  it("extracts actual ELF dependency requirements and rejects malformed section bounds", () => {
    expect(inspectSidecarNativeElf(elf("x64", "2.42"), "x64")).toEqual({
      minimumGlibcVersion: "2.42",
    });
    const contents = elf("x64");
    contents.writeBigUInt64LE(99999n, 40);
    expect(() => inspectSidecarNativeElf(contents, "x64")).toThrow(
      "sidecar_native_elf_invalid",
    );
    const cycle = elf("x64");
    cycle.writeUInt32LE(1, 364);
    expect(() => inspectSidecarNativeElf(cycle, "x64")).toThrow(
      "sidecar_native_elf_invalid",
    );
  });

  it.skipIf(
    !["linux", "darwin", "win32"].includes(process.platform) ||
      !["x64", "arm64"].includes(process.arch),
  )(
    "runs a packaged PTY independently and rejects tampered native content",
    async () => {
      const nodePtyRoot = path.dirname(
        require.resolve("node-pty/package.json"),
      );
      const { nativeAssets, sources } = await collectSidecarNativeArtifacts({
        nodePtyRoot,
      });
      expect(
        nativeAssets.some(
          (asset) =>
            asset.platform === process.platform &&
            asset.architecture === process.arch,
        ),
      ).toBe(true);
      const root = await directory();
      for (const source of sources) {
        const target = path.join(root, source.relativePath);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, source.contents, { mode: 0o500 });
      }
      const outfile = path.join(root, "sidecar.mjs");
      await build({
        stdin: {
          contents: `
if (process.argv[2] === 'old-glibc') process.report.getReport = () => ({header: {glibcVersionRuntime: '2.0'}});
const { spawn } = await import('node-pty');
const terminal = process.platform === 'win32' ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'echo SIDECAR_NATIVE_OK'], {env: process.env, cols: 80, rows: 24}) : spawn('/bin/sh', ['-c', 'printf SIDECAR_NATIVE_OK'], {env: {PATH: '/usr/bin:/bin'}, cols: 80, rows: 24});
terminal.onData(data => process.stdout.write(data));
terminal.onExit(event => {process.exitCode = event.exitCode});`,
          resolveDir: process.cwd(),
        },
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        plugins: [sidecarNodePtyPlugin(nativeAssets)],
        banner: {
          js: `import { createRequire as sidecarRequire } from 'node:module'; import { fileURLToPath as sidecarFilePath } from 'node:url'; import { dirname as sidecarDirname } from 'node:path'; const require = sidecarRequire(import.meta.url); const __dirname = sidecarDirname(sidecarFilePath(import.meta.url));`,
        },
      });
      expect(
        (
          await run(process.execPath, [outfile], {
            cwd: os.tmpdir(),
            timeout: 10_000,
          })
        ).stdout,
      ).toContain("SIDECAR_NATIVE_OK");
      if (process.platform === "linux")
        await expect(
          run(process.execPath, [outfile, "old-glibc"], { timeout: 10_000 }),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining(
            "sidecar_native_glibc_version_mismatch",
          ),
        });
      const nativePath = path.join(
        root,
        `native/${process.platform}-${process.arch}/${process.platform === "win32" ? "conpty.node" : "pty.node"}`,
      );
      const contents = await readFile(nativePath);
      contents[contents.length - 1] ^= 1;
      await chmod(nativePath, 0o700);
      await writeFile(nativePath, contents);
      await chmod(nativePath, 0o500);
      await expect(
        run(process.execPath, [outfile], { timeout: 10_000 }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("sidecar_native_digest_mismatch"),
      });
    },
  );
});
