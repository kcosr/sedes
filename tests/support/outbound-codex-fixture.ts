import { SEDES_VERSION } from "../../src/shared/version.js";
import { chmod } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { codexThreadReadMethod, type CodexThread } from "../../src/server/backends/codex/codex-c1-protocol.js";
import { codexModelListMethod, codexThreadStartMethod } from "../../src/server/backends/codex/codex-c2-protocol.js";
import { codexAccountUsageResult } from "../helpers/codex-account-usage.js";

export interface OutboundCodexFixtureRequest {
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** Offline app-server peer for an actual persistent sidecar on this OS host.
 * No executable, authenticated provider, prompt, or external service is used.
 */
export class OutboundCodexFixture {
  readonly requests: OutboundCodexFixtureRequest[] = [];
  readonly errors: unknown[] = [];
  readonly model = "gpt-5.6-codex";
  readonly #server: Server;
  readonly #websockets: WebSocketServer;
  readonly #sockets = new Set<Socket>();
  readonly #threads = new Map<string, CodexThread>();
  readonly #loaded = new Set<string>();
  readonly #codexHome: string;
  readonly #workspacePath: string;
  #active: { socket: WebSocket; thread: CodexThread; turn: CodexThread["turns"][number] } | undefined;
  #pendingSteer?: Extract<CodexThread["turns"][number]["items"][number], { type: "userMessage" }>;
  #nextTurnListGate?: Promise<void>;
  #closePromise: Promise<void> | undefined;

