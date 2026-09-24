import { resolveEnvironmentVariables } from "../../environment-variables/runtime-environment.js";
import type { EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  PermissionMode,
  SDKMessage,
  SDKSessionInfo,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import type {
  SidecarOperationDefinition,
  SidecarOperationRegistry,
} from "../../../internal/sidecar-protocol/index.js";
import { verifyClaudeRuntimeVersion } from "./claude-release-guard.js";
import type { ClaudeSdkSessionInitialization } from "./claude-sdk-session.js";
import {
  resolveClaudeSafeSkills,
  type ClaudeSafeSkill,
} from "./claude-skills.js";
import type {
  ClaudeRuntimeClient,
  ClaudeRuntimeProbeInput,
  ClaudeRuntimeProbeResult,
  ClaudeRuntimeSession,
  ClaudeRuntimeSessionOptions,
} from "./claude-runtime-client.js";
import {
  CLAUDE_RUNTIME_CAPABILITY_ID,
  CLAUDE_RUNTIME_MAJOR_VERSION,
  claudeRuntimeQueryCloseOperation,
  claudeRuntimeCanUseToolOperation,
  claudeRuntimeQueryFailedEventSchema,
  claudeRuntimeQueryInterruptOperation,
  claudeRuntimeQueryMessageEventSchema,
  claudeRuntimeQueryOpenOperation,
  claudeRuntimeQuerySendOperation,
  claudeRuntimeQuerySetEffortOperation,
  claudeRuntimeQuerySetModelOperation,
  claudeRuntimeQuerySetPermissionModeOperation,
  claudeRuntimeInitializeOperation,
  claudeRuntimeProbeOperation,
  claudeRuntimeSessionInfoOperation,
  claudeRuntimeSessionListOperation,
  claudeRuntimeSessionMessagesOperation,
  claudeRuntimeSessionRenameOperation,
  registerClaudeRuntimeV1HostOperations,
  type ClaudeRuntimeCanUseToolRequest,
  type ClaudeRuntimeCanUseToolResponse,
  type ClaudeRuntimeQueryFailedEvent,
  type ClaudeRuntimeQueryMessageEvent,
  type ClaudeRuntimePermissionResponseAckRequest,
} from "./worker/claude-runtime-v1.js";

export interface ClaudeRuntimeWorkerClientPeer {
  call<Request, Response>(
    definition: SidecarOperationDefinition<Request, Response>,
    request: Request,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Response>;
  onEvent<Payload>(input: {
    readonly capabilityId: string;
    readonly majorVersion: number;
    readonly event: string;
    readonly schema: z.ZodType<Payload>;
    readonly listener: (payload: Payload) => void;
  }): () => void;
  close(reason: string): Promise<void>;
}

const CLAUDE_PERMISSION_RESPONSE_ACK_DRAIN_MILLISECONDS = 30_000;

/** One generation-fenced client for the provider-private Claude worker. */
export class ClaudeRuntimeWorkerClient implements ClaudeRuntimeClient {
  readonly #peer: ClaudeRuntimeWorkerClientPeer;
  readonly #sessions = new Map<string, WorkerSession>();
  readonly #unsubscribe: readonly (() => void)[];
  readonly #runtimeInitialization: {
    readonly executablePath: string;
    readonly configDirectory?: string;
  readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
    readonly initializationTimeoutMs: number;
  };
  #initializing: Promise<void> | undefined;
  #closed = false;

  constructor(input: {
    readonly peer: ClaudeRuntimeWorkerClientPeer;
    readonly hostRegistry: SidecarOperationRegistry;
    readonly executablePath: string;
    readonly configDirectory?: string;
  readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
    readonly initializationTimeoutMs: number;
    readonly closed?: Promise<unknown>;
  }) {
    this.#peer = input.peer;
    this.#runtimeInitialization = Object.freeze({
      executablePath: input.executablePath,
      configDirectory: input.configDirectory,
      startupEnvironmentVariables: input.startupEnvironmentVariables,
      initializationTimeoutMs: input.initializationTimeoutMs,
    });
    registerClaudeRuntimeV1HostOperations(input.hostRegistry, {
      canUseTool: async (request, context) =>
        await this.#canUseTool(request, context.signal),
      acknowledgePermissionResponse: async (request) =>
        await this.#acknowledgePermissionResponse(request),
    });
    this.#unsubscribe = Object.freeze([
      input.peer.onEvent({
        capabilityId: CLAUDE_RUNTIME_CAPABILITY_ID,
        majorVersion: CLAUDE_RUNTIME_MAJOR_VERSION,
        event: "query.message",
        schema: claudeRuntimeQueryMessageEventSchema,
        listener: (event) => this.#message(event),
      }),
      input.peer.onEvent({
        capabilityId: CLAUDE_RUNTIME_CAPABILITY_ID,
        majorVersion: CLAUDE_RUNTIME_MAJOR_VERSION,
        event: "query.failed",
        schema: claudeRuntimeQueryFailedEventSchema,
        listener: (event) => this.#failed(event),
      }),
    ]);
    void input.closed?.then(
      () => this.close(new Error("claude_runtime_worker_closed")),
      (error) => this.close(error),
    );
  }

  async probe(
    input: ClaudeRuntimeProbeInput,
  ): Promise<ClaudeRuntimeProbeResult> {
    this.#assertOpen();
    await this.#initialize();
    const result = await this.#peer.call(
      claudeRuntimeProbeOperation,
      {
        cwd: input.cwd,
      },
      {
        signal: AbortSignal.timeout(
          this.#runtimeInitialization.initializationTimeoutMs,
        ),
      },
    );
    verifyClaudeRuntimeVersion(result.cliRelease, {
      ...(input.onNewerVersion ? { onNewerVersion: input.onNewerVersion } : {}),
      ...(input.onVersionAssessment
        ? { onVersionAssessment: input.onVersionAssessment }
        : {}),
    });
    return result as ClaudeRuntimeProbeResult;
  }

  createSession(options: ClaudeRuntimeSessionOptions): ClaudeRuntimeSession {
    this.#assertOpen();
    const queryId = randomUUID();
    const session = new WorkerSession(this, queryId, options);
    this.#sessions.set(queryId, session);
    return session;
  }

  async listSessions(
    options: Parameters<ClaudeRuntimeClient["listSessions"]>[0],
  ) {
    this.#assertOpen();
    await this.#initialize();
    const result = await this.#peer.call(
      claudeRuntimeSessionListOperation,
      options,
    );
    return result.sessions as SDKSessionInfo[];
  }

  async getSessionInfo(
    sessionId: string,
    options: Parameters<ClaudeRuntimeClient["getSessionInfo"]>[1],
  ) {
    this.#assertOpen();
    await this.#initialize();
    const result = await this.#peer.call(claudeRuntimeSessionInfoOperation, {
      sessionId,
      ...options,
    });
    return (result.session ?? undefined) as SDKSessionInfo | undefined;
  }

  async getSessionMessages(
    sessionId: string,
    options: Parameters<ClaudeRuntimeClient["getSessionMessages"]>[1],
  ) {
    this.#assertOpen();
    await this.#initialize();
    const result = await this.#peer.call(
      claudeRuntimeSessionMessagesOperation,
      {
        sessionId,
        ...options,
      },
    );
    return result.messages as SessionMessage[];
  }

  async renameSession(
    sessionId: string,
    title: string,
    options: { readonly dir: string },
  ): Promise<void> {
    this.#assertOpen();
    await this.#initialize();
    await this.#peer.call(claudeRuntimeSessionRenameOperation, {
      sessionId,
      title,
      dir: options.dir,
    });
  }

  close(error: unknown = new Error("claude_runtime_client_closed")): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    for (const session of this.#sessions.values())
      session.workerFailed(error, { peerAvailable: false });
    this.#sessions.clear();
  }

  call<Request, Response>(
    definition: SidecarOperationDefinition<Request, Response>,
    request: Request,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Response> {
    this.#assertOpen();
    return this.#peer.call(definition, request, options);
  }

  initialize(): Promise<void> {
    this.#assertOpen();
    return this.#initialize();
  }

  forget(queryId: string, session: WorkerSession): void {
    if (this.#sessions.get(queryId) === session) this.#sessions.delete(queryId);
  }

  fence(reason: string, error: unknown): void {
    void this.#peer.close(reason).catch(() => undefined);
    this.close(error);
  }

  #message(event: ClaudeRuntimeQueryMessageEvent): void {
    this.#sessions.get(event.queryId)?.message(event.message as SDKMessage);
  }

  #failed(event: ClaudeRuntimeQueryFailedEvent): void {
    this.#sessions.get(event.queryId)?.workerFailed(new Error(event.code), {
      remoteCleanupRequired: false,
    });
  }

  async #canUseTool(
    request: ClaudeRuntimeCanUseToolRequest,
    signal: AbortSignal,
  ): Promise<ClaudeRuntimeCanUseToolResponse> {
    const session = this.#sessions.get(request.queryId);
    if (!session) {
      return {
        behavior: "deny",
        message: "Claude query is no longer attached.",
        toolUseID: request.options.toolUseID,
        decisionClassification: "user_reject",
      };
    }
    const identity = {
      requestId: request.options.requestId,
      toolUseID: request.options.toolUseID,
    };
    try {
      const response = claudeRuntimeCanUseToolOperation.responseSchema.parse(
        await session.canUseTool(request, signal),
      ) as ClaudeRuntimeCanUseToolResponse;
      signal.throwIfAborted();
      session.expectPermissionResponseAck(identity);
      return response;
    } catch (error) {
      session.permissionResponseDeliveryFailed({ ...identity, error });
      throw error;
    }
  }

  async #acknowledgePermissionResponse(
    request: ClaudeRuntimePermissionResponseAckRequest,
  ): Promise<{ readonly acknowledged: true }> {
    const session = this.#sessions.get(request.queryId);
    if (!request.adopted) {
      await session?.rejectPermissionResponseAck({
        requestId: request.requestId,
        toolUseID: request.toolUseID,
      });
      return { acknowledged: true as const };
    }
    if (!session) {
      return { acknowledged: true as const };
    }
    await session.acknowledgePermissionResponse({
      requestId: request.requestId,
      toolUseID: request.toolUseID,
    });
    return { acknowledged: true as const };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("claude_runtime_client_closed");
  }

  #initialize(): Promise<void> {
    if (!this.#initializing) {
      let initializing!: Promise<void>;
      initializing = resolveEnvironmentVariables(this.#runtimeInitialization.startupEnvironmentVariables ?? {})
        .then(startupEnvironment => this.#peer.call(claudeRuntimeInitializeOperation, { ...this.#runtimeInitialization, startupEnvironment }, {
          signal: AbortSignal.timeout(
            this.#runtimeInitialization.initializationTimeoutMs,
          ),
        }))
        .then(() => undefined)
        .catch((error) => {
          if (this.#initializing === initializing)
            this.#initializing = undefined;
          throw error;
        });
      this.#initializing = initializing;
    }
    return this.#initializing;
  }
}

