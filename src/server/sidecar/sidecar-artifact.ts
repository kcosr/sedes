import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { SIDECAR_MINIMUM_NODE_VERSION } from "../../internal/sidecar-protocol/sidecar-runtime-version.js";

export { SIDECAR_MINIMUM_NODE_VERSION } from "../../internal/sidecar-protocol/sidecar-runtime-version.js";

export const SIDECAR_ARTIFACT_ID = "openai.sedes.sidecar";
export const SIDECAR_ARTIFACT_FILENAME = "sedes" as const;
export const SIDECAR_ARTIFACT_MODES = Object.freeze([
  "agent_tools_cli",
  "persistent_service",
] as const);
export const SIDECAR_MAXIMUM_ARTIFACT_BYTES = 32 * 1_024 * 1_024;

export interface SidecarNativeAssetFile {
  readonly relativePath: `native/${"linux" | "darwin" | "win32"}-${"x64" | "arm64"}/${string}`;
  readonly sha256: string;
  readonly size: number;
  readonly mode: 0o500;
}

export type SidecarNativeAsset = {
  readonly architecture: "x64" | "arm64";
  readonly files: readonly [
    SidecarNativeAssetFile,
    ...SidecarNativeAssetFile[],
  ];
} & (
  | {
      readonly platform: "linux";
      readonly nodeModuleVersion: string;
      readonly minimumGlibcVersion: string;
    }
  | { readonly platform: "darwin" | "win32"; readonly nodeApiVersion: number }
);

export interface SidecarArtifactRegistration {
  readonly artifactId: typeof SIDECAR_ARTIFACT_ID;
  readonly modes: typeof SIDECAR_ARTIFACT_MODES;
  readonly executableDirectory: string;
  readonly executablePath: string;
  readonly artifactSha256: string;
  readonly artifactBytes: number;
  readonly buildId: string;
  readonly minimumNodeVersion: typeof SIDECAR_MINIMUM_NODE_VERSION;
  readonly nativeAssets: readonly SidecarNativeAsset[];
}

interface SidecarArtifactManifest {
  readonly schemaVersion?: unknown;
  readonly artifactId?: unknown;
  readonly filename?: unknown;
  readonly sha256?: unknown;
  readonly bytes?: unknown;
  readonly buildId?: unknown;
  readonly minimumNodeVersion?: unknown;
  readonly modes?: unknown;
  readonly nativeAssets?: unknown;
}

export async function loadSidecarArtifactRegistration(
  manifestPath: string,
): Promise<SidecarArtifactRegistration> {
  if (
    !path.isAbsolute(manifestPath) ||
    path.resolve(manifestPath) !== manifestPath
  ) {
    throw new Error("sidecar_artifact_manifest_path_invalid");
  }
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as SidecarArtifactManifest;
  if (
    manifest.schemaVersion !== 6 ||
    manifest.artifactId !== SIDECAR_ARTIFACT_ID ||
    manifest.filename !== SIDECAR_ARTIFACT_FILENAME ||
    !exactArtifactModes(manifest.modes) ||
    typeof manifest.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(manifest.sha256) ||
    !Number.isSafeInteger(manifest.bytes) ||
    (manifest.bytes as number) <= 0 ||
    (manifest.bytes as number) > SIDECAR_MAXIMUM_ARTIFACT_BYTES ||
    typeof manifest.buildId !== "string" ||
    !validSidecarBuildId(manifest.buildId) ||
    manifest.minimumNodeVersion !== SIDECAR_MINIMUM_NODE_VERSION ||
    !validSidecarNativeAssets(manifest.nativeAssets)
  ) {
    throw new Error("sidecar_artifact_manifest_invalid");
  }
  const executablePath = path.join(
    path.dirname(manifestPath),
    SIDECAR_ARTIFACT_FILENAME,
  );
  const metadata = await lstat(executablePath);
  const executableDirectory = path.dirname(executablePath);
  const directoryMetadata = await lstat(executableDirectory);
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o500) ||
    metadata.size !== manifest.bytes ||
    (await realpath(executablePath)) !== executablePath
  ) {
    throw new Error("sidecar_artifact_file_invalid");
  }
  const bytes = await readFile(executablePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== manifest.sha256) {
    throw new Error("sidecar_artifact_digest_mismatch");
  }
  const registration = Object.freeze({
    artifactId: SIDECAR_ARTIFACT_ID,
    modes: SIDECAR_ARTIFACT_MODES,
    executableDirectory,
    executablePath,
    artifactSha256: digest,
    artifactBytes: metadata.size,
    buildId: manifest.buildId,
    minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION,
    nativeAssets: Object.freeze(
      manifest.nativeAssets.map((asset) =>
        Object.freeze({
          ...asset,
          files: Object.freeze(
            asset.files.map((file) => Object.freeze({ ...file })),
          ) as readonly [SidecarNativeAssetFile, ...SidecarNativeAssetFile[]],
        }),
      ),
    ),
  });
  await readVerifiedNativeAssets(registration);
  return registration;
}

export async function readVerifiedSidecarArtifact(
  registration: SidecarArtifactRegistration,
): Promise<Uint8Array> {
  assertSidecarArtifactRegistration(registration);
  const [directoryMetadata, metadata] = await Promise.all([
    lstat(registration.executableDirectory),
    lstat(registration.executablePath),
  ]);
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o500) ||
    metadata.size !== registration.artifactBytes ||
    metadata.size > SIDECAR_MAXIMUM_ARTIFACT_BYTES ||
    (await realpath(registration.executablePath)) !==
      registration.executablePath
  ) {
    throw new Error("sidecar_artifact_file_invalid");
  }
  const bytes = await readFile(registration.executablePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== registration.artifactSha256) {
    throw new Error("sidecar_artifact_digest_mismatch");
  }
  return bytes;
}

