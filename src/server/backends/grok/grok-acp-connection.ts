import type {
  CancelNotification,
  CloseSessionRequest,
  CloseSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  AcpBinding,
  ACP_AGENT_NOTIFICATIONS,
  ACP_AGENT_REQUESTS,
  ACP_CLIENT_NOTIFICATIONS,
  ACP_CLIENT_REQUESTS,
  AcpRemoteError,
  defineAcpOutboundCapabilityCorrection,
  defineAcpInlineReverseNotificationHandler,
  defineAcpReverseNotificationHandler,
  defineAcpReverseRequestHandler,
  type AcpRequestDescriptor,
  type AcpRequestOptions,
  type AcpRequestSettlement,
  type AcpSettlementRequestOptions,
} from "../../provider-protocol/bindings/acp-v1/index.js";
import type {
  FramedMessageTransport,
  ProviderTransportScope,
} from "../../provider-protocol/transport/assured-framed-transport.js";
import {
  admitGrokAcpInitializeProfile,
  decodeGrokInitializeModelCatalog,
  GROK_ACP_DIALECT_PROFILE,
  GROK_CACHED_TOKEN_AUTH_METHOD_ID,
  GROK_XAI_NOTIFICATIONS,
  GROK_XAI_REQUESTS,
  GrokAuthenticationRequiredError,
  type GrokSessionRenameRequest,
  type GrokSessionRenameResponse,
  type GrokModelCatalog,
  type GrokSourceCandidateTurnCompletedNotification,
} from "./grok-acp-dialect.js";
import type { GrokSubagentEvent } from "./grok-subagent-reducer.js";
import {
  GrokNativeHistoryReader,
  type GrokNativeHistoryReadInput,
  type GrokNativeHistoryReadResult,
} from "./grok-native-history-reader.js";

export const GROK_ACP_IMAGE_INPUT_PATH_REGISTERED = true;

const GROK_STANDARD_IMAGE_PROMPT_CORRECTION =
  defineAcpOutboundCapabilityCorrection({
    profile: GROK_ACP_DIALECT_PROFILE,
    descriptor: ACP_AGENT_REQUESTS.prompt,
    admits: (request) =>
      request.prompt.some((content) => content.type === "image") &&
      request.prompt.every(
        (content) =>
          content.type === "text" ||
          content.type === "resource_link" ||
          content.type === "image",
      ),
  });

export interface GrokAcpNotificationSink {
  notificationDisposition(sessionId: string): "dispatch" | "ignore";
  authorizeSession(sessionId: string): boolean | Promise<boolean>;
  authorizeSessionInline?(sessionId: string): boolean;
  authorizePermissionSession(sessionId: string): boolean | Promise<boolean>;
  subagentEvent(event: GrokSubagentEvent): void | Promise<void>;
  sessionUpdate(notification: SessionNotification): void | Promise<void>;
  sessionUpdateInline?(notification: SessionNotification): void;
  liveTurnCompleted(
    notification: GrokSourceCandidateTurnCompletedNotification,
  ): void | Promise<void>;
  replaySessionUpdate(sessionId: string): void | Promise<void>;
  permissionRequested(
    request: RequestPermissionRequest,
  ): RequestPermissionResponse | Promise<RequestPermissionResponse>;
}

/** One assured ACP connection generation. Session ownership lives above it. */
export class GrokAcpConnection {
  readonly #binding: AcpBinding;
  readonly #nativeHistory: GrokNativeHistoryReader;
  readonly modelCatalog: GrokModelCatalog;

  private constructor(
    binding: AcpBinding,
    modelCatalog: GrokModelCatalog,
    nativeHistory: GrokNativeHistoryReader,
  ) {
    this.#binding = binding;
    this.#nativeHistory = nativeHistory;
    this.modelCatalog = modelCatalog;
  }

