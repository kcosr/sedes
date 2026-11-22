#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, fork } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { verifyPackageIntegrity } from './server-package-integrity.mjs';
import { verifyServerPayload } from './server-package-payload.mjs';
import { assertPackageNodeVersion } from './package-node-version.mjs';

const execute = promisify(execFile);

export async function readRuntimeEntrypoints(root) {
  const file = await open(path.join(root, 'runtime-entrypoints.json'), 'r');
  let encoded;
  try {
    assert.ok((await file.stat()).isFile(), 'Runtime entrypoint manifest must be a file');
    const buffer = Buffer.alloc(1_048_577);
    let bytes = 0;
    while (bytes < buffer.length) {
      const { bytesRead } = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (bytesRead === 0) break;
      bytes += bytesRead;
    }
    assert.ok(bytes <= 1_048_576, 'Runtime entrypoint manifest exceeds its byte limit');
    encoded = buffer.subarray(0, bytes).toString('utf8');
  } finally { await file.close(); }
  const value = JSON.parse(encoded);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Invalid runtime entrypoint manifest');
  assert.deepEqual(Object.keys(value).sort(), ['entrypoints', 'version']);
  assert.equal(value.version, 1, 'Unsupported runtime entrypoint manifest');
  assert.ok(Array.isArray(value.entrypoints) && value.entrypoints.length <= 10_000, 'Invalid runtime entrypoint inventory');
  const seen = new Set();
  for (const entry of value.entrypoints) {
    assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), 'Invalid runtime entrypoint');
    assert.deepEqual(Object.keys(entry).sort(), ['kind', 'package', 'specifier']);
    assert.ok(typeof entry.specifier === 'string' && entry.specifier.length <= 1_024 &&
      /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:\/[A-Za-z0-9_@.+-]+)*$/u.test(entry.specifier) &&
      entry.specifier.split('/').every(part => part !== '.' && part !== '..'), 'Invalid runtime package specifier');
    const name = entry.specifier.startsWith('@') ? entry.specifier.split('/').slice(0, 2).join('/') : entry.specifier.split('/')[0];
    assert.equal(entry.package, name, 'Runtime entrypoint package does not own its specifier');
    assert.ok(['import', 'require', 'resolve_import', 'resolve_require'].includes(entry.kind), 'Invalid runtime import kind');
    const key = `${entry.kind}:${entry.specifier}`;
    assert.ok(!seen.has(key), 'Duplicate runtime entrypoint'); seen.add(key);
  }
  return value.entrypoints;
}

/** Run inside the selected package/runtime, respecting each actual export condition. */
export function createRuntimeDependencyProbe(entrypoints) {
  return `
  const {createRequire} = await import('node:module');
  const {realpathSync} = await import('node:fs');
  const {fileURLToPath} = await import('node:url');
  const path = await import('node:path');
  const assert = (await import('node:assert/strict')).default;
  const root = process.argv[1];
  const requirePackage = createRequire(path.join(root, 'package.json'));
  const manifest = requirePackage('./package.json');
  const packageModules = path.join(realpathSync(root), 'node_modules') + path.sep;
  const entrypoints = ${JSON.stringify(entrypoints.map(({ package: name, specifier, kind }) => ({ package: name, specifier, kind })))};
  assert.deepEqual([...new Set(entrypoints.map(entry => entry.package))].sort(), Object.keys(manifest.dependencies).sort(),
    'Packaged runtime imports do not match declared dependencies');
  for (const entry of entrypoints) {
    const commonjs = entry.kind === 'require' || entry.kind === 'resolve_require';
    const resolved = realpathSync(commonjs ? requirePackage.resolve(entry.specifier) : fileURLToPath(import.meta.resolve(entry.specifier)));
    assert.ok(resolved.startsWith(packageModules), 'Dependency resolves outside package: ' + entry.specifier);
    const owner = realpathSync(path.join(packageModules, entry.package)) + path.sep;
    assert.ok(owner.startsWith(packageModules) && resolved.startsWith(owner), 'Dependency resolves outside package: ' + entry.specifier);
    if (entry.kind === 'require') requirePackage(entry.specifier);
    else if (entry.kind === 'import') await import(entry.specifier);
    else assert.ok(entry.kind === 'resolve_import' || entry.kind === 'resolve_require', 'Unknown runtime import kind');
  }
  `;
}

