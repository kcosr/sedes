#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyPackageIntegrity } from './server-package-integrity.mjs';
import { verifyServerPayload } from './server-package-payload.mjs';
import { assertPackageNodeVersion } from './package-node-version.mjs';

const execute = promisify(execFile);
const nativeProbe = `
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL, fileURLToPath} = require('node:url');
const {realpathSync} = require('node:fs');
const root = process.argv[1];
const requirePackage = require('node:module').createRequire(path.join(root, 'package.json'));
(async () => {
  const manifest = requirePackage('./package.json');
  const packageModules = path.join(realpathSync(root), 'node_modules') + path.sep;
  const dependencies = Object.keys(manifest.dependencies).map(name => {
    const resolved = realpathSync(fileURLToPath(import.meta.resolve(name)));
    assert.ok(resolved.startsWith(packageModules), 'Dependency resolves outside package: ' + name);
    return resolved;
  });
  const {openOverlayDatabaseConnection} = await import(pathToFileURL(path.join(root, 'dist/server/db/database.js')));
  const {initializeEmptyBackendNormalizedDatabase} = await import(pathToFileURL(path.join(root, 'dist/server/db/migrate.js')));
  const db = openOverlayDatabaseConnection(path.join(process.env.APP_STATE_DIR, 'probe.db'));
  try {
    initializeEmptyBackendNormalizedDatabase(db);
    assert.equal(db.prepare('SELECT 42 AS answer').get().answer, 42);
    assert.ok(db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count > 0);
    assert.equal(db.pragma('integrity_check', {simple:true}), 'ok');
  } finally { db.close(); }
  for (const name of ['pi', 'codex', 'claude', 'grok']) {
    await import(pathToFileURL(path.join(root, 'dist/server/backends', name, name + '-backend-module.js')));
  }
  for (const resolved of dependencies) await import(pathToFileURL(resolved));
  const requirePi = require('node:module').createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const transformed = requirePi('esbuild').transformSync('const answer: number = 42', {loader:'ts'});
  assert.ok(transformed.code.includes('42'), 'Pi esbuild target executable failed');
  await new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    const shell = windows ? process.env.ComSpec : '/bin/sh';
    const args = windows ? ['/d', '/s', '/c', 'echo sedes_package_pty_ok'] : ['-c', 'printf sedes_package_pty_ok'];
    const terminal = requirePackage('node-pty').spawn(shell, args, {name:'xterm', cols:80, rows:24, cwd:root, env:process.env});
    let output = '';
    const timer = setTimeout(() => { terminal.kill(); reject(new Error('PTY timed out')); }, 5000);
    terminal.onData(data => { output += data; });
    terminal.onExit(({exitCode}) => { clearTimeout(timer); if (exitCode !== 0 || !output.includes('sedes_package_pty_ok')) reject(new Error('PTY output/exit invalid')); else resolve(); });
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

export async function verifyRuntime(root, { nodeExecutable = process.execPath, electronRunAsNode = false } = {}) {
  // Worker entry guards compare argv to import.meta.url. Resolve installation
  // aliases such as `current` before launching their executable entry points.
  root = await realpath(root);
  await verifyServerPayload(root, { allowRemoteSidecarTargets: electronRunAsNode });
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (process.platform === 'win32' && (!systemRoot || !path.isAbsolute(systemRoot))) throw new Error('Windows verification requires SystemRoot');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sedes-pkg-'));
  // Deliberately do not inherit provider credentials, NODE_PATH, Node flags,
  // Sedes configuration, or the invoking account's home/runtime state.
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: temporary,
    TMPDIR: temporary, XDG_CONFIG_HOME: path.join(temporary, 'config'),
    XDG_STATE_HOME: path.join(temporary, 'state'), XDG_CACHE_HOME: path.join(temporary, 'cache'),
    APP_STATE_DIR: path.join(temporary, 'state'), NODE_ENV: 'production',
    SEDES_CONFIG_FILE: path.join(temporary, 'server.json'),
  };
  if (process.platform === 'win32') {
    Object.assign(env, {
      SystemRoot: systemRoot, WINDIR: systemRoot,
      ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
      PATH: [path.dirname(process.execPath), path.join(systemRoot, 'System32'), path.join(systemRoot, 'System32/WindowsPowerShell/v1.0'), systemRoot].join(path.delimiter),
      USERPROFILE: temporary, APPDATA: path.join(temporary, 'AppData/Roaming'), LOCALAPPDATA: path.join(temporary, 'AppData/Local'),
      TEMP: temporary, TMP: temporary,
    });
  }
  // Electron's backend addons use its ABI. Remote artifacts intentionally run
  // with standalone Node and must not inherit Electron's executable mode.
  const externalNodeEnvironment = { ...env };
  if (electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  let server;
  let exited;
  try {
    await mkdir(env.APP_STATE_DIR);
    await writeFile(env.SEDES_CONFIG_FILE, JSON.stringify({schemaVersion:11, packagedClients:[], listen:{host:'127.0.0.1', port:0}}));
    await execute(nodeExecutable, ['--input-type=module', '--eval', nativeProbe, root], {cwd:root, env, timeout:30_000, maxBuffer:4*1024*1024});
    for (const [artifact, args, expected] of [
      ['dist/sidecar/sedes', ['service'], 'sidecar_arguments_invalid'],
      ['dist/pi-sandbox-worker/sedes-pi-sandbox-worker.mjs', [], 'pi_sandbox_worker_arguments_invalid'],
      ['dist/claude-runtime-worker/sedes-claude-runtime-worker.mjs', [], 'claude_runtime_worker_arguments_invalid'],
    ]) {
      const result = await execute(process.execPath, [path.join(root, artifact), ...args], {cwd:temporary, env:externalNodeEnvironment, timeout:10_000}).then(
        value => ({...value, code:0}), error => error,
      );
      assert.equal(result.code, 1, `${artifact} must reach its argument guard`);
      assert.equal(result.stderr.trim(), expected, `${artifact} failed before its argument guard`);
    }
    await execute(process.execPath, [path.join(root, 'dist/connector/sedes-sidecar.mjs'), '--help'], {cwd:temporary, env:externalNodeEnvironment, timeout:10_000});
    server = fork(path.join(root, 'dist/server/index.js'), [], {cwd:temporary, env:{...env, SEDES_MANAGED_PARENT_PROTOCOL:'electron-local-v1'}, execPath:nodeExecutable, execArgv:[], stdio:['ignore','pipe','pipe','ipc']});
    let logs = '';
    server.stdout.on('data', chunk => { logs += chunk; });
    server.stderr.on('data', chunk => { logs += chunk; });
    exited = new Promise(resolve => server.once('exit', (code, signal) => resolve({code, signal})));
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${logs}`)), 30_000);
      server.on('message', message => {
        if (message.type === 'ready') { clearTimeout(timer); resolve(message); }
        if (message.type === 'startup_failed') { clearTimeout(timer); reject(new Error(`Server startup failed: ${logs} ${JSON.stringify(message)}`)); }
      });
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', () => { clearTimeout(timer); reject(new Error(`Server exited before ready: ${logs}`)); });
    });
    const response = await fetch(ready.baseUrl, {signal:AbortSignal.timeout(10_000)});
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<title>Sedes<\/title>/);
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]);
    assert.ok(assets.some(asset => asset.endsWith('.js')), 'Browser JS missing');
    assert.ok(assets.some(asset => asset.endsWith('.css')), 'Browser CSS missing');
    for (const asset of new Set(assets)) {
      const fetched = await fetch(new URL(asset, ready.baseUrl), {signal:AbortSignal.timeout(10_000)});
      assert.equal(fetched.status, 200);
      assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), await readFile(path.join(root, 'dist/client', asset)));
    }
    server.kill('SIGTERM');
    const exit = await boundedExit(exited, 15_000);
    assert.deepEqual(exit, {code:0, signal:null}, `Server shutdown failed: ${logs}`);
    return ['sqlite-query-and-migrations', 'real-pty', 'pi-esbuild', 'provider-module-imports', 'pi-esbuild-target-binary', 'sidecar-and-worker-argument-guards', 'connector-help', 'isolated-server-startup', 'browser-http-and-static-assets', 'graceful-shutdown'];
  } finally {
    try {
      if (server && server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await boundedExit(exited, 5000); }
    } finally { await rm(temporary, {recursive:true, force:true}); }
  }
}

async function boundedExit(exited, milliseconds) {
  let timer;
  try { return await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Server shutdown timed out')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

assertPackageNodeVersion();
if (import.meta.main) {
  const args = process.argv.slice(2);
  if ((args.length !== 2 && !(args.length === 3 && args[2] === '--installed')) || args[0] !== '--package') throw new Error('Usage: node scripts/verify-server-package.mjs --package /extracted/release [--installed]');
  const root = path.resolve(args[1]);
  await verifyPackageIntegrity(root, {installed:args.includes('--installed')});
  console.log(JSON.stringify({checks:await verifyRuntime(root), liveProviders:false}));
}
