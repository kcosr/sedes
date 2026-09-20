import type {
  ListSessionsResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionInfo,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { randomBytes } from "node:crypto";
import type {
  FramedMessageTransport,
  ProviderTransportScope,
} from "../../provider-protocol/transport/assured-framed-transport.js";
import {
  AcpBindingError,
  AcpDeliveryError,
  AcpRemoteError,
} from "../../provider-protocol/bindings/acp-v1/index.js";
import { GrokAcpConnection } from "./grok-acp-connection.js";
import {
  decodeGrokEffectiveSessionConfiguration,
  GrokAuthenticationRequiredError,
  type GrokEffectiveSessionConfiguration,
  type GrokModelCatalog,
  type GrokSourceCandidateTurnCompletedNotification,
} from "./grok-acp-dialect.js";
import type { GrokSubagentEvent } from "./grok-subagent-reducer.js";
import {
  decodeGrokNativeHistoryCursor,
  GrokNativeHistoryProjectionError,
  latestGrokNativeHistoryCursorsByPromptId,
  previousGrokNativeHistoryCursor,
  projectGrokNativeHistory,
  validateGrokNativeHistoryBoundary,
  validateGrokNativeHistoryFrontier,
  validateGrokNativeHistoryPage,
} from "./grok-native-history-projection.js";
import {
  GrokNativeHistoryReadError,
  type GrokNativeHistoryReadResult,
} from "./grok-native-history-reader.js";
import {
  GrokHistoryProjector,
  type GrokHistoryProjectionResult,
  type GrokHistoryRecord,
} from "./grok-history-projector.js";
import {
  type GrokDeliveryDiagnostic,
  writeGrokDeliveryDiagnostic,
} from "./grok-delivery-diagnostics.js";
import {
  GrokSessionRegistry,
  type GrokProvisionalLoadClaim,
  type GrokSessionRoute,
  type GrokSessionState,
} from "./grok-session-registry.js";

const MAXIMUM_LISTED_SESSIONS = 1_000;
const MAXIMUM_LIST_PAGES = 32;
const MAXIMUM_LIST_BYTES = 4 * 1_024 * 1_024;
const MAXIMUM_CURSOR_BYTES = 4_096;
const GROK_NATIVE_HISTORY_RETAINED_TURNS = 10;
const GROK_NATIVE_HISTORY_ACQUISITION_TURNS = 11;
const MAXIMUM_NATIVE_HISTORY_PAGE_TURNS = 100;
export const GROK_PROMPT_POST_TERMINAL_SETTLEMENT_DEADLINE_MILLISECONDS = 10_000;

export interface GrokSessionLifecycleOwner {
  readonly scope: ProviderTransportScope;
  readonly nativeNamespaceKey: string;
  readonly workspace: string;
  readonly connectionGeneration: number;
  readonly processOwnerId: string;
}

export interface GrokListedSession {
  readonly nativeNamespaceKey: string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly title?: string;
  readonly updatedAt?: string;
}

export interface GrokLifecycleSessionResult {
  readonly state: GrokSessionState;
  readonly history: readonly GrokHistoryRecord[];
  readonly configuration: GrokEffectiveSessionConfiguration;
}

export interface GrokLifecycleHistoryPage {
  readonly records: readonly GrokHistoryRecord[];
  readonly previousCursor?: string;
  readonly previousCursorByPromptId?: Readonly<Record<string, string>>;
  readonly evictedPromptCount: number;
}

interface ActiveHistoryRoute {
  readonly route: GrokSessionRoute;
  readonly projector: GrokHistoryProjector;
  readonly configuration: {
    value?: GrokEffectiveSessionConfiguration;
  };
  readonly history: {
    readonly epoch: string;
    previousCursor?: string;
    previousCursorByPromptId: Readonly<Record<string, string>>;
    current: boolean;
  };
  readonly publication: { suppressed: boolean };
}

interface CreateLatch {
  observedSessionId?: string;
  mismatch: boolean;
}

interface ActivePageAcquisition {
  readonly sessionId: string;
  readonly cancellation: AbortController;
  readonly completed: Promise<void>;
}

type GrokLifecycleMutation =
  | "list"
  | "new"
  | "load"
  | "resume"
  | "close"
  | "prompt"
  | "recover_interrupted";

interface ActivePrompt {
  readonly sessionId: string;
  readonly promptId: string;
  readonly content: PromptRequest["prompt"];
  readonly expectedText: string;
  readonly cancellation: AbortController;
  readonly acceptance: Deferred<GrokPromptAcceptance>;
  userEchoOffset: number;
  userEchoContradicted: boolean;
  assistantOutputObserved: boolean;
  userRunClosed: boolean;
  promptTrafficAdmitted: boolean;
  readonly correlatedToolCallIds: Set<string>;
  liveTerminal?: GrokSourceCandidateTurnCompletedNotification;
  violation?: string;
  outcomeUnknownReason?: string;
  interrupt?: Promise<void>;
  interruptAccepted?: boolean;
  completion?: Promise<GrokPromptResult>;
  failureClose?: Promise<void>;
  postTerminalSettlementTimer?: ReturnType<typeof setTimeout>;
}

interface CorrelatedPromptUpdate {
  readonly notification: SessionNotification;
  readonly affectsActivePrompt: boolean;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
}

export interface GrokPromptAcceptance {
  readonly state: GrokSessionState;
  readonly promptId: string;
  readonly history: readonly GrokHistoryRecord[];
}

export interface GrokPromptResult {
  readonly state: GrokSessionState;
  readonly promptId: string;
  readonly response: PromptResponse;
  readonly history: readonly GrokHistoryRecord[];
}

export interface GrokPromptOperation {
  readonly promptId: string;
  readonly accepted: Promise<GrokPromptAcceptance>;
  readonly completed: Promise<GrokPromptResult>;
}

export class GrokPromptOutcomeUnknownError extends Error {
  readonly code = "grok_prompt_outcome_unknown";

  constructor(cause: unknown) {
    super("grok_prompt_outcome_unknown", { cause });
    this.name = "GrokPromptOutcomeUnknownError";
  }
}

/** Provider-private lifecycle for one production-owned Grok ACP generation. */
export class GrokSessionLifecycle {
  readonly #owner: GrokSessionLifecycleOwner;
  readonly #registry: GrokSessionRegistry;
  readonly #active = new Map<string, ActiveHistoryRoute>();
  readonly #publish?: (record: GrokHistoryRecord) => void | Promise<void>;
  readonly #publishAuthoritative?: () => void | Promise<void>;
  readonly #inlineSessionUpdates: boolean;
  readonly #promptPostTerminalSettlementDeadlineMilliseconds: number;
  #connection: GrokAcpConnection | undefined;
  #createLatch: CreateLatch | undefined;
  #pageAcquisition: ActivePageAcquisition | undefined;
  #activePrompt: ActivePrompt | undefined;
  #mutationInFlight: GrokLifecycleMutation | undefined;
  #titleOperationInFlight = false;
  #publishTail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(input: {
    readonly owner: GrokSessionLifecycleOwner;
    readonly registry: GrokSessionRegistry;
    readonly publish?: (record: GrokHistoryRecord) => void | Promise<void>;
    readonly publishAuthoritative?: () => void | Promise<void>;
    readonly inlineSessionUpdates: boolean;
    readonly promptPostTerminalSettlementDeadlineMilliseconds: number;
  }) {
    this.#owner = Object.freeze({
      ...input.owner,
      scope: Object.freeze({ ...input.owner.scope }),
    });
    this.#registry = input.registry;
    this.#publish = input.publish;
    this.#publishAuthoritative = input.publishAuthoritative;
    this.#inlineSessionUpdates = input.inlineSessionUpdates;
    this.#promptPostTerminalSettlementDeadlineMilliseconds =
      input.promptPostTerminalSettlementDeadlineMilliseconds;
  }

  get modelCatalog(): GrokModelCatalog {
    return this.connection.modelCatalog;
  }

  static async open(input: {
    readonly transport: FramedMessageTransport;
    readonly owner: GrokSessionLifecycleOwner;
    readonly registry?: GrokSessionRegistry;
    readonly publish?: (record: GrokHistoryRecord) => void | Promise<void>;
    readonly publishAuthoritative?: () => void | Promise<void>;
    readonly inlineSessionUpdates?: boolean;
    readonly promptPostTerminalSettlementDeadlineMilliseconds?: number;
    readonly signal?: AbortSignal;
  }): Promise<GrokSessionLifecycle> {
    const promptPostTerminalSettlementDeadlineMilliseconds =
      input.promptPostTerminalSettlementDeadlineMilliseconds ??
      GROK_PROMPT_POST_TERMINAL_SETTLEMENT_DEADLINE_MILLISECONDS;
    if (
      !Number.isSafeInteger(promptPostTerminalSettlementDeadlineMilliseconds) ||
      promptPostTerminalSettlementDeadlineMilliseconds <= 0
    ) {
      throw new Error("grok_prompt_settlement_deadline_invalid");
    }
    const lifecycle = new GrokSessionLifecycle({
      owner: input.owner,
      registry: input.registry ?? new GrokSessionRegistry(),
      ...(input.publish ? { publish: input.publish } : {}),
      ...(input.publishAuthoritative
        ? { publishAuthoritative: input.publishAuthoritative }
        : {}),
      inlineSessionUpdates: input.inlineSessionUpdates === true,
      promptPostTerminalSettlementDeadlineMilliseconds,
    });
    const connection = await GrokAcpConnection.open({
      transport: input.transport,
      expectedScope: input.owner.scope,
      connectionGeneration: input.owner.connectionGeneration,
      sink: {
        notificationDisposition: (sessionId) =>
          lifecycle.#notificationDisposition(sessionId),
        authorizeSession: (sessionId) =>
          lifecycle.#authorizeNotificationSession(sessionId),
        authorizeSessionInline: (sessionId) =>
          lifecycle.#authorizeNotificationSession(sessionId),
        authorizePermissionSession: (sessionId) =>
          lifecycle.#authorizePermissionSession(sessionId),
        subagentEvent: async (event) => await lifecycle.#subagentEvent(event),
        sessionUpdate: async (notification) =>
          await lifecycle.#sessionUpdate(notification),
        sessionUpdateInline: (notification) =>
          lifecycle.#sessionUpdateInline(notification),
        liveTurnCompleted: async (notification) =>
          await lifecycle.#turnCompleted(notification, false),
        replaySessionUpdate: (sessionId) =>
          lifecycle.#rejectOwnedReplaySessionUpdate(sessionId),
        permissionRequested: (request) =>
          lifecycle.#permissionRequested(request),
      },
      inlineSessionUpdates: input.inlineSessionUpdates === true,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    lifecycle.#connection = connection;
    return lifecycle;
  }

  get connection(): GrokAcpConnection {
    if (!this.#connection) throw new Error("grok_lifecycle_not_open");
    return this.#connection;
  }

  get closed(): boolean {
    return this.#closed || this.connection.diagnostics().closed;
  }

  async listSessions(input?: {
    readonly signal?: AbortSignal;
  }): Promise<readonly GrokListedSession[]> {
    this.#beginMutation("list");
    try {
      return await this.#scanSessions(input?.signal);
    } finally {
      this.#endMutation("list");
    }
  }

  async newSession(input: {
    readonly configuration: GrokEffectiveSessionConfiguration;
    readonly signal?: AbortSignal;
  }): Promise<GrokLifecycleSessionResult> {
    if (this.#active.size !== 0) {
      throw new Error("grok_process_session_cardinality_exceeded");
    }
    this.#beginMutation("new");
    let createClaim: ReturnType<GrokSessionRegistry["beginCreate"]> | undefined;
    const latch: CreateLatch = { mismatch: false };
    this.#createLatch = latch;
    let providerCreated = false;
    let reservationSettled = false;
    try {
      createClaim = this.#registry.beginCreate(this.#owner);
      const settlement = await this.connection.newSessionWithSettlement(
        {
          cwd: this.#owner.workspace,
          mcpServers: [],
          _meta: {
            modelId: input.configuration.modelId,
            ...(input.configuration.reasoningEffort
              ? { reasoningEffort: input.configuration.reasoningEffort }
              : {}),
          },
        },
        requestOptions(input.signal),
      );
      const created = await this.connection.completeSettlement(settlement, {
        success: (response) => {
          providerCreated = true;
          try {
            const effectiveConfiguration =
              decodeGrokEffectiveSessionConfiguration(response);
            assertSameSessionConfiguration(
              effectiveConfiguration,
              input.configuration,
            );
            const claim = this.#registry.confirmCreate(
              createClaim!,
              response.sessionId,
            );
            reservationSettled = true;
            const route: GrokSessionRoute = claim;
            if (
              latch.mismatch ||
              (latch.observedSessionId !== undefined &&
                latch.observedSessionId !== response.sessionId)
            ) {
              throw new Error("grok_session_create_notification_mismatch");
            }
            const active = this.#installProvisional(route);
            active.configuration.value = effectiveConfiguration;
            try {
              requireProjection(active.projector.sealReplay());
              active.publication.suppressed = false;
              const state = this.#registry.confirmLoad(claim);
              return Object.freeze({
                state,
                history: active.projector.records(),
                configuration: effectiveConfiguration,
              });
            } catch (error) {
              this.#active.delete(route.sessionId);
              this.#registry.failLoad(claim);
              throw error;
            }
          } finally {
            if (this.#createLatch === latch) this.#createLatch = undefined;
          }
        },
        remoteError: () => {
          this.#registry.cancelCreate(createClaim!);
          reservationSettled = true;
          if (this.#createLatch === latch) this.#createLatch = undefined;
        },
      });
      let active = this.#active.get(created.state.sessionId);
      if (active) {
        try {
          active = await this.#refreshCreatedHistory(active, input.signal);
        } catch (error) {
          // Creation is already confirmed and the empty resident projector is
          // authoritative enough to remain usable. Native history refresh is
          // a request-local best effort. Carrier/lifecycle failures still
          // propagate because that resident could not remain usable.
          if (!(error instanceof GrokNativeHistoryReadError)) {
            throw error;
          }
        }
      }
      return Object.freeze({
        ...created,
        history: active?.projector.records() ?? created.history,
      });
    } catch (error) {
      if (
        createClaim &&
        !reservationSettled &&
        safeToReleaseCreateReservation(error)
      ) {
        this.#registry.cancelCreate(createClaim);
        reservationSettled = true;
      }
      if (providerCreated || uncertainLifecycleOutcome(error)) {
        this.#fenceGeneration();
      }
      if (providerCreated) {
        await this.connection.close("grok_session_create_commit_failed");
      }
      throw error;
    } finally {
      if (this.#createLatch === latch) this.#createLatch = undefined;
      this.#endMutation("new");
    }
  }

  async loadSession(
    sessionId: string,
    input?: { readonly signal?: AbortSignal },
  ): Promise<GrokLifecycleSessionResult> {
    const route = this.#route(sessionId);
    this.#beginMutation("load");
    try {
      const claim = this.#registry.beginLoad(route);
      let nativeHistory: GrokNativeHistoryReadResult;
      try {
        nativeHistory = await this.#readLatestNativeHistory(
          sessionId,
          input?.signal,
        );
      } catch (error) {
        this.#registry.failLoad(claim);
        throw error;
      }
      const active = this.#installNativeProvisional(route, nativeHistory);
      let providerSucceeded = false;
      let finalized = false;
      try {
        const settlement = await this.connection.loadSessionWithSettlement(
          {
            sessionId,
            cwd: this.#owner.workspace,
            mcpServers: [],
            _meta: { noReplay: true },
          },
          requestOptions(input?.signal),
        );
        return await this.connection.completeSettlement(settlement, {
          success: (response) => {
            providerSucceeded = true;
            const effectiveConfiguration =
              decodeGrokEffectiveSessionConfiguration(response);
            active.configuration.value = effectiveConfiguration;
            active.publication.suppressed = false;
            const state = this.#registry.confirmLoad(claim);
            finalized = true;
            return Object.freeze({
              state,
              history: active.projector.records(),
              configuration: effectiveConfiguration,
            });
          },
          remoteError: (error) => {
            this.#discardProvisional(route, claim, active, error);
            finalized = true;
          },
        });
      } catch (error) {
        if (!finalized) {
          if (providerSucceeded) this.#fenceGeneration();
          else this.#discardProvisional(route, claim, active, error);
        }
        throw error;
      }
    } finally {
      this.#endMutation("load");
    }
  }

  async resumeSession(
    sessionId: string,
    input?: { readonly signal?: AbortSignal },
  ): Promise<GrokSessionState> {
    const route = this.#route(sessionId);
    const resident = this.#registry.requireResident(route);
    const prior = this.#active.get(sessionId);
    if (!prior || !sameRoute(prior.route, route)) {
      throw new Error("grok_session_owner_mismatch");
    }
    if (this.#pageAcquisition) {
      throw new GrokNativeHistoryReadError("grok_native_history_busy");
    }
    this.#beginMutation("resume");
    let fresh: ActiveHistoryRoute | undefined;
    let providerSucceeded = false;
    let providerRequested = false;
    let finalized = false;
    try {
      const nativeHistory = await this.#readLatestNativeHistory(
        sessionId,
        input?.signal,
      );
      fresh = this.#nativeActive(route, nativeHistory);
      fresh.configuration.value = prior.configuration.value;
      this.#active.set(sessionId, fresh);
      providerRequested = true;
      const settlement = await this.connection.resumeSessionWithSettlement(
        { sessionId, cwd: this.#owner.workspace, mcpServers: [] },
        requestOptions(input?.signal),
      );
      await this.connection.completeSettlement(settlement, {
        success: (response) => {
          providerSucceeded = true;
          const effectiveConfiguration =
            decodeGrokEffectiveSessionConfiguration(response);
          if (!fresh!.configuration.value) {
            throw new Error("grok_session_configuration_missing");
          }
          assertSameSessionConfiguration(
            effectiveConfiguration,
            fresh!.configuration.value,
          );
          fresh!.publication.suppressed = false;
          finalized = true;
          return resident;
        },
        remoteError: () => {
          this.#active.set(sessionId, prior);
          finalized = true;
        },
      });
      if (this.#active.get(sessionId) !== fresh) {
        throw new Error("grok_session_owner_mismatch");
      }
      await this.#publishAuthoritative?.();
      return this.#registry.requireResident(route);
    } catch (error) {
      if (!finalized && !providerSucceeded && fresh) {
        this.#active.set(sessionId, prior);
      }
      if (
        providerRequested &&
        (providerSucceeded || uncertainLifecycleOutcome(error))
      ) {
        this.#fenceGeneration();
      }
      throw error;
    } finally {
      this.#endMutation("resume");
    }
  }

  async closeSession(
    sessionId: string,
    input?: { readonly signal?: AbortSignal },
  ): Promise<GrokSessionState> {
    const route = this.#route(sessionId);
    this.#registry.requireResident(route);
    if (this.#pageAcquisition) {
      throw new GrokNativeHistoryReadError("grok_native_history_busy");
    }
    this.#beginMutation("close");
    try {
      const settlement = await this.connection.closeSessionWithSettlement(
        { sessionId },
        requestOptions(input?.signal),
      );
      return await this.connection.completeSettlement(settlement, {
        success: () => {
          const dormant = this.#registry.markSessionDormant(route);
          this.#active.delete(sessionId);
          return dormant;
        },
      });
    } catch (error) {
      if (uncertainLifecycleOutcome(error)) this.#fenceGeneration();
      throw error;
    } finally {
      this.#endMutation("close");
    }
  }

  async renameSession(
    sessionId: string,
    title: string,
    input?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    const route = this.#route(sessionId);
    this.#registry.requireResident(route);
    this.#beginTitleOperation();
    try {
      await this.connection.renameSession(
        {
          sessionId,
          title,
          cwd: this.#owner.workspace,
          kind: "build",
          resetToAuto: false,
        },
        requestOptions(input?.signal),
      );
    } finally {
      this.#endTitleOperation();
    }
  }

  async sessionInfo(
    sessionId: string,
    input?: { readonly signal?: AbortSignal },
  ): Promise<GrokListedSession | undefined> {
    const route = this.#route(sessionId);
    this.#registry.requireResident(route);
    this.#beginTitleOperation();
    try {
      return (await this.#scanSessions(input?.signal)).find(
        (session) => session.sessionId === sessionId,
      );
    } finally {
      this.#endTitleOperation();
    }
  }

  startPrompt(
    sessionId: string,
    promptId: string,
    content: PromptRequest["prompt"],
    input?: { readonly signal?: AbortSignal },
  ): GrokPromptOperation {
    if (!boundedIdentifier(promptId)) throw new Error("grok_prompt_id_invalid");
    const promptContent = canonicalPromptContent(content);
    const expectedText = promptContent
      .filter(
        (
          block,
        ): block is Extract<(typeof promptContent)[number], { type: "text" }> =>
          block.type === "text",
      )
      .map(({ text }) => text)
      .join(" ");
    const route = this.#route(sessionId);
    const resident = this.#registry.requireResident(route);
    let active = this.#active.get(sessionId);
    if (!active || !sameRoute(active.route, route)) {
      throw new Error("grok_session_owner_mismatch");
    }
    const pageDrain = this.#abortPageForPrompt(sessionId);
    this.#beginMutation("prompt");
    active.history.current = false;
    const prompt: ActivePrompt = {
      sessionId,
      promptId,
      content: promptContent,
      expectedText,
      cancellation: new AbortController(),
      acceptance: deferred<GrokPromptAcceptance>(),
      userEchoOffset: 0,
      userEchoContradicted: false,
      assistantOutputObserved: false,
      userRunClosed: false,
      promptTrafficAdmitted: false,
      correlatedToolCallIds: new Set(),
    };
    this.#activePrompt = prompt;
    const completed = this.#completePrompt(
      prompt,
      resident,
      active,
      input,
      pageDrain,
    );
    prompt.completion = completed;
    // A caller may consume acceptance before it installs its durable
    // completion observer. Keep the owned continuation rejection handled
    // without changing the rejected promise returned to that observer.
    void completed.catch(() => undefined);
    return Object.freeze({
      promptId,
      accepted: prompt.acceptance.promise,
      completed,
    });
  }

  activePromptId(sessionId: string): string | undefined {
    if (this.#closed || !boundedIdentifier(sessionId)) return undefined;
    const prompt = this.#activePrompt;
    if (!prompt || prompt.sessionId !== sessionId) return undefined;
    let active = this.#active.get(sessionId);
    return active && this.#registry.authorizeNotification(active.route)
      ? prompt.promptId
      : undefined;
  }

  /**
   * Installs a local interrupted boundary for an abandoned Sedes prompt.
   * The caller must first authenticate prompt ownership against the exact
   * durable binding scope. Keeping that authority check in the driver avoids
   * teaching the protocol projector about installation secrets.
   */
  async recoverInterruptedSedesPrompt(
    sessionId: string,
    promptId: string,
  ): Promise<readonly GrokHistoryRecord[]> {
    if (!boundedIdentifier(sessionId) || !boundedIdentifier(promptId)) {
      throw new Error("grok_interrupted_recovery_target_invalid");
    }
    if (this.#activePrompt !== undefined) {
      throw new Error("grok_interrupted_recovery_active_prompt");
    }
    const route = this.#route(sessionId);
    this.#registry.requireResident(route);
    let active = this.#active.get(sessionId);
    if (!active || !sameRoute(active.route, route)) {
      throw new Error("grok_session_owner_mismatch");
    }
    this.#beginMutation("recover_interrupted");
    try {
      // Recheck after acquiring the lifecycle mutation authority so this can
      // never terminate a prompt that became active concurrently.
      if (this.#activePrompt !== undefined) {
        throw new Error("grok_interrupted_recovery_active_prompt");
      }
      const result = active.projector.appendLocallyInterruptedPrompt(promptId);
      requireProjection(result);
      await this.#enqueuePublish(projectionRecords(result));
      return active.projector.records();
    } finally {
      this.#endMutation("recover_interrupted");
    }
  }

  async interruptPrompt(sessionId: string, promptId: string): Promise<void> {
    if (
      this.#closed ||
      !boundedIdentifier(sessionId) ||
      !boundedIdentifier(promptId)
    ) {
      throw new Error("grok_prompt_interrupt_target_invalid");
    }
    const prompt = this.#activePrompt;
    const active = this.#active.get(sessionId);
    if (
      !prompt ||
      prompt.sessionId !== sessionId ||
      prompt.promptId !== promptId ||
      !active ||
      !this.#registry.authorizeNotification(active.route)
    ) {
      throw new Error("grok_prompt_interrupt_target_changed");
    }
    if (prompt.interruptAccepted) return;
    if (prompt.interrupt) return await prompt.interrupt;
    const interrupt = this.connection.cancelSession({ sessionId });
    prompt.interrupt = interrupt;
    try {
      await interrupt;
      prompt.interruptAccepted = true;
    } catch (error) {
      if (prompt.interrupt === interrupt) prompt.interrupt = undefined;
      throw error;
    }
  }

  async #completePrompt(
    prompt: ActivePrompt,
    resident: GrokSessionState,
    active: ActiveHistoryRoute,
    input: { readonly signal?: AbortSignal } | undefined,
    pageDrain?: Promise<void>,
  ): Promise<GrokPromptResult> {
    try {
      await pageDrain;
      const settlement = await this.connection.promptWithSettlement(
        {
          sessionId: prompt.sessionId,
          prompt: prompt.content,
          _meta: { promptId: prompt.promptId },
        },
        requestOptions(
          input?.signal
            ? AbortSignal.any([input.signal, prompt.cancellation.signal])
            : prompt.cancellation.signal,
          // Grok resolves session/prompt only when the turn finishes. A
          // wall-clock request timeout is therefore a turn-duration limit,
          // not a transport health check. The ACP binding still bounds the
          // outbound frame write and owns cancellation/transport closure.
          null,
        ),
      );
      const response = await this.connection.completeSettlement(settlement, {
        success: (value) => {
          validatePromptCompletion(prompt, value);
          return value;
        },
      });
      if (this.#active.get(prompt.sessionId) !== active) {
        throw new Error("grok_session_owner_mismatch");
      }
      return Object.freeze({
        state: resident,
        promptId: prompt.promptId,
        response,
        history: active.projector.records(),
      });
    } catch (error) {
      const definiteNonAcceptance = definitePromptNonAcceptance(error, prompt);
      const failure = prompt.violation
        ? new Error(prompt.violation)
        : prompt.outcomeUnknownReason ||
            (prompt.promptTrafficAdmitted &&
              (error instanceof AcpRemoteError ||
                error instanceof GrokAuthenticationRequiredError))
          ? new GrokPromptOutcomeUnknownError(error)
          : error;
      const diagnostics = this.connection.diagnostics();
      writeGrokDeliveryDiagnostic({
        phase: "prompt_failure",
        generation: this.#owner.connectionGeneration,
        outcome:
          prompt.violation ??
          prompt.outcomeUnknownReason ??
          (error instanceof AcpBindingError ? error.code : "internal_error"),
        closeReason: diagnostics.closeReason ?? "open",
        invalidEnvelopeRootType: diagnostics.invalidEnvelopeRootType ?? "none",
        invalidEnvelopeShape: diagnostics.invalidEnvelopeShape ?? "none",
        invalidEnvelopeUnknownKeys: diagnostics.invalidEnvelopeUnknownKeys ?? 0,
        invalidEnvelopeMethod: diagnostics.invalidEnvelopeMethod ?? "none",
        invalidEnvelopeBounds: diagnostics.invalidEnvelopeBounds ?? "none",
        protocolFailures: diagnostics.protocolFailures,
        handlerFailures: diagnostics.handlerFailures,
      });
      rejectDeferred(prompt.acceptance, failure);
      if (!definiteNonAcceptance) {
        try {
          await this.#fencePrompt(prompt, "grok_prompt_failed");
        } catch {
          // The prompt failure remains the operation result. Connection close
          // diagnostics retain cleanup failure without creating a rejection
          // that nobody owns.
        }
      }
      throw failure;
    } finally {
      if (prompt.postTerminalSettlementTimer !== undefined) {
        clearTimeout(prompt.postTerminalSettlementTimer);
        prompt.postTerminalSettlementTimer = undefined;
      }
      if (this.#activePrompt === prompt) this.#activePrompt = undefined;
      this.#endMutation("prompt");
    }
  }

  history(sessionId: string): readonly GrokHistoryRecord[] {
    const route = this.#route(sessionId);
    this.#registry.requireResident(route);
    const active = this.#active.get(sessionId);
    if (!active || !sameRoute(active.route, route)) {
      throw new Error("grok_session_owner_mismatch");
    }
    return active.projector.records();
  }

  retainedHistoryPage(sessionId: string): GrokLifecycleHistoryPage {
    const route = this.#route(sessionId);
    this.#registry.requireResident(route);
    const active = this.#active.get(sessionId);
    if (!active || !sameRoute(active.route, route)) {
      throw new Error("grok_session_owner_mismatch");
    }
    return Object.freeze({
      records: active.projector.records(),
      evictedPromptCount: active.projector.diagnostics().evictedPromptCount,
      ...(active.history.previousCursor
        ? { previousCursor: active.history.previousCursor }
        : {}),
      previousCursorByPromptId: active.history.previousCursorByPromptId,
    });
  }

  async historyPage(
    sessionId: string,
    input: {
      readonly cursor?: string;
      readonly limit: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<GrokLifecycleHistoryPage> {
    const route = this.#route(sessionId);
    this.#registry.requireResident(route);
    let active = this.#active.get(sessionId);
    if (!active || !sameRoute(active.route, route)) {
      throw new Error("grok_session_owner_mismatch");
    }
    const cursor = input.cursor;
    if (cursor === undefined) {
      if (
        !active.history.current &&
        !this.#mutationInFlight &&
        !this.#activePrompt &&
        !this.#pageAcquisition
      ) {
        const cancellation = new AbortController();
        const signal = input.signal
          ? AbortSignal.any([input.signal, cancellation.signal])
          : cancellation.signal;
        const operation = this.#refreshResidentHistory(active, signal);
        const completed = operation.then(
          () => undefined,
          () => undefined,
        );
        const acquisition: ActivePageAcquisition = {
          sessionId,
          cancellation,
          completed,
        };
        this.#pageAcquisition = acquisition;
        try {
          active = await operation;
        } catch (error) {
          if (!requestLocalNativeHistoryFailure(error)) throw error;
        } finally {
          if (this.#pageAcquisition === acquisition) {
            this.#pageAcquisition = undefined;
          }
        }
      }
      return Object.freeze({
        records: active.projector.records(),
        evictedPromptCount: active.projector.diagnostics().evictedPromptCount,
        ...(active.history.previousCursor
          ? { previousCursor: active.history.previousCursor }
          : {}),
        previousCursorByPromptId: active.history.previousCursorByPromptId,
      });
    }
    if (this.#mutationInFlight || this.#activePrompt || this.#pageAcquisition) {
      throw new GrokNativeHistoryReadError("grok_native_history_busy");
    }
    const cancellation = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, cancellation.signal])
      : cancellation.signal;
    const operation = this.#readOlderHistoryPage(
      active,
      { cursor, limit: input.limit },
      signal,
    );
    const completed = operation.then(
      () => undefined,
      () => undefined,
    );
    const acquisition: ActivePageAcquisition = {
      sessionId,
      cancellation,
      completed,
    };
    this.#pageAcquisition = acquisition;
    try {
      return await operation;
    } finally {
      if (this.#pageAcquisition === acquisition) {
        this.#pageAcquisition = undefined;
      }
    }
  }

  async close(reason = "grok_lifecycle_close"): Promise<void> {
    this.#closed = true;
    const prompt = this.#activePrompt;
    const page = this.#pageAcquisition;
    page?.cancellation.abort(new Error("grok_session_lifecycle_closed"));
    prompt?.cancellation.abort(new Error("grok_session_lifecycle_closed"));
    let closeFailure: unknown;
    try {
      await this.connection.close(reason);
    } catch (error) {
      closeFailure = error;
    } finally {
      if (prompt?.completion) {
        await prompt.completion.catch(() => undefined);
      }
      await page?.completed;
      this.#fenceGeneration();
      this.#registry.releaseProcessOwner(this.#owner);
    }
    if (closeFailure !== undefined) throw closeFailure;
  }

  #authorizeNotificationSession(sessionId: string): boolean {
    return (
      !this.#closed &&
      boundedIdentifier(sessionId) &&
      this.#notificationDisposition(sessionId) === "dispatch"
    );
  }

  #notificationDisposition(sessionId: string): "dispatch" | "ignore" {
    if (!boundedIdentifier(sessionId)) return "dispatch";
    if (this.#active.has(sessionId)) return "dispatch";
    // Grok assigns a new native session id. Until the correlated new-session
    // response arrives, retain only native-id evidence and recover payloads
    // from the provider-owned journal after the reservation releases.
    if (this.#createLatch) return "dispatch";
    // Owned Grok processes may emit child-session token traffic. Sedes does
    // not expose those children, so structurally valid frames have no semantic
    // consumer and must not enter the asynchronous parent notification queue.
    return "ignore";
  }

  #rejectOwnedReplaySessionUpdate(sessionId: string): never {
    const active = this.#active.get(sessionId);
    if (!active || !this.#registry.authorizeNotification(active.route)) {
      throw new Error("grok_session_replay_authority_invalid");
    }
    throw new Error("grok_session_replay_after_no_replay");
  }

  #authorizePermissionSession(sessionId: string): boolean {
    const prompt = this.#activePrompt;
    if (!prompt || sessionId !== prompt.sessionId) return false;
    const active = this.#active.get(sessionId);
    return (
      active !== undefined && this.#registry.authorizeNotification(active.route)
    );
  }

  #sessionUpdate(notification: SessionNotification): Promise<void> {
    const result = this.#processSessionUpdate(notification, false);
    return result ?? Promise.resolve();
  }

  #sessionUpdateInline(notification: SessionNotification): void {
    if (!this.#inlineSessionUpdates) {
      throw new Error("grok_inline_session_update_not_enabled");
    }
    const result = this.#processSessionUpdate(notification, true);
    if (result !== undefined) {
      throw new Error("grok_inline_session_update_became_async");
    }
  }

  #processSessionUpdate(
    notification: SessionNotification,
    inline: boolean,
  ): void | Promise<void> {
    const active = this.#active.get(notification.sessionId);
    if (active) {
      if (
        (this.#mutationInFlight === "load" ||
          this.#mutationInFlight === "resume") &&
        notification._meta?.isReplay === true
      ) {
        throw new Error("grok_session_replay_after_no_replay");
      }
      if (this.#activePrompt?.violation) return;
      const updateKind = notification.update.sessionUpdate;
      const correlated = this.#correlatePromptUpdate(notification);
      if (!correlated) return;
      const { notification: correlatedNotification, affectsActivePrompt } =
        correlated;
      const prompt = this.#activePrompt;
      const promptDependent = isPromptDependentUpdate(correlatedNotification);
      if (
        promptDependent &&
        affectsActivePrompt &&
        prompt?.sessionId === notification.sessionId
      ) {
        prompt.promptTrafficAdmitted = true;
      }
      const ingestStartedAt = Date.now();
      const result = active.projector.ingestStandard(correlatedNotification);
      const records = projectionRecords(result);
      writeGrokDeliveryDiagnostic({
        phase: "history_ingest",
        update: updateKind,
        outcome: result.kind,
        records: records.length,
        characters: projectedCharacterCount(records),
        milliseconds: Date.now() - ingestStartedAt,
      });
      if (result.kind === "resnapshot_required") {
        if (
          correlatedNotification.update.sessionUpdate === "tool_call" ||
          correlatedNotification.update.sessionUpdate === "tool_call_update"
        ) {
          writeGrokDeliveryDiagnostic(
            toolProjectionDiagnostic(correlatedNotification),
          );
        }
        if (
          promptDependent &&
          affectsActivePrompt &&
          prompt?.sessionId === notification.sessionId
        ) {
          this.#failPromptOutcomeUnknown(
            prompt,
            `grok_prompt_history_${result.reason}`,
          );
        } else {
          this.#registry.markSessionLost(active.route);
          this.#active.delete(notification.sessionId);
        }
        return;
      }
      if (
        records.length > 0 &&
        this.#publish &&
        !active.publication.suppressed
      ) {
        const publishStartedAt = Date.now();
        const published = () => {
          writeGrokDeliveryDiagnostic({
            phase: "history_publish",
            update: updateKind,
            outcome: "published",
            records: records.length,
            characters: projectedCharacterCount(records),
            milliseconds: Date.now() - publishStartedAt,
          });
          if (closesPromptUserRun(correlatedNotification)) {
            this.#acceptPromptUserRun(this.#activePrompt, active);
          }
        };
        if (inline) {
          this.#publishInline(records);
          published();
          return;
        }
        return this.#enqueuePublish(records).then(published);
      }
      if (closesPromptUserRun(correlatedNotification)) {
        this.#acceptPromptUserRun(this.#activePrompt, active);
      }
      return;
    }
    const latch = this.#createLatch;
    if (latch) {
      this.#observeCreateSessionId(latch, notification.sessionId);
      return;
    }
    writeGrokDeliveryDiagnostic({
      phase: "history_ingest",
      update: notification.update.sessionUpdate,
      outcome: "unowned_session_ignored",
      records: 0,
      characters: 0,
      milliseconds: 0,
    });
  }

  async #subagentEvent(event: GrokSubagentEvent): Promise<void> {
    const active = this.#active.get(event.sessionId);
    if (!active) {
      if (this.#createLatch) {
        this.#observeCreateSessionId(this.#createLatch, event.sessionId);
      }
      return;
    }
    const activePrompt =
      !event.replay && this.#activePrompt?.sessionId === event.sessionId
        ? this.#activePrompt
        : undefined;
    const prompt =
      !event.replay && event.kind === "spawned" ? activePrompt : undefined;
    if (
      !event.replay &&
      event.kind === "spawned" &&
      (!prompt ||
        prompt.sessionId !== event.sessionId ||
        event.parentPromptId !== prompt.promptId)
    ) {
      return;
    }
    if (prompt) prompt.promptTrafficAdmitted = true;
    const ingestStartedAt = Date.now();
    const result = active.projector.ingestSubagentEvent(event);
    const records = projectionRecords(result);
    writeGrokDeliveryDiagnostic({
      phase: "history_ingest",
      update: `subagent_${event.kind}`,
      outcome: result.kind,
      records: records.length,
      characters: projectedCharacterCount(records),
      milliseconds: Date.now() - ingestStartedAt,
    });
    if (result.kind === "resnapshot_required") {
      if (activePrompt && this.#activePrompt === activePrompt) {
        this.#failPromptOutcomeUnknown(
          activePrompt,
          `grok_prompt_history_${result.reason}`,
        );
      } else {
        this.#registry.markSessionLost(active.route);
        this.#active.delete(event.sessionId);
      }
      return;
    }
    if (records.length > 0 && this.#publish && !active.publication.suppressed) {
      await this.#enqueuePublish(records);
    }
    if (prompt) this.#acceptPromptUserRun(prompt, active);
  }

  async #turnCompleted(
    notification: GrokSourceCandidateTurnCompletedNotification,
    replay: boolean,
  ): Promise<void> {
    if ((notification._meta.isReplay === true) !== replay) {
      throw new Error("grok_turn_completed_replay_mismatch");
    }
    const active = this.#active.get(notification.sessionId);
    if (!active) {
      if (this.#createLatch) {
        this.#observeCreateSessionId(this.#createLatch, notification.sessionId);
      }
      return;
    }
    const prompt = replay ? undefined : this.#activePrompt;
    if (!replay) {
      if (!prompt || prompt.sessionId !== notification.sessionId) {
        this.#registry.markSessionLost(active.route);
        this.#active.delete(notification.sessionId);
        return;
      }
      if (prompt.violation) return;
      if (notification.update.prompt_id !== prompt.promptId) {
        this.#violatePrompt(
          prompt,
          "grok_prompt_completion_correlation_mismatch",
        );
        return;
      }
      if (prompt.liveTerminal) {
        this.#violatePrompt(prompt, "grok_prompt_terminal_duplicate");
        return;
      }
      if (!promptUserEchoComplete(prompt)) {
        this.#violatePrompt(prompt, "grok_prompt_user_echo_mismatch");
        return;
      }
      prompt.liveTerminal = notification;
      prompt.promptTrafficAdmitted = true;
    }
    const ingestStartedAt = Date.now();
    const result =
      active.projector.ingestSourceCandidateTurnCompleted(notification);
    const records = projectionRecords(result);
    writeGrokDeliveryDiagnostic({
      phase: "history_ingest",
      update: "turn_completed",
      outcome: result.kind,
      records: records.length,
      characters: projectedCharacterCount(records),
      milliseconds: Date.now() - ingestStartedAt,
    });
    if (result.kind === "resnapshot_required") {
      if (prompt && this.#activePrompt === prompt) {
        this.#failPromptOutcomeUnknown(
          prompt,
          `grok_prompt_history_${result.reason}`,
        );
      } else {
        this.#registry.markSessionLost(active.route);
        this.#active.delete(notification.sessionId);
      }
      return;
    }
    if (!replay) this.#armPromptSettlementDeadline(prompt);
    if (records.length > 0 && this.#publish && !active.publication.suppressed) {
      const publishStartedAt = Date.now();
      await this.#enqueuePublish(records);
      writeGrokDeliveryDiagnostic({
        phase: "history_publish",
        update: "turn_completed",
        outcome: "published",
        records: records.length,
        characters: projectedCharacterCount(records),
        milliseconds: Date.now() - publishStartedAt,
      });
    }
    if (!replay) this.#acceptPromptUserRun(this.#activePrompt, active);
  }

  #permissionRequested(
    request: RequestPermissionRequest,
  ): RequestPermissionResponse {
    const prompt = this.#activePrompt;
    const active = this.#active.get(request.sessionId);
    if (
      !prompt ||
      prompt.sessionId !== request.sessionId ||
      !active ||
      !sameRoute(active.route, this.#route(request.sessionId)) ||
      !this.#authorizePermissionSession(request.sessionId)
    ) {
      throw new Error("grok_prompt_permission_route_invalid");
    }
    prompt.promptTrafficAdmitted = true;

    // Interim production disposition: the configured Grok launch is explicitly
    // unrestricted, while permission presentation is not advertised yet.
    // Select a one-shot allow option internally if Grok still asks. Persistent
    // allow is used only when the provider offers no one-shot allow choice.
    const option =
      request.options.find(({ kind }) => kind === "allow_once") ??
      request.options.find(({ kind }) => kind === "allow_always");
    if (!option) {
      this.#violatePrompt(prompt, "grok_prompt_permission_allow_unavailable");
      return { outcome: { outcome: "cancelled" } };
    }
    return {
      outcome: { outcome: "selected", optionId: option.optionId },
    };
  }

  #correlatePromptUpdate(
    notification: SessionNotification,
  ): CorrelatedPromptUpdate | undefined {
    const prompt = this.#activePrompt;
    if (!prompt || prompt.sessionId !== notification.sessionId) {
      return { notification, affectsActivePrompt: false };
    }
    const kind = notification.update.sessionUpdate;
    const toolUpdate = kind === "tool_call" || kind === "tool_call_update";
    if (
      kind !== "user_message_chunk" &&
      kind !== "agent_message_chunk" &&
      kind !== "agent_thought_chunk" &&
      kind !== "plan" &&
      !toolUpdate
    ) {
      return { notification, affectsActivePrompt: false };
    }
    if (kind === "user_message_chunk" && prompt.userRunClosed) {
      this.#violatePrompt(prompt, "grok_prompt_user_echo_after_acceptance");
      return undefined;
    }
    const metadataPromptId = isRecord(notification._meta)
      ? notification._meta.promptId
      : undefined;
    if (
      kind === "plan" &&
      (notification._meta === undefined || notification._meta === null)
    ) {
      return { notification, affectsActivePrompt: false };
    }
    if (toolUpdate) {
      const active = this.#active.get(notification.sessionId);
      const correlation = active?.projector.toolPromptCorrelation(
        notification.update.sessionUpdate === "tool_call" ||
          notification.update.sessionUpdate === "tool_call_update"
          ? notification.update.toolCallId
          : "",
        typeof metadataPromptId === "string" ? metadataPromptId : undefined,
        prompt.promptId,
      );
      if (correlation?.kind === "retained_background") {
        return { notification, affectsActivePrompt: false };
      }
    }
    const promptIdMismatch =
      kind === "user_message_chunk"
        ? metadataPromptId !== undefined && metadataPromptId !== prompt.promptId
        : toolUpdate
          ? metadataPromptId !== undefined &&
            metadataPromptId !== prompt.promptId
          : metadataPromptId !== prompt.promptId;
    if (promptIdMismatch) {
      writeGrokDeliveryDiagnostic({
        phase: "prompt_correlation",
        update: kind,
        metadata: metadataPromptId === undefined ? "absent" : "mismatch",
      });
      this.#violatePrompt(prompt, "grok_prompt_event_correlation_mismatch");
      return undefined;
    }
    if (kind !== "user_message_chunk" && !promptUserEchoComplete(prompt)) {
      this.#violatePrompt(prompt, "grok_prompt_user_echo_mismatch");
      return undefined;
    }
    if (
      notification.update.sessionUpdate === "tool_call" ||
      notification.update.sessionUpdate === "tool_call_update"
    ) {
      const toolCallId = notification.update.toolCallId;
      if (metadataPromptId !== undefined) {
        prompt.correlatedToolCallIds.add(toolCallId);
        return { notification, affectsActivePrompt: true };
      }
      if (
        kind !== "tool_call_update" ||
        !prompt.correlatedToolCallIds.has(toolCallId)
      ) {
        writeGrokDeliveryDiagnostic({
          phase: "prompt_correlation",
          update: kind,
          metadata: "absent",
        });
        this.#violatePrompt(prompt, "grok_prompt_event_correlation_mismatch");
        return undefined;
      }
      return {
        notification: Object.freeze({
          ...notification,
          _meta: Object.freeze({
            ...(isRecord(notification._meta) ? notification._meta : {}),
            promptId: prompt.promptId,
          }),
        }),
        affectsActivePrompt: true,
      };
    }
    if (
      notification.update.sessionUpdate !== "user_message_chunk" &&
      notification.update.sessionUpdate !== "agent_message_chunk" &&
      notification.update.sessionUpdate !== "agent_thought_chunk"
    ) {
      return { notification, affectsActivePrompt: true };
    }
    if (notification.update.content.type !== "text") {
      return { notification, affectsActivePrompt: true };
    }
    if (kind === "user_message_chunk") {
      const text = notification.update.content.text;
      if (prompt.userEchoContradicted) {
        return { notification, affectsActivePrompt: true };
      }
      const end = prompt.userEchoOffset + text.length;
      if (prompt.expectedText.slice(prompt.userEchoOffset, end) !== text) {
        prompt.userEchoContradicted = true;
        return { notification, affectsActivePrompt: true };
      }
      prompt.userEchoOffset = end;
    } else if (
      kind === "agent_message_chunk" &&
      notification.update.content.text.length > 0
    ) {
      prompt.assistantOutputObserved = true;
    }
    return { notification, affectsActivePrompt: true };
  }

  #violatePrompt(
    prompt: ActivePrompt,
    reason: string,
    afterReverseResponse = false,
  ): void {
    prompt.violation ??= reason;
    rejectDeferred(prompt.acceptance, new Error(prompt.violation));
    const terminate = () => {
      prompt.cancellation.abort(new Error(prompt.violation));
      if (this.#activePrompt !== prompt) return;
      void this.#fencePrompt(prompt, "grok_prompt_violation").catch(
        () => undefined,
      );
    };
    if (afterReverseResponse) setImmediate(terminate);
    else queueMicrotask(terminate);
  }

  #failPromptOutcomeUnknown(prompt: ActivePrompt, reason: string): void {
    prompt.outcomeUnknownReason ??= reason;
    const failure = new GrokPromptOutcomeUnknownError(new Error(reason));
    rejectDeferred(prompt.acceptance, failure);
    prompt.cancellation.abort(failure);
    if (this.#activePrompt !== prompt) return;
    void this.#fencePrompt(prompt, "grok_prompt_outcome_unknown").catch(
      () => undefined,
    );
  }

  #armPromptSettlementDeadline(prompt: ActivePrompt | undefined): void {
    if (!prompt || prompt.postTerminalSettlementTimer !== undefined) return;
    prompt.postTerminalSettlementTimer = setTimeout(() => {
      prompt.postTerminalSettlementTimer = undefined;
      if (this.#activePrompt !== prompt) return;
      this.#failPromptOutcomeUnknown(
        prompt,
        "grok_prompt_post_terminal_settlement_timeout",
      );
    }, this.#promptPostTerminalSettlementDeadlineMilliseconds);
  }

  #acceptPromptUserRun(
    prompt: ActivePrompt | undefined,
    active: ActiveHistoryRoute,
  ): void {
    if (
      !prompt ||
      prompt.userRunClosed ||
      prompt.sessionId !== active.route.sessionId ||
      prompt.violation
    ) {
      return;
    }
    prompt.userRunClosed = true;
    if (!promptUserEchoComplete(prompt)) {
      this.#violatePrompt(prompt, "grok_prompt_user_echo_mismatch");
      return;
    }
    if (this.#active.get(prompt.sessionId) !== active) {
      this.#violatePrompt(
        prompt,
        "grok_prompt_completion_correlation_mismatch",
      );
      return;
    }
    resolveDeferred(
      prompt.acceptance,
      Object.freeze({
        state: this.#registry.requireResident(active.route),
        promptId: prompt.promptId,
        history: active.projector.records(),
      }),
    );
  }

  #fencePrompt(prompt: ActivePrompt, reason: string): Promise<void> {
    if (prompt.failureClose) return prompt.failureClose;
    this.#fenceGeneration();
    const closing = this.connection.close(reason).finally(() => {
      this.#registry.releaseProcessOwner(this.#owner);
    });
    prompt.failureClose = closing;
    return closing;
  }

  #route(sessionId: string): GrokSessionRoute {
    if (!boundedIdentifier(sessionId)) {
      throw new Error("grok_session_route_invalid");
    }
    return Object.freeze({ ...this.#owner, sessionId });
  }

  #installProvisional(route: GrokSessionRoute): ActiveHistoryRoute {
    if (this.#active.has(route.sessionId)) {
      throw new Error("grok_session_active_owner_exists");
    }
    const active = Object.freeze({
      route,
      projector: new GrokHistoryProjector({
        nativeNamespaceKey: route.nativeNamespaceKey,
        sessionId: route.sessionId,
      }),
      configuration: {},
      history: {
        epoch: nativeHistoryEpoch(),
        previousCursorByPromptId: Object.freeze({}),
        current: true,
      },
      publication: { suppressed: true },
    });
    this.#active.set(route.sessionId, active);
    return active;
  }

  #installNativeProvisional(
    route: GrokSessionRoute,
    history: GrokNativeHistoryReadResult,
  ): ActiveHistoryRoute {
    if (this.#active.has(route.sessionId)) {
      throw new Error("grok_session_active_owner_exists");
    }
    const active = this.#nativeActive(route, history);
    this.#active.set(route.sessionId, active);
    return active;
  }

  #nativeActive(
    route: GrokSessionRoute,
    history: GrokNativeHistoryReadResult,
    epoch = nativeHistoryEpoch(),
  ): ActiveHistoryRoute {
    const projector = projectGrokNativeHistory(history, {
      nativeNamespaceKey: route.nativeNamespaceKey,
      sessionId: route.sessionId,
      retainedCompletedPromptWindow: GROK_NATIVE_HISTORY_RETAINED_TURNS,
    });
    const previousCursorByPromptId = latestGrokNativeHistoryCursorsByPromptId(
      history,
      epoch,
    );
    const oldestPromptId = projector
      .records()
      .find((record) => record.identity.promptId !== undefined)
      ?.identity.promptId;
    const previousCursor = oldestPromptId
      ? previousCursorByPromptId[oldestPromptId]
      : undefined;
    return Object.freeze({
      route,
      projector,
      configuration: {},
      history: {
        epoch,
        ...(previousCursor ? { previousCursor } : {}),
        previousCursorByPromptId,
        current: true,
      },
      publication: { suppressed: true },
    });
  }

  async #readLatestNativeHistory(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<GrokNativeHistoryReadResult> {
    if (this.#activePrompt) {
      throw new GrokNativeHistoryReadError("grok_native_history_busy");
    }
    return await this.connection.readNativeHistory({
      sessionId,
      cwd: this.#owner.workspace,
      turnIndex: GROK_NATIVE_HISTORY_ACQUISITION_TURNS,
      ...(signal ? { signal } : {}),
    });
  }

  async #refreshCreatedHistory(
    active: ActiveHistoryRoute,
    signal?: AbortSignal,
  ): Promise<ActiveHistoryRoute> {
    return await this.#refreshResidentHistory(active, signal);
  }

  async #refreshResidentHistory(
    active: ActiveHistoryRoute,
    signal?: AbortSignal,
  ): Promise<ActiveHistoryRoute> {
    const history = await this.#readLatestNativeHistory(
      active.route.sessionId,
      signal,
    );
    const fresh = this.#nativeActive(
      active.route,
      history,
      active.history.epoch,
    );
    fresh.configuration.value = active.configuration.value;
    fresh.publication.suppressed = false;
    if (this.#active.get(active.route.sessionId) === active) {
      this.#active.set(active.route.sessionId, fresh);
    }
    return fresh;
  }

  async #readOlderHistoryPage(
    active: ActiveHistoryRoute,
    input: { readonly cursor: string; readonly limit: number },
    signal: AbortSignal,
  ): Promise<GrokLifecycleHistoryPage> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAXIMUM_NATIVE_HISTORY_PAGE_TURNS
    ) {
      throw new GrokNativeHistoryProjectionError(
        "grok_native_history_cursor_invalid",
      );
    }
    const cursor = decodeGrokNativeHistoryCursor(
      input.cursor,
      active.history.epoch,
    );
    const overlap = await this.connection.readNativeHistory({
      sessionId: active.route.sessionId,
      cwd: this.#owner.workspace,
      offset: cursor.beforeOffset,
      limit: 1,
      signal,
    });
    const priorStarts = validateGrokNativeHistoryBoundary(overlap, cursor);
    if (priorStarts.length === 0) {
      throw new GrokNativeHistoryProjectionError(
        "grok_native_history_cursor_invalid",
      );
    }
    const startOffset =
      priorStarts[Math.max(0, priorStarts.length - input.limit)]!;
    const history = await this.connection.readNativeHistory({
      sessionId: active.route.sessionId,
      cwd: this.#owner.workspace,
      offset: startOffset,
      limit: cursor.beforeOffset - startOffset,
      signal,
    });
    validateGrokNativeHistoryPage(history, {
      startOffset,
      endOffset: cursor.beforeOffset,
      expectedPrefixHash: cursor.promptStartsPrefixHash,
    });
    const projector = projectGrokNativeHistory(history, {
      nativeNamespaceKey: active.route.nativeNamespaceKey,
      sessionId: active.route.sessionId,
      retainedCompletedPromptWindow: input.limit,
    });
    const previousCursor = previousGrokNativeHistoryCursor(history, {
      epoch: active.history.epoch,
      startOffset,
      issuedFrontierOffset: cursor.issuedFrontierOffset,
      issuedFrontierDigest: cursor.issuedFrontierDigest,
    });
    const previousCursorByPromptId = latestGrokNativeHistoryCursorsByPromptId(
      history,
      active.history.epoch,
      {
        offset: cursor.issuedFrontierOffset,
        digest: cursor.issuedFrontierDigest,
      },
      startOffset,
    );
    const frontier = await this.connection.readNativeHistory({
      sessionId: active.route.sessionId,
      cwd: this.#owner.workspace,
      offset: cursor.issuedFrontierOffset,
      limit: 1,
      signal,
    });
    validateGrokNativeHistoryFrontier(frontier, cursor);
    return Object.freeze({
      records: projector.records(),
      evictedPromptCount: projector.diagnostics().evictedPromptCount,
      ...(previousCursor ? { previousCursor } : {}),
      previousCursorByPromptId,
    });
  }

  #abortPageForPrompt(sessionId: string): Promise<void> | undefined {
    const acquisition = this.#pageAcquisition;
    if (!acquisition || acquisition.sessionId !== sessionId) return undefined;
    acquisition.cancellation.abort(
      new GrokNativeHistoryReadError("grok_native_history_aborted"),
    );
    return acquisition.completed;
  }

  #observeCreateSessionId(latch: CreateLatch, sessionId: string): void {
    if (
      latch.observedSessionId !== undefined &&
      latch.observedSessionId !== sessionId
    ) {
      latch.mismatch = true;
    } else {
      latch.observedSessionId = sessionId;
    }
  }

  #discardProvisional(
    route: GrokSessionRoute,
    claim: GrokProvisionalLoadClaim,
    active: ActiveHistoryRoute,
    error: unknown,
  ): void {
    if (this.#active.get(route.sessionId) === active) {
      this.#active.delete(route.sessionId);
    }
    if (uncertainLifecycleOutcome(error)) {
      this.#fenceGeneration();
    } else if (this.#registry.state(route)?.residency === "provisional_load") {
      this.#registry.failLoad(claim);
    }
  }

  #fenceGeneration(): void {
    this.#registry.fenceGeneration(this.#owner);
    this.#active.clear();
    this.#pageAcquisition?.cancellation.abort(
      new Error("grok_session_generation_fenced"),
    );
    this.#pageAcquisition = undefined;
    this.#activePrompt = undefined;
  }

  #enqueuePublish(records: readonly GrokHistoryRecord[]): Promise<void> {
    if (!this.#publish || records.length === 0) return Promise.resolve();
    const publish = this.#publish;
    const task = this.#publishTail.then(async () => {
      for (const record of records) await publish(record);
    });
    this.#publishTail = task;
    return task;
  }

  #publishInline(records: readonly GrokHistoryRecord[]): void {
    if (!this.#publish || records.length === 0) return;
    for (const record of records) {
      const result = this.#publish(record);
      if (
        typeof result === "object" &&
        result !== null &&
        "then" in result &&
        typeof result.then === "function"
      ) {
        throw new Error("grok_inline_publish_returned_promise");
      }
    }
  }

  #beginMutation(operation: GrokLifecycleMutation): void {
    if (this.#closed || this.connection.diagnostics().closed) {
      throw new Error("grok_session_lifecycle_closed");
    }
    if (this.#mutationInFlight) {
      throw new Error("grok_session_lifecycle_mutation_in_flight");
    }
    this.#mutationInFlight = operation;
  }

  #beginTitleOperation(): void {
    if (this.#closed || this.connection.diagnostics().closed) {
      throw new Error("grok_session_lifecycle_closed");
    }
    if (this.#titleOperationInFlight) {
      throw new Error("grok_session_title_operation_in_flight");
    }
    this.#titleOperationInFlight = true;
  }

  #endTitleOperation(): void {
    this.#titleOperationInFlight = false;
  }

  async #scanSessions(
    signal?: AbortSignal,
  ): Promise<readonly GrokListedSession[]> {
    const startedAt = Date.now();
    const seenNativeCursors = new Set<string>();
    const seenSessionIds = new Set<string>();
    const sessions: GrokListedSession[] = [];
    let retainedBytes = 0;
    let nativeCursor: string | undefined;
    for (let page = 0; page < MAXIMUM_LIST_PAGES; page += 1) {
      const remaining = 30_000 - (Date.now() - startedAt);
      if (remaining < 1) throw new Error("grok_session_list_deadline");
      const response = await this.connection.listSessions(
        {
          cwd: this.#owner.workspace,
          ...(nativeCursor !== undefined ? { cursor: nativeCursor } : {}),
        },
        requestOptions(signal, remaining),
      );
      const projected = projectNativeListPage(
        response,
        this.#owner.nativeNamespaceKey,
        this.#owner.workspace,
      );
      for (const session of projected.sessions) {
        if (seenSessionIds.has(session.sessionId)) {
          throw new Error("grok_session_list_duplicate_session");
        }
        seenSessionIds.add(session.sessionId);
        retainedBytes += Buffer.byteLength(JSON.stringify(session));
        if (
          sessions.length >= MAXIMUM_LISTED_SESSIONS ||
          retainedBytes > MAXIMUM_LIST_BYTES
        ) {
          throw new Error("grok_session_list_limit_exceeded");
        }
        sessions.push(session);
      }
      nativeCursor = projected.nextCursor;
      if (nativeCursor === undefined) break;
      if (seenNativeCursors.has(nativeCursor)) {
        throw new Error("grok_session_list_cursor_cycle");
      }
      seenNativeCursors.add(nativeCursor);
      if (page === MAXIMUM_LIST_PAGES - 1) {
        throw new Error("grok_session_list_limit_exceeded");
      }
    }
    return Object.freeze(sessions);
  }

  #endMutation(operation: GrokLifecycleMutation): void {
    if (this.#mutationInFlight === operation)
      this.#mutationInFlight = undefined;
  }
}