/** Self-contained because the packaged-runtime probe embeds this function. */
export async function verifyRuntimePty(pty, root) {
  const windows = process.platform === 'win32';
  const shell = windows ? process.env.ComSpec : '/bin/sh';
  const args = windows ? ['/d', '/s', '/c', 'echo sedes_package_pty_ok'] : ['-c', 'printf sedes_package_pty_ok'];
  const terminal = pty.spawn(shell, args, {name:'xterm', cols:80, rows:24, cwd:root, env:process.env});
  let timer;
  let data;
  let exit;
  let terminalExited = false;
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      timer = setTimeout(() => reject(new Error('PTY timed out')), 5000);
      data = terminal.onData(chunk => { output += chunk; });
      exit = terminal.onExit(({exitCode}) => { terminalExited = true; if (exitCode !== 0 || !output.includes('sedes_package_pty_ok')) reject(new Error('PTY output/exit invalid')); else resolve(); });
    });
  } finally {
    clearTimeout(timer);
    data?.dispose();
    exit?.dispose();
    // Shell exit alone leaves node-pty's Windows ConoutConnection worker alive.
    // POSIX has already reaped an exited shell; do not signal a retired PID.
    if (windows || !terminalExited) terminal.kill();
  }
}

/** Self-contained and executed inside the selected packaged Node/Electron runtime. */
export async function verifyAntigravityHistoryWorker(root) {
  const assert = (await import('node:assert/strict')).default;
  const {mkdtemp, mkdir, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const path = await import('node:path');
  const {pathToFileURL} = await import('node:url');
  const {DatabaseSync} = await import('node:sqlite');
  const {Worker} = await import('node:worker_threads');
  const temporary = await mkdtemp(path.join(tmpdir(), 'sedes-history-worker-probe-'));
  let worker;
  const varint = value => {
    let n = BigInt(value); const bytes = [];
    do { const byte = Number(n & 127n); n >>= 7n; bytes.push(n ? byte | 128 : byte); } while (n);
    return Buffer.from(bytes);
  };
  const field = (number, value) => {
    if (typeof value === 'number') return Buffer.concat([varint(number * 8), varint(value)]);
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
  };
  try {
    const identity = {sessionId:'8a54e222-1000-4000-8000-000000000001', cwd:temporary};
    const directory = path.join(temporary, 'antigravity-cli/conversations');
    await mkdir(directory, {recursive:true});
    const database = new DatabaseSync(path.join(directory, `${identity.sessionId}.db`));
    try {
      database.exec("CREATE TABLE trajectory_meta (cascade_id TEXT); CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, has_subtrajectory INTEGER, step_format INTEGER, step_payload BLOB)");
      database.prepare('INSERT INTO trajectory_meta VALUES (?)').run(identity.sessionId);
      database.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(field(1, field(1, pathToFileURL(temporary).href)));
      database.prepare('INSERT INTO steps VALUES (0, 15, 3, 0, 0, ?)').run(Buffer.concat([
        field(1, 15), field(4, 3), field(20, Buffer.concat([field(1, 'packaged-history-worker-ok'), field(12, 2)])),
      ]));
    } finally { database.close(); }
    worker = new Worker(pathToFileURL(path.join(root, 'dist/antigravity-history-worker/sedes-antigravity-history-worker.mjs')), {
      workerData:{tenantId:'probe', principalId:'probe', backendInstanceId:'probe', executionEnvironmentId:'probe', geminiDirectory:temporary, initializationTimeoutMs:1000},
      env:{}, execArgv:[],
    });
    // Keep an error listener between individual exchanges and during cleanup;
    // each active exchange still reports startup/read errors to its caller.
    let workerError;
    worker.on('error', error => { workerError = error; });
    const exited = new Promise(resolve => worker.once('exit', code => resolve(code)));
    const exchange = request => new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); worker.off('message', message); worker.off('error', error); worker.off('exit', exit); };
      const message = response => { if (response.id === request.id) { cleanup(); resolve(response); } };
      const error = failure => { cleanup(); reject(failure); };
      const exit = code => error(new Error(`Antigravity history worker exited before its response: ${code}`));
      const timer = setTimeout(() => error(new Error('Antigravity history worker round-trip timed out')), 5000);
      worker.on('message', message); worker.once('error', error); worker.once('exit', exit);
      try { worker.postMessage(request); } catch (failure) { error(failure); }
    });
    const first = await exchange({id:1, kind:'read', identity, cancellation:new SharedArrayBuffer(4)});
    assert.equal(first.kind, 'read', 'Packaged Antigravity history worker must read native SQLite');
    assert.equal(first.history.sessionId, identity.sessionId);
    assert.equal(first.history.cwd, identity.cwd);
    assert.equal(first.history.native.steps[0].response.text, 'packaged-history-worker-ok');
    assert.equal(first.bytes, Buffer.byteLength(JSON.stringify(first.history)));
    const unchanged = await exchange({id:2, kind:'read', identity, knownRevision:first.revision, cancellation:new SharedArrayBuffer(4)});
    assert.deepEqual(unchanged, {id:2, kind:'read', history:null, revision:first.revision, bytes:0});
    assert.deepEqual(await exchange({id:3, kind:'forget', identity, cancellation:new SharedArrayBuffer(4)}), {id:3, kind:'done'});
    assert.deepEqual(await exchange({id:4, kind:'close'}), {id:4, kind:'done'});
    let timer;
    try {
      assert.equal(await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Antigravity history worker shutdown timed out')), 5000); })]), 0);
      if (workerError) throw workerError;
    } finally { clearTimeout(timer); }
  } finally {
    try { if (worker) await worker.terminate(); }
    finally { await rm(temporary, {recursive:true, force:true}); }
  }
}

