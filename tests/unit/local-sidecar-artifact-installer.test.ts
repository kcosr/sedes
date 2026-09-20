import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runtimeVersion from '../../src/internal/sidecar-protocol/sidecar-runtime-version.js';
import { LocalSidecarArtifactInstaller } from '../../src/server/sidecar/local-sidecar-artifact-installer.js';

afterEach(() => vi.restoreAllMocks());
const scope = { installationId: 'installation', tenantId: 'tenant', principalId: 'principal', executionEnvironmentId: 'environment' };
const bytes = Buffer.from('test-runtime');
const digest = createHash('sha256').update(bytes).digest('hex');
function fixture(minimumNodeVersion: unknown) {
  const download = vi.fn<typeof fetch>();
  const installer = new LocalSidecarArtifactInstaller({ server: new URL('http://host'), scope, accountHome: path.join(tmpdir(), 'uncreated-installer-version-fixture'), fetch: download });
  const payload = { manifest: { schemaVersion: 6, artifactId: 'openai.sedes.sidecar', filename: 'sedes', modes: ['agent_tools_cli', 'persistent_service'],
    sha256: digest, bytes: bytes.length, buildId: 'test', minimumNodeVersion, nativeAssets: [] }, url: `/api/outbound/artifacts/${digest}/payload` };
  return { installer, download, payload };
}

describe('connector/runtime version diagnostics', () => {
  it.each(['22.20.0', '24.0.0'])('requires a connector update for baseline %s even with sufficiently new installed Node', async minimum => {
    const f = fixture(minimum);
    await expect(f.installer.install(f.payload, new AbortController().signal)).rejects.toThrow('outbound_connector_update_required');
    expect(f.download).not.toHaveBeenCalled();
  });
  it('retains unsupported Node as the diagnosis when Node itself is too old', async () => {
    const check = vi.spyOn(runtimeVersion, 'supportsSidecarNodeVersion').mockReturnValue(false);
    const f = fixture('22.19.0');
    await expect(f.installer.install(f.payload, new AbortController().signal)).rejects.toThrow('sidecar_node_version_unsupported');
    expect(check).toHaveBeenCalledWith(process.versions.node);
    expect(f.download).not.toHaveBeenCalled();
  });
  it('does not mask a malformed artifact with a wellformed newer baseline', async () => {
    const f = fixture('24.0.0');
    f.payload.manifest.sha256 = 'invalid';
    await expect(f.installer.install(f.payload, new AbortController().signal)).rejects.toThrow('sidecar_artifact_registration_invalid');
    expect(f.download).not.toHaveBeenCalled();
  });
  it.each([undefined, 24, 'invalid'])('rejects malformed minimum-version metadata %j as an invalid artifact', async minimum => {
    const f = fixture(minimum);
    await expect(f.installer.install(f.payload, new AbortController().signal)).rejects.toThrow('sidecar_artifact_registration_invalid');
    expect(f.download).not.toHaveBeenCalled();
  });
});