function projectNativeListPage(
  response: ListSessionsResponse,
  nativeNamespaceKey: string,
  workspace: string,
): {
  readonly sessions: readonly GrokListedSession[];
  readonly nextCursor?: string;
} {
  if (response.sessions.length > MAXIMUM_LISTED_SESSIONS) {
    throw new Error("grok_session_list_limit_exceeded");
  }
  if (response.nextCursor != null) assertBoundedCursor(response.nextCursor);
  const sessions = response.sessions.map((session) =>
    projectListedSession(session, nativeNamespaceKey, workspace),
  );
  return Object.freeze({
    sessions: Object.freeze(sessions),
    ...(response.nextCursor != null ? { nextCursor: response.nextCursor } : {}),
  });
}

function projectListedSession(
  session: SessionInfo,
  nativeNamespaceKey: string,
  workspace: string,
): GrokListedSession {
  if (session.cwd !== workspace || !boundedIdentifier(session.sessionId)) {
    throw new Error("grok_session_list_scope_mismatch");
  }
  if (session.title != null && !boundedText(session.title, 16_384)) {
    throw new Error("grok_session_list_limit_exceeded");
  }
  if (session.updatedAt != null && !boundedText(session.updatedAt, 1_024)) {
    throw new Error("grok_session_list_limit_exceeded");
  }
  return Object.freeze({
    nativeNamespaceKey,
    sessionId: session.sessionId,
    workspace,
    ...(session.title != null ? { title: session.title } : {}),
    ...(session.updatedAt != null ? { updatedAt: session.updatedAt } : {}),
  });
}

