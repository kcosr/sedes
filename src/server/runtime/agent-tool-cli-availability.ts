import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentToolCliAvailability,
  AgentToolCliRuntimeResolution,
} from "../backends/module.js";
import type { RequestScope } from "../identity/identity-provider.js";

const AGENT_TOOL_CLI_EXECUTABLE = "sedes";
const MAXIMUM_UNIX_SOCKET_PATH_BYTES = 107;
const MAXIMUM_ENVIRONMENT_VALUE_BYTES = 16_384;

type ManagedAgentToolCliSidecarSession = Readonly<{
  closed: Promise<unknown>;
  agentToolCli?: Readonly<{
    endpoint: string;
    executableDirectory: string;
    inheritedPath: string;
  }>;
}>;

type ManagedAgentToolCliSidecarRuntime = Readonly<{
  acquireAgentTools(
    scope: RequestScope,
    executionEnvironmentId: string,
    signal: AbortSignal,
  ): Promise<
    Readonly<{
      session: ManagedAgentToolCliSidecarSession;
      release(): void;
    }>
  >;
}>;

/**
 * Resolves the one build-owned provider CLI directory from either the source
 * module (development) or its compiled counterpart (production). Both module
 * locations deliberately converge on dist/cli/provider-bin.
 */
export function bundledAgentToolCliDirectory(
  moduleUrl: string = import.meta.url,
): string {
  return path.resolve(
    path.dirname(fileURLToPath(moduleUrl)),
    "../../../dist/cli/provider-bin",
  );
}

/**
 * Advertises the local CLI only after the exact executable has been emitted
 * and is executable. A source checkout that has not been built remains
 * truthfully unavailable instead of injecting a dead PATH entry into agents.
 */
export async function resolveLocalAgentToolCliAvailability(input: {
  readonly endpoint: string;
  readonly inheritedPath: string | undefined;
  readonly executableDirectory?: string;
}): Promise<AgentToolCliAvailability> {
  if (!input.inheritedPath) return cliUnavailable();
  const executableDirectory =
    input.executableDirectory ?? bundledAgentToolCliDirectory();
  const executable = path.join(executableDirectory, AGENT_TOOL_CLI_EXECUTABLE);
  try {
    const metadata = await stat(executable);
    if (!metadata.isFile()) return cliUnavailable();
    await access(executable, fsConstants.X_OK);
  } catch {
    return cliUnavailable();
  }
  return Object.freeze({
    availability: "available" as const,
    endpoint: input.endpoint,
    executableDirectory,
    inheritedPath: input.inheritedPath,
  });
}

/**
 * Adapts the exact agent-tool lease of one managed SSH sidecar into the
 * backend-neutral lazy runtime contract. No SSH work occurs until Codex has
 * already proved per-thread eligibility and asks to acquire the CLI runtime.
 */
export function managedSshAgentToolCliAvailability(input: {
  readonly scope: RequestScope;
  readonly executionEnvironmentId: string;
  readonly runtime: ManagedAgentToolCliSidecarRuntime;
}): AgentToolCliAvailability {
  if (
    !input.scope.tenantId ||
    !input.scope.principalId ||
    !input.executionEnvironmentId
  ) {
    throw new Error("managed_agent_tool_cli_configuration_invalid");
  }
  const scope = Object.freeze({ ...input.scope });
  return Object.freeze({
    availability: "managed" as const,
    provider: Object.freeze({
      acquire: async (options?: {
        readonly signal?: AbortSignal;
      }): Promise<AgentToolCliRuntimeResolution> => {
        const signal = options?.signal ?? new AbortController().signal;
        const lease = await input.runtime.acquireAgentTools(
          scope,
          input.executionEnvironmentId,
          signal,
        );
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          lease.release();
        };
        const metadata = lease.session.agentToolCli;
        if (!metadata || !validManagedMetadata(metadata)) {
          release();
          return Object.freeze({
            availability: "unavailable" as const,
            reason: "sidecar_unavailable" as const,
          });
        }
        return Object.freeze({
          availability: "available" as const,
          endpoint: metadata.endpoint,
          executableDirectory: metadata.executableDirectory,
          inheritedPath: metadata.inheritedPath,
          closed: lease.session.closed,
          release,
        });
      },
    }),
  });
}

function cliUnavailable(): AgentToolCliAvailability {
  return Object.freeze({
    availability: "unavailable" as const,
    reason: "cli_unavailable" as const,
  });
}

function validManagedMetadata(
  value: ManagedAgentToolCliSidecarSession["agentToolCli"] & {},
): boolean {
  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    return false;
  }
  const socketPath = endpoint.pathname;
  return (
    endpoint.protocol === "unix:" &&
    endpoint.host.length === 0 &&
    endpoint.username.length === 0 &&
    endpoint.password.length === 0 &&
    endpoint.search.length === 0 &&
    endpoint.hash.length === 0 &&
    !value.endpoint.includes("%") &&
    socketPath.startsWith("/") &&
    socketPath !== "/" &&
    !socketPath.endsWith("/") &&
    path.posix.normalize(socketPath) === socketPath &&
    !/[\u0000-\u001f\u007f\\]/u.test(socketPath) &&
    Buffer.byteLength(socketPath, "utf8") <= MAXIMUM_UNIX_SOCKET_PATH_BYTES &&
    value.endpoint === endpoint.href &&
    endpoint.href === `unix://${socketPath}` &&
    canonicalRemoteDirectory(value.executableDirectory) &&
    boundedEnvironmentValue(value.inheritedPath)
  );
}

function canonicalRemoteDirectory(value: string): boolean {
  return (
    boundedEnvironmentValue(value) &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    value !== "/" &&
    !value.endsWith("/")
  );
}

function boundedEnvironmentValue(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") <= MAXIMUM_ENVIRONMENT_VALUE_BYTES &&
    !/[\u0000\r\n]/u.test(value)
  );
}
