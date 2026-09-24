import type { EnvironmentVariableOverrides } from "../../../../shared/protocol/environment-variables.js";
import { ClaudeHistoryPager } from "../claude-session-history.js";
import { mergeResolvedEnvironment, type ResolvedEnvironmentVariables } from "../../../environment-variables/runtime-environment.js";
import type {
  CanUseTool,
  PermissionResult,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  SidecarOperationError,
  type SidecarOperationDefinition,
} from "../../../../internal/sidecar-protocol/operation-registry.js";
import { SidecarProtocolDeliveryError } from "../../../../internal/sidecar-protocol/contracts.js";
import { claudeConfigDirectory, type ClaudeChildEnvironment } from "../claude-child-environment.js";
import { snapshotBoundedJson } from "../../../provider-protocol/json/bounded-json-snapshot.js";
import type { ClaudeSdkFacade } from "../claude-sdk-facade.js";
import { probeClaudeSdkDirect } from "../claude-sdk-probe.js";
import { ClaudeSdkSession } from "../claude-sdk-session.js";
import {
  CLAUDE_RUNTIME_CAPABILITY_ID,
  CLAUDE_RUNTIME_MAJOR_VERSION,
  CLAUDE_RUNTIME_MAXIMUM_JSON_BYTES,
  CLAUDE_RUNTIME_MAXIMUM_QUERIES,
  claudeRuntimeCanUseToolOperation,
  claudeRuntimeCanUseToolRequestSchema,
  claudeRuntimeCanUseToolResponseSchema,
  claudeRuntimePermissionResponseAckOperation,
  claudeRuntimeQueryFailedEventSchema,
  claudeRuntimeQueryMessageEventSchema,
  type ClaudeRuntimeV1WorkerHandlers,
} from "./claude-runtime-v1.js";

export interface ClaudeRuntimeWorkerProtocolPeer {
  call<Request, Response>(
    definition: SidecarOperationDefinition<Request, Response>,
    request: Request,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Response>;
  sendEvent<Payload>(input: {
    readonly capabilityId: string;
    readonly majorVersion: number;
    readonly event: string;
    readonly payload: Payload;
    readonly schema: import("zod").z.ZodType<Payload>;
  }): Promise<void>;
  close(reason: string): Promise<void>;
}

export interface ClaudeRuntimeWorkerHostOptions {
  readonly sdk: ClaudeSdkFacade;
  readonly peer: ClaudeRuntimeWorkerProtocolPeer;
  readonly maximumQueries?: number;
}

type ActiveQuery = {
  readonly queryId: string;
  readonly sessionId: string;
  readonly session: ClaudeSdkSession;
};

type RuntimeConfiguration = {
  readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
  readonly startupEnvironment?: ResolvedEnvironmentVariables;
  readonly requestedExecutablePath: string;
  readonly requestedConfigDirectory?: string;
  readonly executablePath: string;
  readonly initializationTimeoutMs: number;
  readonly environment: ClaudeChildEnvironment;
  readonly configDirectory: string;
};

/**
 * Provider-private owner for all SDK and native-store work in one worker
 * generation. The main server communicates with this host only through the
 * closed claude_runtime@1 binding.
 */
export class ClaudeRuntimeWorkerHost {
  readonly handlers: ClaudeRuntimeV1WorkerHandlers;
  readonly #sdk: ClaudeSdkFacade;
  readonly #history = new ClaudeHistoryPager<Awaited<ReturnType<ClaudeRuntimeV1WorkerHandlers["getSessionMessages"]>>["messages"][number]>();
  readonly #peer: ClaudeRuntimeWorkerProtocolPeer;
  readonly #maximumQueries: number;
  readonly #queries = new Map<string, ActiveQuery>();
  readonly #queryBySessionId = new Map<string, string>();
  #configuration: RuntimeConfiguration | undefined;
  #initializing: Promise<RuntimeConfiguration> | undefined;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: ClaudeRuntimeWorkerHostOptions) {
    const maximumQueries =
      options.maximumQueries ?? CLAUDE_RUNTIME_MAXIMUM_QUERIES;
    if (
      !Number.isSafeInteger(maximumQueries) ||
      maximumQueries <= 0 ||
      maximumQueries > CLAUDE_RUNTIME_MAXIMUM_QUERIES
    ) {
      throw new Error("claude_runtime_query_limit_invalid");
    }
    this.#sdk = options.sdk;
    this.#peer = options.peer;
    this.#maximumQueries = maximumQueries;
    const handlers: ClaudeRuntimeV1WorkerHandlers = {
      initialize: async (request, context) =>
        await this.#initialize(request, context.signal),
      probe: async ({ cwd }, context) => await this.#probe(cwd, context.signal),
      listSessions: async (request) => await this.#listSessions(request),
      getSessionInfo: async (request) => await this.#getSessionInfo(request),
      getSessionMessages: async (request) =>
        await this.#getSessionMessages(request),
      renameSession: async (request) => await this.#renameSession(request),
      openQuery: async (request, context) =>
        await this.#openQuery(request, context.signal),
      sendQuery: (request) => this.#sendQuery(request),
      interruptQuery: async ({ queryId }) =>
        await this.#interruptQuery(queryId),
      setQueryModel: async ({ queryId, model }) => {
        await this.#query(queryId).session.setModel(model ?? undefined);
        return { updated: true as const };
      },
      setQueryEffort: async ({ queryId, effort }) => {
        await this.#query(queryId).session.setEffort(effort ?? undefined);
        return { updated: true as const };
      },
      setQueryPermissionMode: async ({ queryId, permissionMode }) => {
        await this.#query(queryId).session.setPermissionMode(permissionMode);
        return { updated: true as const };
      },
      closeQuery: async ({ queryId }) => {
        await this.#closeQuery(queryId);
        return { closed: true as const };
      },
    };
    this.handlers = Object.freeze(handlers);
  }

