import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

type ExecutionOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
  timeout?: number;
  maxBuffer: number;
};
type Execute = (command: string, args: string[], options: ExecutionOptions) => Promise<unknown>;
const { installServerDependencies } = (await import(
  new URL("../../scripts/install-server-runtime.mjs", import.meta.url).href
)) as {
  installServerDependencies(root: string, environment: NodeJS.ProcessEnv, options?: { execute: Execute }): Promise<void>;
};
const execFileAsync = promisify(execFile);

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-native-install-"));
  try {
    await mkdir(path.join(root, "node_modules", "node-pty"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "node-pty", "package.json"), JSON.stringify({ name: "node-pty", version: "1.1.0" }));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("installed server native runtime", () => {
  it("permits only the reviewed node-pty hooks and validates before succeeding", async () => {
    await fixture(async (root) => {
      const unused = path.join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64");
      const sdk = path.join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
      await mkdir(unused, { recursive: true });
      await mkdir(sdk, { recursive: true });
      const calls: { command: string; args: string[]; options: ExecutionOptions }[] = [];
      await installServerDependencies(root, { NODE_ENV: "production", npm_execpath: "/npm/bin/npm-cli.js" }, {
        execute: async (command, args, options) => { calls.push({ command, args, options }); },
      });
      expect(calls[0]?.args).toEqual(["/npm/bin/npm-cli.js", "ci", "--omit=dev", "--ignore-scripts"]);
      expect(calls[1]?.args).toEqual(["/npm/bin/npm-cli.js", "rebuild", "node-pty@1.1.0", "--ignore-scripts=false", "--foreground-scripts"]);
      expect(calls[1]?.options.env.npm_config_build_from_source).toBe("true");
      expect(calls.every((call) => call.options.env.NODE_ENV === undefined)).toBe(true);
      expect(calls[2]?.command).toBe(process.execPath);
      expect(calls[2]?.args[0]).toBe("--eval");
      expect(calls[2]?.options.timeout).toBe(10_000);
      expect(await stat(sdk)).toBeDefined();
      await expect(stat(unused)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects a changed native package before allowing its lifecycle scripts", async () => {
    await fixture(async (root) => {
      const manifest = path.join(root, "node_modules", "node-pty", "package.json");
      await writeFile(manifest, (await readFile(manifest, "utf8")).replace("1.1.0", "1.2.0"));
      const calls: string[][] = [];
      await expect(installServerDependencies(root, {}, {
        execute: async (_command, args) => { calls.push(args); },
      })).rejects.toThrow("install_server_node_pty_version_unreviewed");
      expect(calls).toEqual([["ci", "--omit=dev", "--ignore-scripts"]]);
    });
  });

  it("propagates a compiler failure instead of certifying an incomplete release", async () => {
    await fixture(async (root) => {
      let smokeStarted = false;
      await expect(installServerDependencies(root, {}, {
        execute: async (_command, args) => {
          if (args[0] === "rebuild") throw new Error("compiler unavailable");
          if (args[0] === "--eval") smokeStarted = true;
        },
      })).rejects.toThrow("compiler unavailable");
      expect(smokeStarted).toBe(false);
    });
  });

  it.each([true, false])("checks actual PTY output and exit in the smoke child (valid=%s)", async (valid) => {
    await fixture(async (root) => {
      const sqlite = path.join(root, "node_modules", "better-sqlite3");
      await mkdir(sqlite);
      await writeFile(path.join(sqlite, "index.js"), "module.exports = class { prepare() { return { get() { return {ok: 1}; } }; } close() {} };\n");
      await writeFile(path.join(root, "node_modules", "node-pty", "index.js"), `
        exports.spawn = () => ({
          kill() {},
          onData(callback) { setTimeout(() => callback(${JSON.stringify(valid ? "sedes_native_pty_ok" : "incorrect output")}), 5); },
          onExit(callback) { setTimeout(() => callback({exitCode: 0}), 10); },
        });
      `);
      const operation = installServerDependencies(root, process.env, {
        execute: async (command, args, options) => {
          if (args[0] === "--eval") return execFileAsync(command, args, options);
        },
      });
      if (valid) await expect(operation).resolves.toBeUndefined();
      else await expect(operation).rejects.toThrow("install_server_pty_smoke_failed");
    });
  });
});
