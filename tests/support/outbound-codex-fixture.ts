import { chmod } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { codexThreadReadMethod, type CodexThread } from "../../src/server/backends/codex/codex-c1-protocol.js";
import { codexModelListMethod, codexThreadStartMethod } from "../../src/server/backends/codex/codex-c2-protocol.js";

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
          const result = this.#respond(request);
          socket.send(JSON.stringify({ id: request.id, result }));
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

  #respond(request: OutboundCodexFixtureRequest): unknown {
    const params = request.params ?? {};
    switch (request.method) {
      case "initialize": return {
        userAgent: "sedes_web/0.153.0 (Linux 6.8; x86_64) unknown (sedes_web; 0.1.0)",
        codexHome: this.#codexHome,
        platformFamily: "unix",
        platformOs: process.platform === "darwin" ? "macos" : "linux",
      };
      case "account/read": return { account: null, requiresOpenaiAuth: false };
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
          sectionEnteredAt: null, projectId: null, historyMode: "legacy",
          modelProvider: "openai", model: this.model, reasoningEffort: "low",
          createdAt: 1_700_000_000, updatedAt: 1_700_000_000, recencyAt: 1_700_000_000,
          status: { type: "idle" }, path: path.join(this.#codexHome, "sessions", `${id}.jsonl`),
          cwd, cliVersion: "0.153.0", source: "appServer", canAcceptDirectInput: true,
          threadSource: null, agentNickname: null, agentRole: null, gitInfo: null,
          name: null, turns: [],
        } }).thread;
        this.#threads.set(id, thread);
        this.#loaded.add(id);
        return this.#startResult(thread);
      }
      case "thread/read": return { thread: this.#thread(params.threadId) };
      case "thread/resume": {
        const thread = this.#thread(params.threadId);
        this.#loaded.add(thread.id);
        return { ...this.#startResult(thread), initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
      }
      case "thread/unsubscribe": {
        this.#loaded.delete(this.#thread(params.threadId).id);
        return { status: "unsubscribed" };
      }
      default: throw new Error(`outbound_codex_fixture_unexpected_method:${request.method}`);
    }
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
