import { SEDES_VERSION } from "../../src/shared/version.js";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { BackendConversationEvent } from "../../src/shared/protocol/backend.js";
import type { ConversationBinding } from "../../src/server/backends/contracts.js";
import {
  CodexConversationHandle,
  type CodexExecutionSettingsProvider,
} from "../../src/server/backends/codex/codex-conversation-handle.js";
import { CodexDaemonSupervisor } from "../../src/server/backends/codex/codex-daemon-supervisor.js";
import { CodexFastModeSessionRegistry } from "../../src/server/backends/codex/codex-fast-mode-session.js";
import type { ProviderTransportScope } from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import { TcpWebSocketTransportFactory } from "../../src/server/backends/codex/transport/tcp-websocket-transport.js";
import { ConversationActor } from "../../src/server/conversations/conversation-actor.js";
import { ConversationProjector } from "../../src/server/conversations/conversation-projector.js";
import type { ExecutionEnvironmentLease } from "../../src/server/execution/contracts.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import {
  RawTcpWebSocketServer,
  type RawWebSocketConnection,
  type RawWebSocketFrame,
} from "../support/raw-uds-websocket-server.js";
import { createInMemoryOutputArtifactPublisher } from "../helpers/output-artifact-publisher.js";

type InteractionEvent = Extract<
  BackendConversationEvent,
  { readonly type: "interaction_opened" | "interaction_resolved" }
>;

const TOKEN_VARIABLE = "SEDES_CODEX_PRODUCTION_INTERACTION_TOKEN";
const CAPABILITY_TOKEN = "production-interaction-token-12345";
const CODEX_HOME = "/codex-home-production-interaction";
const THREAD_ID = "thread-authoritative";
const TURN_ID = "turn-authoritative";
const scope: ProviderTransportScope = Object.freeze({
  tenantId: "tenant-production-interaction",
  principalId: "principal-production-interaction",
  backendInstanceId: "codex-production-interaction",
  executionEnvironmentId: "local-production-interaction",
});