class WorkerSession implements ClaudeRuntimeSession {
  readonly #client: ClaudeRuntimeWorkerClient;
  readonly #queryId: string;
  readonly #options: ClaudeRuntimeSessionOptions;
  #closed = false;
  #initialization:
    Awaited<ReturnType<ClaudeRuntimeSession["start"]>> | undefined;
  #startupProbeUuid: string | undefined;
  #safeSkills: readonly ClaudeSafeSkill[] = [];
  #start:
    Promise<Awaited<ReturnType<ClaudeRuntimeSession["start"]>>> | undefined;
  #messageDelivery: Promise<void> = Promise.resolve();
  readonly #openController = new AbortController();
  #openAttempted = false;
  #peerAvailable = true;
  #remoteCleanupRequired = true;
  #remoteCleanup: Promise<void> | undefined;
  #closure: Promise<void> | undefined;
  #acceptingPermissionResponseAcks = true;
  readonly #permissionAckDrainWaiters = new Set<() => void>();
  readonly #pendingPermissionResponseAcks = new Map<
    string,
    {
      readonly toolUseID: string;
      acknowledging?: Promise<void>;
    }
  >();

  constructor(
    client: ClaudeRuntimeWorkerClient,
    queryId: string,
    options: ClaudeRuntimeSessionOptions,
  ) {
    this.#client = client;
    this.#queryId = queryId;
    this.#options = options;
  }