  static async open(input: {
    readonly transport: FramedMessageTransport;
    readonly expectedScope: ProviderTransportScope;
    readonly connectionGeneration: number;
    readonly sink: GrokAcpNotificationSink;
    readonly inlineSessionUpdates?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<GrokAcpConnection> {
    const authorize = async (sessionId: string) =>
      await input.sink.authorizeSession(sessionId);
    const disposition = (params: unknown): "dispatch" | "ignore" => {
      const sessionId = notificationSessionId(params);
      return sessionId === undefined
        ? "dispatch"
        : input.sink.notificationDisposition(sessionId);
    };
    const multiplexedDisposition = (params: unknown): "dispatch" | "ignore" => {
      const owned = disposition(params);
      if (owned === "ignore") return "ignore";
      const updateKind = multiplexedSessionUpdateKind(params);
      if (updateKind === undefined) return "dispatch";
      return updateKind === "turn_completed" ||
        updateKind === "subagent_spawned" ||
        updateKind === "subagent_progress" ||
        updateKind === "subagent_finished"
        ? "dispatch"
        : "ignore";
    };
    if (
      input.inlineSessionUpdates &&
      (!input.sink.sessionUpdateInline || !input.sink.authorizeSessionInline)
    ) {
      throw new Error("grok_inline_session_update_sink_missing");
    }
    const sessionUpdateHandler = input.inlineSessionUpdates
      ? defineAcpInlineReverseNotificationHandler({
          descriptor: ACP_CLIENT_NOTIFICATIONS.sessionUpdate,
          disposition,
          authorize: (notification) =>
            input.sink.authorizeSessionInline!(notification.sessionId),
          handle: (notification) =>
            input.sink.sessionUpdateInline!(notification),
        })
      : defineAcpReverseNotificationHandler({
          descriptor: ACP_CLIENT_NOTIFICATIONS.sessionUpdate,
          disposition,
          authorize: (notification) => authorize(notification.sessionId),
          handle: async (notification) =>
            await input.sink.sessionUpdate(notification),
        });
    let binding: AcpBinding | undefined;
    const nativeHistory = new GrokNativeHistoryReader({
      request: async (request, options) => {
        if (!binding) throw new Error("grok_connection_not_open");
        return await binding.requestWithSettlement(
          GROK_XAI_REQUESTS.sessionUpdates,
          request,
          {
            ...options,
            notificationCutover: {
              kind: "ordering_key",
              orderingKey: request.sessionId,
            },
          },
        );
      },
      onAbandonedDrainTimeout: () => {
        void binding
          ?.close("grok_native_history_abandoned_drain_timeout")
          .catch(() => undefined);
      },
    });
    binding = new AcpBinding({
      transport: input.transport,
      expectedScope: input.expectedScope,
      expectedConnectionGeneration: input.connectionGeneration,
      profiles: [GROK_ACP_DIALECT_PROFILE],
      outboundCapabilityCorrections: [GROK_STANDARD_IMAGE_PROMPT_CORRECTION],
      extensions: [
        GROK_XAI_REQUESTS.renameSession,
        GROK_XAI_REQUESTS.sessionUpdates,
        GROK_XAI_NOTIFICATIONS.liveSessionNotification,
        GROK_XAI_NOTIFICATIONS.replaySessionUpdate,
        GROK_XAI_NOTIFICATIONS.sessionUpdatesChunk,
      ],
      reverseHandlers: [
        sessionUpdateHandler,
        defineAcpInlineReverseNotificationHandler({
          descriptor: GROK_XAI_NOTIFICATIONS.sessionUpdatesChunk,
          disposition: () => (nativeHistory.acquiring ? "dispatch" : "ignore"),
          authorize: () => true,
          handle: (notification) => nativeHistory.acceptChunk(notification),
        }),
        defineAcpReverseNotificationHandler({
          descriptor: GROK_XAI_NOTIFICATIONS.replaySessionUpdate,
          disposition,
          authorize: (notification) => authorize(notification.sessionId),
          handle: async (notification) =>
            await input.sink.replaySessionUpdate(notification.sessionId),
        }),
        defineAcpReverseNotificationHandler({
          descriptor: GROK_XAI_NOTIFICATIONS.liveSessionNotification,
          disposition: multiplexedDisposition,
          authorize: (notification) => authorize(notification.sessionId),
          handle: async (notification) => {
            if (notification.kind === "turn_completed") {
              await input.sink.liveTurnCompleted(notification.notification);
            } else if (notification.kind === "subagent") {
              await input.sink.subagentEvent(notification.event);
            }
          },
        }),
        defineAcpReverseRequestHandler({
          descriptor: ACP_CLIENT_REQUESTS.requestPermission,
          authorize: (request) =>
            input.sink.authorizePermissionSession(request.sessionId),
          handle: async (request) =>
            await input.sink.permissionRequested(request),
        }),
      ],
    });
    try {
      const response = await binding.initialize(
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "sedes", version: "1" },
        },
        {
          ...(input.signal ? { cancellationSignal: input.signal } : {}),
          deadlineMilliseconds: 30_000,
        },
      );
      admitGrokAcpInitializeProfile(response);
      const modelCatalog = decodeGrokInitializeModelCatalog(response);
      try {
        await binding.request(
          ACP_AGENT_REQUESTS.authenticate,
          { methodId: GROK_CACHED_TOKEN_AUTH_METHOD_ID },
          {
            ...(input.signal ? { cancellationSignal: input.signal } : {}),
            deadlineMilliseconds: 30_000,
          },
        );
      } catch (error) {
        if (error instanceof AcpRemoteError && error.remoteCode === -32_000) {
          throw new GrokAuthenticationRequiredError();
        }
        throw error;
      }
      return new GrokAcpConnection(binding, modelCatalog, nativeHistory);
    } catch (error) {
      await binding.close("grok_initialize_failed");
      throw error;
    }
  }

  get closed() {
    return this.#binding.closed;
  }

  diagnostics() {
    return this.#binding.diagnostics();
  }

  listSessions(
    request: ListSessionsRequest,
    options?: AcpRequestOptions,
  ): Promise<ListSessionsResponse> {
    return this.#request(ACP_AGENT_REQUESTS.listSessions, request, options);
  }