  get activeQueryCount(): number {
    return this.#queries.size;
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#history.close();
    this.#closePromise ??= Promise.allSettled(
      [...this.#queries.values()].map(({ session }) => session.close()),
    ).then(() => {
      this.#queries.clear();
      this.#queryBySessionId.clear();
    });
    return this.#closePromise;
  }

  async #probe(cwd: string, signal: AbortSignal) {
    this.#assertOpen();
    const configuration = this.#configured();
    const result = await probeClaudeSdkDirect({
      sdk: this.#sdk,
      executablePath: configuration.executablePath,
      cwd,
      timeoutMs: configuration.initializationTimeoutMs,
      environment: configuration.environment,
      signal,
    });
    return {
      cliRelease: result.cliRelease,
      account: projectAccount(result.account),
      models: result.models.map(projectModel),
      commands: result.commands.map(projectCommand),
      skillNames: [...result.skillNames],
      terminalCommandNames: [...result.terminalCommandNames],
    };
  }

  async #listSessions(
    request: Parameters<ClaudeRuntimeV1WorkerHandlers["listSessions"]>[0],
  ) {
    this.#assertOpen();
    const sessions = await this.#sdk.listSessions(
      { ...request },
      this.#configured().environment,
    );
    return { sessions: sessions.map(projectSessionInfo) };
  }

  async #getSessionInfo(
    request: Parameters<ClaudeRuntimeV1WorkerHandlers["getSessionInfo"]>[0],
  ) {
    this.#assertOpen();
    const session = await this.#sdk.getSessionInfo(
      request.sessionId,
      request.dir ? { dir: request.dir } : {},
      this.#configured().environment,
    );
    return { session: session ? projectSessionInfo(session) : null };
  }

  async #getSessionMessages(
    request: Parameters<ClaudeRuntimeV1WorkerHandlers["getSessionMessages"]>[0],
  ) {
    this.#assertOpen();
    const { sessionId, offset: _offset, limit: _limit, cursor: _cursor, maintenance: _maintenance, ...options } = request;
    return this.#history.getPage(sessionId, request, async () => {
      const messages = await this.#sdk.getSessionMessages(
        sessionId,
        { ...options },
        this.#configured().environment,
      );
      const projected = messages.map((message) => ({
        type: message.type,
        uuid: message.uuid,
        session_id: message.session_id,
        message: snapshotJson(message.message),
        parent_tool_use_id: message.parent_tool_use_id,
        parent_agent_id: message.parent_agent_id,
        ...("origin" in message && message.origin !== undefined
          ? { origin: snapshotJson(message.origin) }
          : {}),
        ...("timestamp" in message && typeof message.timestamp === "string"
          ? { timestamp: message.timestamp }
          : {}),
      }));
      return projected;
    });
  }

  async #renameSession(
    request: Parameters<ClaudeRuntimeV1WorkerHandlers["renameSession"]>[0],
  ) {
    this.#assertOpen();
    await this.#sdk.renameSession(
      request.sessionId,
      request.title,
      { dir: request.dir },
      this.#configured().environment,
    );
    return { renamed: true as const };
  }

  async #openQuery(
    request: Parameters<ClaudeRuntimeV1WorkerHandlers["openQuery"]>[0],
    signal: AbortSignal,
  ) {
    this.#assertOpen();
    signal.throwIfAborted();
    if (
      this.#queries.has(request.queryId) ||
      this.#queryBySessionId.has(request.sessionId)
    ) {
      throw new SidecarOperationError("claude_runtime_query_duplicate");
    }
    if (this.#queries.size >= this.#maximumQueries) {
      throw new SidecarOperationError(
        "claude_runtime_query_capacity_exceeded",
        true,
      );
    }
    const queryId = request.queryId;
    const configuration = this.#configured();
    const executionEnvironment = mergeResolvedEnvironment(configuration.environment, request.executionEnvironment ?? {});
    let query!: ActiveQuery;
    const permissionResponseAdoption = new Map<string, boolean>();
    const canUseTool = request.enableCanUseTool
      ? this.#remoteCanUseTool(queryId, permissionResponseAdoption)
      : undefined;
    const session = new ClaudeSdkSession({
      sdk: this.#sdk,
      executablePath: configuration.executablePath,
      initializationTimeoutMs: configuration.initializationTimeoutMs,
      sessionId: request.sessionId,
      cwd: request.cwd,
      launch: request.launch,
      ...(request.launch === "fork"
        ? {
            sourceSessionId: request.sourceSessionId,
            resumeSessionAt: request.resumeSessionAt,
          }
        : {}),
      ...(request.title ? { title: request.title } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      ...(request.permissionMode
        ? { permissionMode: request.permissionMode }
        : {}),
      ...(request.allowDangerouslySkipPermissions
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(canUseTool ? { canUseTool } : {}),
      ...(canUseTool
        ? {
            onPermissionResponseDelivered: async (identity) => {
              const key = permissionResponseKey(
                identity.requestId,
                identity.toolUseID,
              );
              const adopted = permissionResponseAdoption.get(key) ?? true;
              permissionResponseAdoption.delete(key);
              try {
                await this.#peer.call(
                  claudeRuntimePermissionResponseAckOperation,
                  {
                    queryId,
                    requestId: identity.requestId,
                    toolUseID: identity.toolUseID,
                    adopted,
                  },
                );
              } catch (error) {
                await this.#peer
                  .close("claude_runtime_permission_acknowledgement_failed")
                  .catch(() => undefined);
                throw error;
              }
            },
          }
        : {}),
      environment: Object.freeze({
        ...executionEnvironment,
        ...request.environment,
        ...(request.environment.PATH
          ? { PATH: request.environment.PATH.split(path.delimiter)[0]! + (executionEnvironment.PATH ? path.delimiter + executionEnvironment.PATH : "") }
          : {}),
      }),
      onMessage: async (message) => {
        const payload = claudeRuntimeQueryMessageEventSchema.parse({
          queryId,
          message,
        });
        await this.#peer.sendEvent({
          capabilityId: CLAUDE_RUNTIME_CAPABILITY_ID,
          majorVersion: CLAUDE_RUNTIME_MAJOR_VERSION,
          event: "query.message",
          schema: claudeRuntimeQueryMessageEventSchema,
          payload,
        });
      },
      onFailure: () => {
        if (this.#queries.get(queryId) !== query) return;
        this.#forgetQuery(query);
        void this.#peer
          .sendEvent({
            capabilityId: CLAUDE_RUNTIME_CAPABILITY_ID,
            majorVersion: CLAUDE_RUNTIME_MAJOR_VERSION,
            event: "query.failed",
            schema: claudeRuntimeQueryFailedEventSchema,
            payload: { queryId, code: "claude_runtime_query_failed" },
          })
          .catch(() =>
            this.#peer.close("claude_runtime_event_delivery_failed"),
          );
      },
    });
    query = { queryId, sessionId: request.sessionId, session };
    this.#queries.set(queryId, query);
    this.#queryBySessionId.set(request.sessionId, queryId);
    try {
      const initialization = await raceAgainstAbort(session.start(), signal);
      signal.throwIfAborted();
      const startupProbeUuid = session.startupProbeUuid;
      if (!startupProbeUuid) {
        throw new Error("claude_runtime_startup_probe_identity_missing");
      }
      return {
        queryId,
        startupProbeUuid,
        initialization: {
          models: initialization.models.map(projectModel),
          commands: initialization.commands.map(projectCommand),
          skillNames: [...initialization.skillNames],
          terminalCommandNames: [...initialization.terminalCommandNames],
          account: projectAccount(initialization.account),
          ...(initialization.actualModel
            ? { actualModel: initialization.actualModel }
            : {}),
          actualPermissionMode: initialization.actualPermissionMode,
          cliRelease: initialization.cliRelease,
        },
      };
    } catch (error) {
      this.#forgetQuery(query);
      await session.close().catch(() => undefined);
      throw error;
    }
  }

  async #sendQuery(
    request: Parameters<ClaudeRuntimeV1WorkerHandlers["sendQuery"]>[0],
  ) {
    this.#assertOpen();
    if (
      typeof request.content !== "string" &&
      !Array.isArray(request.content)
    ) {
      throw new SidecarOperationError("claude_runtime_query_content_invalid");
    }
    await this.#query(request.queryId).session.send({
      operationId: request.operationId,
      ...(request.priority ? { priority: request.priority } : {}),
      content: request.content as SDKUserMessage["message"]["content"],
      ...(request.shouldQuery !== undefined
        ? { shouldQuery: request.shouldQuery }
        : {}),
    });
    return { accepted: true as const };
  }

  async #interruptQuery(queryId: string) {
    this.#assertOpen();
    const receipt = await this.#query(queryId).session.interrupt();
    return {
      receipt: receipt
        ? {
            still_queued: [...receipt.still_queued],
            ...(receipt.cancelled ? { cancelled: [...receipt.cancelled] } : {}),
          }
        : null,
    };
  }

  async #closeQuery(queryId: string): Promise<void> {
    this.#assertOpen();
    const query = this.#queries.get(queryId);
    if (!query) return;
    this.#forgetQuery(query);
    await query.session.close();
  }

  #remoteCanUseTool(
    queryId: string,
    permissionResponseAdoption: Map<string, boolean>,
  ): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      try {
        // Provenance is descriptive, not permission authority. Omit invalid
        // labels before transport rather than taking down the worker peer.
        const mcpServer = claudeRuntimeCanUseToolRequestSchema.shape.options.shape
          .mcpServer.safeParse(options.mcpServer);
        const request = claudeRuntimeCanUseToolRequestSchema.parse({
          queryId,
          toolName,
          input,
          options: {
            ...(options.suggestions
              ? { suggestions: options.suggestions }
              : {}),
            ...(options.blockedPath
              ? { blockedPath: options.blockedPath }
              : {}),
            ...(options.decisionReason
              ? { decisionReason: options.decisionReason }
              : {}),
            ...(options.defaultToNo !== undefined
              ? { defaultToNo: options.defaultToNo }
              : {}),
            ...(options.suppressAlwaysAllowRule !== undefined
              ? { suppressAlwaysAllowRule: options.suppressAlwaysAllowRule }
              : {}),
            ...(mcpServer.success && mcpServer.data
              ? { mcpServer: mcpServer.data }
              : {}),
            ...(options.title ? { title: options.title } : {}),
            ...(options.displayName
              ? { displayName: options.displayName }
              : {}),
            ...(options.description
              ? { description: options.description }
              : {}),
            toolUseID: options.toolUseID,
            ...(options.agentID ? { agentID: options.agentID } : {}),
            requestId: options.requestId,
            ...(options.matchedAskRule
              ? { matchedAskRule: options.matchedAskRule }
              : {}),
          },
        });
        const response = await this.#peer.call(
          claudeRuntimeCanUseToolOperation,
          request,
          { signal: options.signal },
        );
        return claudeRuntimeCanUseToolResponseSchema.parse(
          response,
        ) as PermissionResult;
      } catch (error) {
        permissionResponseAdoption.set(
          permissionResponseKey(options.requestId, options.toolUseID),
          false,
        );
        if (!isSignalCancellation(error, options.signal)) {
          void this.#peer.close("claude_runtime_permission_delivery_failed");
        }
        return {
          behavior: "deny",
          message: "Permission request unavailable.",
          toolUseID: options.toolUseID,
          decisionClassification: "user_reject",
        };
      }
    };
  }

  #query(queryId: string): ActiveQuery {
    this.#assertOpen();
    const query = this.#queries.get(queryId);
    if (!query) {
      throw new SidecarOperationError("claude_runtime_query_not_found");
    }
    return query;
  }

  async #initialize(
    request: Parameters<ClaudeRuntimeV1WorkerHandlers["initialize"]>[0],
    signal: AbortSignal,
  ): Promise<{ readonly initialized: true; readonly configDirectory: string }> {
    this.#assertOpen();
    signal.throwIfAborted();
    const existing = this.#configuration;
    if (existing) {
      assertSameConfiguration(existing, request);
      return {
        initialized: true as const,
        configDirectory: existing.configDirectory,
      };
    }
    if (!this.#initializing) {
      let initializing!: Promise<RuntimeConfiguration>;
      initializing = verifyRuntimeConfiguration(request).catch((error) => {
        if (this.#initializing === initializing) this.#initializing = undefined;
        throw error;
      });
      this.#initializing = initializing;
    }
    const configuration = await raceAgainstAbort(this.#initializing, signal);
    signal.throwIfAborted();
    assertSameConfiguration(configuration, request);
    this.#configuration ??= configuration;
    const configOverride = configuration.environment.CLAUDE_CONFIG_DIR;
    if (configOverride === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = configOverride;
    return {
      initialized: true as const,
      configDirectory: configuration.configDirectory,
    };
  }

  #configured(): RuntimeConfiguration {
    const configuration = this.#configuration;
    if (!configuration) {
      throw new SidecarOperationError("claude_runtime_not_initialized");
    }
    return configuration;
  }

  #forgetQuery(query: ActiveQuery): void {
    if (this.#queries.get(query.queryId) === query) {
      this.#queries.delete(query.queryId);
    }
    if (this.#queryBySessionId.get(query.sessionId) === query.queryId) {
      this.#queryBySessionId.delete(query.sessionId);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SidecarOperationError("claude_runtime_worker_closed");
    }
  }
}

