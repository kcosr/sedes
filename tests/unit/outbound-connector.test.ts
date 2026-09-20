import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { OUTBOUND_CONTROL_PATH, OUTBOUND_CONTROL_PROTOCOL } from '../../src/internal/outbound-protocol.js';
import { LocalSidecarArtifactInstaller, type OutboundArtifactManifest } from '../../src/server/sidecar/local-sidecar-artifact-installer.js';
import { outboundArtifactUrl, outboundServerUrl, outboundWebSocketUrl } from '../../src/server/sidecar/outbound-connector-url.js';
import { openOutboundConnectorState } from '../../src/server/sidecar/outbound-connector-state.js';
import { runOutboundConnector } from '../../src/server/sidecar/outbound-connector.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function directory() { const result = await mkdtemp(path.join(tmpdir(), 'sedes-outbound-')); temporary.push(result); return result; }
const scope = { installationId: 'test-installation', tenantId: 'test-tenant', principalId: 'test-principal', executionEnvironmentId: 'test-environment' };
function release(bytes: Uint8Array): OutboundArtifactManifest {
  return { schemaVersion: 6, artifactId: 'openai.sedes.sidecar', filename: 'sedes', modes: ['agent_tools_cli', 'persistent_service'],
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, buildId: 'test-outbound', minimumNodeVersion: '22.19.0', nativeAssets: [] };
}

const credential = 'test-credential-'.repeat(4);
async function seedCredential(stateDirectory: string, serverUrl: string) {
  const store = await openOutboundConnectorState(stateDirectory, outboundServerUrl(serverUrl).href);
  await store.save({ ...store.state, credential });
  await store.close();
}

async function connectorServer(stateDirectory: string, handle: (socket: WebSocket) => void) {
  const http = createServer();
  const websocket = new WebSocketServer({ server: http, path: OUTBOUND_CONTROL_PATH, handleProtocols: () => OUTBOUND_CONTROL_PROTOCOL });
  websocket.on('connection', handle);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('test_server_missing');
  await seedCredential(stateDirectory, `http://127.0.0.1:${address.port}`);
  return { serverUrl: `http://127.0.0.1:${address.port}`, async close() {
    for (const socket of websocket.clients) socket.terminate();
    await new Promise<void>(resolve => websocket.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  } };
}

describe('outbound registration retry and rejection recovery', () => {
  it('rejects retry while pending without losing the attempt or a later approval', async () => {
    const stateDirectory = await directory();
    const pairingId = randomUUID();
    const hellos: Array<{ connectorId: string; registrationAttemptId: string }> = [];
    const server = await connectorServer(stateDirectory, socket => socket.once('message', data => {
      hellos.push(JSON.parse(data.toString()));
      socket.send(JSON.stringify(hellos.length === 1
        ? { type: 'pairing', status: 'pending', registrationId: randomUUID(), correlationCode: 'ABCD-1234', generation: 1 }
        : { type: 'pairing', status: 'accepted', pairingId, scope, generation: 2 }));
    }));
    try {
      const stop = new AbortController();
      await runOutboundConnector({ ...server, stateDirectory, connectorVersion: 'test', signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]),
        log: message => { if (message.startsWith('Waiting for approval')) stop.abort(); } });
      const original = await readFile(path.join(stateDirectory, 'identity.json'), 'utf8');
      await expect(runOutboundConnector({ ...server, stateDirectory, connectorVersion: 'test', retryRegistration: true,
        signal: AbortSignal.timeout(10_000) })).rejects.toThrow('outbound_registration_still_pending');
      expect(await readFile(path.join(stateDirectory, 'identity.json'), 'utf8')).toBe(original);
      expect(hellos).toHaveLength(1);
      const paired = new AbortController();
      await runOutboundConnector({ ...server, stateDirectory, connectorVersion: 'test', signal: AbortSignal.any([paired.signal, AbortSignal.timeout(10_000)]),
        log: message => { if (message.startsWith('Paired environment')) paired.abort(); } });
      expect(hellos).toHaveLength(2);
      expect(hellos[1]?.registrationAttemptId).toBe(hellos[0]?.registrationAttemptId);
      expect(JSON.parse(await readFile(path.join(stateDirectory, 'identity.json'), 'utf8')).binding).toEqual({ pairingId, scope });
    } finally { await server.close(); }
  });

  it.each(['denied', 'expired'] as const)('retries a %s request with the same connector and a new attempt', async terminalDecision => {
    const stateDirectory = await directory();
    const store = await openOutboundConnectorState(stateDirectory, 'http://host/');
    const original = store.state;
    await store.save({ ...original, credential, terminalDecision });
    await store.close();
    await runOutboundConnector({ serverUrl: 'http://host/', stateDirectory, connectorVersion: 'test', retryRegistration: true, signal: AbortSignal.abort() });
    const next = JSON.parse(await readFile(path.join(stateDirectory, 'identity.json'), 'utf8'));
    expect(next.connectorId).toBe(original.connectorId);
    expect(next.registrationAttemptId).not.toBe(original.registrationAttemptId);
    expect(next.terminalDecision).toBeUndefined();
  });

  it.each(['outbound_installation_mismatch', 'outbound_pairing_mismatch', 'outbound_pairing_unavailable',
    'outbound_registration_conflict', 'outbound_registration_invalid', 'outbound_protocol_invalid'])('stops on permanent rejection %s', async reason => {
    const stateDirectory = await directory();
    let connections = 0;
    const server = await connectorServer(stateDirectory, socket => socket.once('message', () => { connections += 1; socket.close(1008, reason); }));
    try {
      await expect(runOutboundConnector({ ...server, stateDirectory, connectorVersion: 'test', signal: AbortSignal.timeout(10_000) })).rejects.toThrow(reason);
      expect(connections).toBe(1);
    } finally { await server.close(); }
  });

  it.each(['outbound_connector_already_connected', 'outbound_server_draining', 'outbound_server_error'])('retries temporary rejection %s', async reason => {
    const stateDirectory = await directory();
    let connections = 0;
    const server = await connectorServer(stateDirectory, socket => socket.once('message', () => {
      connections += 1;
      if (connections === 1) socket.close(1008, reason);
      else socket.send(JSON.stringify({ type: 'pairing', status: 'denied', generation: 2 }));
    }));
    try {
      await runOutboundConnector({ ...server, stateDirectory, connectorVersion: 'test', signal: AbortSignal.timeout(10_000) });
      expect(connections).toBe(2);
    } finally { await server.close(); }
  });
});

