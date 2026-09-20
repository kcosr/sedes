import { pairingCodeSchema } from '../../shared/authentication.js';
import { randomUUID } from 'node:crypto';
import { homedir, hostname, userInfo } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { WebSocket, type RawData } from 'ws';
import { OUTBOUND_CONTROL_MAX_BYTES, OUTBOUND_CONTROL_PATH, OUTBOUND_CONTROL_PROTOCOL, OUTBOUND_RUNTIME_CHUNK_BYTES, OUTBOUND_RUNTIME_PATH, OUTBOUND_RUNTIME_PROTOCOL, outboundClientMessageSchema, outboundHelloSchema, outboundServerMessageSchema, type OutboundClientMessage, type OutboundServerMessage } from '../../internal/outbound-protocol.js';
import { createWebSocketByteStream } from '../../internal/websocket-byte-stream.js';
import type { SidecarByteStream } from '../../internal/sidecar-protocol/contracts.js';
import { sameSidecarServiceScope } from '../../internal/sidecar-protocol/service-management-v1.js';
import { supportsSidecarNodeVersion } from '../../internal/sidecar-protocol/sidecar-runtime-version.js';
import { LocalSidecarArtifactInstaller } from './local-sidecar-artifact-installer.js';
import { LocalSidecarController } from './local-sidecar-controller.js';
import { openOutboundConnectorState, type OutboundConnectorState } from './outbound-connector-state.js';
import { outboundServerUrl, outboundWebSocketUrl } from './outbound-connector-url.js';

export interface OutboundConnectorOptions {
  readonly serverUrl: string;
  readonly pairingCode?: string;
  readonly stateDirectory?: string;
  readonly connectorVersion: string;
  readonly retryRegistration?: boolean;
  readonly resumePairing?: boolean;
  readonly signal: AbortSignal;
  readonly log?: (message: string) => void;
}

/** The connector is replaceable network plumbing; its exit never stops owned work. */
export async function runOutboundConnector(options: OutboundConnectorOptions): Promise<void> {
  if (!supportsSidecarNodeVersion(process.versions.node)) throw new Error('sidecar_node_version_unsupported');
  const server = outboundServerUrl(options.serverUrl);
  const directory = options.stateDirectory ?? path.join(homedir(), '.local', 'state', 'sedes', 'connector');
  const store = await openOutboundConnectorState(directory, server.href);
  let state = store.state;
  const log = options.log ?? (() => undefined);
  try {
    if (state.serverUrl !== server.href) throw new ConnectorTerminalError('outbound_server_changed_use_separate_state_directory');
    if (options.pairingCode !== undefined) {
      const code = pairingCodeSchema.safeParse(options.pairingCode);
      if (!code.success) throw new ConnectorTerminalError('outbound_pairing_code_invalid_expected_eight_letters');
      const response = await fetch(new URL('/api/auth/pair', server), {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: code.data, clientName: hostname(), kind: 'sidecar', connectorId: state.connectorId, ...(state.credential ? { previousCredential: state.credential } : {}) }),
      });
      if (!response.ok) throw new ConnectorTerminalError('outbound_pairing_failed_generate_new_code');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('credential' in result) || typeof result.credential !== 'string' || result.credential.length < 32 || result.credential.length > 1024) throw new ConnectorTerminalError('outbound_pairing_response_invalid');
      state = { ...state, credential: result.credential };
      await store.save(state);
    }
    if (!state.credential) {
      let status: unknown;
      try {
        const response = await fetch(new URL('/api/auth/status', server), { redirect: 'error', signal: AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) });
        if (!response.ok) throw new Error('status unavailable');
        status = await response.json();
      } catch { throw new ConnectorTerminalError('outbound_authentication_status_unavailable'); }
      if (!status || typeof status !== 'object' || !('required' in status) || status.required !== false) {
        throw new ConnectorTerminalError('outbound_authentication_required_use_pairing_url_or_pairing_code');
      }
    }
    if (options.resumePairing) {
      if (options.retryRegistration || (state.terminalDecision !== 'revoked' && !options.pairingCode)) throw new Error('outbound_pairing_not_revoked');
      // A fresh enrollment also permits resume when the old revocation notice was lost.
      // The server remains authoritative for the existing registration attempt.
      const { terminalDecision: _, ...rest } = state;
      state = rest;
      await store.save(state);
    }
    if (options.retryRegistration) {
      if (state.binding) throw new Error('outbound_paired_identity_requires_explicit_new_state');
      if (state.terminalDecision !== 'denied' && state.terminalDecision !== 'expired') throw new Error('outbound_registration_still_pending');
      const { terminalDecision: _, ...rest } = state;
      state = { ...rest, registrationAttemptId: randomUUID() };
      await store.save(state);
    }
    if (state.terminalDecision) throw new Error(`outbound_registration_${state.terminalDecision}`);
    log(`Connecting to ${server.origin}`);
    let attempt = 0;
    while (!options.signal.aborted) {
      const started = Date.now();
      try {
        await connectionSession({ server, state: () => state, save: async value => { await store.save(value); state = value; }, options, log });
      } catch (error) {
        if (options.signal.aborted) break;
        log(diagnostic(error));
        if (error instanceof ConnectorTerminalError) throw error;
      }
      if (state.terminalDecision || options.signal.aborted) break;
      if (Date.now() - started > 60_000) attempt = 0;
      const delay = Math.round(Math.min(30_000, 500 * 2 ** Math.min(attempt++, 6)) * (0.75 + Math.random() * 0.5));
      await pause(delay, undefined, { signal: options.signal }).catch(error => { if (!options.signal.aborted) throw error; });
    }
  } finally { await store.close(); }
}