function permissionResponseKey(requestId: string, toolUseID: string): string {
  return JSON.stringify([requestId, toolUseID]);
}

function isSignalCancellation(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  return (
    error === signal.reason ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof SidecarProtocolDeliveryError &&
      error.message === "sidecar_request_cancelled")
  );
}

async function verifyRuntimeConfiguration(request: {
  readonly executablePath: string;
  readonly configDirectory?: string;
  readonly initializationTimeoutMs: number;
  readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
  readonly startupEnvironment?: ResolvedEnvironmentVariables;
}): Promise<RuntimeConfiguration> {
  // Native defaults resolve inside the execution-host worker. The desired
  // omission remains distinct from an explicit override after initialization.
  const configOverride = request.configDirectory ?? process.env.CLAUDE_CONFIG_DIR;
  const requestedConfigDirectory = request.configDirectory ?? claudeConfigDirectory(process.env);
  const executablePath = await resolveClaudeExecutable(request.executablePath);
  const [executableMetadata, configRealPath] = await Promise.all([
    lstat(executablePath).catch(() => undefined),
    realpath(requestedConfigDirectory).catch(() => ""),
  ]);
  // Canonicalize native defaults for ownership checks without turning them
  // into an explicit override: Claude's native default behavior depends on
  // CLAUDE_CONFIG_DIR remaining unset. Explicit overrides must be canonical.
  const configMetadata = await lstat(configRealPath).catch(() => undefined);
  if (!executableMetadata?.isFile() || executableMetadata.isSymbolicLink()) {
    throw new SidecarOperationError("claude_runtime_executable_invalid");
  }
  try {
    await access(executablePath, fsConstants.X_OK);
  } catch {
    throw new SidecarOperationError("claude_runtime_executable_invalid");
  }
  const uid = process.getuid?.();
  if (
    !Number.isSafeInteger(uid) ||
    uid! < 0 ||
    (request.configDirectory !== undefined && configRealPath !== request.configDirectory) ||
    !configMetadata?.isDirectory() ||
    configMetadata.isSymbolicLink() ||
    configMetadata.uid !== uid ||
    (configMetadata.mode & 0o002) !== 0
  ) {
    throw new SidecarOperationError("claude_runtime_config_directory_invalid");
  }
  return Object.freeze({
    startupEnvironmentVariables: request.startupEnvironmentVariables,
    requestedExecutablePath: request.executablePath,
    ...(request.configDirectory === undefined ? {} : { requestedConfigDirectory: request.configDirectory }),
    executablePath,
    initializationTimeoutMs: request.initializationTimeoutMs,
    environment: mergeResolvedEnvironment(workerBaseEnvironment(configOverride === undefined ? undefined : configRealPath), request.startupEnvironment ?? {}),
    configDirectory: configRealPath,
  });
}

