import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { probeEnvironment } from './raw-app-server-client.mjs';
import { startMockResponsesServer } from './mock-responses-server.mjs';

// Deliberately faulty relay: isolated native daemon and loopback inference only.
// This qualifies native ordering; the application tests cover ownership admission.
import model from './speed-fixture-model.json' with { type: 'json' };
const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.SEDES_SPEED_NATIVE_EXECUTABLE;
if (!binary || !path.isAbsolute(binary)) throw new Error('Set SEDES_SPEED_NATIVE_EXECUTABLE to an absolute pinned binary path');
const versionHome = await mkdtemp(path.join(os.tmpdir(), 'speed-version-'));
let release;
try {
  release = execFileSync(binary, ['--version'], { env: probeEnvironment(versionHome), encoding: 'utf8', timeout: 10000 }).trim().replace(/^codex-cli /, '');
} finally { await rm(versionHome, { recursive: true, force: true }); }
assert(['0.162.1', '0.163.0', '0.166.0'].includes(release));
const candidates = [[release, binary]];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const result = await test(); if (result) return result; await delay(10); }
  throw new Error(`Timeout: ${label}`);
}
class Client {
  constructor(ws) {
    this.ws = ws; this.nextId = 0; this.pending = new Map(); this.messages = []; this.requests = [];
    ws.on('message', frame => {
      const value = JSON.parse(frame.toString()); this.messages.push(value);
      if (value.id !== undefined && value.method) this.requests.push(value);
      else if (value.id !== undefined) { const p = this.pending.get(value.id); if (!p) return; this.pending.delete(value.id); clearTimeout(p.timer); value.error ? p.reject(Object.assign(new Error(value.error.message), { rpcError: value.error })) : p.resolve(value.result); }
    });
  }
  static async open(url) {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const client = new Client(ws);
    await client.request('initialize', { clientInfo: { name: 'sedes_speed_order_probe', version: '1' }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: 'initialized', params: {} })); return client;
  }
  request(method, params, timeout = 10000) {
    const id = `probe-${++this.nextId}`;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`probe_timeout:${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.ws.send(JSON.stringify({ id, method, params })); return promise;
  }
  async approval() { return until(() => this.requests.shift(), 'tool approval'); }
  decline(request) { assert.equal(request.method, 'item/commandExecution/requestApproval'); this.ws.send(JSON.stringify({ id: request.id, result: { decision: 'decline' } })); }
  completed(turnId) { return until(() => this.messages.find(v => v.method === 'turn/completed' && v.params.turn.id === turnId), 'turn completion'); }
  close() { this.ws.terminate(); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('probe_closed')); } this.pending.clear(); }
}
async function relay(upstreamUrl) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await new Promise(resolve => server.once('listening', resolve));
  const states = [];
  server.on('connection', downstream => {
    const upstream = new WebSocket(upstreamUrl, { perMessageDeflate: false });
    const opened = new Promise((resolve, reject) => { upstream.once('open', resolve); upstream.once('error', reject); });
    const state = { downstream, upstream, held: [], hold: false, observed: [], downstreamClosed: false, queue: Promise.resolve() };
    states.push(state);
    downstream.on('message', frame => { state.queue = state.queue.then(async () => { await opened; const text = frame.toString(); if (state.hold && JSON.parse(text).id !== undefined) state.held.push(text); else upstream.send(text); }); });
    // Deliberate fault: closure of the caller/carrier does not immediately
    // close the native connection; a relay can still own buffered old frames.
    downstream.on('close', () => { state.downstreamClosed = true; });
    upstream.on('message', frame => { const text = frame.toString(); state.observed.push(JSON.parse(text)); if (downstream.readyState === WebSocket.OPEN) downstream.send(text); });
  });
  const address = server.address();
  return {
    url: `ws://127.0.0.1:${address.port}`,
    states,
    async flush(state) { await state.queue; state.hold = false; for (const text of state.held.splice(0)) state.upstream.send(text); },
    async close() { for (const state of states) { state.downstream.terminate(); state.upstream.terminate(); } await new Promise(resolve => server.close(resolve)); },
  };
}
function toolResponse(id) { return [
  { type: 'response.created', response: { id } },
  { type: 'response.output_item.done', item: { type: 'function_call', call_id: id, name: 'exec_command', arguments: JSON.stringify({ cmd: 'touch command-must-not-run', sandbox_permissions: 'require_escalated', justification: 'Offline ordering probe; decline this tool', yield_time_ms: 1000 }) } },
  { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
]; }
const input = [{ type: 'text', text: 'Isolated offline ordering check', text_elements: [] }];
async function run(release, binary) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sso-'));
  const home = path.join(root, 'home'); const workspace = path.join(root, 'work'); const socket = path.join(root, 'app.sock');
  const clients = []; let fixture, proxy, daemon, stderr = '';
  try {
    await Promise.all([mkdir(home), mkdir(workspace)]);
    fixture = await startMockResponsesServer();
    const catalogPath = path.join(home, 'models.json'); await writeFile(catalogPath, JSON.stringify({ models: [model] }));
    await writeFile(path.join(home, 'config.toml'), `model = "sedes-speed-fixture"\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\nmodel_provider = "sedes_fixture"\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n[model_providers.sedes_fixture]\nname = "Sedes deterministic fixture"\nbase_url = "${fixture.baseUrl}"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nrequires_openai_auth = false\nsupports_websockets = false\n[features]\napps = false\nplugins = false\nfast_mode = true\nultrafast_mode = true\nstep_model_switching = true\n`, { mode: 0o600 });
    daemon = spawn(binary, ['app-server', '--strict-config', '--listen', `unix://${socket}`], { cwd: workspace, env: probeEnvironment(home), stdio: ['ignore', 'ignore', 'pipe'] });
    daemon.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8000); });
    await until(() => access(socket).then(() => true, () => false), 'native socket');
    const endpoint = `ws+unix://${socket}:/`;
    const admin = await Client.open(endpoint); clients.push(admin);
    const threadId = (await admin.request('thread/start', { model: model.slug, cwd: workspace, approvalPolicy: 'on-request', sandbox: 'read-only', ephemeral: true })).thread.id;
    proxy = await relay(endpoint);
    const older = await Client.open(proxy.url); clients.push(older);
    const same = proxy.states[0];

    // Continuous stream: both requests remain ordered even while the first
    // caller times out before either reaches native app-server.
    fixture.enqueue(toolResponse('same-stream-tool'));
    const turn1 = (await admin.request('turn/start', { threadId, serviceTier: 'default', input })).turn.id;
    const approval1 = await admin.approval();
    same.hold = true;
    await assert.rejects(older.request('turn/settings/update', { threadId, turnId: turn1, serviceTier: 'priority' }, 80), /probe_timeout/);
    const newer = older.request('turn/settings/update', { threadId, turnId: turn1, serviceTier: 'ultrafast' });
    await until(() => same.held.length === 2, 'two same-stream queued frames');
    await proxy.flush(same);
    assert.deepEqual(await newer, { status: 'applied' });
    admin.decline(approval1); await admin.completed(turn1);
    const sameStreamTier = JSON.parse(fixture.requestBodies.at(-1)).service_tier;
    assert.equal(sameStreamTier, 'ultrafast');

    // Same stream: uncertain default write precedes future native turn/start.
    same.hold = true;
    await assert.rejects(older.request('thread/settings/update', { threadId, serviceTier: 'priority' }, 80), /probe_timeout/);
    const next = older.request('turn/start', { threadId, input });
    await until(() => same.held.length === 2, 'default plus start queued');
    await proxy.flush(same);
    const turn2 = (await next).turn.id; await admin.completed(turn2);
    const defaultThenStartTier = JSON.parse(fixture.requestBodies.at(-1)).service_tier;
    assert.equal(defaultThenStartTier, 'priority');

    // Replacement connection: new request reaches app-server before a frame
    // already accepted by the old carrier. Native FIFO follows ARRIVAL order.
    fixture.enqueue(toolResponse('cross-stream-tool'));
    const turn3 = (await admin.request('turn/start', { threadId, serviceTier: 'default', input })).turn.id;
    const approval3 = await admin.approval();
    same.hold = true;
    await assert.rejects(older.request('turn/settings/update', { threadId, turnId: turn3, serviceTier: 'priority' }, 80), /probe_timeout/);
    await until(() => same.held.length === 1, 'old frame buffered');
    older.close(); await until(() => same.downstreamClosed, 'caller disconnected');
    const replacement = await Client.open(endpoint); clients.push(replacement);
    assert.deepEqual(await replacement.request('turn/settings/update', { threadId, turnId: turn3, serviceTier: 'ultrafast' }), { status: 'applied' });
    const oldId = JSON.parse(same.held[0]).id;
    await proxy.flush(same);
    const oldReply = await until(() => same.observed.find(v => v.id === oldId), 'old stream delayed result');
    assert.deepEqual(oldReply.result, { status: 'applied' });
    admin.decline(approval3); await admin.completed(turn3);
    const replacementThenLateOldTier = JSON.parse(fixture.requestBodies.at(-1)).service_tier;
    assert.equal(replacementThenLateOldTier, 'priority');

    // Same hazard for defaults: late old write can run after new start on a
    // replacement stream. No claim that ordinary Sedes uses this fault relay.
    const defaultOld = await Client.open(proxy.url); clients.push(defaultOld);
    const delayed = proxy.states[1]; delayed.hold = true;
    await assert.rejects(defaultOld.request('thread/settings/update', { threadId, serviceTier: 'ultrafast' }, 80), /probe_timeout/);
    await until(() => delayed.held.length === 1, 'old default buffered');
    defaultOld.close(); await until(() => delayed.downstreamClosed, 'default caller disconnected');
    fixture.enqueue(toolResponse('late-default-tool'));
    const turn4 = (await admin.request('turn/start', { threadId, serviceTier: 'priority', input })).turn.id;
    const approval4 = await admin.approval();
    const oldDefaultId = JSON.parse(delayed.held[0]).id;
    await proxy.flush(delayed);
    const lateDefault = await until(() => delayed.observed.find(v => v.id === oldDefaultId), 'late default result');
    assert.deepEqual(lateDefault.result, {});
    admin.decline(approval4); await admin.completed(turn4);
    const explicitRootTierAfterDelayedDefault = JSON.parse(fixture.requestBodies.at(-1)).service_tier;
    assert.equal(explicitRootTierAfterDelayedDefault, 'priority');
    await assert.rejects(access(path.join(workspace, 'command-must-not-run')), { code: 'ENOENT' });
    return { release, explicitRootTierAfterDelayedDefault, sameStreamTier, defaultThenStartTier, replacementThenLateOldTier, oldStreamCallerDisconnectedBeforeNewRequest: true, delayedOldDefaultAcceptedAfterNewTurnStarted: true, commandNeverExecuted: true,
      limitation: 'Deterministic fault relay delays old native-bound frames and native disconnect propagation. Demonstrates no cross-stream issue-order guarantee, not an observed Sedes reconnect bug. Same-stream delays are before native enqueue, not a held native handler.' };
  } catch (error) { error.message += `\nIsolated native stderr: ${stderr}`; throw error; }
  finally {
    for (const client of clients) client.close();
    await proxy?.close();
    if (daemon && daemon.exitCode === null) { daemon.kill('SIGTERM'); await Promise.race([new Promise(resolve => daemon.once('exit', resolve)), delay(2000)]); if (daemon.exitCode === null) daemon.kill('SIGKILL'); }
    await fixture?.close(); await rm(root, { recursive: true, force: true });
  }
}
const results = [];
for (const [release, binary] of candidates) {
  const metadata = JSON.parse(await readFile(`${repo}/protocol/codex-app-server/0.166.0/runtime-compatibility/${release}.json`, 'utf8'));
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  assert.equal(sha256, metadata.platforms.find(p => p.nodePlatform === process.platform && p.nodeArch === process.arch).executableSha256);
  const result = await run(release, binary); results.push({ ...result, sha256 }); console.log(JSON.stringify(result));
}
console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), fixtureOnly: true, liveProviderVerified: false, platform: `${process.platform}/${process.arch}`, results }, null, 2));
