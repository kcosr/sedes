import type {
  Query,
  NonNullableUsage,
  SDKAssistantMessage,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { ClaudeInputQueue } from "../../src/server/backends/claude/claude-input-queue.js";
import type {
  ClaudeQueryInput,
  ClaudeSdkFacade,
} from "../../src/server/backends/claude/claude-sdk-facade.js";

// The esbuild override must match ONLY worker-main's facade import. Re-exporting
// the real module preserves release constants/types for other worker imports.
export * from "../../src/server/backends/claude/claude-sdk-facade.js";
export { FakeOutboundClaudeSdkFacade as OfficialClaudeSdkFacade };

export const OUTBOUND_CLAUDE_FIXTURE_LOG = ".outbound-claude-events.jsonl";
export const OUTBOUND_CLAUDE_PERMISSION_PROMPT = "[outbound-permission]";

export interface OutboundClaudeFixtureEvent {
  readonly event: "query_open" | "startup_probe" | "send" | "permission_pending" |
    "permission_resolved" | "result" | "interrupt" | "query_close" | "query_error";
  readonly pid: number;
  readonly queryId: string;
  readonly sessionId: string;
  readonly sendCount: number;
  readonly operationId?: string;
  readonly behavior?: string;
}

/** Offline SDK facade loaded inside the real owned worker by test-only esbuild. */
export class FakeOutboundClaudeSdkFacade implements ClaudeSdkFacade {
  readonly #sessions = new Map<string, { info: SDKSessionInfo; messages: SessionMessage[] }>();
  #queryCount = 0;

  async readCliRelease(): Promise<string> { return "2.1.274"; }
  async readCliAuthStatus() {
    return { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "Claude Max" };
  }
  async listSessions() { return [...this.#sessions.values()].map((value) => value.info); }
  async getSessionInfo(sessionId: string) { return this.#sessions.get(sessionId)?.info; }
  async getSessionMessages(sessionId: string) { return [...(this.#sessions.get(sessionId)?.messages ?? [])]; }
  async renameSession(sessionId: string, title: string) {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error("outbound_claude_fixture_session_missing");
    session.info = { ...session.info, customTitle: title, summary: title };
  }

  createQuery(input: ClaudeQueryInput): Query {
    if (++this.#queryCount > 128) throw new Error("outbound_claude_fixture_query_limit");
    if (typeof input.prompt === "string") throw new Error("outbound_claude_fixture_streaming_input_required");
    const sessionId = input.options.sessionId ?? input.options.resume ?? randomUUID();
    const queryId = randomUUID();
    const cwd = input.options.cwd;
    if (!cwd || !path.isAbsolute(cwd)) throw new Error("outbound_claude_fixture_cwd_invalid");
    const directory = input.options.env?.CLAUDE_CONFIG_DIR ?? cwd;
    if (!path.isAbsolute(directory)) throw new Error("outbound_claude_fixture_log_directory_invalid");
    const filename = path.join(directory, OUTBOUND_CLAUDE_FIXTURE_LOG);
    const messages = new ClaudeInputQueue<SDKMessage>(32);
    const iterator = input.prompt[Symbol.asyncIterator]();
    const controller = new AbortController();
    let currentTurn: AbortController | undefined;
    let sendCount = 0;
    let closed = false;
    let finishClose!: () => void;
    const didClose = new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
      finishClose = () => resolve({ done: true, value: undefined });
    });
    const log = (event: OutboundClaudeFixtureEvent["event"], extra: { operationId?: string; behavior?: string } = {}) => {
      appendFileSync(filename, `${JSON.stringify({ event, pid: process.pid, queryId, sessionId, sendCount, ...extra })}\n`, { mode: 0o600 });
    };
    const emit = (message: SDKMessage) => {
      if (closed) return;
      messages.push(message);
      if ((message.type === "user" || message.type === "assistant") && input.options.persistSession !== false) {
        const session = this.#sessions.get(sessionId);
        if (session) {
          if (!message.uuid) throw new Error("outbound_claude_fixture_message_identity_missing");
          session.messages.push({
            type: message.type,
            uuid: message.uuid,
            session_id: sessionId,
            message: message.message,
            parent_tool_use_id: message.parent_tool_use_id,
            parent_agent_id: null,
          });
          session.info = { ...session.info, lastModified: Date.now() };
        }
      }
    };
    const close = () => {
      if (closed) return;
      log("query_close");
      closed = true;
      controller.abort(new Error("outbound_claude_fixture_closed"));
      currentTurn?.abort(controller.signal.reason);
      finishClose();
      messages.close();
      input.options.abortController?.signal.removeEventListener("abort", close);
      void iterator.return?.();
    };
    log("query_open");
    emit({
      type: "system", subtype: "init", apiKeySource: "oauth", claude_code_version: "2.1.274",
      cwd, tools: input.options.persistSession === false ? [] : ["Bash"], mcp_servers: [],
      model: "claude-sonnet-5", permissionMode: input.options.permissionMode ?? "default",
      slash_commands: [], output_style: "default", skills: [], plugins: [], uuid: randomUUID(), session_id: sessionId,
    });
    input.options.abortController?.signal.addEventListener("abort", close, { once: true });
    if (input.options.abortController?.signal.aborted) close();

    const run = async () => {
      while (!closed) {
        const next = await Promise.race([iterator.next(), didClose]);
        if (next.done || closed) return;
        const prompt = next.value;
        if (prompt.shouldQuery === false || prompt.isSynthetic === true) {
          log("startup_probe", { ...(prompt.uuid ? { operationId: prompt.uuid } : {}) });
          continue;
        }
        if (++sendCount > 32) throw new Error("outbound_claude_fixture_send_limit");
        const operationId = prompt.uuid;
        if (!operationId) throw new Error("outbound_claude_fixture_operation_missing");
        log("send", { operationId });
        if (input.options.persistSession !== false && !this.#sessions.has(sessionId)) {
          this.#sessions.set(sessionId, {
            info: { sessionId, summary: "Offline outbound Claude conversation", cwd, lastModified: Date.now() },
            messages: [],
          });
        }
        emit({ ...prompt, session_id: sessionId });
        currentTurn = new AbortController();
        let response = "Offline outbound Claude response.";
        const text = typeof prompt.message.content === "string" ? prompt.message.content : JSON.stringify(prompt.message.content);
        if (text.includes(OUTBOUND_CLAUDE_PERMISSION_PROMPT)) {
          if (!input.options.canUseTool) throw new Error("outbound_claude_fixture_permission_callback_missing");
          const toolUseID = `outbound-tool-${randomUUID()}`;
          const requestId = `outbound-permission-${randomUUID()}`;
          const toolInput = { command: "printf outbound-fixture", description: "Offline fixture permission request" };
          emit(assistant(sessionId, [{ type: "tool_use", id: toolUseID, name: "Bash", input: toolInput }], "tool_use"));
          log("permission_pending", { operationId });
          const permission = await input.options.canUseTool("Bash", toolInput, {
            signal: AbortSignal.any([controller.signal, currentTurn.signal]), toolUseID, requestId,
          });
          if (closed) return;
          if (!permission) throw new Error("outbound_claude_fixture_permission_result_missing");
          log("permission_resolved", { operationId, behavior: permission.behavior });
          response = permission.behavior === "allow" ? "Offline permission approved." : "Offline permission denied.";
          emit({ type: "user", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseID, content: response, is_error: permission.behavior !== "allow" }] } });
        }
        if (closed) return;
        emit(assistant(sessionId, [{ type: "text", text: response, citations: null }], "end_turn"));
        emit({
          type: "result", subtype: "success", duration_ms: 1, duration_api_ms: 0,
          is_error: false, num_turns: 1, result: response, stop_reason: "end_turn", total_cost_usd: 0,
          usage: usage(), modelUsage: {}, permission_denials: [], user_message_uuid: operationId,
          uuid: randomUUID(), session_id: sessionId,
        });
        log("result", { operationId });
        currentTurn = undefined;
      }
    };
    void run().catch((error: unknown) => {
      if (closed) return;
      log("query_error");
      messages.fail(error);
    });
    return Object.assign(messages[Symbol.asyncIterator](), {
      [Symbol.asyncIterator]() { return this; },
      initializationResult: async () => initialization(),
      interrupt: async () => {
        log("interrupt");
        currentTurn?.abort(new Error("outbound_claude_fixture_interrupted"));
        return { still_queued: [] };
      },
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      applyFlagSettings: async () => undefined,
      close,
    }) as unknown as Query;
  }
}

function initialization(): SDKControlInitializeResponse {
  return {
    commands: [], agents: [], output_style: "default", available_output_styles: ["default"],
    models: [{ value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Claude Sonnet 5",
      description: "Offline deterministic fixture", supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] }],
    account: { apiProvider: "firstParty", subscriptionType: "Claude Max", tokenSource: "oauth" },
  };
}

function usage(): NonNullableUsage {
  return { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: "standard", inference_geo: "not_available", iterations: [], speed: "standard",
    fallback_credit: { status: { type: "not_applied", reason: "not_enabled" } },
    output_tokens_details: { thinking_tokens: 0 },
  };
}

function assistant(
  sessionId: string,
  content: SDKAssistantMessage["message"]["content"],
  stopReason: SDKAssistantMessage["message"]["stop_reason"],
): SDKAssistantMessage {
  return { type: "assistant", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null,
    message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model: "claude-sonnet-5",
      content, stop_reason: stopReason, stop_sequence: null, usage: usage(),
      container: null, context_management: null, diagnostics: null, stop_details: null,
    },
  };
}
