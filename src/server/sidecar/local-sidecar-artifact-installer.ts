import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { SidecarServiceScope } from '../../internal/sidecar-protocol/service-management-v1.js';
import { supportsSidecarNodeVersion } from '../../internal/sidecar-protocol/sidecar-runtime-version.js';
import { assertSidecarArtifactRegistration, SIDECAR_ARTIFACT_FILENAME, SIDECAR_ARTIFACT_ID, SIDECAR_ARTIFACT_MODES, SIDECAR_MINIMUM_NODE_VERSION, type SidecarArtifactRegistration } from './sidecar-artifact.js';
import type { SidecarArtifactInstallation } from './sidecar-provisioner.js';
import { persistentSidecarPaths } from './persistent-sidecar-paths.js';
import { acquireStartupLock } from './persistent-sidecar-bootstrap.js';
import { buildSanitizedSidecarEnvironment } from './sanitized-sidecar-environment.js';
import { assertConnectorDirectory, assertConnectorFiles, ensureConnectorDirectory, ensureConnectorDirectories, sealConnectorFile, syncConnectorDirectory } from './outbound-connector-filesystem.js';
import { outboundArtifactUrl } from './outbound-connector-url.js';

export type OutboundArtifactManifest = Pick<SidecarArtifactRegistration, 'buildId' | 'minimumNodeVersion' | 'nativeAssets'> & {
  readonly schemaVersion: 6;
  readonly artifactId: typeof SIDECAR_ARTIFACT_ID;
  readonly filename: typeof SIDECAR_ARTIFACT_FILENAME;
  readonly modes: typeof SIDECAR_ARTIFACT_MODES;
  readonly sha256: string;
  readonly bytes: number;
};

export function outboundArtifactManifest(artifact: SidecarArtifactRegistration): OutboundArtifactManifest {
  return { schemaVersion: 6, artifactId: artifact.artifactId, filename: SIDECAR_ARTIFACT_FILENAME, modes: artifact.modes,
    sha256: artifact.artifactSha256, bytes: artifact.artifactBytes, buildId: artifact.buildId,
    minimumNodeVersion: artifact.minimumNodeVersion, nativeAssets: artifact.nativeAssets };
}

const installSchema = z.strictObject({ manifest: z.unknown(), url: z.string().min(1).max(2048) });
const manifestKeys = ['schemaVersion', 'artifactId', 'filename', 'modes', 'sha256', 'bytes', 'buildId', 'minimumNodeVersion', 'nativeAssets'].sort().join(',');

function parseManifest(value: unknown, directory: string): OutboundArtifactManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== manifestKeys) throw new Error('sidecar_artifact_manifest_invalid');
  const candidate = value as OutboundArtifactManifest;
  if (candidate.schemaVersion !== 6 || candidate.filename !== SIDECAR_ARTIFACT_FILENAME) throw new Error('sidecar_artifact_manifest_invalid');
  if (typeof candidate.minimumNodeVersion !== 'string' || !/^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/u.test(candidate.minimumNodeVersion)) throw new Error('sidecar_artifact_registration_invalid');
  // Validate every other field before diagnosing a connector baseline mismatch.
  // No mismatched manifest is admitted or converted to the compiled contract.
  assertSidecarArtifactRegistration({ artifactId: candidate.artifactId, modes: candidate.modes,
    artifactSha256: candidate.sha256, artifactBytes: candidate.bytes, buildId: candidate.buildId,
    minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION, nativeAssets: candidate.nativeAssets,
    executableDirectory: directory, executablePath: path.join(directory, SIDECAR_ARTIFACT_FILENAME) });
  if (candidate.minimumNodeVersion !== SIDECAR_MINIMUM_NODE_VERSION) throw new Error('outbound_connector_update_required');
  return candidate;
}

/** Installs exact reviewed release bytes locally; optional PTY ABI support is checked lazily by the daemon. */
export class LocalSidecarArtifactInstaller {
  readonly #server: URL;
  readonly #scope: SidecarServiceScope;
  readonly #accountHome: string;
  readonly #fetch: typeof fetch;
  readonly #credential: string | undefined;
  constructor(input: { server: URL; credential?: string; scope: SidecarServiceScope; accountHome?: string; fetch?: typeof fetch }) {
    this.#server = input.server;
    this.#credential = input.credential;
    this.#scope = input.scope;
    this.#accountHome = input.accountHome ?? homedir();
    this.#fetch = input.fetch ?? fetch;
  }

