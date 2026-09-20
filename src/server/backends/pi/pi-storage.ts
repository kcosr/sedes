import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface PiStorage {
  readonly agentDir: string;
  readonly sessionDirectory: string;
  readonly sessionDirectoryOverride?: string;
}

const REMOTE_PI_STORE_DIRECTORY = "remote-pi-native-sessions";
const REMOTE_PI_NAMESPACE_VERSION = "v1";
// Permanent opaque persisted-locator domain; changing it moves existing stores.
const REMOTE_PI_NAMESPACE_DOMAIN = "pi-harness.remote-pi-native-store.v1\0";

function hashNamespacePart(hash: ReturnType<typeof createHash>, value: string) {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hash.update(length).update(bytes);
}

/**
 * Derives a bounded, pathname-safe namespace solely from immutable configured
 * identities. A workspace path is deliberately not an input: remote paths are
 * semantic metadata and must never become main-host path authority.
 */
export function remotePiNativeStoreNamespace(input: {
  readonly backendInstanceId: string;
  readonly executionEnvironmentId: string;
}): string {
  if (!input.backendInstanceId || !input.executionEnvironmentId) {
    throw new Error("remote_pi_native_store_identity_invalid");
  }
  const hash = createHash("sha256").update(REMOTE_PI_NAMESPACE_DOMAIN);
  hashNamespacePart(hash, input.backendInstanceId);
  hashNamespacePart(hash, input.executionEnvironmentId);
  return hash.digest("hex");
}

export function resolveRemotePiStorage(
  input: {
    readonly installationStateDirectory: string;
    readonly backendInstanceId: string;
    readonly executionEnvironmentId: string;
  },
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PiStorage {
  if (!path.isAbsolute(input.installationStateDirectory)) {
    throw new Error("remote_pi_native_store_base_invalid");
  }
  const agentDir = configuredPath(
    environment.PI_CODING_AGENT_DIR ?? getAgentDir(),
  );
  const sessionDirectory = path.join(
    path.resolve(input.installationStateDirectory),
    REMOTE_PI_STORE_DIRECTORY,
    REMOTE_PI_NAMESPACE_VERSION,
    remotePiNativeStoreNamespace(input),
    "sessions",
  );
  return {
    agentDir,
    sessionDirectory,
    sessionDirectoryOverride: sessionDirectory,
  };
}

function configuredPath(value: string): string {
  const expanded =
    value === "~"
      ? homedir()
      : value.startsWith(`~${path.sep}`)
        ? path.join(homedir(), value.slice(2))
        : value;
  return path.resolve(expanded);
}

export function resolvePiStorage(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PiStorage {
  const agentDir = configuredPath(
    environment.PI_CODING_AGENT_DIR ?? getAgentDir(),
  );
  const explicit = environment.PI_CODING_AGENT_SESSION_DIR;
  if (explicit) {
    const sessionDirectory = configuredPath(explicit);
    return {
      agentDir,
      sessionDirectory,
      sessionDirectoryOverride: sessionDirectory,
    };
  }
  const configured = SettingsManager.create(homedir(), agentDir, {
    projectTrusted: false,
  }).getSessionDir();
  if (configured) {
    const sessionDirectory = configuredPath(configured);
    return {
      agentDir,
      sessionDirectory,
      sessionDirectoryOverride: sessionDirectory,
    };
  }
  return { agentDir, sessionDirectory: path.join(agentDir, "sessions") };
}