describe('outbound connector origin and identity', () => {
  it('maps plain HTTP to WS and HTTPS to WSS without a separate transport opt-in', () => {
    expect(outboundWebSocketUrl(outboundServerUrl('http://host:4784'), OUTBOUND_CONTROL_PATH).href).toBe('ws://host:4784/api/outbound/control');
    expect(outboundWebSocketUrl(outboundServerUrl('https://host'), OUTBOUND_CONTROL_PATH).href).toBe('wss://host/api/outbound/control');
    expect(() => outboundServerUrl('https://name:password@host')).toThrow('outbound_server_url_invalid');
    expect(() => outboundArtifactUrl(new URL('https://host'), 'https://other/api/outbound/artifacts/test')).toThrow('outbound_artifact_url_invalid');
    expect(() => outboundArtifactUrl(new URL('https://host'), '/api/config')).toThrow('outbound_artifact_url_invalid');
  });

  it('preserves connector and registration identity across process sessions and URL changes', async () => {
    const root = await directory();
    const first = await openOutboundConnectorState(root, 'http://first/');
    const identity = first.state;
    await first.close();
    const second = await openOutboundConnectorState(root, 'https://new-url/');
    expect(second.state).toEqual(identity);
    await second.close();
  });

  it('keeps malformed existing identity state and fails rather than silently re-registering', async () => {
    const root = await directory();
    await writeFile(path.join(root, 'identity.json'), '{"broken":true}', { mode: 0o600 });
    await expect(openOutboundConnectorState(root, 'http://host/')).rejects.toThrow();
    expect(await readFile(path.join(root, 'identity.json'), 'utf8')).toBe('{"broken":true}');
  });
});