function requireProjection(result: GrokHistoryProjectionResult): void {
  if (result.kind === "resnapshot_required") {
    throw new Error(`grok_history_${result.reason}`);
  }
}

function uncertainLifecycleOutcome(error: unknown): boolean {
  if (error instanceof AcpDeliveryError) {
    return error.delivery !== "not_sent";
  }
  return error instanceof AcpBindingError && !(error instanceof AcpRemoteError);
}

function requestLocalNativeHistoryFailure(error: unknown): boolean {
  return (
    error instanceof GrokNativeHistoryReadError ||
    error instanceof GrokNativeHistoryProjectionError
  );
}

function definitePromptNonAcceptance(
  error: unknown,
  prompt: ActivePrompt,
): boolean {
  if (
    prompt.violation ||
    prompt.promptTrafficAdmitted ||
    prompt.acceptance.settled
  ) {
    return false;
  }
  return (
    error instanceof AcpRemoteError ||
    error instanceof GrokAuthenticationRequiredError ||
    (error instanceof AcpDeliveryError && error.delivery === "not_sent")
  );
}

function safeToReleaseCreateReservation(error: unknown): boolean {
  if (error instanceof AcpDeliveryError) return error.delivery === "not_sent";
  return (
    error instanceof AcpBindingError &&
    (error.code === "acp_binding_overloaded" ||
      error.code === "acp_binding_capability_denied" ||
      error.code === "acp_binding_protocol_violation")
  );
}

