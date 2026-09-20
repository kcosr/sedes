import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { outboundInstallationSchema } from '../../internal/outbound-protocol.js';
import { SIDECAR_WIRE_VERSION } from '../../internal/sidecar-protocol/envelopes.js';
import { readSidecarManagementRecord, writeSidecarManagementRecord } from '../../internal/sidecar-protocol/service-management-channel.js';
import { sameSidecarServiceConfiguration, sameSidecarServiceScope, sidecarManagementResponseSchema,
  type SidecarManagementRequest, type SidecarManagementReceipt, type SidecarManagementResponse,
  type SidecarServiceConfiguration, type SidecarServiceScope, type SidecarServiceStatus } from '../../internal/sidecar-protocol/service-management-v1.js';
import { OutboundCarrierError, type OutboundConnectionRegistry } from '../outbound/outbound-connection-registry.js';
import { assertSidecarArtifactRegistration, type SidecarArtifactRegistration } from './sidecar-artifact.js';
import { outboundArtifactManifest } from './local-sidecar-artifact-installer.js';
import { SidecarConnectionError, SidecarServiceManagementError, SidecarServiceStagingError,
  type PersistentSidecarByteStream, type SidecarArtifactInstallation, type SidecarProvisioner, type SidecarServiceControlInput, type SidecarServiceControlBoundary } from './sidecar-provisioner.js';

/** Server-side strategy. All paths and process operations are resolved by the paired host. */
export class OutboundSidecarProvisioner implements SidecarProvisioner {
  readonly transportKind = 'outbound';
  readonly #registry: OutboundConnectionRegistry;
  readonly #artifact: SidecarArtifactRegistration;
  readonly #scope: SidecarServiceScope;
  readonly #configuration: SidecarServiceConfiguration;
  readonly #agentToolEndpointKey: string;
  constructor(input: { registry: OutboundConnectionRegistry; artifact: SidecarArtifactRegistration; serviceScope: SidecarServiceScope; configuration: SidecarServiceConfiguration; agentToolEndpointKey: string }) {
    assertSidecarArtifactRegistration(input.artifact);
    if (!/^[a-f0-9]{24}$/u.test(input.agentToolEndpointKey)) throw new Error('sidecar_agent_tool_endpoint_key_invalid');
    this.#registry = input.registry; this.#artifact = input.artifact; this.#scope = input.serviceScope;
    this.#configuration = input.configuration; this.#agentToolEndpointKey = input.agentToolEndpointKey;
  }