async function resolveClaudeExecutable(requestedPath: string): Promise<string> {
  if (requestedPath !== "claude") {
    const executableRealPath = await realpath(requestedPath).catch(() => "");
    if (executableRealPath !== requestedPath) {
      throw new SidecarOperationError("claude_runtime_executable_invalid");
    }
    return executableRealPath;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "claude");
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isFile() && !metadata.isSymbolicLink()) continue;
      await access(candidate, fsConstants.X_OK);
      const executableRealPath = await realpath(candidate);
      const executableMetadata = await lstat(executableRealPath);
      if (executableMetadata.isFile() && !executableMetadata.isSymbolicLink()) {
        return executableRealPath;
      }
    } catch {
      // Match executable PATH lookup: unusable entries do not shadow later ones.
    }
  }
  throw new SidecarOperationError("claude_runtime_executable_invalid");
}

function workerBaseEnvironment(
  configDirectory: string | undefined,
): ClaudeChildEnvironment {
  const result: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const name of [
    "HOME",
    "PATH",
    "LANG",
    "TMPDIR",
    "USER",
    "LOGNAME",
  ] as const) {
    const value = process.env[name];
    if (
      value !== undefined &&
      value.length <= 16_384 &&
      !/[\u0000\r\n]/u.test(value)
    ) {
      result[name] = value;
    }
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (
      name.startsWith("LC_") &&
      value !== undefined &&
      value.length <= 128 &&
      /^[A-Za-z0-9_@.+-]*$/u.test(value)
    ) {
      result[name] = value;
    }
  }
  if (configDirectory !== undefined) result.CLAUDE_CONFIG_DIR = configDirectory;
  return Object.freeze(result);
}