class ConnectorTerminalError extends Error {}

const permanentServerRejections = new Set([
  'outbound_installation_mismatch',
  'outbound_pairing_mismatch',
  'outbound_pairing_unavailable',
  'outbound_registration_conflict',
  'outbound_registration_invalid',
  'outbound_protocol_invalid',
  'outbound_authenticated_connector_mismatch',
  'outbound_authentication_required_repair',
]);

async function connectionSession(input: {
  server: URL;
  state(): OutboundConnectorState;
  save(value: OutboundConnectorState): Promise<void>;
  options: OutboundConnectorOptions;
  log(message: string): void;
}): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, input.options.signal]);
  const socket = new WebSocket(outboundWebSocketUrl(input.server, OUTBOUND_CONTROL_PATH), OUTBOUND_CONTROL_PROTOCOL,
    { headers: input.state().credential ? { Authorization: `Bearer ${input.state().credential}` } : {}, perMessageDeflate: false, maxPayload: OUTBOUND_CONTROL_MAX_BYTES, handshakeTimeout: 15_000, followRedirects: false });
  const tasks = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  let local: LocalSidecarController | undefined;
  let artifacts: LocalSidecarArtifactInstaller | undefined;
  let runtime: { ticket: string; close(): Promise<void> } | undefined;
  const attachments = new Map<string, AbortController>();
  let attachmentTail = Promise.resolve();
  let terminal: Error | undefined;
  let seen = Date.now();
  let dispatch = Promise.resolve();
  let queuedMessages = 0;
  let queuedBytes = 0;
  const abort = () => socket.terminate();
  signal.addEventListener('abort', abort, { once: true });
  const closed = new Promise<void>(resolve => socket.once('close', (code, reason) => {
    controller.abort(new Error('outbound_control_closed'));
    if (reason.length) input.log(`Disconnected: ${reason.toString('utf8').replace(/[^A-Za-z0-9 _.:/-]/gu, '_').slice(0, 200)}`);
    if (code === 1002 || code === 1003) terminal ??= new ConnectorTerminalError('outbound_connector_protocol_update_required');
    if (code === 1008 && permanentServerRejections.has(reason.toString('utf8'))) terminal ??= new ConnectorTerminalError(reason.toString('utf8'));
    resolve();
  }));
  socket.on('error', error => { input.log(diagnostic(error)); socket.terminate(); });
  socket.on('ping', () => { seen = Date.now(); });
  const heartbeat = setInterval(() => { if (Date.now() - seen > 35_000) socket.terminate(); }, 5_000);
  heartbeat.unref();
  const send = async (message: OutboundClientMessage) => {
    const bytes = JSON.stringify(outboundClientMessageSchema.parse(message));
    if (socket.readyState !== WebSocket.OPEN || signal.aborted || socket.bufferedAmount + Buffer.byteLength(bytes) > OUTBOUND_CONTROL_MAX_BYTES) throw new Error('outbound_control_unavailable');
    await new Promise<void>((resolve, reject) => socket.send(bytes, error => error ? reject(error) : resolve()));
  };
  const launchTask = (operation: Promise<void>) => {
    pending.add(operation);
    void operation.catch(error => { if (!signal.aborted) input.log(diagnostic(error)); }).finally(() => pending.delete(operation));
  };
  const handle = async (message: OutboundServerMessage) => {
    if (message.type === 'pairing') {
      if (message.status === 'accepted') {
        if (!message.pairingId || !message.scope) throw new ConnectorTerminalError('outbound_pairing_response_invalid');
        const current = input.state();
        if (current.binding && (current.binding.pairingId !== message.pairingId || !sameSidecarServiceScope(current.binding.scope, message.scope))) throw new ConnectorTerminalError('outbound_server_installation_mismatch');
        await input.save({ ...current, serverUrl: input.server.href, binding: { pairingId: message.pairingId, scope: message.scope } });
        if (!local) {
          artifacts = new LocalSidecarArtifactInstaller({ server: input.server, credential: input.state().credential, scope: message.scope });
          local = new LocalSidecarController(message.scope, artifacts);
        }
        input.log(`Paired environment ${message.scope.executionEnvironmentId}`);
      } else if (message.status === 'pending') {
        if (input.state().binding) throw new ConnectorTerminalError('outbound_pairing_identity_lost');
        input.log(`Waiting for approval${message.correlationCode ? `: ${message.correlationCode}` : ''}`);
      } else {
        const current = input.state();
        if (message.status === 'revoked' && message.pairingId && message.scope) {
          if (current.binding && (current.binding.pairingId !== message.pairingId || !sameSidecarServiceScope(current.binding.scope, message.scope))) throw new ConnectorTerminalError('outbound_server_installation_mismatch');
          await input.save({ ...current, binding: { pairingId: message.pairingId, scope: message.scope }, terminalDecision: message.status });
        } else await input.save({ ...current, terminalDecision: message.status });
        input.log(`Registration ${message.status}`);
        socket.close(1000, `outbound_registration_${message.status}`);
      }
      return;
    }
    if (!local || !artifacts) throw new ConnectorTerminalError('outbound_command_before_pairing');
    if (message.type === 'cancel') { tasks.get(message.requestId)?.abort(new Error('outbound_command_cancelled')); return; }
    if (message.type === 'cancelAttach') {
      attachments.get(message.ticket)?.abort(new Error('outbound_attachment_cancelled'));
      if (runtime?.ticket === message.ticket) { await runtime.close(); runtime = undefined; }
      return;
    }
    if (message.type === 'command') {
      if (tasks.size >= 16 || tasks.has(message.requestId)) throw new Error('outbound_command_limit');
      const commandController = new AbortController();
      tasks.set(message.requestId, commandController);
      const commandSignal = AbortSignal.any([signal, commandController.signal, AbortSignal.timeout(120_000)]);
      const target = local; const installer = artifacts;
      launchTask((async () => {
        try {
          const result = message.operation === 'install' ? await installer.install(message.payload, commandSignal) : await target.management(message.payload, commandSignal);
          await send({ type: 'result', requestId: message.requestId, ok: true, result });
        } catch (error) {
          if (!signal.aborted) {
            const reason = diagnostic(error);
            input.log(reason);
            await send({ type: 'result', requestId: message.requestId, ok: false, error: reason });
          }
        } finally { tasks.delete(message.requestId); }
      })());
      return;
    }
    if (attachments.size >= 2 || attachments.has(message.ticket)) {
      await send({ type: 'runtimeReady', ticket: message.ticket, ok: false, error: 'outbound_runtime_attach_in_progress' });
      return;
    }
    const attachController = new AbortController();
    attachments.set(message.ticket, attachController);
    const attachSignal = AbortSignal.any([signal, attachController.signal, AbortSignal.timeout(120_000)]);
    const target = local;
    const previousAttachment = attachmentTail;
    const attaching = (async () => {
      let localStream: SidecarByteStream | undefined;
      let remoteStream: SidecarByteStream | undefined;
      try {
        await previousAttachment;
        attachSignal.throwIfAborted();
        await runtime?.close(); runtime = undefined;
        const opened = await target.runtime(message.payload, attachSignal);
        localStream = opened.stream;
        const remoteSocket = new WebSocket(outboundWebSocketUrl(input.server, OUTBOUND_RUNTIME_PATH), [OUTBOUND_RUNTIME_PROTOCOL, message.ticket],
          { headers: input.state().credential ? { Authorization: `Bearer ${input.state().credential}` } : {}, perMessageDeflate: false, maxPayload: OUTBOUND_RUNTIME_CHUNK_BYTES, handshakeTimeout: 15_000, followRedirects: false });
        remoteStream = createWebSocketByteStream(remoteSocket);
        await waitForOpen(remoteSocket, attachSignal);
        const left = localStream; const right = remoteStream;
        const close = async () => { await Promise.allSettled([left.close('outbound_bridge_detached'), right.close('outbound_bridge_detached')]); };
        attachSignal.throwIfAborted();
        runtime = { ticket: message.ticket, close };
        await send({ type: 'runtimeReady', ticket: message.ticket, ok: true, installation: opened.installation });
        const bridge = bridgeStreams(left, right).finally(close);
        launchTask(bridge);
        localStream = undefined; remoteStream = undefined;
      } catch (error) {
        if (error instanceof ConnectorTerminalError) { terminal = error; socket.terminate(); }
        await Promise.allSettled([localStream?.close('outbound_runtime_failed'), remoteStream?.close('outbound_runtime_failed')]);
        if (!signal.aborted) await send({ type: 'runtimeReady', ticket: message.ticket, ok: false, error: diagnostic(error) });
      } finally { attachments.delete(message.ticket); }
    })();
    attachmentTail = attaching.catch(() => undefined);
    launchTask(attaching);
  };
  socket.on('message', (data: RawData, binary: boolean) => {
    seen = Date.now();
    if (binary) { terminal = new ConnectorTerminalError('outbound_control_binary_invalid'); socket.terminate(); return; }
    const bytes = Array.isArray(data) ? data.reduce((total, part) => total + part.byteLength, 0) : data.byteLength;
    if (queuedMessages >= 32 || queuedBytes + bytes > OUTBOUND_CONTROL_MAX_BYTES * 2) {
      terminal = new ConnectorTerminalError('outbound_control_receive_limit');
      socket.terminate();
      return;
    }
    queuedMessages += 1;
    queuedBytes += bytes;
    dispatch = dispatch.then(async () => {
      signal.throwIfAborted();
      const message = outboundServerMessageSchema.parse(JSON.parse(data.toString()));
      await handle(message);
    }).catch(error => { if (error instanceof ConnectorTerminalError) terminal = error; if (!signal.aborted) input.log(diagnostic(error)); socket.terminate(); })
      .finally(() => { queuedMessages -= 1; queuedBytes -= bytes; });
  });
  try {
    await waitForOpen(socket, signal);
    const state = input.state();
    await send(outboundHelloSchema.parse({ type: 'hello', protocolVersion: 1,
      connectorId: state.connectorId, registrationAttemptId: state.registrationAttemptId,
      metadata: { hostname: hostname(), platform: process.platform, architecture: process.arch, account: userInfo().username,
        connectorVersion: input.options.connectorVersion, nodeVersion: process.versions.node },
      ...(state.binding ? { binding: { pairingId: state.binding.pairingId, installationId: state.binding.scope.installationId } } : {}) }));
    await closed;
  } finally {
    controller.abort(new Error('outbound_session_retired'));
    clearInterval(heartbeat);
    signal.removeEventListener('abort', abort);
    socket.terminate();
    await runtime?.close();
    await dispatch;
    await Promise.allSettled([...pending]);
  }
  if (terminal) throw terminal;
}