describe('HTTP sidecar installation', () => {
  it('verifies and publishes a complete release, then reuses it without another download', async () => {
    const accountHome = await directory();
    const bytes = Buffer.from('console.log("sidecar fixture");\n');
    const manifest = release(bytes);
    let downloads = 0;
    const installer = new LocalSidecarArtifactInstaller({ server: new URL('http://host'), scope, accountHome,
      fetch: async () => { downloads += 1; return new Response(bytes); } });
    const payload = { manifest, url: `/api/outbound/artifacts/${manifest.sha256}/payload` };
    const installed = await installer.install(payload, new AbortController().signal);
    expect(await readFile(installed.executablePath)).toEqual(bytes);
    expect(await installer.install(payload, new AbortController().signal)).toEqual(installed);
    expect(downloads).toBe(1);
    expect(await readdir(path.join(installed.stateRoot, 'incoming'))).toEqual([]);
  });

  it('does not publish a truncated or mismatched download and leaves no staging state', async () => {
    const accountHome = await directory();
    const manifest = release(Buffer.from('expected release'));
    const installer = new LocalSidecarArtifactInstaller({ server: new URL('http://host'), scope, accountHome,
      fetch: async () => new Response(Buffer.from('wrong')) });
    await expect(installer.install({ manifest, url: `/api/outbound/artifacts/${manifest.sha256}/payload` }, new AbortController().signal)).rejects.toThrow('sidecar_install_payload_size_invalid');
    const installed = await installer.installation(manifest.sha256);
    expect(await readdir(path.dirname(installed.executableDirectory))).toEqual([]);
    expect(await readdir(path.join(installed.stateRoot, 'incoming'))).toEqual([]);
  });

  it('repairs a private incomplete digest directory after an interrupted publication', async () => {
    const accountHome = await directory();
    const bytes = Buffer.from('repaired fixture');
    const manifest = release(bytes);
    const installer = new LocalSidecarArtifactInstaller({ server: new URL('http://host'), scope, accountHome, fetch: async () => new Response(bytes) });
    const installed = await installer.installation(manifest.sha256);
    await mkdir(installed.executableDirectory, { recursive: true, mode: 0o700 });
    await installer.install({ manifest, url: `/api/outbound/artifacts/${manifest.sha256}/payload` }, new AbortController().signal);
    expect(await readFile(installed.executablePath)).toEqual(bytes);
  });

  it('rejects manifest path additions before downloading any executable', async () => {
    const accountHome = await directory();
    const manifest = release(Buffer.from('fixture'));
    let called = false;
    const installer = new LocalSidecarArtifactInstaller({ server: new URL('http://host'), scope, accountHome, fetch: async () => { called = true; return new Response(); } });
    await expect(installer.install({ manifest: { ...manifest, destination: '/tmp/other' }, url: `/api/outbound/artifacts/${manifest.sha256}/payload` }, new AbortController().signal)).rejects.toThrow('sidecar_artifact_manifest_invalid');
    expect(called).toBe(false);
  });

  it('rejects same-length corrupt bytes and does not publish them', async () => {
    const accountHome = await directory();
    const manifest = release(Buffer.from('correct'));
    const installer = new LocalSidecarArtifactInstaller({ server: new URL('http://host'), scope, accountHome, fetch: async () => new Response(Buffer.from('invalid')) });
    await expect(installer.install({ manifest, url: `/api/outbound/artifacts/${manifest.sha256}/payload` }, new AbortController().signal)).rejects.toThrow('sidecar_artifact_digest_mismatch');
    const installed = await installer.installation(manifest.sha256);
    expect(await readdir(path.dirname(installed.executableDirectory))).toEqual([]);
  });

  it('authenticates artifact downloads without forwarding credentials to another origin', async () => {
    const accountHome = await directory();
    const bytes = Buffer.from('authenticated artifact');
    const manifest = release(bytes);
    let downloads = 0;
    const installer = new LocalSidecarArtifactInstaller({ server: new URL('http://host'), credential, scope, accountHome,
      fetch: async (_url, options) => { downloads += 1; expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${credential}`); expect(options?.redirect).toBe('error'); return new Response(bytes); } });
    await expect(installer.install({ manifest, url: `http://other/api/outbound/artifacts/${manifest.sha256}/payload` }, new AbortController().signal)).rejects.toThrow('outbound_artifact_url_invalid');
    expect(downloads).toBe(0);
    await installer.install({ manifest, url: `/api/outbound/artifacts/${manifest.sha256}/payload` }, new AbortController().signal);
    expect(downloads).toBe(1);
  });

  it('stages optional native assets even when their ABI cannot be used on the current host', async () => {
    const accountHome = await directory();
    const bytes = Buffer.from('optional native fixture');
    const native = Buffer.alloc(64, 3);
    const manifest: OutboundArtifactManifest = { ...release(bytes), nativeAssets: [{ platform: 'linux', architecture: 'arm64', nodeModuleVersion: '999', minimumGlibcVersion: '99.0',
      files: [{ relativePath: 'native/linux-arm64/pty.node', size: native.length, sha256: createHash('sha256').update(native).digest('hex'), mode: 0o500 }] }] };
    const installer = new LocalSidecarArtifactInstaller({ server: new URL('http://host'), scope, accountHome, fetch: async () => new Response(Buffer.concat([bytes, native])) });
    const installed = await installer.install({ manifest, url: `/api/outbound/artifacts/${manifest.sha256}/payload` }, new AbortController().signal);
    expect(await readFile(path.join(installed.executableDirectory, 'native/linux-arm64/pty.node'))).toEqual(native);
  });
});

it('registers over plain HTTP, waits for approval, and remembers a denial without executing host operations', async () => {
  const stateDirectory = await directory();
  const http = createServer();
  const websocket = new WebSocketServer({ server: http, path: OUTBOUND_CONTROL_PATH, handleProtocols: () => OUTBOUND_CONTROL_PROTOCOL });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('test_server_missing');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  await seedCredential(stateDirectory, serverUrl);
  const log: string[] = [];
  let hello: { connectorId: string; registrationAttemptId: string } | undefined;
  websocket.on('connection', socket => socket.once('message', data => {
    hello = JSON.parse(data.toString());
    socket.send(JSON.stringify({ type: 'pairing', status: 'pending', registrationId: randomUUID(), correlationCode: 'ABCD-1234', generation: 1 }));
    socket.send(JSON.stringify({ type: 'pairing', status: 'denied', generation: 1 }));
  }));
  try {
    await runOutboundConnector({ serverUrl, stateDirectory, connectorVersion: 'test', signal: AbortSignal.timeout(10_000), log: value => log.push(value) });
    expect(hello?.connectorId).toBeTruthy();
    expect(log).toContain('Waiting for approval: ABCD-1234');
    expect(log).toContain('Registration denied');
    const stored = JSON.parse(await readFile(path.join(stateDirectory, 'identity.json'), 'utf8'));
    expect(stored.connectorId).toBe(hello?.connectorId);
    expect(stored.terminalDecision).toBe('denied');
    await expect(runOutboundConnector({ serverUrl, stateDirectory, connectorVersion: 'test', signal: AbortSignal.timeout(10_000) })).rejects.toThrow('outbound_registration_denied');
  } finally {
    for (const socket of websocket.clients) socket.terminate();
    await new Promise<void>(resolve => websocket.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});

it('resumes the same revoked pairing explicitly, including a previously lost approval response', async () => {
  const stateDirectory = await directory();
  const http = createServer();
  const websocket = new WebSocketServer({ server: http, path: OUTBOUND_CONTROL_PATH, handleProtocols: () => OUTBOUND_CONTROL_PROTOCOL });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('test_server_missing');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  await seedCredential(stateDirectory, serverUrl);
  const pairingId = randomUUID();
  const hellos: Array<{ connectorId: string; registrationAttemptId: string; binding?: unknown }> = [];
  websocket.on('connection', socket => socket.once('message', data => {
    hellos.push(JSON.parse(data.toString()));
    socket.send(JSON.stringify({ type: 'pairing', status: hellos.length === 1 ? 'revoked' : 'accepted', pairingId, scope, generation: hellos.length }));
  }));
  try {
    await runOutboundConnector({ serverUrl, stateDirectory, connectorVersion: 'test', signal: AbortSignal.timeout(10_000) });
    const initial = JSON.parse(await readFile(path.join(stateDirectory, 'identity.json'), 'utf8'));
    expect(initial.binding).toEqual({ pairingId, scope });
    expect(initial.terminalDecision).toBe('revoked');
    await expect(runOutboundConnector({ serverUrl, stateDirectory, connectorVersion: 'test', signal: AbortSignal.timeout(10_000) })).rejects.toThrow('outbound_registration_revoked');
    const stop = new AbortController();
    await runOutboundConnector({ serverUrl, stateDirectory, connectorVersion: 'test', resumePairing: true,
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]), log: message => { if (message.startsWith('Paired environment')) stop.abort(); } });
    expect(hellos).toHaveLength(2);
    expect(hellos[1]?.connectorId).toBe(hellos[0]?.connectorId);
    expect(hellos[1]?.registrationAttemptId).toBe(hellos[0]?.registrationAttemptId);
    expect(hellos[1]?.binding).toEqual({ pairingId, installationId: scope.installationId });
    const resumed = JSON.parse(await readFile(path.join(stateDirectory, 'identity.json'), 'utf8'));
    expect(resumed.terminalDecision).toBeUndefined();
    expect(resumed.binding).toEqual(initial.binding);
  } finally {
    for (const socket of websocket.clients) socket.terminate();
    await new Promise<void>(resolve => websocket.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});


describe('outbound authentication enrollment', () => {
  it('rejects malformed enrollment codes before connecting and preserves saved credentials', async () => {
    const stateDirectory = await directory();
    const serverUrl = 'http://127.0.0.1:1';
    const store = await openOutboundConnectorState(stateDirectory, `${serverUrl}/`);
    await store.save({ ...store.state, credential });
    await store.close();
    const before = await readFile(path.join(stateDirectory, 'identity.json'), 'utf8');
    await expect(runOutboundConnector({ serverUrl, stateDirectory, pairingCode: '1234-5678', connectorVersion: 'test', signal: AbortSignal.timeout(1000) }))
      .rejects.toThrow('outbound_pairing_code_invalid_expected_eight_letters');
    expect(await readFile(path.join(stateDirectory, 'identity.json'), 'utf8')).toBe(before);
  });

  it('fails closed when the server authentication status cannot be read', async () => {
    await expect(runOutboundConnector({ serverUrl: 'http://127.0.0.1:1', stateDirectory: await directory(), connectorVersion: 'test', signal: AbortSignal.timeout(1000) }))
      .rejects.toThrow('outbound_authentication_status_unavailable');
  });

  it('persists enrollment, authenticates reconnects, and proves connector ownership when rotating', async () => {
    const stateDirectory = await directory();
    let enrollment: Record<string, unknown> | undefined;
    let enrollments = 0;
    const enrollmentRequests: Record<string, unknown>[] = [];
    const http = createServer((request, response) => {
      expect(request.url).toBe('/api/auth/pair');
      enrollments += 1;
      let body = '';
      request.on('data', data => { body += data; });
      request.on('end', () => { enrollment = JSON.parse(body); enrollmentRequests.push(enrollment!); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ credential })); });
    });
    const websocket = new WebSocketServer({ server: http, path: OUTBOUND_CONTROL_PATH, handleProtocols: () => OUTBOUND_CONTROL_PROTOCOL });
    websocket.on('connection', (socket, request) => {
      expect(request.headers.authorization).toBe(`Bearer ${credential}`);
      socket.once('message', data => {
        expect(JSON.parse(data.toString()).connectorId).toBe(enrollment?.connectorId);
        socket.send(JSON.stringify({ type: 'pairing', status: 'pending', registrationId: randomUUID(), correlationCode: 'ABCD-1234', generation: 1 }));
      });
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('test_server_missing');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    try {
      for (const pairingCode of [' bcdfghjk ', undefined, ' lmnp-qrst ']) {
        const stop = new AbortController();
        await runOutboundConnector({ serverUrl, stateDirectory, pairingCode, resumePairing: pairingCode !== undefined, connectorVersion: 'test', signal: AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]), log: message => { if (message.startsWith('Waiting for approval')) stop.abort(); } });
      }
      expect(enrollments).toBe(2);
      expect(enrollmentRequests[0]).toMatchObject({ token: 'BCDF-GHJK', kind: 'sidecar', clientName: expect.any(String), connectorId: expect.any(String) });
      expect(enrollmentRequests[0]).not.toHaveProperty('previousCredential');
      expect(enrollmentRequests[1]).toMatchObject({ token: 'LMNP-QRST', previousCredential: credential });
      const saved = JSON.parse(await readFile(path.join(stateDirectory, 'identity.json'), 'utf8'));
      expect(saved.credential).toBe(credential);
      expect(JSON.stringify(saved)).not.toContain('BCDF-GHJK');
      await expect(runOutboundConnector({ serverUrl: 'http://127.0.0.1:1', stateDirectory, connectorVersion: 'test', signal: AbortSignal.timeout(1000) })).rejects.toThrow('outbound_server_changed_use_separate_state_directory');
    } finally {
      for (const socket of websocket.clients) socket.terminate();
      await new Promise<void>(resolve => websocket.close(() => resolve()));
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  });

  it('stops retrying when a saved credential is rejected', async () => {
    const stateDirectory = await directory();
    const http = createServer();
    let attempts = 0;
    http.on('upgrade', (_request, socket) => { attempts += 1; socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('test_server_missing');
    const serverUrl = `http://127.0.0.1:${address.port}`;
    await seedCredential(stateDirectory, serverUrl);
    try {
      await expect(runOutboundConnector({ serverUrl, stateDirectory, connectorVersion: 'test', signal: AbortSignal.timeout(5000) })).rejects.toThrow('outbound_authentication_rejected_generate_new_pairing_code');
      expect(attempts).toBe(1);
    } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
  });
});


it('connects without auth only while explicitly disabled and retains credentials across off/on transitions', async () => {
  const stateDirectory = await directory();
  let required = false;
  let statusRequests = 0;
  const authorizations: Array<string | undefined> = [];
  const http = createServer((request, response) => {
    expect(request.url).toBe('/api/auth/status');
    statusRequests += 1;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ required, authenticated: false }));
  });
  const websocket = new WebSocketServer({ server: http, path: OUTBOUND_CONTROL_PATH, handleProtocols: () => OUTBOUND_CONTROL_PROTOCOL });
  websocket.on('connection', (socket, request) => {
    authorizations.push(request.headers.authorization);
    socket.once('message', () => socket.send(JSON.stringify({ type: 'pairing', status: 'pending', registrationId: randomUUID(), correlationCode: 'ABCD-1234', generation: 1 })));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('test_server_missing');
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const connectOnce = async () => {
    const stop = new AbortController();
    await runOutboundConnector({ serverUrl, stateDirectory, connectorVersion: 'test', signal: AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]), log: message => { if (message.startsWith('Waiting for approval')) stop.abort(); } });
  };
  try {
    await connectOnce();
    expect(authorizations).toEqual([undefined]);
    const unpaired = JSON.parse(await readFile(path.join(stateDirectory, 'identity.json'), 'utf8'));
    expect(unpaired.credential).toBeUndefined();
    required = true;
    await expect(connectOnce()).rejects.toThrow('outbound_authentication_required_use_pairing_url_or_pairing_code');
    expect(authorizations).toHaveLength(1);
    await seedCredential(stateDirectory, serverUrl);
    const saved = await readFile(path.join(stateDirectory, 'identity.json'), 'utf8');
    required = false;
    await connectOnce();
    required = true;
    await connectOnce();
    expect(authorizations).toEqual([undefined, `Bearer ${credential}`, `Bearer ${credential}`]);
    expect(statusRequests).toBe(2);
    expect(await readFile(path.join(stateDirectory, 'identity.json'), 'utf8')).toBe(saved);
  } finally {
    for (const socket of websocket.clients) socket.terminate();
    await new Promise<void>(resolve => websocket.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});
