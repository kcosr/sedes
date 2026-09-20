import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const registeredKinds = new WeakSet<object>();
const registeredArtifacts = new WeakSet<object>();

export interface ManagedWorkerLaunchIdentity {
  readonly carrierGeneration: number;
  readonly sessionNonce: string;
}

/** Installation-owned definition. Runtime callers cannot supply argv or env. */
export interface ManagedWorkerKind {
  readonly artifactId: string;
  readonly filename: string;
  readonly modes: readonly string[];
  readonly stateNamespace: string;
  readonly minimumNodeVersion: string;
  readonly maximumArtifactBytes: number;
  /** Fixed remote-login/local variables admitted to this worker, never caller values. */
  readonly inheritedEnvironmentNames?: readonly string[];
  readonly launchArguments: (
    identity: ManagedWorkerLaunchIdentity,
  ) => readonly string[];
}

export interface ManagedWorkerArtifactRegistration {
  readonly kind: ManagedWorkerKind;
  readonly executableDirectory: string;
  readonly executablePath: string;
  readonly artifactSha256: string;
  readonly artifactBytes: number;
  readonly buildId: string;
}

export function registerManagedWorkerKind(
  input: ManagedWorkerKind,
): ManagedWorkerKind {
  if (
    !/^[a-z0-9][a-z0-9._-]{0,199}$/u.test(input.artifactId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(input.filename) ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(input.stateNamespace) ||
    !/^\d+\.\d+\.\d+$/u.test(input.minimumNodeVersion) ||
    !Number.isSafeInteger(input.maximumArtifactBytes) ||
    input.maximumArtifactBytes <= 0 ||
    input.maximumArtifactBytes > 128 * 1024 * 1024 ||
    input.modes.length === 0 ||
    input.modes.length > 16 ||
    new Set(input.modes).size !== input.modes.length ||
    input.modes.some((mode) => !/^[a-z][a-z0-9_]{0,63}$/u.test(mode)) ||
    (input.inheritedEnvironmentNames?.length ?? 0) > 32 ||
    input.inheritedEnvironmentNames?.some((name) =>
      !/^[A-Z_][A-Z0-9_]{0,63}$/u.test(name)) ||
    new Set(input.inheritedEnvironmentNames ?? []).size !==
      (input.inheritedEnvironmentNames?.length ?? 0)
  ) {
    throw new Error("managed_worker_kind_invalid");
  }
  const kind = Object.freeze({
    ...input,
    modes: Object.freeze([...input.modes]),
    inheritedEnvironmentNames: Object.freeze([
      ...(input.inheritedEnvironmentNames ?? []),
    ]),
  });
  registeredKinds.add(kind);
  return kind;
}

export async function loadManagedWorkerArtifact(
  kind: ManagedWorkerKind,
  manifestPath: string,
): Promise<ManagedWorkerArtifactRegistration> {
  assertManagedWorkerKind(kind);
  if (!path.isAbsolute(manifestPath) || path.resolve(manifestPath) !== manifestPath) {
    throw new Error("managed_worker_manifest_path_invalid");
  }
  const manifestMetadata = await lstat(manifestPath).catch(() => undefined);
  if (!manifestMetadata?.isFile() || manifestMetadata.isSymbolicLink() ||
      (manifestMetadata.mode & 0o777) !== 0o400 ||
      await realpath(manifestPath).catch(() => "") !== manifestPath) {
    throw new Error("managed_worker_manifest_invalid");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const exactKeys = [
    "artifactId", "buildId", "bytes", "filename", "minimumNodeVersion",
    "modes", "schemaVersion", "sha256",
  ].sort().join("\0");
  if (
    Object.keys(manifest).sort().join("\0") !== exactKeys ||
    manifest.schemaVersion !== 1 ||
    manifest.artifactId !== kind.artifactId ||
    manifest.filename !== kind.filename ||
    manifest.minimumNodeVersion !== kind.minimumNodeVersion ||
    JSON.stringify(manifest.modes) !== JSON.stringify(kind.modes) ||
    typeof manifest.buildId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(manifest.buildId) ||
    typeof manifest.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.bytes) ||
    (manifest.bytes as number) <= 0 ||
    (manifest.bytes as number) > kind.maximumArtifactBytes
  ) throw new Error("managed_worker_manifest_invalid");
  const executableDirectory = path.dirname(manifestPath);
  const executablePath = path.join(executableDirectory, kind.filename);
  const [directory, executable] = await Promise.all([
    lstat(executableDirectory), lstat(executablePath).catch(() => undefined),
  ]);
  if (
    !directory.isDirectory() || directory.isSymbolicLink() ||
    !executable?.isFile() || executable.isSymbolicLink() ||
    (executable.mode & 0o777) !== 0o500 || executable.size !== manifest.bytes ||
    await realpath(executablePath).catch(() => "") !== executablePath
  ) throw new Error("managed_worker_artifact_invalid");
  const bytes = await readFile(executablePath);
  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
    throw new Error("managed_worker_artifact_digest_mismatch");
  }
  const registration = Object.freeze({
    kind, executableDirectory, executablePath,
    artifactSha256: manifest.sha256, artifactBytes: manifest.bytes as number,
    buildId: manifest.buildId,
  });
  registeredArtifacts.add(registration);
  return registration;
}

export async function readVerifiedManagedWorkerArtifact(
  artifact: ManagedWorkerArtifactRegistration,
): Promise<Uint8Array> {
  assertManagedWorkerArtifact(artifact);
  const metadata = await lstat(artifact.executablePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o500 || metadata.size !== artifact.artifactBytes ||
      await realpath(artifact.executablePath) !== artifact.executablePath) {
    throw new Error("managed_worker_artifact_invalid");
  }
  const bytes = await readFile(artifact.executablePath);
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.artifactSha256) {
    throw new Error("managed_worker_artifact_digest_mismatch");
  }
  return bytes;
}

export function assertManagedWorkerKind(kind: ManagedWorkerKind): void {
  if (!registeredKinds.has(kind)) throw new Error("managed_worker_kind_unregistered");
}

export function assertManagedWorkerArtifact(
  artifact: ManagedWorkerArtifactRegistration,
): void {
  if (!registeredArtifacts.has(artifact)) {
    throw new Error("managed_worker_artifact_unregistered");
  }
}

export function managedWorkerLaunchArguments(
  kind: ManagedWorkerKind,
  identity: ManagedWorkerLaunchIdentity,
): readonly string[] {
  assertManagedWorkerKind(kind);
  if (!Number.isSafeInteger(identity.carrierGeneration) || identity.carrierGeneration <= 0 ||
      identity.sessionNonce.length < 32 || identity.sessionNonce.length > 160 ||
      !/^[A-Za-z0-9_-]+$/u.test(identity.sessionNonce)) {
    throw new Error("managed_worker_launch_identity_invalid");
  }
  const values = kind.launchArguments(Object.freeze({ ...identity }));
  if (values.length === 0 || values.length > 32 || values.some((value) =>
    value.length === 0 || value.length > 4096 || /[\u0000\r\n]/u.test(value))) {
    throw new Error("managed_worker_launch_arguments_invalid");
  }
  return Object.freeze([...values]);
}