function assertSameConfiguration(
  configuration: RuntimeConfiguration,
  request: {
    readonly executablePath: string;
    readonly configDirectory?: string;
    readonly initializationTimeoutMs: number;
    readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
    readonly startupEnvironment?: ResolvedEnvironmentVariables;
  },
): void {
  if (
    configuration.requestedExecutablePath !== request.executablePath ||
    configuration.requestedConfigDirectory !== request.configDirectory ||
    configuration.initializationTimeoutMs !== request.initializationTimeoutMs ||
    JSON.stringify(configuration.startupEnvironmentVariables ?? {}) !== JSON.stringify(request.startupEnvironmentVariables ?? {})
  ) {
    throw new SidecarOperationError("claude_runtime_initialization_mismatch");
  }
}

function projectAccount(account: {
  readonly subscriptionType?: string;
  readonly tokenSource?: string;
  readonly apiKeySource?: string;
  readonly apiProvider?:
    | "firstParty"
    | "bedrock"
    | "vertex"
    | "foundry"
    | "anthropicAws"
    | "anthropicGoogleCloud"
    | "mantle"
    | "gateway";
}) {
  return {
    ...(account.subscriptionType
      ? { subscriptionType: account.subscriptionType }
      : {}),
    ...(account.tokenSource ? { tokenSource: account.tokenSource } : {}),
    ...(account.apiKeySource ? { apiKeySource: account.apiKeySource } : {}),
    ...(account.apiProvider ? { apiProvider: account.apiProvider } : {}),
  };
}

