import { createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import path from "node:path";

const secretFileName = ".tool-provenance-key";
const encodedSecretPattern = /^[A-Za-z0-9_-]{43}$/;
// Permanent derivation format identifiers. These values define persisted or
// externally observed identities and therefore survive product renames.
const lineageCursorHkdfInfo = "harness.thread-lineage.cursor-signing.v1";
const attachmentScopeHkdfInfo = "harness.composer-attachment.scope-key.v1";
const agentToolCliEndpointHkdfInfo = "harness.agent-tool-cli.endpoint-key.v1";
const sidecarInstallationIdentityHkdfInfo =
  "sedes.sidecar.installation-identity.v1";

/** Stable public service namespace, never an authentication credential. */
export function deriveSidecarInstallationIdentity(
  installationKey: Uint8Array,
): string {
  if (installationKey.byteLength !== 32) {
    throw new Error("installation_secret_invalid");
  }
  return Buffer.from(
    hkdfSync(
      "sha256",
      installationKey,
      Buffer.alloc(0),
      sidecarInstallationIdentityHkdfInfo,
      32,
    ),
  ).toString("hex");
}

export function deriveLineageCursorSigningKey(
  installationKey: Uint8Array,
): Uint8Array {
  if (installationKey.byteLength !== 32) {
    throw new Error("installation_secret_invalid");
  }
  return new Uint8Array(
    hkdfSync(
      "sha256",
      installationKey,
      Buffer.alloc(0),
      lineageCursorHkdfInfo,
      32,
    ),
  );
}

/** Path-safe opaque principal namespace; raw tenant/principal IDs never leave Sedes. */
export function deriveComposerAttachmentScopeKey(
  installationKey: Uint8Array,
  scope: { readonly tenantId: string; readonly principalId: string },
): string {
  if (
    installationKey.byteLength !== 32 ||
    !scope.tenantId ||
    !scope.principalId ||
    scope.tenantId.includes("\0") ||
    scope.principalId.includes("\0")
  ) {
    throw new Error("installation_secret_invalid");
  }
  const key = hkdfSync(
    "sha256",
    installationKey,
    Buffer.alloc(0),
    attachmentScopeHkdfInfo,
    32,
  );
  return createHmac("sha256", key)
    .update(scope.tenantId)
    .update("\0")
    .update(scope.principalId)
    .digest("hex");
}

/**
 * Stable, opaque remote UDS namespace for one installation-owned execution
 * environment. The value identifies a socket path; it is not an auth token.
 */
export function deriveAgentToolCliEndpointKey(
  installationKey: Uint8Array,
  scope: { readonly tenantId: string; readonly principalId: string },
  executionEnvironmentId: string,
): string {
  if (
    installationKey.byteLength !== 32 ||
    !scope.tenantId ||
    !scope.principalId ||
    !executionEnvironmentId ||
    scope.tenantId.includes("\0") ||
    scope.principalId.includes("\0") ||
    executionEnvironmentId.includes("\0")
  ) {
    throw new Error("installation_secret_invalid");
  }
  const key = hkdfSync(
    "sha256",
    installationKey,
    Buffer.alloc(0),
    agentToolCliEndpointHkdfInfo,
    32,
  );
  return createHmac("sha256", key)
    .update(scope.tenantId)
    .update("\0")
    .update(scope.principalId)
    .update("\0")
    .update(executionEnvironmentId)
    .digest("hex")
    .slice(0, 24);
}

function decodeSecret(value: string): Uint8Array {
  const normalized = value.trim();
  if (!encodedSecretPattern.test(normalized)) {
    throw new Error("installation_secret_invalid");
  }
  const decoded = Buffer.from(normalized, "base64url");
  if (decoded.byteLength !== 32) {
    throw new Error("installation_secret_invalid");
  }
  return decoded;
}

/**
 * Loads the installation-local key that authenticates application-authored
 * provenance embedded in backend-owned logs. The state-directory process lock
 * must already be held by the caller.
 */
export async function loadOrCreateToolProvenanceKey(
  stateDirectory: string,
): Promise<Uint8Array> {
  if (!path.isAbsolute(stateDirectory)) {
    throw new Error("installation_secret_state_directory_not_absolute");
  }
  const secretPath = path.join(stateDirectory, secretFileName);
  const loadExisting = async (): Promise<Uint8Array> => {
    const existing = await open(
      secretPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await existing.stat();
      if (
        !stat.isFile() ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
      ) {
        throw new Error("installation_secret_permissions_invalid");
      }
      return decodeSecret(await existing.readFile({ encoding: "utf8" }));
    } finally {
      await existing.close();
    }
  };
  try {
    return await loadExisting();
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const temporaryPath = path.join(
    stateDirectory,
    `${secretFileName}.tmp-${process.pid}-${randomUUID()}`,
  );
  const encoded = randomBytes(32).toString("base64url");
  const created = await open(
    temporaryPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await created.writeFile(`${encoded}\n`, { encoding: "utf8" });
    await created.sync();
  } finally {
    await created.close();
  }

  try {
    try {
      await link(temporaryPath, secretPath);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      return await loadExisting();
    }
    // Windows does not expose POSIX directory handles that can be fsynced.
    // The file itself was synced above; retain the stronger directory-entry
    // durability guarantee on platforms that support it.
    if (process.platform !== "win32") {
      const directory = await open(
        stateDirectory,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return decodeSecret(encoded);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
}
