import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SIDECAR_WIRE_VERSION } from '../../src/internal/sidecar-protocol/envelopes.js';
import type { SidecarManagementRequest, SidecarServiceStatus } from '../../src/internal/sidecar-protocol/service-management-v1.js';
import { OutboundCarrierError, type OutboundConnectionRegistry } from '../../src/server/outbound/outbound-connection-registry.js';
import { OutboundSidecarProvisioner } from '../../src/server/sidecar/outbound-sidecar-provisioner.js';
import { SidecarConnectionError, type SidecarServiceControlBoundary } from '../../src/server/sidecar/sidecar-provisioner.js';
import type { SidecarArtifactRegistration } from '../../src/server/sidecar/sidecar-artifact.js';

const scope = { installationId: 'installation', tenantId: 'tenant', principalId: 'principal', executionEnvironmentId: 'environment' };
const configuration = { environmentRevision: 1, operationsRevision: 1 };
const artifactDirectory = path.resolve('test-artifact');
const artifact: SidecarArtifactRegistration = { artifactId: 'openai.sedes.sidecar', modes: ['agent_tools_cli', 'persistent_service'],
  executableDirectory: artifactDirectory, executablePath: path.join(artifactDirectory, 'sedes'), artifactSha256: 'a'.repeat(64), artifactBytes: 16,
  buildId: 'current', minimumNodeVersion: '22.19.0', nativeAssets: [] };
const status = (changes: Partial<SidecarServiceStatus> = {}): SidecarServiceStatus => ({ scope, serviceIncarnation: 'incarnation',
  buildId: 'current', artifactSha256: artifact.artifactSha256, runtimeWireVersion: SIDECAR_WIRE_VERSION, controllerEpoch: 1,
  attached: false, attachmentMode: 'none', state: 'ready', desiredConfiguration: configuration, effectiveConfiguration: configuration,
  configurationState: 'applied', resources: [], resourcesFingerprint: 'b'.repeat(64), ...changes });
function setup(request: (...args: unknown[]) => Promise<unknown>) {
  const registry = { request: vi.fn(request), openRuntime: vi.fn(async () => { throw new Error('test_attachment_reached'); }) };
  const provisioner = new OutboundSidecarProvisioner({ registry: registry as unknown as OutboundConnectionRegistry,
    artifact, serviceScope: scope, configuration, agentToolEndpointKey: 'c'.repeat(24) });
  return { registry, provisioner };
}
const signal = () => new AbortController().signal;