function projectModel(model: {
  readonly value: string;
  readonly resolvedModel?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: readonly (
    "low" | "medium" | "high" | "xhigh" | "max"
  )[];
  readonly supportsAdaptiveThinking?: boolean;
  readonly supportedDialogKinds?: readonly string[];
}) {
  return {
    value: model.value,
    ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    displayName: model.displayName,
    description: model.description,
    ...(model.supportsEffort !== undefined
      ? { supportsEffort: model.supportsEffort }
      : {}),
    ...(model.supportedEffortLevels
      ? { supportedEffortLevels: [...model.supportedEffortLevels] }
      : {}),
    ...(model.supportsAdaptiveThinking !== undefined
      ? { supportsAdaptiveThinking: model.supportsAdaptiveThinking }
      : {}),
    ...(model.supportedDialogKinds
      ? { supportedDialogKinds: [...model.supportedDialogKinds] }
      : {}),
  };
}

function projectCommand(command: {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string;
  readonly aliases?: readonly string[];
}) {
  return {
    name: command.name,
    description: command.description,
    argumentHint: command.argumentHint,
    ...(command.aliases ? { aliases: [...command.aliases] } : {}),
  };
}

function projectSessionInfo(session: {
  readonly sessionId: string;
  readonly summary: string;
  readonly lastModified: number;
  readonly fileSize?: number;
  readonly customTitle?: string;
  readonly firstPrompt?: string;
  readonly gitBranch?: string;
  readonly cwd?: string;
  readonly tag?: string;
  readonly createdAt?: number;
}) {
  return {
    sessionId: session.sessionId,
    summary: session.summary,
    lastModified: session.lastModified,
    ...(session.fileSize !== undefined ? { fileSize: session.fileSize } : {}),
    ...(session.customTitle ? { customTitle: session.customTitle } : {}),
    ...(session.firstPrompt ? { firstPrompt: session.firstPrompt } : {}),
    ...(session.gitBranch ? { gitBranch: session.gitBranch } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.tag ? { tag: session.tag } : {}),
    ...(session.createdAt !== undefined
      ? { createdAt: session.createdAt }
      : {}),
  };
}

function snapshotJson(value: unknown) {
  return snapshotBoundedJson(value, {
    maximumDepth: 64,
    maximumObjectProperties: 16_384,
    maximumArrayItems: 262_144,
    maximumStringBytes: 64 * 1024 * 1024,
    maximumTotalNodes: 1_000_000,
    maximumEncodedBytes: CLAUDE_RUNTIME_MAXIMUM_JSON_BYTES,
  });
}

async function raceAgainstAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("operation_aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
