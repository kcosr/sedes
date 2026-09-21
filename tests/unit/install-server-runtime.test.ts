import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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
        execute: async (command: string, args: string[], options: {env: NodeJS.ProcessEnv}) => { calls.push({ command, args, options }); return { stdout: JSON.stringify({ checks: ["fixture-check"], liveProviders: false }) }; },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.command).toBe(process.execPath);
      const canonical = await realpath(root);
      expect(calls[0]?.args).toEqual([path.join(canonical, "scripts", "verify-server-package.mjs"), "--package", canonical]);
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


describe("server package permission portability", () => {
  it("normalizes builder modes while retaining intentionally protected worker files", async () => {
    await fixture(async (root) => {
      await chmod(path.join(root, "package.json"), 0o660);
      await chmod(path.join(root, "bin", "server"), 0o770);
      await writeFile(path.join(root, "worker-manifest.json"), "{}", { mode: 0o400 });
      await writeFile(path.join(root, "worker.mjs"), "// worker", { mode: 0o500 });
      await writePackageIntegrity(root);
      const entries = JSON.parse(await readFile(path.join(root, "FILES.json"), "utf8"));
      expect(entries["package.json"].mode).toBe(0o644);
      expect(entries["bin/server"].mode).toBe(0o755);
      expect(entries["worker-manifest.json"].mode).toBe(0o400);
      expect(entries["worker.mjs"].mode).toBe(0o500);
      await expect(verifyPackageIntegrity(root)).resolves.toMatchObject({ version: "1.0.0" });
    });
  });

  it.each(["027", "077"])("preserves exact permissions when extracting under umask %s with tar -p", async (umask) => {
    await fixture(async (root) => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), "sedes-package-tar-"));
      const execute = promisify(execFile);
      try {
        await writeFile(path.join(root, "protected-worker.mjs"), "// worker", { mode: 0o500 });
        await writePackageIntegrity(root);
        const archive = path.join(temporary, "release.tar.gz");
        await execute("tar", ["-czf", archive, "-C", root, "."]);
        const reduced = path.join(temporary, "reduced");
        const preserved = path.join(temporary, "preserved");
        await mkdir(reduced);
        await mkdir(preserved);
        for (const [flags, destination] of [["-xzf", reduced], ["-xpzf", preserved]]) {
          await execute("/bin/sh", ["-c", 'umask "$1"; exec tar "$2" "$3" -C "$4"', "extract", umask, flags!, archive, destination!]);
        }
        await expect(verifyPackageIntegrity(reduced)).rejects.toThrow("Re-extract with tar -xpzf");
        await expect(verifyPackageIntegrity(preserved)).resolves.toMatchObject({ version: "1.0.0" });
        expect((await stat(path.join(preserved, "bin", "server"))).mode & 0o777).toBe(0o755);
        expect((await stat(path.join(preserved, "protected-worker.mjs"))).mode & 0o777).toBe(0o500);
        await execute(path.join(preserved, "bin", "server"));
      } finally { await rm(temporary, { recursive: true, force: true }); }
    });
  });
});


describe("server verifier completion reports", () => {
  it.each([
    undefined, "", "not JSON", "null", "[]", "{}",
    JSON.stringify({ checks: [], liveProviders: false }),
    JSON.stringify({ checks: [""], liveProviders: false }),
    JSON.stringify({ checks: ["  "], liveProviders: false }),
    JSON.stringify({ checks: [1], liveProviders: false }),
    JSON.stringify({ checks: ["startup"] }),
    JSON.stringify({ checks: ["startup"], liveProviders: true }),
    JSON.stringify({ checks: ["startup"], liveProviders: false, extra: true }),
  ])("refuses a successful verifier process with invalid report %j", async (stdout) => {
    await fixture(async (root) => {
      await expect(verifyServerRelease(root, {}, { execute: async () => ({ stdout }) })).rejects.toThrow("server_package_verifier_report_invalid");
    });
  });

  it("rejects an actual silent verifier that exits successfully", async () => {
    await fixture(async (root) => {
      await mkdir(path.join(root, "scripts"));
      await writeFile(path.join(root, "scripts", "verify-server-package.mjs"), "process.exitCode = 0;\n");
      await writePackageIntegrity(root);
      await expect(verifyServerRelease(root, {})).rejects.toThrow("server_package_verifier_report_invalid");
    });
  });

  it("canonicalizes a symlinked package root before launching verification", async () => {
    await fixture(async (root) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-verifier-alias-"));
      try {
        const alias = path.join(directory, "release");
        await symlink(root, alias);
        const canonical = await realpath(root);
        await expect(verifyServerRelease(alias, {}, { execute: async (_command: string, args: string[], options: { cwd: string }) => {
          expect(args).toEqual([path.join(canonical, "scripts", "verify-server-package.mjs"), "--package", canonical]);
          expect(options.cwd).toBe(canonical);
          return { stdout: JSON.stringify({ checks: ["startup", "pty"], liveProviders: false }) };
        } })).resolves.toMatchObject({ version: "1.0.0" });
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  });
});