export function assertSidecarArtifactRegistration(
  registration: SidecarArtifactRegistration,
): void {
  if (
    registration.artifactId !== SIDECAR_ARTIFACT_ID ||
    !exactArtifactModes(registration.modes) ||
    !path.isAbsolute(registration.executableDirectory) ||
    path.resolve(registration.executableDirectory) !==
      registration.executableDirectory ||
    !path.isAbsolute(registration.executablePath) ||
    path.resolve(registration.executablePath) !== registration.executablePath ||
    registration.executablePath !==
      path.join(registration.executableDirectory, SIDECAR_ARTIFACT_FILENAME) ||
    !/^[0-9a-f]{64}$/u.test(registration.artifactSha256) ||
    !Number.isSafeInteger(registration.artifactBytes) ||
    registration.artifactBytes <= 0 ||
    registration.artifactBytes > SIDECAR_MAXIMUM_ARTIFACT_BYTES ||
    !validSidecarBuildId(registration.buildId) ||
    registration.minimumNodeVersion !== SIDECAR_MINIMUM_NODE_VERSION ||
    !validSidecarNativeAssets(registration.nativeAssets)
  ) {
    throw new Error("sidecar_artifact_registration_invalid");
  }
}

/** One exact upload: JavaScript followed by manifest-ordered native bytes. */
export async function readVerifiedSidecarArtifactPayload(
  registration: SidecarArtifactRegistration,
): Promise<Uint8Array> {
  const executable = await readVerifiedSidecarArtifact(registration);
  const native = await readVerifiedNativeAssets(registration);
  return Buffer.concat([executable, ...native]);
}

async function readVerifiedNativeAssets(
  registration: SidecarArtifactRegistration,
): Promise<readonly Uint8Array[]> {
  const result: Uint8Array[] = [];
  for (const asset of registration.nativeAssets) {
    for (const relative of [
      "native",
      `native/${asset.platform}-${asset.architecture}`,
    ]) {
      const directory = path.join(registration.executableDirectory, relative);
      const metadata = await lstat(directory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (await realpath(directory)) !== directory
      ) {
        throw new Error("sidecar_native_artifact_directory_invalid");
      }
    }
    for (const file of asset.files) {
      const filename = path.join(
        registration.executableDirectory,
        file.relativePath,
      );
      const metadata = await lstat(filename);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size !== file.size ||
        (process.platform !== "win32" &&
          (metadata.mode & 0o777) !== file.mode) ||
        (await realpath(filename)) !== filename
      ) {
        throw new Error("sidecar_native_artifact_file_invalid");
      }
      const bytes = await readFile(filename);
      if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new Error("sidecar_native_artifact_digest_mismatch");
      }
      result.push(bytes);
    }
  }
  return result;
}

export function validSidecarNativeAssets(
  value: unknown,
): value is readonly SidecarNativeAsset[] {
  if (!Array.isArray(value) || value.length > 6) return false;
  const seen = new Set<string>();
  return value.every((asset: unknown) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset))
      return false;
    const item = asset as Record<string, unknown>;
    const names =
      item.platform === "linux"
        ? ["pty.node"]
        : item.platform === "darwin"
          ? ["pty.node", "spawn-helper"]
          : item.platform === "win32"
            ? [
                "conpty.node",
                "conpty_console_list.node",
                "conout-worker.cjs",
                "console-list-agent.cjs",
              ]
            : [];
    const key = `${item.platform}-${item.architecture}`;
    if (
      !names.length ||
      Object.keys(item).length !== (item.platform === "linux" ? 5 : 4) ||
      (item.architecture !== "x64" && item.architecture !== "arm64") ||
      seen.has(key) ||
      (item.platform === "linux"
        ? typeof item.nodeModuleVersion !== "string" ||
          !/^[1-9][0-9]{0,3}$/u.test(item.nodeModuleVersion) ||
          typeof item.minimumGlibcVersion !== "string" ||
          !/^[0-9]{1,3}\.[0-9]{1,3}(?:\.[0-9]{1,3})?$/u.test(
            item.minimumGlibcVersion,
          )
        : !Number.isSafeInteger(item.nodeApiVersion) ||
          (item.nodeApiVersion as number) < 1 ||
          (item.nodeApiVersion as number) > 10) ||
      !Array.isArray(item.files) ||
      item.files.length !== names.length
    )
      return false;
    if (
      !item.files.every((value: unknown, index: number) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return false;
        const file = value as Record<string, unknown>;
        return (
          Object.keys(file).length === 4 &&
          file.relativePath === `native/${key}/${names[index]}` &&
          typeof file.sha256 === "string" &&
          /^[0-9a-f]{64}$/u.test(file.sha256) &&
          Number.isSafeInteger(file.size) &&
          (file.size as number) >= 64 &&
          (file.size as number) <= SIDECAR_MAXIMUM_ARTIFACT_BYTES &&
          file.mode === 0o500
        );
      })
    )
      return false;
    seen.add(key);
    return true;
  });
}

function exactArtifactModes(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === SIDECAR_ARTIFACT_MODES.length &&
    value.every((mode, index) => mode === SIDECAR_ARTIFACT_MODES[index])
  );
}

export function validSidecarBuildId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  );
}
