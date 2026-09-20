import type { EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { resolveEnvironmentVariables, mergeResolvedEnvironment, type ResolvedEnvironmentVariables } from "../../environment-variables/runtime-environment.js";
import { stat } from "node:fs/promises";
import type {
  EnvironmentOwnedProcessChannel,
  ExecutionEnvironmentChannelProvider,
  PreparedEnvironmentOwnedProcess,
} from "../../execution/environment-channel.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { buildGrokChildEnvironment } from "./grok-child-environment.js";
import {
  withGrokAgentToolCliEnvironment,
  type GrokAgentToolCliEnvironmentInput,
} from "./grok-agent-tool-cli-environment.js";
import {
  decodeGrokVersionEvidence,
  type AdmittedGrokRuntimeVersion,
} from "./grok-release-guard.js";

const VERSION_PROBE_TIMEOUT_MILLISECONDS = 5_000;
const VERSION_PROBE_OUTPUT_BYTES = 4_096;

export function grokRuntimePlatformSupported(
  platform: NodeJS.Platform,
  architecture: string,
): boolean {
  return (
    (platform === "linux" && architecture === "x64") ||
    (platform === "darwin" &&
      (architecture === "arm64" || architecture === "x64"))
  );
}

export interface ResolvedGrokWorkspaceRuntimeConfiguration {
  readonly scope: RequestScope;
  readonly backendInstanceId: string;
  readonly executionEnvironmentId: string;
  readonly workspace: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly process: PreparedEnvironmentOwnedProcess;
  readonly executable: AdmittedGrokRuntimeVersion & { readonly path: string };
}

/**
 * One driver-runtime executable admission cache. Every lookup revalidates the
 * local executable identity, so an in-place upgrade is probed before it can be
 * launched as a provider session. Failed probes are evicted and may be retried
 * by a later operation.
 */
export class GrokRuntimeVersionCache {
  readonly #entries = new Map<
    string,
    Readonly<{
      executableIdentity: string;
      pending: Promise<AdmittedGrokRuntimeVersion & { readonly path: string }>;
    }>
  >();

  async resolve(input: {
    readonly channels: ExecutionEnvironmentChannelProvider;
    readonly scope: Parameters<
      ExecutionEnvironmentChannelProvider["openOwnedProcess"]
    >[0];
    readonly prepared: PreparedEnvironmentOwnedProcess;
    readonly environment: Readonly<Record<string, string>>;
    readonly timeoutMilliseconds: number;
  }): Promise<AdmittedGrokRuntimeVersion & { readonly path: string }> {
    const key = input.prepared.executable.canonicalPath;
    const executableIdentity = await readExecutableIdentity(key);
    const existing = this.#entries.get(key);
    if (existing?.executableIdentity === executableIdentity) {
      return await existing.pending;
    }
    const pending = (async () => {
      const admitted = await verifyPreparedGrokRuntime(
        input.channels,
        input.scope,
        input.prepared,
        input.environment,
        input.timeoutMilliseconds,
      );
      if ((await readExecutableIdentity(key)) !== executableIdentity) {
        throw new Error("grok_runtime_executable_changed");
      }
      return admitted;
    })();
    const entry = Object.freeze({ executableIdentity, pending });
    this.#entries.set(key, entry);
    try {
      return await pending;
    } catch (error) {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
      throw error;
    }
  }
}

async function readExecutableIdentity(canonicalPath: string): Promise<string> {
  const identity = await stat(canonicalPath, { bigint: true });
  if (!identity.isFile()) throw new Error("grok_runtime_executable_invalid");
  return [
    identity.dev,
    identity.ino,
    identity.size,
    identity.mtimeNs,
    identity.ctimeNs,
    identity.mode,
  ].join(":");
}

export async function resolveGrokWorkspaceRuntimeConfiguration(input: {
  readonly scope: RequestScope;
  readonly backendInstanceId: string;
  readonly executionEnvironmentId: string;
  readonly executablePath?: string;
  readonly canonicalWorkspace: string;
  readonly environmentChannel: ExecutionEnvironmentChannelProvider;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
  readonly executionEnvironment?: ResolvedEnvironmentVariables;
  readonly agentToolCliEnvironment?: GrokAgentToolCliEnvironmentInput;
  readonly versionCache?: GrokRuntimeVersionCache;
  /** Test-only deadline override; production omits it. */
  readonly versionProbeTimeoutMilliseconds?: number;
}): Promise<ResolvedGrokWorkspaceRuntimeConfiguration> {
  if (
    !input.backendInstanceId ||
    input.environmentChannel.executionEnvironmentId !==
      input.executionEnvironmentId ||
    input.environmentChannel.scope.tenantId !== input.scope.tenantId ||
    input.environmentChannel.scope.principalId !== input.scope.principalId
  ) {
    throw new Error("grok_runtime_scope_invalid");
  }
  const channelScope = Object.freeze({
    ...input.scope,
    backendInstanceId: input.backendInstanceId,
    executionEnvironmentId: input.executionEnvironmentId,
  });
  const baseEnvironment = mergeResolvedEnvironment(mergeResolvedEnvironment(buildGrokChildEnvironment(input.environment), await resolveEnvironmentVariables(input.startupEnvironmentVariables ?? {}, input.environment)), input.executionEnvironment ?? {});
  const resolveExecutable =
    input.environmentChannel.resolveOwnedProcessExecutable;
  if (!resolveExecutable) {
    throw new Error("grok_owned_process_executable_resolution_unsupported");
  }
  const executableIdentity = await resolveExecutable.call(
    input.environmentChannel,
    channelScope,
    {
      commandName: "grok",
      ...(input.executablePath ? { configuredPath: input.executablePath } : {}),
    },
  );
  const process = await input.environmentChannel.prepareOwnedProcess(
    channelScope,
    {
      executablePath: executableIdentity.canonicalPath,
      workingDirectory: input.canonicalWorkspace,
    },
  );
  const versionCache = Object.keys(input.startupEnvironmentVariables ?? {}).length || Object.keys(input.executionEnvironment ?? {}).length
    ? new GrokRuntimeVersionCache()
    : input.versionCache ?? new GrokRuntimeVersionCache();
  const executable = await versionCache.resolve({
    channels: input.environmentChannel,
    scope: channelScope,
    prepared: process,
    environment: baseEnvironment,
    timeoutMilliseconds:
      input.versionProbeTimeoutMilliseconds ??
      VERSION_PROBE_TIMEOUT_MILLISECONDS,
  });
  const environment = withGrokAgentToolCliEnvironment(
    baseEnvironment,
    input.agentToolCliEnvironment?.availability.availability === "available"
      ? { ...input.agentToolCliEnvironment, availability: { ...input.agentToolCliEnvironment.availability, inheritedPath: baseEnvironment.PATH ?? "" } }
      : input.agentToolCliEnvironment,
  );
  return Object.freeze({
    scope: Object.freeze({ ...input.scope }),
    backendInstanceId: input.backendInstanceId,
    executionEnvironmentId: input.executionEnvironmentId,
    workspace: process.workingDirectory.canonicalPath,
    environment,
    process,
    executable,
  });
}

async function verifyPreparedGrokRuntime(
  channels: ExecutionEnvironmentChannelProvider,
  scope: Parameters<ExecutionEnvironmentChannelProvider["openOwnedProcess"]>[0],
  prepared: PreparedEnvironmentOwnedProcess,
  environment: Readonly<Record<string, string>>,
  timeoutMilliseconds: number,
): Promise<AdmittedGrokRuntimeVersion & { readonly path: string }> {
  if (!grokRuntimePlatformSupported(process.platform, process.arch)) {
    throw new Error("grok_runtime_platform_incompatible");
  }
  const controller = new AbortController();
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 10 ||
    timeoutMilliseconds > 30_000
  ) {
    throw new Error("grok_runtime_version_probe_timeout_invalid");
  }
  const timer = setTimeout(
    () => controller.abort(new Error("grok_runtime_version_probe_timeout")),
    timeoutMilliseconds,
  );
  let channel: EnvironmentOwnedProcessChannel | undefined;
  try {
    channel = await channels.openOwnedProcess(
      scope,
      {
        prepared,
        arguments: ["version", "--json"],
        environment,
        cleanup: {
          gracefulCloseMilliseconds: 250,
          terminateMilliseconds: 500,
          killMilliseconds: 500,
        },
      },
      controller.signal,
    );
    const stdout = readBounded(channel.stdout);
    const stderr = readBounded(channel.stderr);
    void stdout.catch(() => undefined);
    void stderr.catch(() => undefined);
    const closure = await Promise.race([
      channel.closed,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          {
            once: true,
          },
        );
      }),
    ]);
    await channel.close("grok_version_probe_complete");
    if (closure.exitCode !== 0) {
      throw new Error("grok_runtime_version_probe_nonzero_exit");
    }
    return Object.freeze({
      path: prepared.executable.canonicalPath,
      ...decodeGrokVersionEvidence(await stdout, await stderr),
    });
  } finally {
    clearTimeout(timer);
    await channel?.close("grok_version_probe_finally");
  }
}

async function readBounded(
  source: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.byteLength;
    if (bytes > VERSION_PROBE_OUTPUT_BYTES) {
      throw new Error("grok_runtime_version_probe_output_too_large");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