function assertSameSessionConfiguration(
  actual: GrokEffectiveSessionConfiguration,
  expected: GrokEffectiveSessionConfiguration,
): void {
  if (
    actual.modelId !== expected.modelId ||
    actual.reasoningEffort !== expected.reasoningEffort
  ) {
    throw new Error("grok_session_configuration_mismatch");
  }
}

function requestOptions(
  signal: AbortSignal | undefined,
  deadlineMilliseconds: number | null = 30_000,
) {
  return {
    deadlineMilliseconds,
    ...(signal ? { cancellationSignal: signal } : {}),
  };
}

function assertBoundedCursor(cursor: string): void {
  if (!boundedText(cursor, MAXIMUM_CURSOR_BYTES)) {
    throw new Error("grok_session_cursor_invalid");
  }
}

function boundedIdentifier(value: string): boolean {
  return boundedText(value, 1_024);
}

function nativeHistoryEpoch(): string {
  return randomBytes(32).toString("base64url");
}

function boundedText(value: string, maximumBytes: number): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximumBytes &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function canonicalPromptContent(
  value: PromptRequest["prompt"],
): PromptRequest["prompt"] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("grok_prompt_content_invalid");
  }
  let hasDeliverableContent = false;
  const content = value.map((block) => {
    if (block.type === "text") {
      if (
        typeof block.text !== "string" ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(
          block.text,
        )
      ) {
        throw new Error("grok_prompt_content_invalid");
      }
      if (block.text.trim().length > 0) hasDeliverableContent = true;
    } else if (block.type === "image") {
      hasDeliverableContent = true;
    } else if (block.type === "resource_link") {
      if (
        !boundedText(block.name, 255) ||
        !boundedText(block.uri, 8_192) ||
        !block.uri.startsWith("file://") ||
        typeof block.mimeType !== "string" ||
        !boundedText(block.mimeType, 255) ||
        typeof block.size !== "number" ||
        !Number.isSafeInteger(block.size) ||
        block.size < 0
      ) {
        throw new Error("grok_prompt_content_invalid");
      }
      hasDeliverableContent = true;
      return Object.freeze({
        type: "resource_link" as const,
        name: block.name,
        uri: block.uri,
        mimeType: block.mimeType,
        size: block.size,
      });
    } else {
      throw new Error("grok_prompt_content_invalid");
    }
    return Object.freeze({ ...block });
  });
  if (!hasDeliverableContent) {
    throw new Error("grok_prompt_content_invalid");
  }
  return Object.freeze(content) as PromptRequest["prompt"];
}