describe('outbound lifecycle provisioning', () => {
  it('marks only server-observed carrier failures for automatic connection recovery', async () => {
    const lost = setup(async () => { throw new OutboundCarrierError('outbound_connector_offline'); });
    await expect(lost.provisioner.inspect(signal())).rejects.toBeInstanceOf(SidecarConnectionError);
    const rejected = setup(async () => { throw new Error('outbound_connector_offline'); });
    await expect(rejected.provisioner.inspect(signal())).rejects.not.toBeInstanceOf(SidecarConnectionError);
  });

  it.each([8, SIDECAR_WIRE_VERSION + 1])('keeps management while refusing wire v%s with live work', async runtimeWireVersion => {
    const observed = status({ runtimeWireVersion, resources: [{ resourceId: 'terminal', kind: 'terminal', state: 'active', revision: '1', blockers: ['live_terminal'] }] });
    const { registry, provisioner } = setup(async (_scope, _environment, _operation, raw) => {
      const request = raw as SidecarManagementRequest;
      return { managementVersion: 1, requestId: request.requestId, outcome: 'ok', status: observed };
    });
    await expect(provisioner.launch(1, 'd'.repeat(64), signal())).rejects.toThrow('sidecar_runtime_upgrade_required');
    expect(registry.request).toHaveBeenCalledTimes(1);
    expect(registry.openRuntime).not.toHaveBeenCalled();
  });

  it('reattaches a compatible busy predecessor without granting permission to respawn that old build', async () => {
    const observed = status({ buildId: 'old', artifactSha256: 'e'.repeat(64), resources: [{ resourceId: 'provider', kind: 'provider', state: 'active', revision: '1', blockers: ['active_work'] }] });
    const { registry, provisioner } = setup(async (_scope, _environment, _operation, raw) => {
      const request = raw as SidecarManagementRequest;
      return { managementVersion: 1, requestId: request.requestId, outcome: 'ok', status: observed };
    });
    await expect(provisioner.launch(1, 'd'.repeat(64), signal())).rejects.toThrow('test_attachment_reached');
    expect(registry.openRuntime).toHaveBeenCalledWith(scope, scope.executionEnvironmentId,
      expect.objectContaining({ expectedBuild: 'old', expectedDigest: 'e'.repeat(64), startIfAbsent: false }), expect.any(AbortSignal));
  });

  it('fails staging before sending any restart command', async () => {
    const { registry, provisioner } = setup(async () => { throw new Error('disk_full'); });
    const observed = status();
    const boundary = vi.fn<SidecarServiceControlBoundary>(effect => effect());
    await expect(provisioner.control({ mutationId: 'restart', operation: 'restart', expectedServiceIncarnation: observed.serviceIncarnation,
      controllerEpoch: 1, expectedConfiguration: configuration, expectedResourcesFingerprint: observed.resourcesFingerprint, force: false }, signal(), boundary)).rejects.toThrow('sidecar_service_staging_failed');
    expect(boundary).not.toHaveBeenCalled();
    expect(registry.request).toHaveBeenCalledTimes(1);
    expect(registry.request.mock.calls[0]?.[2]).toBe('install');
    expect(registry.openRuntime).not.toHaveBeenCalled();
  });

  it('stages before entering the interruption boundary and runs a successful replacement inside it exactly once', async () => {
    const order: string[] = [];
    const replacement = status({ serviceIncarnation: 'replacement' });
    const { registry, provisioner } = setup(async (_scope, _environment, operation, raw) => {
      if (operation === 'install') {
        order.push('stage');
        return { accountHome: '/home/client', nodeExecutable: '/usr/bin/node', stateRoot: '/state', environment: {}, executableDirectory: artifactDirectory, executablePath: artifact.executablePath };
      }
      const request = raw as SidecarManagementRequest;
      order.push(request.operation);
      return { managementVersion: 1, requestId: request.requestId, outcome: 'ok', status: request.operation === 'status' ? replacement : status({ state: 'stopped' }) };
    });
    const boundary = vi.fn<SidecarServiceControlBoundary>(async effect => {
      order.push('enter');
      const result = await effect();
      order.push('leave');
      return result;
    });
    await expect(provisioner.control({ mutationId: 'restart', operation: 'restart', expectedServiceIncarnation: 'incarnation',
      controllerEpoch: 1, expectedConfiguration: configuration, expectedResourcesFingerprint: 'b'.repeat(64), force: true }, signal(), boundary)).resolves.toEqual(replacement);
    expect(order).toEqual(['stage', 'enter', 'restart', 'status', 'leave']);
    expect(boundary).toHaveBeenCalledOnce();
    expect(registry.openRuntime).not.toHaveBeenCalled();
  });

  it('does not treat an unexpected missing mutation receipt as proof of safe shutdown', async () => {
    const { registry, provisioner } = setup(async (_scope, _environment, _operation, raw) => {
      const request = raw as SidecarManagementRequest;
      return { managementVersion: 1, requestId: request.requestId, outcome: 'receipt', receipt: null };
    });
    await expect(provisioner.control({ mutationId: 'stop', operation: 'stop', expectedServiceIncarnation: 'incarnation',
      controllerEpoch: 1, expectedConfiguration: configuration, expectedResourcesFingerprint: 'b'.repeat(64), force: false }, signal())).rejects.toThrow('sidecar_management_outcome_unknown');
    expect(registry.request).toHaveBeenCalledTimes(1);
    expect(registry.openRuntime).not.toHaveBeenCalled();
  });

  it('never creates a missing daemon on the recovery attachment path', async () => {
    const { registry, provisioner } = setup(async (_scope, _environment, _operation, raw) => {
      const request = raw as SidecarManagementRequest;
      return { managementVersion: 1, requestId: request.requestId, outcome: 'absent' };
    });
    await expect(provisioner.attachExisting(1, 'd'.repeat(64), signal())).rejects.toThrow('sidecar_service_absent');
    expect(registry.openRuntime).not.toHaveBeenCalled();
  });
});