  newSessionWithSettlement(
    request: NewSessionRequest,
    options?: AcpRequestOptions,
  ): Promise<AcpRequestSettlement<NewSessionResponse>> {
    return this.#requestWithSettlement(ACP_AGENT_REQUESTS.newSession, request, {
      ...options,
      notificationCutover: { kind: "all" },
    });
  }

  loadSessionWithSettlement(
    request: LoadSessionRequest,
    options?: AcpRequestOptions,
  ): Promise<AcpRequestSettlement<LoadSessionResponse>> {
    return this.#requestWithSettlement(
      ACP_AGENT_REQUESTS.loadSession,
      request,
      {
        ...options,
        notificationCutover: {
          kind: "ordering_key",
          orderingKey: request.sessionId,
        },
      },
    );
  }

  resumeSessionWithSettlement(
    request: ResumeSessionRequest,
    options?: AcpRequestOptions,
  ): Promise<AcpRequestSettlement<ResumeSessionResponse>> {
    return this.#requestWithSettlement(
      ACP_AGENT_REQUESTS.resumeSession,
      request,
      {
        ...options,
        notificationCutover: {
          kind: "ordering_key",
          orderingKey: request.sessionId,
        },
      },
    );
  }

  closeSessionWithSettlement(
    request: CloseSessionRequest,
    options?: AcpRequestOptions,
  ): Promise<AcpRequestSettlement<CloseSessionResponse>> {
    return this.#requestWithSettlement(
      ACP_AGENT_REQUESTS.closeSession,
      request,
      {
        ...options,
        notificationCutover: {
          kind: "ordering_key",
          orderingKey: request.sessionId,
        },
      },
    );
  }

  promptWithSettlement(
    request: PromptRequest,
    options?: AcpRequestOptions,
  ): Promise<AcpRequestSettlement<PromptResponse>> {
    return this.#requestWithSettlement(ACP_AGENT_REQUESTS.prompt, request, {
      ...options,
      notificationCutover: {
        kind: "ordering_key",
        orderingKey: request.sessionId,
      },
    });
  }

  cancelSession(request: CancelNotification): Promise<void> {
    return this.#binding.notify(ACP_AGENT_NOTIFICATIONS.cancelSession, request);
  }

  renameSession(
    request: GrokSessionRenameRequest,
    options?: AcpRequestOptions,
  ): Promise<GrokSessionRenameResponse> {
    return this.#request(GROK_XAI_REQUESTS.renameSession, request, options);
  }

  readNativeHistory(
    input: GrokNativeHistoryReadInput,
  ): Promise<GrokNativeHistoryReadResult> {
    return this.#nativeHistory.read(input);
  }

  async completeSettlement<Response, Result>(
    settlement: AcpRequestSettlement<Response>,
    handlers: {
      readonly success: (response: Response) => Result;
      readonly remoteError?: (error: AcpRemoteError) => void;
    },
  ): Promise<Result> {
    return await settlement.commitNotificationCutover(() => {
      if (settlement.kind === "success") {
        return handlers.success(settlement.response);
      }
      handlers.remoteError?.(settlement.error);
      if (settlement.error.remoteCode === -32_000) {
        throw new GrokAuthenticationRequiredError();
      }
      throw settlement.error;
    });
  }

  async close(reason = "grok_connection_close"): Promise<void> {
    await this.#binding.close(reason);
  }

  async #request<Request, Response>(
    descriptor: AcpRequestDescriptor<Request, Response>,
    request: Request,
    options?: AcpRequestOptions,
  ): Promise<Response> {
    try {
      return await this.#binding.request(descriptor, request, options);
    } catch (error) {
      if (error instanceof AcpRemoteError && error.remoteCode === -32_000) {
        throw new GrokAuthenticationRequiredError();
      }
      throw error;
    }
  }

  async #requestWithSettlement<Request, Response>(
    descriptor: AcpRequestDescriptor<Request, Response>,
    request: Request,
    options: AcpSettlementRequestOptions,
  ): Promise<AcpRequestSettlement<Response>> {
    return await this.#binding.requestWithSettlement(
      descriptor,
      request,
      options,
    );
  }
}

function notificationSessionId(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const sessionId = (params as { readonly sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" &&
    sessionId.length > 0 &&
    Buffer.byteLength(sessionId, "utf8") <= 1_024 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(sessionId)
    ? sessionId
    : undefined;
}

function multiplexedSessionUpdateKind(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const update = (params as { readonly update?: unknown }).update;
  if (typeof update !== "object" || update === null || Array.isArray(update)) {
    return undefined;
  }
  const updateKind = (update as { readonly sessionUpdate?: unknown })
    .sessionUpdate;
  return typeof updateKind === "string" &&
    updateKind.length > 0 &&
    Buffer.byteLength(updateKind, "utf8") <= 1_024 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(updateKind)
    ? updateKind
    : undefined;
}