function isPromptDependentUpdate(notification: SessionNotification): boolean {
  return (
    notification.update.sessionUpdate === "user_message_chunk" ||
    notification.update.sessionUpdate === "agent_message_chunk" ||
    notification.update.sessionUpdate === "agent_thought_chunk" ||
    notification.update.sessionUpdate === "plan" ||
    notification.update.sessionUpdate === "tool_call" ||
    notification.update.sessionUpdate === "tool_call_update"
  );
}

function closesPromptUserRun(notification: SessionNotification): boolean {
  return (
    notification.update.sessionUpdate === "agent_message_chunk" ||
    notification.update.sessionUpdate === "agent_thought_chunk"
  );
}

function toolProjectionDiagnostic(
  notification: SessionNotification,
): Extract<GrokDeliveryDiagnostic, { phase: "tool_projection" }> {
  const update = notification.update;
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  ) {
    throw new Error("grok_tool_projection_diagnostic_invalid");
  }
  const metadata = isRecord(notification._meta) ? notification._meta : {};
  return {
    phase: "tool_projection",
    update: update.sessionUpdate,
    event: diagnosticIdentifierDisposition(metadata.eventId),
    title: diagnosticOptionalStringDisposition(update.title),
    name: diagnosticOptionalStringDisposition(update.name),
    replay:
      metadata.isReplay === undefined
        ? "absent"
        : metadata.isReplay === true
          ? "true"
          : "other",
  };
}