  async install(signal: AbortSignal): Promise<SidecarArtifactInstallation> {
    const response = await this.#carrier(() => this.#registry.request(this.#scope, this.#scope.executionEnvironmentId, 'install',
      { manifest: outboundArtifactManifest(this.#artifact), url: `/api/outbound/artifacts/${this.#artifact.artifactSha256}/payload` }, signal));
    return outboundInstallationSchema.parse(response);
  }

  async inspect(signal: AbortSignal): Promise<SidecarServiceStatus | undefined> {
    const response = await this.#management({ managementVersion: 1, requestId: randomUUID(), scope: this.#scope, operation: 'status' }, signal);
    if (response.outcome === 'absent') return undefined;
    return this.#status(response);
  }

  async inspectReceipt(mutationId: string, signal: AbortSignal): Promise<SidecarManagementReceipt | undefined> {
    const response = await this.#management({ managementVersion: 1, requestId: randomUUID(), scope: this.#scope, operation: 'receipt', mutationId }, signal);
    if (response.outcome !== 'receipt') throw new Error('sidecar_management_response_invalid');
    return response.receipt ?? undefined;
  }

  async withdrawReceipt(mutationId: string, expectedServiceIncarnation: string, signal: AbortSignal): Promise<SidecarManagementReceipt | undefined> {
    const response = await this.#management({ managementVersion: 1, requestId: randomUUID(), scope: this.#scope, operation: 'withdraw', mutationId, expectedServiceIncarnation }, signal);
    if (response.outcome === 'absent') return undefined;
    if (response.outcome !== 'receipt' || !response.receipt) throw new Error('sidecar_management_response_invalid');
    return response.receipt;
  }

  async launch(carrierGeneration: number, sessionNonce: string, signal: AbortSignal): Promise<PersistentSidecarByteStream> {
    let existing = await this.inspect(signal);
    for (let attempt = 0; existing && this.#outdated(existing); attempt += 1) {
      if (existing.resources.some(resource => resource.state === 'active' || resource.state === 'unknown' || resource.blockers.length > 0)) {
        if (existing.runtimeWireVersion !== SIDECAR_WIRE_VERSION) throw new SidecarServiceManagementError('sidecar_runtime_upgrade_required', existing);
        break;
      }
      const outdated = existing;
      try {
        existing = await this.control({ mutationId: randomUUID(), operation: 'upgrade', expectedServiceIncarnation: outdated.serviceIncarnation,
          controllerEpoch: outdated.controllerEpoch, expectedConfiguration: outdated.desiredConfiguration,
          expectedResourcesFingerprint: outdated.resourcesFingerprint, force: false }, signal);
        break;
      } catch (error) {
        if (!(error instanceof SidecarServiceManagementError) || error.code !== 'sidecar_service_confirmation_stale' ||
          !error.status || error.status.serviceIncarnation !== outdated.serviceIncarnation || attempt >= 2) throw error;
        existing = error.status;
      }
    }
    return await this.#attach(carrierGeneration, sessionNonce, existing, true, 'normal', signal);
  }

  async attachExisting(carrierGeneration: number, sessionNonce: string, signal: AbortSignal): Promise<PersistentSidecarByteStream> {
    const existing = await this.inspect(signal);
    if (!existing) throw new Error('sidecar_service_absent');
    if (existing.runtimeWireVersion !== SIDECAR_WIRE_VERSION) throw new SidecarServiceManagementError('sidecar_runtime_upgrade_required', existing);
    return await this.#attach(carrierGeneration, sessionNonce, existing, false, 'recovery', signal);
  }

  async control(input: SidecarServiceControlInput, signal: AbortSignal, boundary: SidecarServiceControlBoundary = effect => effect()): Promise<SidecarServiceStatus | undefined> {
    if (input.operation !== 'stop') {
      try { await this.install(signal); }
      catch (error) { throw new SidecarServiceStagingError(error); }
    }
    signal.throwIfAborted();
    return await boundary(() => this.#controlStaged(input, signal));
  }

  async #controlStaged(input: SidecarServiceControlInput, signal: AbortSignal): Promise<SidecarServiceStatus | undefined> {
    let response = await this.#management({ managementVersion: 1, requestId: input.mutationId, scope: this.#scope,
      operation: input.operation === 'stop' ? 'stop' : 'restart', expectedServiceIncarnation: input.expectedServiceIncarnation,
      controllerEpoch: input.controllerEpoch, expectedConfiguration: input.expectedConfiguration,
      expectedResourcesFingerprint: input.expectedResourcesFingerprint, force: input.force }, signal);
    let absentWithoutAdmission = false;
    if (response.outcome === 'absent') {
      const receipt = await this.inspectReceipt(input.mutationId, signal);
      absentWithoutAdmission = receipt === undefined;
      // Shared local ownership proved absence; an absent receipt proves no admission.
      response = { managementVersion: 1, requestId: input.mutationId, outcome: 'receipt', receipt: receipt ?? null };
    }
    if (response.outcome === 'receipt' && !response.receipt && !absentWithoutAdmission) {
      throw new SidecarServiceManagementError('sidecar_management_outcome_unknown');
    }
    if (response.outcome === 'receipt' && response.receipt) {
      const receipt = response.receipt;
      if (receipt.state === 'withdrawn') throw new SidecarServiceManagementError('sidecar_management_mutation_withdrawn', undefined, 'rejected');
      if (receipt.state === 'failed' || receipt.state === 'handoff_pending') throw new SidecarServiceManagementError(receipt.code ?? 'sidecar_management_failed', undefined, 'rejected');
      if (receipt.state !== 'completed') throw new SidecarServiceManagementError('sidecar_management_outcome_unknown');
    } else if (response.outcome !== 'receipt') {
      const status = this.#status(response);
      if (status.state !== 'stopped') throw new SidecarServiceManagementError('sidecar_service_stop_unconfirmed', status);
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      signal.throwIfAborted();
      const current = await this.inspect(signal);
      if (!current) break;
      if (current.serviceIncarnation !== input.expectedServiceIncarnation) {
        if (input.operation === 'stop') return undefined;
        if (this.#outdated(current)) throw new SidecarServiceManagementError('sidecar_service_replaced_concurrently', current);
        return current;
      }
      if (attempt === 99) throw new SidecarServiceManagementError('sidecar_service_stop_unconfirmed');
      await pause(50, undefined, { signal });
    }
    if (input.operation === 'stop') return undefined;
    const attached = await this.#attach(1, randomBytes(32).toString('hex'), undefined, true, 'normal', signal);
    try { return attached.serviceStatus; } finally { await attached.close('sidecar_management_replacement_ready'); }
  }

  async #attach(carrierGeneration: number, sessionNonce: string, serving: SidecarServiceStatus | undefined, startIfAbsent: boolean,
    mode: 'normal' | 'recovery', signal: AbortSignal): Promise<PersistentSidecarByteStream> {
    const stream = await this.#carrier(() => this.#registry.openRuntime(this.#scope, this.#scope.executionEnvironmentId, {
      scope: this.#scope, configuration: this.#configuration, expectedDigest: serving?.artifactSha256 ?? this.#artifact.artifactSha256,
      expectedBuild: serving?.buildId ?? this.#artifact.buildId, agentToolEndpointKey: this.#agentToolEndpointKey, startIfAbsent: startIfAbsent && !serving,
    }, signal));
    const request: SidecarManagementRequest = { managementVersion: 1, requestId: randomUUID(), scope: this.#scope, operation: 'attach',
      expectedBuildId: serving?.buildId ?? this.#artifact.buildId, expectedArtifactSha256: serving?.artifactSha256 ?? this.#artifact.artifactSha256,
      runtimeWireVersion: SIDECAR_WIRE_VERSION, carrierGeneration, sessionNonce, configuration: this.#configuration, mode };
    try {
      await writeSidecarManagementRecord(stream, request, signal);
      const response = await readSidecarManagementRecord(stream, sidecarManagementResponseSchema, signal);
      if (response.value.requestId !== request.requestId) throw new Error('sidecar_management_response_identity_invalid');
      return { ...response.stream, serviceStatus: this.#status(response.value), installation: stream.installation };
    } catch (error) { await stream.close('outbound_runtime_attach_failed'); throw error; }
  }

  async #management(request: SidecarManagementRequest, signal: AbortSignal): Promise<SidecarManagementResponse> {
    const response = sidecarManagementResponseSchema.parse(await this.#carrier(() => this.#registry.request(this.#scope, this.#scope.executionEnvironmentId, 'management', request, signal)));
    if (response.requestId !== request.requestId) throw new Error('sidecar_management_response_identity_invalid');
    if (response.outcome === 'error') throw new SidecarServiceManagementError(response.code, response.status, 'rejected');
    return response;
  }

  #status(response: SidecarManagementResponse): SidecarServiceStatus {
    if (response.outcome === 'error') throw new SidecarServiceManagementError(response.code, response.status, 'rejected');
    if (response.outcome !== 'ok' || !sameSidecarServiceScope(response.status.scope, this.#scope)) throw new Error('sidecar_service_scope_mismatch');
    return response.status;
  }

  #outdated(status: SidecarServiceStatus): boolean {
    return status.buildId !== this.#artifact.buildId || status.artifactSha256 !== this.#artifact.artifactSha256 ||
      status.runtimeWireVersion !== SIDECAR_WIRE_VERSION || !sameSidecarServiceConfiguration(status.effectiveConfiguration, this.#configuration);
  }

  async #carrier<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof OutboundCarrierError) throw new SidecarConnectionError({ cause: error }, error.message);
      throw error;
    }
  }
}