async function waitForOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const opened = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); socket.terminate(); reject(new Error('outbound_connection_failed')); };
    const rejected = (_request: unknown, response: import('node:http').IncomingMessage) => {
      cleanup(); response.resume(); socket.terminate();
      reject(response.statusCode === 401 || response.statusCode === 403 ? new ConnectorTerminalError('outbound_authentication_rejected_generate_new_pairing_code') : new Error('outbound_connection_failed'));
    };
    const cleanup = () => { socket.off('unexpected-response', rejected); socket.off('open', opened); socket.off('error', failed); socket.off('close', failed); signal.removeEventListener('abort', failed); };
    socket.once('unexpected-response', rejected); socket.once('open', opened); socket.once('error', failed); socket.once('close', failed); signal.addEventListener('abort', failed, { once: true });
  });
}

async function bridgeStreams(left: SidecarByteStream, right: SidecarByteStream): Promise<void> {
  const copy = async (source: SidecarByteStream, destination: SidecarByteStream) => { for await (const bytes of source.bytes) await destination.write(bytes); };
  const directions = [copy(left, right), copy(right, left)];
  try { await Promise.race(directions); }
  finally { await Promise.allSettled([left.close('outbound_bridge_closed'), right.close('outbound_bridge_closed')]); await Promise.allSettled(directions); }
}

function diagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : 'outbound_connector_failed').replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, 240);
}