describe.sequential("production-composed TCP interaction authority", () => {
  it("recovers one supervisor/actor controller while an initialized observer stays passive", async () => {
    const peer = new RawTcpWebSocketServer({
      handshakeResponder: (request) =>
        header(request, "authorization") === `Bearer ${CAPABILITY_TOKEN}` &&
        header(request, "origin") === undefined
          ? "accept"
          : { statusCode: 401 },
    });
    await peer.listen();
    const listener = new ScriptedInteractionAppServer(peer);
    const channels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: scope.executionEnvironmentId,
      environment: { [TOKEN_VARIABLE]: CAPABILITY_TOKEN },
    });
    const transportFactory = new TcpWebSocketTransportFactory({
      scope,
      channels,
      url: peer.url,
      secretReference: {
        source: "environment",
        variable: TOKEN_VARIABLE,
      },
      limits: { handshakeTimeoutMilliseconds: 1_000 },
    });
    const supervisorErrors: unknown[] = [];
    const supervisor = new CodexDaemonSupervisor({
      scope,
      transportFactory,
      restartDelaysMilliseconds: [0, 5, 10],
      restartJitterRatio: 0,
      maximumRestartAttempts: 5,
      initializationTimeoutMilliseconds: 1_000,
      stabilityResetMilliseconds: 60_000,
      shutdownTimeoutMilliseconds: 1_000,
      onError: (error) => supervisorErrors.push(error),
    });
    const releaseOwnership = vi.fn();
    const releaseLease = vi.fn(async () => undefined);
    const events: InteractionEvent[] = [];
    let handle: CodexConversationHandle | undefined;
    let actor: ConversationActor | undefined;
    let observer: InitializedObserver | undefined;

    try {
      const starting = supervisor.start();
      const controllerGeneration1 = await waitForConnection(peer, 0);
      listener.attach(controllerGeneration1);
      await starting;
      expect(supervisor.snapshot()).toMatchObject({
        state: "ready",
        generation: 1,
      });

      handle = new CodexConversationHandle({
        binding: binding(),
        canonicalWorkspacePath: "/workspace",
        workspaceId: "workspace-one",
        opaqueBindingDetail: "test-codex-binding-detail",
        client: supervisor.client,
        serverRequests: supervisor.serverRequests,
        toolProvenanceKey: new Uint8Array(32).fill(7),
        correlationAncestorThreadIds: [],
        executionSettings,
        outputArtifacts: createInMemoryOutputArtifactPublisher(),
        fastModeSessions: new CodexFastModeSessionRegistry(),
        validateExecutionSettings: async () => undefined,
        resolveImportedReasoningEffort: async (_model, observed) =>
          observed ?? "low",
        releaseOwnership,
      });
      handle.subscribe((event) => {
        if (
          event.type === "interaction_opened" ||
          event.type === "interaction_resolved"
        ) {
          events.push(event);
        }
      });
      actor = new ConversationActor({
        handle,
        environmentLease: environmentLease(releaseLease),
        attachmentDelivery: {
          materialize: async () => ({
            attachments: [],
            canonicalBytes: {
              read: async () => {
                throw new Error("unexpected_canonical_attachment_read");
              },
            },
            canonicalEvidence: { resolve: () => [] },
          }),
        } as never,
        projector: new ConversationProjector({
          backendInstanceId: scope.backendInstanceId,
          bindingIdentity: "production-interaction-binding",
        }),
        projectionUpdateIntervalMilliseconds: 1,
      });
      await actor.start({ signal: new AbortController().signal });
      const firstProjectionGeneration = actor.timeline.generation;

      observer = new InitializedObserver(peer.url);
      const observerOpening = observer.open();
      const observerConnection = await waitForConnection(peer, 1);
      const observerState = listener.attach(observerConnection);
      await observerOpening;
      await observer.initializeAndSubscribe();
      expect(observerState).toMatchObject({
        role: "observer",
        initialized: true,
        subscribed: true,
      });

      listener.openProviderRequest(
        "approval-production-generation-1",
        "item/commandExecution/requestApproval",
        {
          kind: "command",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "item-command",
          startedAtMs: Date.parse("2026-08-01T00:00:00.000Z"),
          environmentId: null,
          command: "npm test",
          cwd: "/workspace",
        },
      );
      await observer.waitFor(
        (message) => message.id === "approval-production-generation-1",
      );
      const approval = await waitFor(
        () => opened(events)[0],
        "production_approval_interaction_missing",
      );
      if (approval.kind !== "decision") {
        throw new Error("production_approval_interaction_invalid");
      }
      const approvalResponse = actor.respond({
        applicationOperationId: "production-approval-response",
        interactionId: approval.backendInteractionId,
        kind: "decision",
        selectedActionId: "accept",
      });
      await listener.waitForResponse(
        "approval-production-generation-1",
        "controller",
      );
      await approvalResponse;
      await waitFor(
        () => resolved(events).length === 1,
        "production_approval_resolution_missing",
      );
      expect(
        listener.responsesFor("approval-production-generation-1", "observer"),
      ).toEqual([]);

      listener.openProviderRequest(
        "input-production-generation-1",
        "item/tool/requestUserInput",
        userInputParams("item-input-before-reconnect"),
      );
      await observer.waitFor(
        (message) => message.id === "input-production-generation-1",
      );
      const interrupted = await waitFor(
        () => opened(events)[1],
        "production_input_interaction_missing",
      );
      const observerRequestCountBeforeReconnect = observer.count(
        (message) => message.id === "input-production-generation-1",
      );

      // The listener, observer, and native callback survive. Only the
      // Sedes-owned client socket is replaced; supervisor generation and
      // actor projection recovery are production-driven.
      controllerGeneration1.destroy();
      const controllerGeneration2 = await waitForConnection(peer, 2);
      listener.attach(controllerGeneration2);
      await waitFor(
        () =>
          supervisor.snapshot().state === "ready" &&
          supervisor.snapshot().generation === 2,
        "production_supervisor_generation_two_missing",
        5_000,
      );
      await waitFor(
        () => actor?.timeline.generation !== firstProjectionGeneration,
        "production_actor_projection_not_recovered",
        5_000,
      );
      await expect(
        actor.respond({
          applicationOperationId: "stale-production-input-response",
          interactionId: interrupted.backendInteractionId,
          kind: "questionnaire",
          answers: [
            {
              questionId: "environment",
              answer: { kind: "text", value: "stale answer" },
            },
          ],
        }),
      ).rejects.toMatchObject({
        category: "rejected",
        backendCode: "codex_interaction_not_pending",
      });

      // The scripted provider automatically re-delivers its still-pending
      // native callback after the production actor's generation-two resume.
      const reconnected = await waitFor(
        () => opened(events)[2],
        "production_reconnected_input_missing",
        5_000,
      );
      expect(reconnected.backendInteractionId).not.toBe(
        interrupted.backendInteractionId,
      );
      await waitFor(
        () =>
          observer!.count(
            (message) => message.id === "input-production-generation-1",
          ) > observerRequestCountBeforeReconnect,
        "production_observer_redelivery_missing",
      );
      const inputResponse = actor.respond({
        applicationOperationId: "production-input-response-generation-2",
        interactionId: reconnected.backendInteractionId,
        kind: "questionnaire",
        answers: [
          {
            questionId: "environment",
            answer: { kind: "text", value: "staging" },
          },
        ],
      });
      const settledInput = await listener.waitForResponse(
        "input-production-generation-1",
        "controller",
      );
      expect(settledInput.result).toEqual({
        answers: { environment: { answers: ["user_note: staging"] } },
      });
      await inputResponse;
      await waitFor(
        () => resolved(events).length === 3,
        "production_input_resolution_missing",
      );

      expect(
        listener.responsesFor("input-production-generation-1", "observer"),
      ).toEqual([]);
      expect(
        listener.responsesFor("input-production-generation-1", "controller"),
      ).toHaveLength(1);
      expect(observer.readyState).toBe(WebSocket.OPEN);
      expect(peer.listening).toBe(true);
      expect(supervisorErrors).toEqual([]);
      expect(listener.failures).toEqual([]);
      for (const request of peer.requests) {
        expect(header(request, "authorization")).toBe(
          `Bearer ${CAPABILITY_TOKEN}`,
        );
        expect(header(request, "origin")).toBeUndefined();
      }

      await actor.close();
      actor = undefined;
      handle = undefined;
      await supervisor.close();
      expect(peer.listening).toBe(true);
      expect(observer.readyState).toBe(WebSocket.OPEN);
      expect(releaseOwnership).toHaveBeenCalledTimes(1);
      expect(releaseLease).toHaveBeenCalledTimes(1);
    } finally {
      await actor?.close().catch(() => undefined);
      await handle?.close().catch(() => undefined);
      await supervisor.close().catch(() => undefined);
      await observer?.close().catch(() => undefined);
      channels.close();
      await peer.close();
    }
  }, 20_000);
});