  async installation(digest: string): Promise<SidecarArtifactInstallation> {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('sidecar_artifact_digest_invalid');
    const accountHome = await realpath(this.#accountHome);
    const stateRoot = persistentSidecarPaths(accountHome, process.getuid?.() ?? 0, this.#scope).stateRoot;
    const executableDirectory = path.join(stateRoot, 'artifacts', 'sha256', digest);
    const environment = buildSanitizedSidecarEnvironment({ ...process.env, HOME: accountHome });
    return { accountHome, nodeExecutable: await realpath(process.execPath), stateRoot,
      environment: environment as Record<string, string>, executableDirectory,
      executablePath: path.join(executableDirectory, SIDECAR_ARTIFACT_FILENAME) };
  }

  async install(payload: unknown, signal: AbortSignal): Promise<SidecarArtifactInstallation> {
    const request = installSchema.parse(payload);
    if (!supportsSidecarNodeVersion(process.versions.node)) throw new Error('sidecar_node_version_unsupported');
    const validationDirectory = path.resolve(this.#accountHome, '.sedes-manifest-validation');
    const manifest = parseManifest(request.manifest, validationDirectory);
    const installation = await this.installation(manifest.sha256);
    const url = outboundArtifactUrl(this.#server, request.url);
    if (url.pathname !== `/api/outbound/artifacts/${manifest.sha256}/payload`) throw new Error('outbound_artifact_url_invalid');
    const rows = [{ relativePath: SIDECAR_ARTIFACT_FILENAME, size: manifest.bytes, sha256: manifest.sha256 },
      ...manifest.nativeAssets.flatMap(asset => asset.files)];
    const total = rows.reduce((count, row) => count + row.size, 0);
    if (!Number.isSafeInteger(total) || total > 256 * 1024 * 1024) throw new Error('sidecar_install_artifact_too_large');
    await ensureConnectorDirectories([installation.stateRoot, path.join(installation.stateRoot, 'incoming'), path.join(installation.stateRoot, 'artifacts'), path.dirname(installation.executableDirectory)]);
    const verify = async () => {
      await assertConnectorDirectory(installation.executableDirectory);
      const marker = path.join(installation.executableDirectory, 'build-id');
      await assertConnectorFiles([
        ...rows.map(row => ({ filename: path.join(installation.executableDirectory, row.relativePath), maximumBytes: row.size, executable: true })),
        { filename: marker, maximumBytes: 120, executable: 'readonly' },
      ]);
      for (const row of rows) {
        const filename = path.join(installation.executableDirectory, row.relativePath);
        if ((await lstat(filename)).size !== row.size || createHash('sha256').update(await readFile(filename)).digest('hex') !== row.sha256) throw new Error('sidecar_artifact_digest_mismatch');
      }
      if (await readFile(marker, 'utf8') !== manifest.buildId) throw new Error('sidecar_install_build_mismatch');
    };
    const release = await acquireStartupLock(path.join(installation.stateRoot, 'incoming', `install-${manifest.sha256}.lock`));
    try {
    let existing = false;
    try { await lstat(installation.executableDirectory); existing = true; }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    if (existing) {
      try { await verify(); return installation; }
      catch (error) {
        if (!hasCode(error, 'ENOENT')) throw error;
        // Only a proved owned, incomplete publication is repaired. Invalid bytes,
        // ownership and links remain errors; the digest lock fences other installers.
        const retired = path.join(installation.stateRoot, 'incoming', `incomplete-${randomUUID()}`);
        await rename(installation.executableDirectory, retired);
        await rm(retired, { recursive: true, force: true });
      }
    }
    signal.throwIfAborted();
    const response = await this.#fetch(url, { signal, redirect: 'error', headers: this.#credential ? { Authorization: `Bearer ${this.#credential}` } : {} });
    if (!response.ok || !response.body) throw new Error('outbound_artifact_download_failed');
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) !== total) { await response.body.cancel(); throw new Error('sidecar_install_payload_size_invalid'); }
    const stage = path.join(installation.stateRoot, 'incoming', `stage-${randomUUID()}`);
    await ensureConnectorDirectory(stage);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      let rowIndex = 0;
      let count = 0;
      let rowBytes = 0;
      let hash = createHash('sha256');
      const openRow = async () => {
        const filename = path.join(stage, rows[rowIndex]!.relativePath);
        await ensureConnectorDirectory(path.dirname(filename));
        handle = await open(filename, 'wx', 0o600);
      };
      await openRow();
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        count += chunk.byteLength;
        if (count > total) throw new Error('sidecar_install_artifact_too_large');
        let offset = 0;
        while (offset < chunk.byteLength) {
          const row = rows[rowIndex]!;
          const bytes = chunk.subarray(offset, offset + Math.min(row.size - rowBytes, chunk.byteLength - offset));
          await handle!.writeFile(bytes);
          hash.update(bytes); rowBytes += bytes.byteLength; offset += bytes.byteLength;
          if (rowBytes === row.size) {
            if (hash.digest('hex') !== row.sha256) throw new Error('sidecar_artifact_digest_mismatch');
            await handle!.sync(); await handle!.close(); handle = undefined;
            await sealConnectorFile(path.join(stage, row.relativePath), true);
            rowIndex += 1; rowBytes = 0; hash = createHash('sha256');
            if (rowIndex < rows.length) await openRow();
          }
        }
      }
      if (count !== total || rowIndex !== rows.length) throw new Error('sidecar_install_payload_size_invalid');
      const marker = path.join(stage, 'build-id');
      const markerHandle = await open(marker, 'wx', 0o600);
      try { await markerHandle.writeFile(manifest.buildId); await markerHandle.sync(); } finally { await markerHandle.close(); }
      await sealConnectorFile(marker, 'readonly');
      const nativeDirectories = new Set(rows.flatMap(row => row.relativePath.includes('/')
        ? [path.join(stage, 'native'), path.dirname(path.join(stage, row.relativePath))] : []));
      for (const directory of [...nativeDirectories].sort((left, right) => right.length - left.length)) await syncConnectorDirectory(directory);
      await syncConnectorDirectory(stage);
      signal.throwIfAborted();
      try { await rename(stage, installation.executableDirectory); }
      catch (error) { if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) throw error; }
      await verify();
      await syncConnectorDirectory(path.dirname(installation.executableDirectory));
      return installation;
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(stage, { recursive: true, force: true });
    }
    } finally { await release(); }
  }
}

function hasCode(error: unknown, code: string): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === code; }
