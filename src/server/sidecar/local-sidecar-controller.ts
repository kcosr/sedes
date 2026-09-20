import { lstat, realpath } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SidecarByteStream } from '../../internal/sidecar-protocol/contracts.js';
import { outboundRuntimeBootstrapSchema, type OutboundRuntimeBootstrap } from '../../internal/outbound-protocol.js';
import { readSidecarManagementRecord, writeSidecarManagementRecord } from '../../internal/sidecar-protocol/service-management-channel.js';
import { sameSidecarServiceScope, sidecarManagementRequestSchema, sidecarManagementResponseSchema, type SidecarManagementResponse, type SidecarServiceScope } from '../../internal/sidecar-protocol/service-management-v1.js';
import { assertOwnedDirectory, assertPreviousServiceRetired, ensurePersistentSidecar } from './persistent-sidecar-bootstrap.js';
import { persistentSidecarPaths } from './persistent-sidecar-paths.js';
import { PersistentSidecarManagementReceipts } from './persistent-sidecar-management-receipts.js';
import { sidecarSocketByteStream } from './sidecar-socket-byte-stream.js';
import { windowsSidecarIpc } from './sidecar-windows-ipc.js';
import { LocalSidecarArtifactInstaller } from './local-sidecar-artifact-installer.js';
import type { SidecarArtifactInstallation } from './sidecar-provisioner.js';

/** Account-local control. Its lifetime never owns or terminates the daemon. */
export class LocalSidecarController {
  readonly #scope: SidecarServiceScope;
  readonly #artifacts: LocalSidecarArtifactInstaller;
  constructor(scope: SidecarServiceScope, artifacts: LocalSidecarArtifactInstaller) { this.#scope = scope; this.#artifacts = artifacts; }

  async #paths() {
    return persistentSidecarPaths(await realpath(homedir()), process.getuid?.() ?? 0, this.#scope);
  }

  async management(value: unknown, signal: AbortSignal): Promise<SidecarManagementResponse> {
    const request = sidecarManagementRequestSchema.parse(value);
    this.#assertScope(request.scope);
    if (request.operation === 'attach') throw new Error('outbound_management_attach_requires_runtime');
    const paths = await this.#paths();
    try { await assertOwnedDirectory(paths.stateRoot, false); await assertOwnedDirectory(paths.servicesRoot, true); await assertOwnedDirectory(paths.serviceDirectory, true); }
    catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
      return request.operation === 'receipt'
        ? { managementVersion: 1, requestId: request.requestId, outcome: 'receipt', receipt: null }
        : { managementVersion: 1, requestId: request.requestId, outcome: 'absent' };
    }
    if (request.operation === 'receipt') {
      const receipt = await new PersistentSidecarManagementReceipts(path.join(paths.serviceDirectory, 'management-receipts')).read(request.mutationId);
      return { managementVersion: 1, requestId: request.requestId, outcome: 'receipt', receipt: receipt ?? null };
    }
    let stream: SidecarByteStream;
    try { stream = await this.#connect(paths, signal); }
    catch (error) {
      if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ECONNREFUSED')) throw error;
      // No socket does not prove retirement: retain the shared process-lifetime fence.
      await assertPreviousServiceRetired(paths.descriptorPath, paths.endpointPath);
      return { managementVersion: 1, requestId: request.requestId, outcome: 'absent' };
    }
    try {
      await writeSidecarManagementRecord(stream, request, signal);
      const response = await readSidecarManagementRecord(stream, sidecarManagementResponseSchema, signal);
      if (response.value.requestId !== request.requestId) throw new Error('sidecar_management_response_identity_invalid');
      return response.value;
    } finally { await stream.close('outbound_management_complete'); }
  }

  async runtime(value: OutboundRuntimeBootstrap, signal: AbortSignal): Promise<{ stream: SidecarByteStream; installation: SidecarArtifactInstallation }> {
    const input = outboundRuntimeBootstrapSchema.parse(value);
    this.#assertScope(input.scope);
    signal.throwIfAborted();
    const installation = await this.#artifacts.installation(input.expectedDigest);
    if (input.startIfAbsent) {
      await ensurePersistentSidecar({ ...input, executablePath: installation.executablePath, environment: installation.environment, signal });
    }
    signal.throwIfAborted();
    const paths = await this.#paths();
    return { stream: await this.#connect(paths, signal), installation };
  }

  #assertScope(scope: SidecarServiceScope) { if (!sameSidecarServiceScope(scope, this.#scope)) throw new Error('sidecar_service_scope_mismatch'); }

  async #connect(paths: ReturnType<typeof persistentSidecarPaths>, signal: AbortSignal): Promise<SidecarByteStream> {
    if (process.platform !== 'win32') {
      await assertOwnedDirectory(paths.socketDirectory, true);
      const metadata = await lstat(paths.endpointPath);
      if (!metadata.isSocket() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error('sidecar_service_endpoint_invalid');
    }
    signal.throwIfAborted();
    const ipcKey = process.platform === 'win32' ? await windowsSidecarIpc.readKey(paths.endpointPath) : undefined;
    const socket = connect(paths.endpointPath);
    const stream = sidecarSocketByteStream(socket);
    const abort = () => socket.destroy();
    signal.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('sidecar_service_connect_closed')));
      });
      if (ipcKey) await windowsSidecarIpc.authenticate(socket, ipcKey, 'client');
      signal.throwIfAborted();
      return stream;
    } catch (error) { await stream.close('outbound_local_connect_failed'); throw error; }
    finally { signal.removeEventListener('abort', abort); }
  }
}

function hasCode(error: unknown, code: string): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === code; }