type ConnectionRole = "controller" | "observer";
type ClientEnvelope = Readonly<Record<string, unknown>>;
type ConnectionState = {
  readonly connection: RawWebSocketConnection;
  readonly received: ClientEnvelope[];
  cursor: number;
  role?: ConnectionRole;
  initialized: boolean;
  subscribed: boolean;
  closed: boolean;
};
type ProviderRequest = {
  readonly id: string;
  readonly method:
    "item/commandExecution/requestApproval" | "item/tool/requestUserInput";
  readonly params: Readonly<Record<string, unknown>>;
};

class ScriptedInteractionAppServer {
  readonly failures: unknown[] = [];
  readonly #peer: RawTcpWebSocketServer;
  readonly #states = new Set<ConnectionState>();
  readonly #responses: Array<{
    readonly id: string;
    readonly role: ConnectionRole;
    readonly result: unknown;
  }> = [];
  #pending: ProviderRequest | undefined;

  constructor(peer: RawTcpWebSocketServer) {
    this.#peer = peer;
  }

  attach(connection: RawWebSocketConnection): ConnectionState {
    const state: ConnectionState = {
      connection,
      received: [],
      cursor: 0,
      initialized: false,
      subscribed: false,
      closed: false,
    };
    this.#states.add(state);
    void connection.closed.then(() => {
      state.closed = true;
      state.subscribed = false;
    });
    void this.#pump(state).catch((error) => this.failures.push(error));
    return state;
  }

  openProviderRequest(
    id: ProviderRequest["id"],
    method: ProviderRequest["method"],
    params: ProviderRequest["params"],
  ): void {
    if (this.#pending)
      throw new Error("scripted_provider_request_already_open");
    this.#pending = { id, method, params };
    void this.#broadcastPending().catch((error) => this.failures.push(error));
  }

  responsesFor(id: string, role: ConnectionRole) {
    return this.#responses.filter(
      (response) => response.id === id && response.role === role,
    );
  }

  async waitForResponse(id: string, role: ConnectionRole) {
    return await waitFor(
      () => this.responsesFor(id, role)[0],
      "scripted_provider_response_missing",
    );
  }

  async #pump(state: ConnectionState): Promise<void> {
    await state.connection.upgraded;
    while (!state.closed) {
      while (state.cursor < state.connection.frames.length) {
        const frame = state.connection.frames[state.cursor++];
        if (frame && isTextFrame(frame)) {
          const envelope = JSON.parse(
            frame.payload.toString("utf8"),
          ) as ClientEnvelope;
          state.received.push(envelope);
          await this.#receive(state, envelope);
        }
      }
      await delay(2);
    }
  }

  async #receive(
    state: ConnectionState,
    envelope: ClientEnvelope,
  ): Promise<void> {
    if (typeof envelope.method === "string") {
      await this.#receiveMethod(state, envelope);
      return;
    }
    if (
      typeof envelope.id === "string" &&
      Object.hasOwn(envelope, "result") &&
      envelope.id === this.#pending?.id
    ) {
      if (!state.role)
        throw new Error("scripted_provider_response_uninitialized");
      const pending = this.#pending;
      this.#responses.push({
        id: pending.id,
        role: state.role,
        result: envelope.result,
      });
      this.#pending = undefined;
      await this.#broadcast({
        method: "serverRequest/resolved",
        params: { threadId: THREAD_ID, requestId: pending.id },
      });
    }
  }

  async #receiveMethod(
    state: ConnectionState,
    envelope: ClientEnvelope,
  ): Promise<void> {
    const method = envelope.method;
    if (method === "initialized") {
      state.initialized = true;
      return;
    }
    if (method === "initialize") {
      const clientName = nestedString(envelope, "params", "clientInfo", "name");
      state.role = clientName === "sedes_web" ? "controller" : "observer";
      await this.#respond(state, envelope.id, {
        userAgent:
          `sedes_web/0.153.0 (Linux 6.8; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
        codexHome: CODEX_HOME,
        platformFamily: "unix",
        platformOs: "linux",
      });
      return;
    }
    if (method === "account/read") {
      this.#assertInitialized(state);
      await this.#respond(state, envelope.id, {
        account: null,
        requiresOpenaiAuth: false,
      });
      return;
    }
    if (method === "thread/read") {
      this.#assertInitialized(state);
      await this.#respond(state, envelope.id, { thread: nativeThread() });
      return;
    }
    if (method === "thread/resume") {
      this.#assertInitialized(state);
      state.subscribed = true;
      await this.#respond(state, envelope.id, resumeResult());
      if (this.#pending && state.role === "controller") {
        setTimeout(() => {
          void this.#broadcastPending().catch((error) =>
            this.failures.push(error),
          );
        }, 10).unref();
      }
      return;
    }
    if (method === "experimentalFeature/list") {
      this.#assertInitialized(state);
      await this.#respond(state, envelope.id, {
        data: [
          {
            name: "fast_mode",
            stage: "stable",
            displayName: "Fast mode",
            description: null,
            announcement: null,
            enabled: false,
            defaultEnabled: true,
          },
        ],
        nextCursor: null,
      });
      return;
    }
    if (method === "thread/unsubscribe") {
      state.subscribed = false;
      await this.#respond(state, envelope.id, { status: "unsubscribed" });
      return;
    }
    throw new Error(`scripted_app_server_method_unexpected:${method}`);
  }

  async #respond(
    state: ConnectionState,
    id: unknown,
    result: unknown,
  ): Promise<void> {
    if (typeof id !== "string" && typeof id !== "number") {
      throw new Error("scripted_app_server_request_id_invalid");
    }
    await state.connection.sendText(JSON.stringify({ id, result }));
  }

  async #broadcastPending(): Promise<void> {
    if (!this.#pending) return;
    await this.#broadcast(this.#pending);
  }

  async #broadcast(envelope: unknown): Promise<void> {
    await Promise.all(
      [...this.#states]
        .filter(
          (state) => state.initialized && state.subscribed && !state.closed,
        )
        .map((state) => state.connection.sendText(JSON.stringify(envelope))),
    );
  }

  #assertInitialized(state: ConnectionState): void {
    if (!state.initialized || !state.role) {
      throw new Error("scripted_app_server_client_not_initialized");
    }
  }
}

class InitializedObserver {
  readonly #url: string;
  readonly #messages: ClientEnvelope[] = [];
  #socket: WebSocket | undefined;
  #nextId = 10_000;

  constructor(url: string) {
    this.#url = url;
  }

  get readyState(): number | undefined {
    return this.#socket?.readyState;
  }

  async open(): Promise<void> {
    const socket = new WebSocket(this.#url, {
      headers: { Authorization: `Bearer ${CAPABILITY_TOKEN}` },
    });
    this.#socket = socket;
    socket.on("message", (data) => {
      this.#messages.push(
        JSON.parse(
          Buffer.from(data as Uint8Array).toString("utf8"),
        ) as ClientEnvelope,
      );
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
  }

  async initializeAndSubscribe(): Promise<void> {
    await this.#request("initialize", {
      clientInfo: {
        name: "c5c_passive_observer",
        title: "C5c passive observer",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    this.#send({ method: "initialized" });
    await this.#request("account/read", { refreshToken: false });
    await this.#request("thread/resume", { threadId: THREAD_ID });
  }

  count(predicate: (message: ClientEnvelope) => boolean): number {
    return this.#messages.filter(predicate).length;
  }

  async waitFor(predicate: (message: ClientEnvelope) => boolean) {
    return await waitFor(
      () => this.#messages.find(predicate),
      "initialized_observer_message_missing",
    );
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
      setTimeout(() => {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        resolve();
      }, 500).unref();
    });
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    this.#send({ id, method, params });
    const response = await this.waitFor((message) => message.id === id);
    return response.result;
  }

  #send(envelope: unknown): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw new Error("initialized_observer_not_open");
    }
    this.#socket.send(JSON.stringify(envelope));
  }
}

const executionSettings: CodexExecutionSettingsProvider = {
  desiredSettings: () => ({
    model: "gpt-5.6",
    reasoningEffort: "low",
    serviceTier: "standard",
    sandboxMode: "read-only",
    networkAccess: "disabled",
    approvalPolicy: "never",
    approvalReviewer: "user",
  }),
  resolveFastModeDisabled: () => ({
    model: "gpt-5.6",
    reasoningEffort: "low",
    serviceTier: "standard",
    sandboxMode: "read-only",
    networkAccess: "disabled",
    approvalPolicy: "never",
    approvalReviewer: "user",
  }),
  forkSettingsEligibility: () => ({
    availability: "available",
    settingsRevision: 1,
    settings: {
      model: "gpt-5.6",
      reasoningEffort: "low",
      serviceTier: "standard",
      sandboxMode: "read-only",
      networkAccess: "disabled",
      approvalPolicy: "never",
      approvalReviewer: "user",
    },
  }),
  freezeOperationSnapshot: () => ({
    settings: {
      model: "gpt-5.6",
      reasoningEffort: "low",
      serviceTier: "standard",
      sandboxMode: "read-only",
      networkAccess: "disabled",
      approvalPolicy: "never",
      approvalReviewer: "user",
    },
  }),
  observeEffective: () => undefined,
  markEffectiveUnknown: () => undefined,
};

function binding(): ConversationBinding {
  return {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    applicationThreadId: "application-thread-authoritative",
    backendConversationId: THREAD_ID,
    backendInstanceId: scope.backendInstanceId,
    connectionProfileId: "profile-production-interaction",
    executionEnvironmentId: scope.executionEnvironmentId,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function environmentLease(
  release: () => Promise<void>,
): ExecutionEnvironmentLease {
  return {
    scope: {
      tenantId: scope.tenantId,
      principalId: scope.principalId,
    },
    environment: {
      id: scope.executionEnvironmentId,
      label: "Local",
      availability: "available",
      diagnosticCode: null,
      revision: 0,
    },
    workspace: {
      canonicalPath: "/workspace",
      authorityRevision: 0,
      summary: {
        id: "019196f7-a0a8-7bc4-a89b-8cf013978511",
        environmentId: scope.executionEnvironmentId,
        displayName: "workspace",
        displayPath: "/workspace",
        availability: "available",
        trustState: "trusted",
        revision: 0,
      },
    },
    release,
  };
}

function nativeThread() {
  return {
    id: THREAD_ID,
    extra: {},
    sessionId: "session-authoritative",
    forkedFromId: null,
    parentThreadId: null,
    preview: "Authoritative thread",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "legacy",
    modelProvider: "openai",
    model: null,
    reasoningEffort: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    recencyAt: 1_700_000_100,
    status: { type: "active", activeFlags: ["waitingOnApproval"] },
    path: "/private/rollout.jsonl",
    cwd: "/workspace",
    cliVersion: "0.153.0",
    source: "appServer",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "Fixture",
    turns: [
      {
        id: TURN_ID,
        items: [
          {
            type: "userMessage",
            id: "item-user",
            clientId: null,
            content: [{ type: "text", text: "message", text_elements: [] }],
          },
        ],
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: 1_700_000_000,
        completedAt: null,
        durationMs: null,
      },
    ],
  };
}

function resumeResult() {
  const thread = nativeThread();
  return {
    thread,
    model: "gpt-5.6",
    modelProvider: "openai",
    serviceTier: "default",
    cwd: thread.cwd,
    runtimeWorkspaceRoots: [thread.cwd],
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    activePermissionProfile: { id: ":read-only", extends: null },
    reasoningEffort: "low",
    multiAgentMode: "explicitRequestOnly",
    initialTurnsPage: null,
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
  };
}

function userInputParams(itemId: string): Readonly<Record<string, unknown>> {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId,
    questions: [
      {
        id: "environment",
        header: "Environment",
        question: "Which environment?",
        isOther: false,
        isSecret: false,
        options: null,
      },
    ],
    isBlocking: true,
  };
}

function opened(events: readonly InteractionEvent[]) {
  return events.flatMap((event) =>
    event.type === "interaction_opened" ? [event.interaction] : [],
  );
}

function resolved(events: readonly InteractionEvent[]) {
  return events.filter((event) => event.type === "interaction_resolved");
}

function isTextFrame(frame: RawWebSocketFrame): boolean {
  return frame.opcode === 0x1;
}

function nestedString(
  input: ClientEnvelope,
  ...keys: readonly string[]
): string | undefined {
  let value: unknown = input;
  for (const key of keys) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    value = (value as Readonly<Record<string, unknown>>)[key];
  }
  return typeof value === "string" ? value : undefined;
}

function header(request: string, name: string): string | undefined {
  const prefix = `${name.toLowerCase()}:`;
  for (const line of request.split("\r\n").slice(1)) {
    if (line.toLowerCase().startsWith(prefix)) {
      return line.slice(line.indexOf(":") + 1).trim();
    }
  }
  return undefined;
}

async function waitForConnection(
  peer: RawTcpWebSocketServer,
  index: number,
): Promise<RawWebSocketConnection> {
  return await waitFor(
    () => peer.connections[index],
    "production_interaction_connection_missing",
  );
}

async function waitFor<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  code: string,
  timeoutMilliseconds = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    await delay(5);
  }
  throw new Error(code);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
