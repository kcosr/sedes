import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSanitizedSidecarEnvironment } from "../../src/server/sidecar/sanitized-sidecar-environment.js";
import { REMOTE_BOOTSTRAP_SOURCE } from "../../src/server/sidecar/sidecar-artifact-bootstrap.js";
import type { SidecarNativeAsset } from "../../src/server/sidecar/sidecar-artifact.js";

const roots: string[] = [];
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "sedes-native-install-"));
  roots.push(home);
  const executable = Buffer.from("script fixture");
  const native = Buffer.alloc(128, 42);
  const assets: SidecarNativeAsset[] = [
    {
      platform: "linux",
      architecture: "x64",
      nodeModuleVersion: "137",
      minimumGlibcVersion: "2.28",
      files: [
        {
          relativePath: "native/linux-x64/pty.node",
          sha256: digest(native),
          size: native.length,
          mode: 0o500,
        },
      ],
    },
  ];
  return {
    home,
    executable,
    native,
    assets,
    payload: Buffer.concat([executable, native]),
    target: path.join(
      home,
      ".local/state/sedes/sidecar/artifacts/sha256",
      digest(executable),
    ),
  };
}

async function runBootstrap(
  input: Awaited<ReturnType<typeof fixture>>,
  payload = input.payload,
  assets: unknown = input.assets,
  targetEnvironment: NodeJS.ProcessEnv = {},
) {
  // Root-run CI simulates a separately owned trusted launcher, as the installer
  // authority tests do. Account-owned artifact/namespace metadata is untouched.
  const launcher = await realpath("/usr/bin/env");
  const chain: string[] = [];
  for (let entry = launcher; ; entry = path.dirname(entry)) {
    chain.push(entry);
    if (entry === "/") break;
  }
  const prelude =
    process.geteuid?.() === 0
      ? `const originalLstat=require('node:fs').promises.lstat;require('node:fs').promises.lstat=async(...args)=>{const value=await originalLstat(...args);if(${JSON.stringify(chain)}.includes(args[0]))Object.defineProperty(value,'uid',{value:65534});return value};`
      : "";
  const source =
    prelude +
    REMOTE_BOOTSTRAP_SOURCE.replace(
      "o.userInfo().homedir",
      JSON.stringify(input.home),
    );
  const child = spawn(
    process.execPath,
    [
      "-e",
      source,
      digest(input.executable),
      "native-fixture",
      String(input.executable.length),
      Buffer.from(JSON.stringify(assets)).toString("base64url"),
    ],
    {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: input.home,
        ...targetEnvironment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let sent = false;
  child.stdout.on("data", (bytes: Buffer) => {
    stdout.push(bytes);
    if (!sent && Buffer.concat(stdout).includes("send\n")) {
      sent = true;
      child.stdin.end(payload);
    }
  });
  child.stderr.on("data", (bytes: Buffer) => stderr.push(bytes));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
    sent,
  };
}

describe("sidecar release bootstrap", () => {
  it("admits the target login Claude directory without forwarding main-server values", async () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/main/private-claude");
    vi.stubEnv("ANTHROPIC_API_KEY", "main-provider-secret");
    const input = await fixture();
    const run = await runBootstrap(input, input.payload, input.assets, {
      CLAUDE_CONFIG_DIR: "/target/provider-account/claude",
      ANTHROPIC_API_KEY: "target-provider-secret",
      NODE_OPTIONS: "--trace-warnings",
    });
    expect(run.exitCode).toBe(0);
    const proof = JSON.parse(
      run.stdout
        .split("\n")
        .find((line) => line.startsWith("ready "))!
        .slice(6),
    );
    expect(proof.environment.CLAUDE_CONFIG_DIR).toBe(
      "/target/provider-account/claude",
    );
    expect(proof.environment).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(proof.environment).not.toHaveProperty("NODE_OPTIONS");
    expect(run.stdout).not.toContain("/main/private-claude");
    const noOverride = await runBootstrap(input);
    const nativeProof = JSON.parse(
      noOverride.stdout
        .split("\n")
        .find((line) => line.startsWith("ready "))!
        .slice(6),
    );
    expect(nativeProof.environment).not.toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it.each([
    "/target/claude\nINJECTED=value",
    "/target/claude\r",
    "x".repeat(4097),
  ])(
    "rejects unsafe target Claude directory value %# instead of changing provider homes",
    async (value) => {
      const input = await fixture();
      const run = await runBootstrap(input, input.payload, input.assets, {
        CLAUDE_CONFIG_DIR: value,
      });
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toBe("sidecar_claude_config_directory_invalid");
      expect(run.stdout).not.toContain("ready ");
    },
  );

  it("sanitizes only supplied target Claude configuration with the existing environment bounds", () => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/main/private-claude");
    expect(
      buildSanitizedSidecarEnvironment({
        HOME: "/target",
        CLAUDE_CONFIG_DIR: "/target/custom claude",
        ANTHROPIC_API_KEY: "secret",
        NODE_OPTIONS: "--inspect",
      }),
    ).toEqual({ HOME: "/target", CLAUDE_CONFIG_DIR: "/target/custom claude" });
    expect(
      buildSanitizedSidecarEnvironment({ HOME: "/target" }),
    ).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    for (const value of [
      "bad\0path",
      "bad\npath",
      "bad\rpath",
      "x".repeat(4097),
    ]) {
      expect(() =>
        buildSanitizedSidecarEnvironment({ CLAUDE_CONFIG_DIR: value }),
      ).toThrow("sidecar_claude_config_directory_invalid");
    }
  });

  it("publishes a complete verified native release atomically and recognizes its cache", async () => {
    const input = await fixture();
    expect(await runBootstrap(input)).toMatchObject({
      exitCode: 0,
      stderr: "",
      sent: true,
    });
    expect(await readFile(path.join(input.target, "sedes"))).toEqual(
      input.executable,
    );
    const filename = path.join(
      input.target,
      input.assets[0]!.files[0].relativePath,
    );
    expect(await readFile(filename)).toEqual(input.native);
    expect((await lstat(filename)).mode & 0o777).toBe(0o500);
    expect((await lstat(path.dirname(filename))).mode & 0o777).toBe(0o700);
    expect(await runBootstrap(input)).toMatchObject({
      exitCode: 0,
      stderr: "",
      sent: false,
    });
  });

  it("installs all portable helpers in release order over the existing SSH upload", async () => {
    const input = await fixture();
    const payloads: Buffer[] = [input.native];
    for (const platform of ["darwin", "win32"] as const) {
      const names =
        platform === "darwin"
          ? ["pty.node", "spawn-helper"]
          : [
              "conpty.node",
              "conpty_console_list.node",
              "conout-worker.cjs",
              "console-list-agent.cjs",
            ];
      const files = names.map((name, index) => {
        const bytes = Buffer.alloc(128, index + 3);
        payloads.push(bytes);
        return {
          relativePath: `native/${platform}-arm64/${name}` as const,
          sha256: digest(bytes),
          size: bytes.length,
          mode: 0o500 as const,
        };
      });
      input.assets.push({
        platform,
        architecture: "arm64",
        nodeApiVersion: 8,
        files: files as [(typeof files)[number], ...(typeof files)[number][]],
      });
    }
    input.payload = Buffer.concat([input.executable, ...payloads]);
    expect(await runBootstrap(input)).toMatchObject({
      exitCode: 0,
      stderr: "",
      sent: true,
    });
    let index = 0;
    for (const asset of input.assets)
      for (const file of asset.files) {
        expect(
          await readFile(path.join(input.target, file.relativePath)),
        ).toEqual(payloads[index++]);
      }
    expect(await runBootstrap(input)).toMatchObject({
      exitCode: 0,
      stderr: "",
      sent: false,
    });
  });

  it("rejects a corrupt or truncated native upload without publishing a digest directory", async () => {
    const input = await fixture();
    const changed = Buffer.from(input.payload);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    expect(await runBootstrap(input, changed)).toMatchObject({
      exitCode: 1,
      stderr: "sidecar_install_digest_mismatch",
    });
    await expect(lstat(input.target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await runBootstrap(input, input.payload.subarray(0, -1)),
    ).toMatchObject({
      exitCode: 1,
      stderr: "sidecar_install_payload_size_invalid",
    });
    await expect(lstat(input.target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects manifest traversal and a cached native-directory symlink", async () => {
    const input = await fixture();
    const badAssets = [
      {
        ...input.assets[0],
        files: [
          { ...input.assets[0]!.files[0], relativePath: "../outside.node" },
        ],
      },
    ];
    expect(await runBootstrap(input, input.payload, badAssets)).toMatchObject({
      exitCode: 1,
      stderr: "sidecar_install_native_manifest_invalid",
      sent: false,
    });
    expect((await runBootstrap(input)).exitCode).toBe(0);
    const nativeDirectory = path.join(input.target, "native/linux-x64");
    await chmod(path.join(nativeDirectory, "pty.node"), 0o700);
    await rm(nativeDirectory, { recursive: true });
    await symlink(input.home, nativeDirectory);
    expect(await runBootstrap(input)).toMatchObject({
      exitCode: 1,
      stderr: "sidecar_install_namespace_invalid",
      sent: false,
    });
  });
});