function diagnosticIdentifierDisposition(
  value: unknown,
): "absent" | "valid" | "invalid" {
  return value === undefined
    ? "absent"
    : typeof value === "string" && boundedIdentifier(value)
      ? "valid"
      : "invalid";
}

function diagnosticOptionalStringDisposition(
  value: unknown,
): "absent" | "null" | "empty" | "valid" | "invalid" {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (value === "") return "empty";
  return typeof value === "string" && Buffer.byteLength(value) <= 64 * 1_024
    ? "valid"
    : "invalid";
}

function promptUserEchoComplete(prompt: ActivePrompt): boolean {
  return (
    !prompt.userEchoContradicted &&
    prompt.userEchoOffset === prompt.expectedText.length
  );
}

function projectionRecords(
  result: GrokHistoryProjectionResult,
): readonly GrokHistoryRecord[] {
  if (result.kind !== "accepted") return [];
  if (result.records) return result.records;
  return result.record ? [result.record] : [];
}

function projectedCharacterCount(
  records: readonly GrokHistoryRecord[],
): number {
  return records.reduce((total, record) => {
    if (record.kind === "turn_completed") return total;
    if (record.kind === "collaboration") {
      return (
        total +
        (record.agentLabel?.text.length ?? 0) +
        (record.summary?.text.length ?? 0)
      );
    }
    if (record.kind === "plan") {
      return (
        total +
        record.replacement.entries.reduce(
          (characters, entry) => characters + entry.text.text.length,
          0,
        )
      );
    }
    if (record.kind === "tool") return total;
    if (record.kind === "omission") return total;
    return total + record.text.text.length;
  }, 0);
}