  get closed(): boolean {
    return this.#closed;
  }
  get initialization() {
    return this.#initialization;
  }
  get startupProbeUuid(): string | undefined {
    return this.#startupProbeUuid;
  }
  get safeSkills(): readonly ClaudeSafeSkill[] {
    return this.#safeSkills;
  }

  start() {
    if (this.#closed)
      return Promise.reject(new Error("claude_runtime_session_closed"));
    this.#start ??= this.#open();
    return this.#start;
  }

  async #open() {
    const options = this.#options;
    try {
      await this.#client.initialize();
      if (this.#closed) throw new Error("claude_runtime_session_closed");
      this.#openAttempted = true;
      const timeoutSignal = AbortSignal.timeout(
        options.initializationTimeoutMs,
      );
      const response = await this.#client.call(
        claudeRuntimeQueryOpenOperation,
        {
          queryId: this.#queryId,
          sessionId: options.sessionId,
          cwd: options.cwd,
          launch: options.launch,
          ...(options.launch === "fork"
            ? {
                sourceSessionId: options.sourceSessionId!,
                resumeSessionAt: options.resumeSessionAt!,
              }
            : {}),
          ...(options.title ? { title: options.title } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
          ...(options.permissionMode
            ? { permissionMode: options.permissionMode }
            : {}),
          ...(options.allowDangerouslySkipPermissions
            ? { allowDangerouslySkipPermissions: true as const }
            : {}),
          enableCanUseTool: options.canUseTool !== undefined,
          environment: definedEnvironment(options.environment),
          ...(options.executionEnvironment ? { executionEnvironment: options.executionEnvironment } : {}),
        } as never,
        {
          signal: AbortSignal.any([this.#openController.signal, timeoutSignal]),
        },
      );
      if (this.#closed) throw new Error("claude_runtime_session_closed");
      if (response.queryId !== this.#queryId) {
        throw new Error("claude_runtime_query_identity_mismatch");
      }
      verifyClaudeRuntimeVersion(response.initialization.cliRelease, {
        ...(options.onNewerVersion
          ? { onNewerVersion: options.onNewerVersion }
          : {}),
        ...(options.onVersionAssessment
          ? { onVersionAssessment: options.onVersionAssessment }
          : {}),
      });
      const initialization =
        response.initialization as ClaudeSdkSessionInitialization;
      this.#initialization = initialization;
      this.#startupProbeUuid = response.startupProbeUuid;
      this.#safeSkills = resolveClaudeSafeSkills(initialization);
      return initialization;
    } catch (error) {
      if (this.#openAttempted) {
        try {
          await this.#cleanupRemote();
        } catch (cleanupError) {
          this.#client.fence(
            "claude_runtime_query_open_cleanup_unconfirmed",
            cleanupError,
          );
        }
      }
      options.onVersionAssessmentFailed?.();
      this.workerFailed(error);
      throw error;
    }
  }

  async send(input: Parameters<ClaudeRuntimeSession["send"]>[0]): Promise<void> {
    this.#assertReady();
    await this.#client
      .call(claudeRuntimeQuerySendOperation, {
        queryId: this.#queryId,
        operationId: input.operationId,
        content: input.content as never,
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.shouldQuery !== undefined
          ? { shouldQuery: input.shouldQuery }
          : {}),
      })
      .catch((error) => { this.workerFailed(error); throw error; });
  }

  async interrupt() {
    this.#assertReady();
    return (
      (
        await this.#client.call(claudeRuntimeQueryInterruptOperation, {
          queryId: this.#queryId,
        })
      ).receipt ?? undefined
    );
  }