const nativeProbe = entrypoints => `
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const root = process.argv[1];
const requirePackage = require('node:module').createRequire(path.join(root, 'package.json'));
${verifyRuntimePty.toString()}
${verifyAntigravityHistoryWorker.toString()}
(async () => {
  await (async () => { ${createRuntimeDependencyProbe(entrypoints)} })();
  const {openOverlayDatabaseConnection} = await import(pathToFileURL(path.join(root, 'dist/server/db/database.js')));
  const {initializeEmptyBackendNormalizedDatabase} = await import(pathToFileURL(path.join(root, 'dist/server/db/migrate.js')));
  const db = openOverlayDatabaseConnection(path.join(process.env.APP_STATE_DIR, 'probe.db'));
  try {
    initializeEmptyBackendNormalizedDatabase(db);
    assert.equal(db.prepare('SELECT 42 AS answer').get().answer, 42);
    assert.ok(db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count > 0);
    assert.equal(db.pragma('integrity_check', {simple:true}), 'ok');
  } finally { db.close(); }
  for (const name of ['pi', 'codex', 'claude', 'grok', 'opencode']) {
    await import(pathToFileURL(path.join(root, 'dist/server/backends', name, name + '-backend-module.js')));
  }
  const requirePi = require('node:module').createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const transformed = requirePi('esbuild').transformSync('const answer: number = 42', {loader:'ts'});
  assert.ok(transformed.code.includes('42'), 'Pi esbuild target executable failed');
  await verifyRuntimePty(requirePackage('node-pty'), root);
  await verifyAntigravityHistoryWorker(root);
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

export function requestRuntimeShutdown(server) {
  // SIGTERM force-terminates Windows children. The managed parent protocol
  // already treats IPC disconnect as a graceful shutdown request.
  if (process.platform === 'win32') {
    if (server.connected) server.disconnect();
  } else server.kill('SIGTERM');
}

export async function verifyRuntime(root, { nodeExecutable = process.execPath, electronRunAsNode = false } = {}) {
  const nativeHistoryWorkerRoot = path.join(root, 'dist/antigravity-history-worker');
  const nativeHistoryWorkerManifest = JSON.parse(await readFile(path.join(nativeHistoryWorkerRoot, 'manifest.json'), 'utf8'));
  const nativeHistoryWorker = await readFile(path.join(nativeHistoryWorkerRoot, 'sedes-antigravity-history-worker.mjs'));
  assert.equal(nativeHistoryWorkerManifest.schemaVersion, 1);
  assert.equal(nativeHistoryWorkerManifest.artifactId, 'openai.sedes.antigravity-history-worker');
  assert.equal(nativeHistoryWorkerManifest.filename, 'sedes-antigravity-history-worker.mjs');
  assert.equal(nativeHistoryWorkerManifest.bytes, nativeHistoryWorker.byteLength);
  assert.equal(nativeHistoryWorkerManifest.sha256, createHash('sha256').update(nativeHistoryWorker).digest('hex'));
  // Worker entry guards compare argv to import.meta.url. Resolve installation
  // aliases such as `current` before launching their executable entry points.
  root = await realpath(root);
  await verifyServerPayload(root, { allowRemoteSidecarTargets: electronRunAsNode });
  const entrypoints = await readRuntimeEntrypoints(root);
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
    await execute(nodeExecutable, ['--input-type=module', '--eval', nativeProbe(entrypoints), root], {cwd:root, env, timeout:30_000, maxBuffer:4*1024*1024});
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
    requestRuntimeShutdown(server);
    const exit = await boundedExit(exited, 15_000);
    assert.deepEqual(exit, {code:0, signal:null}, `Server shutdown failed: ${logs}`);
    return ['sqlite-query-and-migrations', 'real-pty', 'pi-esbuild', 'provider-module-imports', 'pi-esbuild-target-binary', 'antigravity-history-worker-round-trip', 'sidecar-and-worker-argument-guards', 'connector-help', 'isolated-server-startup', 'browser-http-and-static-assets', 'graceful-shutdown'];
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