function validatePromptCompletion(
  prompt: ActivePrompt,
  response: PromptResponse,
): void {
  if (prompt.violation) throw new Error(prompt.violation);
  const terminal = prompt.liveTerminal;
  if (
    !prompt.userRunClosed ||
    !prompt.acceptance.settled ||
    !promptUserEchoComplete(prompt) ||
    (!prompt.assistantOutputObserved &&
      terminal?.update.stop_reason !== "cancelled") ||
    !terminal ||
    terminal.update.prompt_id !== prompt.promptId ||
    terminal.update.stop_reason !== response.stopReason
  ) {
    throw new Error("grok_prompt_completion_correlation_mismatch");
  }
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const value: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (resolved) => resolvePromise(resolved),
    reject: (reason) => rejectPromise(reason),
    settled: false,
  };
  // The completion continuation owns terminal failure. Callers commonly
  // install their acceptance await and completion observer in separate turns;
  // keep an early definite rejection from becoming unhandled meanwhile.
  void value.promise.catch(() => undefined);
  return value;
}

function resolveDeferred<T>(deferredValue: Deferred<T>, value: T): void {
  if (deferredValue.settled) return;
  deferredValue.settled = true;
  deferredValue.resolve(value);
}

function rejectDeferred<T>(deferredValue: Deferred<T>, reason: unknown): void {
  if (deferredValue.settled) return;
  deferredValue.settled = true;
  deferredValue.reject(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameRoute(left: GrokSessionRoute, right: GrokSessionRoute): boolean {
  return (
    left.nativeNamespaceKey === right.nativeNamespaceKey &&
    left.workspace === right.workspace &&
    left.connectionGeneration === right.connectionGeneration &&
    left.processOwnerId === right.processOwnerId &&
    left.sessionId === right.sessionId &&
    left.scope.tenantId === right.scope.tenantId &&
    left.scope.principalId === right.scope.principalId &&
    left.scope.backendInstanceId === right.scope.backendInstanceId &&
    left.scope.executionEnvironmentId === right.scope.executionEnvironmentId
  );
}