  private constructor(
    readonly socketPath: string,
    options: { readonly codexHome?: string; readonly workspacePath?: string },
  ) {
    this.#codexHome = options.codexHome ?? path.join(path.dirname(socketPath), ".codex");
    this.#workspacePath = options.workspacePath ?? path.dirname(socketPath);
    this.#server = createServer((_request, response) => response.writeHead(404).end());
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
    this.#websockets = new WebSocketServer({
      server: this.#server,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
    });
    this.#websockets.on("connection", (socket) => {
      let initialized = false;
      socket.on("error", (error) => this.errors.push(error));
      socket.on("message", (bytes, binary) => {
        let request: OutboundCodexFixtureRequest | undefined;
        try {
          if (binary) throw new Error("outbound_codex_fixture_binary_frame");
          const value = JSON.parse(bytes.toString()) as unknown;
          if (!value || typeof value !== "object" || !("method" in value) || typeof value.method !== "string") {
            throw new Error("outbound_codex_fixture_invalid_request");
          }
          request = value as OutboundCodexFixtureRequest;
          if (this.requests.length >= 4096) throw new Error("outbound_codex_fixture_request_limit");
          this.requests.push(request);
          if (request.method === "initialized") {
            initialized = true;
            return;
          }
          if (request.id === undefined) throw new Error("outbound_codex_fixture_unknown_notification");
          if (request.method !== "initialize" && !initialized) throw new Error("outbound_codex_fixture_uninitialized");
          const result = this.#respond(request, socket);
          const response = JSON.stringify({ id: request.id, result });
          if (request.method === "thread/turns/list" && this.#nextTurnListGate) {
            void this.#nextTurnListGate.then(() => {
              if (socket.readyState === WebSocket.OPEN) socket.send(response);
            });
            this.#nextTurnListGate = undefined;
            return;
          }
          socket.send(response);
          if (request.method === "turn/start" && this.#active) {
            const { thread, turn } = this.#active;
            this.#notify("turn/started", { threadId: thread.id, turn });
            for (const item of turn.items) this.#notify("item/completed", { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() });
          }
        } catch (error) {
          this.errors.push(error);
          if (request?.id !== undefined && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: error instanceof Error ? error.message : "fixture request failed" } }));
          } else socket.close(1008, "Fixture protocol rejected");
        }
      });
    });
  }

  static async start(
    socketPath: string,
    options: { readonly codexHome?: string; readonly workspacePath?: string } = {},
  ): Promise<OutboundCodexFixture> {
    if (!path.isAbsolute(socketPath)) throw new Error("outbound_codex_fixture_socket_not_absolute");
    const fixture = new OutboundCodexFixture(socketPath, options);
    try {
      await new Promise<void>((resolve, reject) => {
        fixture.#server.once("error", reject);
        fixture.#server.listen(socketPath, resolve);
      });
      await chmod(socketPath, 0o600);
      return fixture;
    } catch (error) {
      await fixture.close();
      throw error;
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      for (const socket of this.#websockets.clients) socket.terminate();
      for (const socket of this.#sockets) socket.destroy();
      await new Promise<void>((resolve) => this.#websockets.close(() => resolve()));
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    })();
    return this.#closePromise;
  }

  /** Whether the native connection that started the held turn is still open. */
  get activeTurnConnected(): boolean {
    return this.#active?.socket.readyState === WebSocket.OPEN;
  }

  /** Drive the same native turn on either side of a Settings save. */
  appendOutput(text: string): void {
    const message = this.startAnswer("commentary");
    message.append(text);
    message.complete();
  }

  /** The test controls when each provider delta and the authoritative item arrive. */
  startAnswer(phase: "commentary" | "final_answer" | null) {
    if (!this.#active) throw new Error("outbound_codex_fixture_turn_missing");
    const { thread, turn } = this.#active;
    const item: Extract<CodexThread["turns"][number]["items"][number], { type: "agentMessage" }> = {
      type: "agentMessage", id: `${turn.id}-item-${turn.items.length}`, text: "",
      moderation: null, phase, memoryCitation: null, delivery: null, questions: null,
    };
    turn.items.push(item);
    const scope = { threadId: thread.id, turnId: turn.id };
    this.#notify("item/started", { ...scope, item, startedAtMs: Date.now() });
    return {
      append: (delta: string) => {
        item.text += delta;
        this.#notify("item/agentMessage/delta", { ...scope, itemId: item.id, delta });
      },
      complete: (terminalPhase = phase, completedText = item.text) => {
        item.phase = terminalPhase;
        item.text = completedText;
        this.#notify("item/completed", { ...scope, item, completedAtMs: Date.now() });
      },
    };
  }

  /** The app-server's steer receipt precedes materialization of its authenticated input. */
  materializeSteer(): void {
    if (!this.#active || !this.#pendingSteer) throw new Error("outbound_codex_fixture_pending_steer_missing");
    const { thread, turn } = this.#active;
    const item = this.#pendingSteer;
    this.#pendingSteer = undefined;
    turn.items.push(item);
    const scope = { threadId: thread.id, turnId: turn.id, item };
    this.#notify("item/started", { ...scope, startedAtMs: Date.now() });
    this.#notify("item/completed", { ...scope, completedAtMs: Date.now() });
  }

  holdNextTurnListUntil(release: Promise<void>): void {
    this.#nextTurnListGate = release;
  }

  completeTurn(): void {
    if (!this.#active) throw new Error("outbound_codex_fixture_turn_missing");
    const { thread, turn } = this.#active;
    turn.status = "completed";
    turn.completedAt = Math.floor(Date.now() / 1000);
    turn.durationMs = (turn.completedAt - turn.startedAt!) * 1000;
    thread.status = { type: "idle" };
    this.#notify("turn/completed", { threadId: thread.id, turn });
    this.#notify("thread/status/changed", { threadId: thread.id, status: thread.status });
    this.#active = undefined;
  }

  #notify(method: string, params: object): void {
    const socket = this.#active?.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("outbound_codex_fixture_turn_disconnected");
    socket.send(JSON.stringify({ method, params }));
  }

  #respond(request: OutboundCodexFixtureRequest, socket: WebSocket): unknown {
    const params = request.params ?? {};
    switch (request.method) {
      case "initialize": return {
        userAgent: `sedes_web/0.172.0 (Linux 6.8; x86_64) unknown (sedes_web; ${SEDES_VERSION})`,
        codexHome: this.#codexHome,
        platformFamily: "unix",
        platformOs: process.platform === "darwin" ? "macos" : "linux",
      };
      case "account/read": return { account: null, requiresOpenaiAuth: false };
      case "account/rateLimits/read": return codexAccountUsageResult();
      case "model/list": return codexModelListMethod.decodeResult({ data: [{
        id: this.model,
        model: this.model,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName: "Offline Codex fixture",
        description: "Deterministic model metadata; no provider execution",
        hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low reasoning" }],
        defaultReasoningEffort: "low",
        inputModalities: ["text"],
        supportsPersonality: false,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: true,
      }], nextCursor: null });
      case "thread/list": return { data: [...this.#threads.values()], nextCursor: null, backwardsCursor: null };
      case "thread/loaded/list": return { data: [...this.#loaded], nextCursor: null };
      case "experimentalFeature/list": return { data: [], nextCursor: null };
      case "skills/list": return { data: [{ cwd: this.#workspacePath, skills: [], errors: [] }] };
      case "thread/start": {
        if (this.#threads.size >= 32) throw new Error("outbound_codex_fixture_thread_limit");
        const cwd = typeof params.cwd === "string" ? params.cwd : this.#workspacePath;
        const id = `outbound-codex-fixture-${this.#threads.size + 1}`;
        const thread = codexThreadReadMethod.decodeResult({ thread: {
          id, extra: {}, sessionId: `${id}-session`, forkedFromId: null,
          parentThreadId: null, preview: "", ephemeral: false, section: null,
          sectionEnteredAt: null, projectId: null, historyMode: params.historyMode === "paginated" ? "paginated" : "legacy",
          modelProvider: "openai", model: this.model, reasoningEffort: "low",
          createdAt: 1_700_000_000, updatedAt: 1_700_000_000, recencyAt: 1_700_000_000,
          status: { type: "idle" }, path: path.join(this.#codexHome, "sessions", `${id}.jsonl`),
          cwd, cliVersion: "0.172.0", source: "appServer", canAcceptDirectInput: true,
          threadSource: typeof params.threadSource === "string" ? params.threadSource : null, agentNickname: null, agentRole: null, gitInfo: null,
          name: null, turns: [],
        } }).thread;
        this.#threads.set(id, thread);
        this.#loaded.add(id);
        return this.#startResult(thread);
      }
      case "turn/start": {
        if (this.#active) throw new Error("outbound_codex_fixture_duplicate_turn");
        const thread = this.#thread(params.threadId);
        const turn: CodexThread["turns"][number] = {
          id: `${thread.id}-turn-${thread.turns.length + 1}`, rootTurnId: null, itemsView: "full", items: [],
          status: "inProgress", error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null,
        };
        const input = Array.isArray(params.input) ? params.input.find(entry => entry.type === "text") : undefined;
        turn.items.push({ type: "userMessage", id: `${turn.id}-input`, clientId: typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : null,
          content: [{ type: "text", text: String(input?.text ?? ""), text_elements: [] }] });
        thread.status = { type: "active", activeFlags: [] };
        thread.turns.push(turn);
        this.#active = { thread, turn, socket };
        return { turn };
      }
      case "turn/steer": {
        const current = this.#active;
        if (!current || current.thread.id !== params.threadId || current.turn.id !== params.expectedTurnId || this.#pendingSteer) {
          throw new Error("outbound_codex_fixture_invalid_steer_target");
        }
        const input = Array.isArray(params.input) ? params.input.find(entry => entry.type === "text") : undefined;
        this.#pendingSteer = { type: "userMessage", id: `${current.turn.id}-steer-${current.turn.items.length}`,
          clientId: typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : null,
          content: [{ type: "text", text: String(input?.text ?? ""), text_elements: [] }] };
        return { turnId: current.turn.id };
      }
      case "thread/read": {
        const thread = this.#thread(params.threadId);
        return { thread: thread.historyMode === "paginated" || params.includeTurns === false ? { ...thread, turns: [] } : thread };
      }
      case "thread/settings/update": {
        const thread = this.#thread(params.threadId);
        socket.send(JSON.stringify({ method: "thread/settings/updated", params: { threadId: thread.id, threadSettings: {
          cwd: thread.cwd, approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly", networkAccess: false },
          activePermissionProfile: { id: ":read-only", extends: null }, model: this.model, modelProvider: "openai", serviceTier: null,
          effort: "low", summary: null, collaborationMode: { mode: "default", settings: { model: this.model, reasoning_effort: "low", developer_instructions: null } },
          multiAgentMode: "explicitRequestOnly", personality: null,
        } } }));
        return {};
      }
      case "thread/goal/get": return { goal: null };
      case "thread/name/set": return {};
      case "thread/turns/list": return this.#turnPage(this.#thread(params.threadId), params.sortDirection);
      case "thread/items/list": {
        const thread = this.#thread(params.threadId);
        const data = thread.turns.filter(turn => !params.turnId || turn.id === params.turnId)
          .flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item })));
        return { data: params.sortDirection === "desc" ? data.reverse() : data, nextCursor: null, backwardsCursor: data.length ? "fixture-items-head" : null };
      }
      case "thread/resume": {
        const thread = this.#thread(params.threadId);
        this.#loaded.add(thread.id);
        const page = params.initialTurnsPage as { sortDirection?: string } | undefined;
        return { ...this.#startResult({ ...thread, turns: [] }), initialTurnsPage: page ? this.#turnPage(thread, page.sortDirection) : null,
          turnsBackwardsCursor: page && thread.turns.length ? "fixture-turns-head" : null, itemsBackwardsCursor: thread.turns.some(turn => turn.items.length) ? "fixture-items-head" : null };
      }
      case "thread/unsubscribe": {
        this.#loaded.delete(this.#thread(params.threadId).id);
        return { status: "unsubscribed" };
      }
      default: throw new Error(`outbound_codex_fixture_unexpected_method:${request.method}`);
    }
  }

  #turnPage(thread: CodexThread, direction: unknown) {
    const data = thread.turns.map(turn => ({ ...turn, items: [], itemsView: "notLoaded" }));
    return { data: direction === "desc" ? data.reverse() : data, nextCursor: null, backwardsCursor: data.length ? "fixture-turns-head" : null };
  }

  #thread(id: unknown): CodexThread {
    const thread = typeof id === "string" ? this.#threads.get(id) : undefined;
    if (!thread) throw new Error("outbound_codex_fixture_thread_missing");
    return thread;
  }

  #startResult(thread: CodexThread) {
    return codexThreadStartMethod.decodeResult({
      thread, model: this.model, modelProvider: "openai", serviceTier: null,
      cwd: thread.cwd, runtimeWorkspaceRoots: [thread.cwd], instructionSources: [],
      approvalPolicy: "never", approvalsReviewer: "user",
      sandbox: { type: "readOnly", networkAccess: false },
      activePermissionProfile: { id: ":read-only", extends: null },
      reasoningEffort: "low", multiAgentMode: "explicitRequestOnly",
    });
  }
}
