import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const providerFile = fileURLToPath(new URL("../../src/server/execution/local-interactive-terminal-provider.ts", import.meta.url));
const packageUrl = new URL("../../package.json", import.meta.url).href;

describe.runIf(process.platform === "win32")("native Windows terminal resource ownership", () => {
  it.each([false, true])("completes naturally after shell exit with descendant cleanup=%s", async cleanupOnNaturalExit => {
    const prefix = path.join(os.tmpdir(), "sedes-pty-exit-");
    const directory = await mkdtemp(prefix);
    const systemRoot = process.env.SystemRoot!;
    const environment = {
      SystemRoot: systemRoot, WINDIR: systemRoot,
      ComSpec: path.join(systemRoot, "System32", "cmd.exe"),
      PATH: [path.dirname(process.execPath), path.join(systemRoot, "System32"), systemRoot].join(path.delimiter),
      HOME: directory, USERPROFILE: directory,
      APPDATA: path.join(directory, "AppData", "Roaming"), LOCALAPPDATA: path.join(directory, "AppData", "Local"),
      TEMP: directory, TMP: directory,
    };
    const source = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { LocalInteractiveTerminalProvider } from './provider.mjs';
      const { spawn } = createRequire(${JSON.stringify(packageUrl)})('node-pty');
      const scope = { tenantId: 'test-tenant', principalId: 'test-principal' };
      const provider = new LocalInteractiveTerminalProvider({ scope, environmentId: 'test', environment: process.env, spawnPty: spawn, cleanupOnNaturalExit: ${cleanupOnNaturalExit} });
      const terminal = await provider.openTerminal({ scope, environmentId: 'test', terminalId: 'test', incarnationId: 'test', initialCwd: process.env.TEMP, rows: 24, columns: 80 });
      let output = '';
      const events = [];
      terminal.onOutput(bytes => { output += Buffer.from(bytes).toString('utf8'); events.push('output'); });
      const exited = new Promise(resolve => terminal.onExit(exit => { events.push('exit'); resolve(exit); }));
      assert.deepEqual(await terminal.write(Buffer.from('echo sedes_native_terminal_ok\\r\\nexit 0\\r\\n')), { outcome: 'sent' });
      const exit = await exited;
      assert.deepEqual(exit, { disposition: 'exited', exitCode: 0, signal: null, ${cleanupOnNaturalExit ? "cleanupConfirmed: true" : ""} });
      assert.match(output, /\\r?\\nsedes_native_terminal_ok/);
      assert.equal(events.at(-1), 'exit');
      const replay = [];
      terminal.onExit(value => replay.push(value));
      assert.deepEqual(replay, [exit]);
      assert.deepEqual(await terminal.write(Buffer.from('ignored')), { outcome: 'not_sent' });
      await terminal.terminate('kill');
      console.log('terminal completed naturally');
      // No forced exit or fixture cleanup of the PTY: retained workers must
      // make this child time out even after the exit assertions have passed.
    `;
    try {
      // Keep loader/eval flags out of node-pty's inherited worker/fork args.
      await build({ entryPoints: [providerFile], outfile: path.join(directory, "provider.mjs"), bundle: true, platform: "node", format: "esm", external: ["node-pty"] });
      const script = path.join(directory, "probe.mjs");
      await writeFile(script, source);
      const result = await execute(process.execPath, [script], {
        env: environment, timeout: 10_000, windowsHide: true,
      });
      expect(result.stdout).toBe("terminal completed naturally\n");
      // node-pty's post-exit console-list helper can report AttachConsole
      // failure before its own fallback completes. The main child must exit 0.
    } catch (error) {
      const failure = error as { code?: unknown; killed?: boolean; stdout?: string; stderr?: string };
      console.error("native terminal child failure", { code: failure.code, killed: failure.killed, stdout: failure.stdout, stderr: failure.stderr });
      throw error;
    } finally {
      if (!path.isAbsolute(directory) || !directory.startsWith(prefix)) throw new Error("Invalid native terminal fixture cleanup path");
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
