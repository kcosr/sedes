import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { verifyServerRelease } = await import(new URL("../../scripts/install-server-runtime.mjs", import.meta.url).href);
const { writePackageIntegrity, verifyPackageIntegrity } = await import(new URL("../../scripts/server-package-integrity.mjs", import.meta.url).href);

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-package-integrity-"));
  try {
    await mkdir(path.join(root, "bin"));
    await writeFile(path.join(root, "bin", "server"), "#!/bin/sh\n", { mode: 0o755 });
    await symlink("server", path.join(root, "bin", "linked"));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "@sedes/server-runtime", version: "1.0.0" }));
    await writeFile(path.join(root, "BUILD-INFO.json"), JSON.stringify({
      format: 1, version: "1.0.0", source: { commit: "a".repeat(40) },
      target: { platform: process.platform, arch: process.arch, label: `${process.platform === "darwin" ? "macos" : process.platform}-${process.arch === "x64" ? "x86_64" : process.arch}` },
      node: { minimum: "24.18.0", version: process.version, abi: process.versions.modules },
    }));
    await writePackageIntegrity(root);
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("offline server package verification", () => {
  it("verifies bytes, executable permissions and relative symlinks before offline smoke", async () => {
    await fixture(async (root) => {
      const calls: {command: string, args: string[], options: {env: NodeJS.ProcessEnv}}[] = [];
      await verifyServerRelease(root, { NODE_ENV: "production", PATH: process.env.PATH }, {
        execute: async (command: string, args: string[], options: {env: NodeJS.ProcessEnv}) => { calls.push({ command, args, options }); },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toBe(process.execPath);
      expect(calls[0]?.args).toEqual([path.join(root, "scripts", "verify-server-package.mjs"), "--package", root]);
      expect(calls[0]?.options.env.NODE_ENV).toBeUndefined();
      expect(calls[0]?.args.join(" ")).not.toMatch(/npm|rebuild/);
    });
  });
  it.each(["bytes", "permissions", "symlink", "extra", "missing", "checksums"])("refuses %s corruption before executing any release code", async (kind) => {
    await fixture(async (root) => {
      if (kind === "bytes") await writeFile(path.join(root, "bin", "server"), "damaged");
      if (kind === "permissions") await chmod(path.join(root, "bin", "server"), 0o644);
      if (kind === "symlink") {
        await rm(path.join(root, "bin", "linked"));
        await symlink("../package.json", path.join(root, "bin", "linked"));
      }
      if (kind === "extra") await writeFile(path.join(root, "extra"), "unexpected");
      if (kind === "missing") await rm(path.join(root, "bin", "server"));
      if (kind === "checksums") await writeFile(path.join(root, "SHA256SUMS"), "invalid");
      let executed = false;
      await expect(verifyServerRelease(root, {}, { execute: async () => { executed = true; } })).rejects.toThrow(/mismatch/);
      expect(executed).toBe(false);
    });
  });
  it.each([
    { nodeVersion: "24.17.9" }, { nodeVersion: "23.99.0" }, { nodeAbi: "wrong" },
    { platform: "win32" }, { arch: "other" },
  ])("refuses an incompatible target runtime %j", async (options) => {
    await fixture(async (root) => {
      await expect(verifyPackageIntegrity(root, options)).rejects.toThrow(/require|does not match/);
    });
  });
  it("allows installer metadata only for installed releases and still checks wrappers", async () => {
    await fixture(async (root) => {
      await writeFile(path.join(root, "RELEASE.json"), "{}");
      await expect(verifyPackageIntegrity(root)).rejects.toThrow("RELEASE.json");
      await expect(verifyPackageIntegrity(root, { installed: true })).resolves.toMatchObject({ version: "1.0.0" });
      await chmod(path.join(root, "bin", "server"), 0o644);
      await expect(verifyPackageIntegrity(root, { installed: true })).rejects.toThrow("bin/server");
    });
  });
  it("rejects links escaping the release even when generating an inventory", async () => {
    await fixture(async (root) => {
      await symlink("../../outside", path.join(root, "bin", "escape"));
      await expect(writePackageIntegrity(root)).rejects.toThrow("escapes release");
    });
  });
  it("rejects build metadata for a different manifest version", async () => {
    await fixture(async (root) => {
      const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
      await writeFile(path.join(root, "package.json"), JSON.stringify({ ...manifest, version: "2.0.0" }));
      await writePackageIntegrity(root);
      await expect(verifyPackageIntegrity(root)).rejects.toThrow("manifest does not match");
    });
  });
  it("propagates failed runtime smoke without accepting the package", async () => {
    await fixture(async (root) => {
      await expect(verifyServerRelease(root, {}, { execute: async () => { throw new Error("PTY smoke failed"); } })).rejects.toThrow("PTY smoke failed");
    });
  });
});
