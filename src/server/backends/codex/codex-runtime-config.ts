import type { EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { resolveEnvironmentVariables, mergeResolvedEnvironment } from "../../environment-variables/runtime-environment.js";
import { homedir } from "node:os";
import path from "node:path";
import type {
  EnvironmentOwnedProcessChannel,
  ExecutionEnvironmentChannelProvider,
  PreparedEnvironmentOwnedProcess,
} from "../../execution/environment-channel.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
} from "../contracts.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { CodexBackendModuleConfiguration } from "./codex-backend-configuration.js";
import {
  CODEX_APP_SERVER_RELEASE,
  assertCodexRuntimePlatformSupported,
  decodeCodexRuntimeVersionProbe,
  verifyCodexRuntimeVersion,
  type VerifiedCodexRuntime,
} from "./codex-release-guard.js";

const FORWARDED_ENVIRONMENT_NAMES = [
  "ALL_PROXY",
  "CODEX_CA_CERTIFICATE",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_FILE",
  "TZ",
] as const;

const VERSION_PROBE_TIMEOUT_MILLISECONDS = 5_000;
const VERSION_PROBE_OUTPUT_BYTES = 4_096;

export interface CodexRuntimeConfigurationInput {
  readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
  readonly scope: RequestScope;
  readonly instance: AgentBackendInstance;
  readonly connections: readonly AgentConnectionProfile[];
  readonly connection: CodexBackendModuleConfiguration["connection"];
  readonly environmentChannel: ExecutionEnvironmentChannelProvider;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export type ResolvedCodexRuntimeConfiguration =
  | Readonly<{
      scope: RequestScope;
      instance: AgentBackendInstance;
      executionEnvironmentId: string;
      codexHome: string;
      nativeStoreHome: string;
      childEnvironment: Readonly<Record<string, string>>;
      connection: Readonly<{
        ownership: "owned";
        channel: Readonly<{
          type: "process_stdio";
          process: PreparedEnvironmentOwnedProcess;
          executable: VerifiedCodexRuntime;
          workingDirectory: string;
        }>;
      }>;
    }>
  | Readonly<{
      scope: RequestScope;
      instance: AgentBackendInstance;
      executionEnvironmentId: string;
      readonly codexHome?: never;
      readonly nativeStoreHome?: never;
      readonly childEnvironment?: never;
      connection: Readonly<{
        ownership: "external";
        channel:
          | Readonly<{ type: "unix_websocket"; socketPath: string }>
          | Readonly<{
              type: "tcp_websocket";
              url: string;
              authentication: Readonly<{
                type: "capability_token";
                secret:
                  | Readonly<{ source: "environment"; variable: string }>
                  | Readonly<{ source: "protected_file"; path: string }>;
              }>;
            }>;
      }>;
    }>;

export async function resolveCodexRuntimeConfiguration(
  input: CodexRuntimeConfigurationInput,
): Promise<ResolvedCodexRuntimeConfiguration> {
  const executionEnvironmentId = assertRuntimeScope(input);
  const channelScope = Object.freeze({
    ...input.scope,
    backendInstanceId: input.instance.id,
    executionEnvironmentId,
  });
  if (input.connection.ownership === "owned") {
    const configuredCodexHome = input.connection.channel.codexHome;
    const defaultHome = input.environment.HOME ?? homedir();
    const defaultCodexHome = path.join(defaultHome, ".codex");
    const nativeStoreHome = (
      await input.environmentChannel.resolveDirectory(
        channelScope,
        configuredCodexHome ?? defaultCodexHome,
      )
    ).canonicalPath;
    const codexHome = configuredCodexHome ? nativeStoreHome : defaultCodexHome;
    const childEnvironment = mergeResolvedEnvironment(buildCodexLaunchEnvironment(input.environment, {
      home: defaultHome,
      ...(configuredCodexHome ? { codexHomeOverride: nativeStoreHome } : {}),
    }), await resolveEnvironmentVariables(input.startupEnvironmentVariables ?? {}, input.environment));
    const resolveExecutable =
      input.environmentChannel.resolveOwnedProcessExecutable;
    if (!resolveExecutable) {
      throw new Error("codex_owned_process_executable_resolution_unsupported");
    }
    const executableIdentity = await resolveExecutable.call(
      input.environmentChannel,
      channelScope,
      {
        commandName: "codex",
        ...(input.connection.channel.executablePath
          ? { configuredPath: input.connection.channel.executablePath }
          : {}),
      },
    );
    const process = await input.environmentChannel.prepareOwnedProcess(
      channelScope,
      {
        executablePath: executableIdentity.canonicalPath,
        workingDirectory: input.connection.channel.workingDirectory,
      },
    );
    const executable = await verifyPreparedCodexRuntime(
      input.environmentChannel,
      channelScope,
      process,
      childEnvironment,
    );
    return Object.freeze({
      scope: Object.freeze({ ...input.scope }),
      instance: input.instance,
      executionEnvironmentId,
      codexHome,
      nativeStoreHome,
      childEnvironment,
      connection: Object.freeze({
        ownership: "owned" as const,
        channel: Object.freeze({
          type: "process_stdio" as const,
          process,
          executable,
          workingDirectory: process.workingDirectory.canonicalPath,
        }),
      }),
    });
  }

  const connection =
    input.connection.channel.type === "unix_websocket"
      ? Object.freeze({
          ownership: "external" as const,
          channel: Object.freeze({
            type: "unix_websocket" as const,
            socketPath: input.connection.channel.socketPath,
          }),
        })
      : Object.freeze({
          ownership: "external" as const,
          channel: Object.freeze({
            type: "tcp_websocket" as const,
            url: input.connection.channel.url,
            authentication: structuredClone(
              input.connection.channel.authentication,
            ),
          }),
        });

  return Object.freeze({
    scope: Object.freeze({ ...input.scope }),
    instance: input.instance,
    executionEnvironmentId,
    connection,
  });
}

function assertRuntimeScope(input: CodexRuntimeConfigurationInput): string {
  const environmentIds = new Set(
    input.connections
      .filter(({ enabled }) => enabled)
      .map(({ executionEnvironmentId }) => executionEnvironmentId),
  );
  const executionEnvironmentId = [...environmentIds][0];
  if (
    input.instance.kind !== "codex_app_server" ||
    input.instance.protocolRelease !== CODEX_APP_SERVER_RELEASE ||
    input.instance.tenantId !== input.scope.tenantId ||
    environmentIds.size !== 1 ||
    !executionEnvironmentId ||
    input.environmentChannel.executionEnvironmentId !==
      executionEnvironmentId ||
    input.environmentChannel.scope.tenantId !== input.scope.tenantId ||
    input.environmentChannel.scope.principalId !== input.scope.principalId ||
    input.connections.some(
      (connection) =>
        connection.tenantId !== input.scope.tenantId ||
        connection.ownerPrincipalId !== input.scope.principalId ||
        connection.backendInstanceId !== input.instance.id ||
        connection.kind !== "codex_app_server",
    )
  ) {
    throw new Error("codex_runtime_scope_invalid");
  }
  return executionEnvironmentId;
}

export function buildCodexLaunchEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  input: Readonly<{ home: string; codexHomeOverride?: string }>,
): Readonly<Record<string, string>> {
  const childEnvironment: Record<string, string> = {};
  for (const name of FORWARDED_ENVIRONMENT_NAMES) {
    const value = environment[name];
    if (value !== undefined) childEnvironment[name] = value;
  }
  childEnvironment.HOME = input.home;
  if (input.codexHomeOverride !== undefined) {
    childEnvironment.CODEX_HOME = input.codexHomeOverride;
  }
  childEnvironment.NO_COLOR = "1";
  childEnvironment.TERM = "dumb";
  return Object.freeze(childEnvironment);
}