  async setModel(model?: string): Promise<void> {
    this.#assertReady();
    await this.#client.call(claudeRuntimeQuerySetModelOperation, {
      queryId: this.#queryId,
      model: model ?? null,
    });
  }

  async setEffort(
    effort?: Parameters<ClaudeRuntimeSession["setEffort"]>[0],
  ): Promise<void> {
    this.#assertReady();
    await this.#client.call(claudeRuntimeQuerySetEffortOperation, {
      queryId: this.#queryId,
      effort: effort ?? null,
    });
  }

  async setPermissionMode(permissionMode: PermissionMode): Promise<void> {
    this.#assertReady();
    await this.#client.call(claudeRuntimeQuerySetPermissionModeOperation, {
      queryId: this.#queryId,
      permissionMode,
    });
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#openController.abort(new Error("claude_runtime_session_closed"));
    }
    await this.#beginClosure("claude_runtime_query_close_cleanup_unconfirmed");
  }

  message(message: SDKMessage): void {
    if (this.#closed) return;
    if (message.type === "system" && message.subtype === "commands_changed") {
      this.#safeSkills = [];
    }
    this.#messageDelivery = this.#messageDelivery
      .then(async () => { await this.#options.onMessage(message); })
      .catch((error) => this.workerFailed(error));
  }

  workerFailed(
    error: unknown,
    disposition: {
      readonly peerAvailable?: boolean;
      readonly remoteCleanupRequired?: boolean;
    } = {},
  ): void {
    if (disposition.peerAvailable === false) this.#peerAvailable = false;
    if (disposition.remoteCleanupRequired === false) {
      this.#remoteCleanupRequired = false;
    }
    if (disposition.peerAvailable === false) {
      this.#acceptingPermissionResponseAcks = false;
      this.#failUnacknowledgedPermissionResponses(error);
    }
    if (this.#closed) {
      void this.#beginClosure(
        "claude_runtime_query_failure_cleanup_unconfirmed",
      );
      return;
    }
    const initialized = this.#initialization !== undefined;
    this.#closed = true;
    void this.#beginClosure("claude_runtime_query_failure_cleanup_unconfirmed");
    if (initialized) {
      void this.#messageDelivery
        .then(() => this.#options.onFailure?.(error))
        .catch(() => this.#options.onFailure?.(error));
    }
  }

  async canUseTool(
    request: ClaudeRuntimeCanUseToolRequest,
    signal: AbortSignal,
  ) {
    const canUseTool: CanUseTool | undefined = this.#options.canUseTool;
    if (!canUseTool || this.#closed) {
      return {
        behavior: "deny" as const,
        message: "Permission request unavailable.",
        toolUseID: request.options.toolUseID,
        decisionClassification: "user_reject",
      };
    }
    return await canUseTool(
      request.toolName,
      request.input as Record<string, unknown>,
      { ...request.options, signal } as Parameters<CanUseTool>[2],
    );
  }

  expectPermissionResponseAck(input: {
    readonly requestId: string;
    readonly toolUseID: string;
  }): void {
    if (!this.#acceptingPermissionResponseAcks) {
      throw new Error("claude_permission_response_ack_session_closing");
    }
    if (this.#pendingPermissionResponseAcks.has(input.requestId)) {
      throw new Error("claude_permission_response_ack_duplicate");
    }
    this.#pendingPermissionResponseAcks.set(input.requestId, {
      toolUseID: input.toolUseID,
    });
  }

  async acknowledgePermissionResponse(input: {
    readonly requestId: string;
    readonly toolUseID: string;
  }): Promise<void> {
    const pending = this.#pendingPermissionResponseAcks.get(input.requestId);
    if (!pending || pending.toolUseID !== input.toolUseID) {
      throw new Error("claude_permission_response_ack_unmatched");
    }
    pending.acknowledging ??= this.#commitPermissionResponseAck(input).finally(
      () => {
        if (
          this.#pendingPermissionResponseAcks.get(input.requestId) === pending
        ) {
          this.#pendingPermissionResponseAcks.delete(input.requestId);
          this.#notifyPermissionAcksDrained();
        }
      },
    );
    await pending.acknowledging;
  }

  async rejectPermissionResponseAck(input: {
    readonly requestId: string;
    readonly toolUseID: string;
  }): Promise<boolean> {
    const pending = this.#pendingPermissionResponseAcks.get(input.requestId);
    if (!pending) return false;
    if (pending.toolUseID !== input.toolUseID) {
      throw new Error("claude_permission_response_ack_unmatched");
    }
    if (pending.acknowledging) {
      throw new Error("claude_permission_response_ack_already_committing");
    }
    const error = new Error("claude_permission_response_not_adopted");
    await this.#options.onPermissionResponseDeliveryFailed?.({
      ...input,
      error,
    });
    this.#pendingPermissionResponseAcks.delete(input.requestId);
    this.#notifyPermissionAcksDrained();
    return true;
  }

  permissionResponseDeliveryFailed(input: {
    readonly requestId: string;
    readonly toolUseID: string;
    readonly error: unknown;
  }): void {
    try {
      void Promise.resolve(
        this.#options.onPermissionResponseDeliveryFailed?.(input),
      ).catch(() => undefined);
    } catch {
      // Delivery failure is already fail-closed; an observer cannot undo it.
    }
  }

  #assertReady(): void {
    if (this.#closed || !this.#initialization) {
      throw new Error("claude_runtime_session_not_ready");
    }
  }

  #cleanupRemote(): Promise<void> {
    this.#remoteCleanup ??= this.#client
      .call(claudeRuntimeQueryCloseOperation, { queryId: this.#queryId })
      .then(() => undefined);
    return this.#remoteCleanup;
  }

  #beginClosure(fenceReason: string): Promise<void> {
    return (this.#closure ??= Promise.resolve().then(
      async () => await this.#finishClosure(fenceReason),
    ));
  }

  async #finishClosure(fenceReason: string): Promise<void> {
    await this.#messageDelivery.catch(() => undefined);
    if (this.#peerAvailable) {
      if (!(await this.#drainPermissionResponseAcksOrFence())) {
        this.#client.forget(this.#queryId, this);
        return;
      }
    } else {
      this.#failUnacknowledgedPermissionResponses(
        new Error("claude_runtime_worker_closed"),
      );
    }
    try {
      if (
        this.#openAttempted &&
        this.#peerAvailable &&
        this.#remoteCleanupRequired
      ) {
        await this.#cleanupRemote();
      }
    } catch (error) {
      this.#acceptingPermissionResponseAcks = false;
      this.#failUnacknowledgedPermissionResponses(error);
      this.#client.fence(fenceReason, error);
      this.#client.forget(this.#queryId, this);
      return;
    }
    // A reverse permission response can win after the first empty drain while
    // query.close is crossing the carrier. Keep this session addressable until
    // remote cleanup has cancelled further reverse calls, then drain that race.
    this.#acceptingPermissionResponseAcks = false;
    if (
      this.#peerAvailable &&
      !(await this.#drainPermissionResponseAcksOrFence())
    ) {
      this.#client.forget(this.#queryId, this);
      return;
    }
    this.#client.forget(this.#queryId, this);
  }

  async #commitPermissionResponseAck(input: {
    readonly requestId: string;
    readonly toolUseID: string;
  }): Promise<void> {
    try {
      await this.#options.onPermissionResponseDelivered?.(input);
    } catch (error) {
      this.permissionResponseDeliveryFailed({ ...input, error });
      this.#client.fence("claude_runtime_permission_ack_commit_failed", error);
      throw error;
    }
  }

  async #drainPermissionResponseAcks(): Promise<boolean> {
    if (this.#pendingPermissionResponseAcks.size === 0) return true;
    let resolveDrain!: () => void;
    const drained = new Promise<void>((resolve) => {
      resolveDrain = resolve;
      this.#permissionAckDrainWaiters.add(resolve);
    });
    const timeout = new Promise<false>((resolve) => {
      const timer = setTimeout(
        () => resolve(false),
        CLAUDE_PERMISSION_RESPONSE_ACK_DRAIN_MILLISECONDS,
      );
      timer.unref?.();
      void drained.finally(() => clearTimeout(timer));
    });
    try {
      return await Promise.race([drained.then(() => true as const), timeout]);
    } finally {
      this.#permissionAckDrainWaiters.delete(resolveDrain);
    }
  }

  async #drainPermissionResponseAcksOrFence(): Promise<boolean> {
    if (await this.#drainPermissionResponseAcks()) return true;
    const error = new Error("claude_permission_response_ack_drain_timeout");
    this.#acceptingPermissionResponseAcks = false;
    this.#failUnacknowledgedPermissionResponses(error);
    this.#client.fence(
      "claude_runtime_permission_ack_cleanup_unconfirmed",
      error,
    );
    return false;
  }

  #notifyPermissionAcksDrained(): void {
    if (this.#pendingPermissionResponseAcks.size !== 0) return;
    for (const resolve of this.#permissionAckDrainWaiters) resolve();
    this.#permissionAckDrainWaiters.clear();
  }

  #failUnacknowledgedPermissionResponses(error: unknown): void {
    for (const [requestId, pending] of this.#pendingPermissionResponseAcks) {
      if (pending.acknowledging) continue;
      this.#pendingPermissionResponseAcks.delete(requestId);
      this.permissionResponseDeliveryFailed({
        requestId,
        toolUseID: pending.toolUseID,
        error,
      });
    }
    this.#notifyPermissionAcksDrained();
  }
}

function definedEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(input).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  );
}
