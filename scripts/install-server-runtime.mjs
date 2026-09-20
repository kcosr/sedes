import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { pruneClaudeExecutables } from "./prune-claude-executables.mjs";

const execFileAsync = promisify(execFile);
// These are the only package lifecycle hooks admitted by this installer.
// node-pty 1.1.0 ships no Linux prebuild; its reviewed install hook builds it.
const NODE_PTY_VERSION = "1.1.0";
const nativeSmoke = `
const path = require('node:path');
const root = process.argv[1];
const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));
const database = new Database(':memory:');
if (database.prepare('SELECT 1 AS ok').get().ok !== 1) throw new Error('sqlite_smoke_failed');
database.close();
const { spawn } = require(path.join(root, 'node_modules', 'node-pty'));
const terminal = spawn('/bin/sh', ['-c', 'printf sedes_native_pty_ok'], {
  name: 'xterm', cols: 80, rows: 24, cwd: root, env: process.env,
});
let output = '';
const timeout = setTimeout(() => {
  terminal.kill();
  console.error('install_server_pty_smoke_timeout');
  process.exit(1);
}, 5000);
terminal.onData((data) => { output += data; });
terminal.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  if (exitCode !== 0 || !output.includes('sedes_native_pty_ok')) {
    console.error('install_server_pty_smoke_failed');
    process.exitCode = 1;
  }
});
`;

/** Build and validate the staged Linux runtime before the release is activated. */
export async function installServerDependencies(
  stagingDirectory,
  environment,
  { execute = execFileAsync } = {},
) {
  const installEnvironment = { ...environment };
  delete installEnvironment.NODE_ENV;
  const npmExecutable = environment.npm_execpath;
  const command = npmExecutable ? process.execPath : "npm";
  const npm = async (arguments_, extraEnvironment = {}) => {
    await execute(
      command,
      npmExecutable ? [npmExecutable, ...arguments_] : arguments_,
      {
        cwd: stagingDirectory,
        env: { ...installEnvironment, ...extraEnvironment },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  };
  await npm(["ci", "--omit=dev", "--ignore-scripts"]);
  const modulesRoot = path.join(stagingDirectory, "node_modules");
  const installed = JSON.parse(
    await readFile(path.join(modulesRoot, "node-pty", "package.json"), "utf8"),
  );
  if (installed.name !== "node-pty" || installed.version !== NODE_PTY_VERSION) {
    throw new Error("install_server_node_pty_version_unreviewed");
  }
  // An explicit package selector prevents unrelated dependency hooks from
  // running. Force compilation for the Node executable doing the installation.
  await npm(
    ["rebuild", `node-pty@${NODE_PTY_VERSION}`, "--ignore-scripts=false", "--foreground-scripts"],
    { npm_config_build_from_source: "true" },
  );
  await pruneClaudeExecutables(modulesRoot);
  await execute(process.execPath, ["--eval", nativeSmoke, stagingDirectory], {
    cwd: stagingDirectory,
    env: installEnvironment,
    timeout: 10_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
}