export async function verifyPreparedCodexRuntime(
  channels: ExecutionEnvironmentChannelProvider,
  scope: Parameters<ExecutionEnvironmentChannelProvider["openOwnedProcess"]>[0],
  preparedProcess: PreparedEnvironmentOwnedProcess,
  environment: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<VerifiedCodexRuntime> {
  assertCodexRuntimePlatformSupported(process.platform, process.arch);
  const controller = new AbortController();
  const abortFromCaller = () =>
    controller.abort(
      signal?.reason ?? new Error("environment_operation_aborted"),
    );
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (signal?.aborted) abortFromCaller();
  const timer = setTimeout(
    () => controller.abort(new Error("codex_executable_version_probe_timeout")),
    VERSION_PROBE_TIMEOUT_MILLISECONDS,
  );
  timer.unref?.();
  let channel: EnvironmentOwnedProcessChannel | undefined;
  try {
    channel = await channels.openOwnedProcess(
      scope,
      {
        prepared: preparedProcess,
        arguments: ["--version"],
        environment,
        cleanup: {
          gracefulCloseMilliseconds: 250,
          terminateMilliseconds: 500,
          killMilliseconds: 500,
        },
      },
      controller.signal,
    );
    const stdout = readBounded(channel.stdout, VERSION_PROBE_OUTPUT_BYTES);
    const stderr = readBounded(channel.stderr, VERSION_PROBE_OUTPUT_BYTES);
    void stdout.catch(() => undefined);
    void stderr.catch(() => undefined);
    const closure = await Promise.race([
      channel.closed,
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true },
        );
      }),
    ]);
    await channel.close("codex_version_probe_complete");
    if (closure.exitCode !== 0) {
      throw new Error("codex_executable_version_probe_nonzero_exit");
    }
    const version = decodeCodexRuntimeVersionProbe(await stdout, await stderr);
    const verified = verifyCodexRuntimeVersion(version);
    return Object.freeze({
      path: preparedProcess.executable.canonicalPath,
      ...verified,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
    await channel?.close("codex_version_probe_finally");
  }
}

async function readBounded(
  source: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) {
      throw new Error("codex_executable_version_probe_output_too_large");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
