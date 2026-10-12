import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { getSessionMessages, query, type Query, type SessionMessage, type SDKMessage, type SDKUserMessage, type SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { expect, it, vi } from "vitest";
import { ClaudeInputQueue } from "../../src/server/backends/claude/claude-input-queue.js";
import { claudeCommandLifecycle, claudeResultUserMessageIds } from "../../src/server/backends/claude/claude-result-lifecycle.js";
import { ClaudeSdkSession, CLAUDE_SESSION_STATE_EVENTS_VARIABLE } from "../../src/server/backends/claude/claude-sdk-session.js";
import { CLAUDE_AGENT_SDK_RELEASE, OfficialClaudeSdkFacade, type ClaudeQueryInput } from "../../src/server/backends/claude/claude-sdk-facade.js";
import { ClaudeRuntimeCompactError, type ClaudeRuntimeCompactResult } from "../../src/server/backends/claude/claude-compact-operation.js";
import { readClaudeSessionMessages } from "../../src/server/backends/claude/claude-native-transcript.js";
import { claudeResumableHistoryStart, projectClaudeHistory } from "../../src/server/backends/claude/claude-history-projector.js";

/**
 * Actual pinned SDK + native CLI against an isolated localhost Messages API
 * that reports a nearly full context, so Claude Code compacts automatically.
 * Qualifies the live frames and the transcript rows Sedes reads: the boundary,
 * the synthetic summary that follows it, the rows it keeps, and the result's
 * input identity. The only tool the fixture allows is a fixed `printf`.
 */
type Reply = string | { readonly name: "Bash"; readonly input: Record<string, unknown> };
const FIXTURE_COMMAND = "printf FIXTURE_OUTPUT";
const CONTINUED = "This session is being continued";

async function compactingRun(scenario: "turn-start" | "mid-turn"): Promise<{
  readonly messages: SDKMessage[];
  readonly contexts: SDKControlGetContextUsageResponse[];
  readonly summaryContexts: SDKControlGetContextUsageResponse[];
  readonly prompts: readonly string[];
  readonly history: Awaited<ReturnType<typeof readClaudeSessionMessages>>;
  readonly sdkHistory: Awaited<ReturnType<typeof getSessionMessages>>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-compaction-native-"));
  const home = path.join(root, "home"); const cwd = path.join(root, "workspace");
  const configDirectory = path.join(home, ".claude");
  await mkdir(home); await mkdir(cwd);
  const errors: unknown[] = [];
  let requests = 0;
  let initialInputTokens = 0;
  let tokenCountRequests = 0;
  let releaseAfterSummary!: () => void;
  const afterSummaryRead = new Promise<void>(resolve => { releaseAfterSummary = resolve; });
  const stream = (response: ServerResponse, id: string, reply: Reply, inputTokens: number) => {
    const tool = typeof reply !== "string";
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, rest: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
    send("message_start", { message: { id: `msg_${id}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } });
    send("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `toolu_${id}`, name: reply.name, input: {} } : { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(reply.input) } : { type: "text_delta", text: reply } });
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    send("message_stop", {}); response.end();
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.url?.includes("count_tokens")) tokenCountRequests++;
      if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) { response.writeHead(404).end(); return; }
      expect(request.headers["x-api-key"]).toBe("sedes-local-fixture-only");
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string; content: unknown }[]; system: unknown };
      const transcript = JSON.stringify(body.messages);
      const id = String(++requests);
      expect(requests).toBeLessThanOrEqual(6);
      // Compaction summarizes a provider-selected prefix and can omit the
      // newest assistant/tool response. Identify its explicit summary request,
      // rather than guessing from whether a previous reply appears in it.
      if (transcript.includes("Your task is to create a detailed summary")) {
        stream(response, `s${id}`, "<summary>SYNTHETIC_SUMMARY of the fixture conversation</summary>", 50);
      } else if (transcript.includes(CONTINUED)) {
        // Do not let a later model response make the summary-boundary read
        // appear fresh. The control read must complete before this response.
        await afterSummaryRead;
        stream(response, `a${id}`, "AFTER_COMPACTION", 60);
      }
      else if (!transcript.includes("PROMPT_FIRST")) stream(response, `w${id}`, "WARMUP_DONE", 40);
      else if (scenario === "turn-start") stream(response, `f${id}`, "FIRST_DONE", initialInputTokens);
      else stream(response, `t${id}`, { name: "Bash", input: { command: FIXTURE_COMMAND, description: "fixture" } }, initialInputTokens);
    } catch (error) { errors.push(error); response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address_missing");
  const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  Object.assign(env, { PATH: process.env.PATH, HOME: home, TMPDIR: root, CLAUDE_CONFIG_DIR: configDirectory,
    ANTHROPIC_API_KEY: "sedes-local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", [CLAUDE_SESSION_STATE_EVENTS_VARIABLE]: "1",
    // An explicit window keeps this a threshold-compaction test even when
    // a newer CLI defaults to waiting for an API context-overflow response.
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" });
  const input = new ClaudeInputQueue<SDKUserMessage>();
  const abortController = new AbortController(); const timeout = setTimeout(() => abortController.abort(), 60_000);
  const sessionId = randomUUID();
  const session = query({ prompt: input, options: {
    pathToClaudeCodeExecutable: process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude", cwd, env, sessionId,
    model: "claude-sonnet-5", effort: "low", settingSources: [], strictMcpConfig: true, mcpServers: {}, plugins: [],
    tools: ["Bash"], permissionMode: "default", persistSession: true, maxTurns: 6, abortController, includePartialMessages: true,
    canUseTool: async (name, toolInput) => name === "Bash" && toolInput.command === FIXTURE_COMMAND
      ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: "Only the fixture command is allowed." },
  } });
  const warmups: string[] = [randomUUID(), randomUUID()];
  const prompts = scenario === "turn-start" ? [randomUUID(), randomUUID()] : [randomUUID()];
  const allPrompts = [...warmups, ...prompts];
  const send = (uuid: string, content: string) => input.push({ type: "user", uuid: uuid as ReturnType<typeof randomUUID>,
    session_id: "", parent_tool_use_id: null, message: { role: "user", content } });
  const messages: SDKMessage[] = [];
  const contexts: SDKControlGetContextUsageResponse[] = [];
  const summaryContexts: SDKControlGetContextUsageResponse[] = [];
  let awaitingSummary = false;
  try {
    const consume = (async () => {
      for await (const message of session) {
        messages.push(message);
        if (message.type === "system" && message.subtype === "compact_boundary") awaitingSummary = true;
        if (awaitingSummary && message.type === "user" && message.isSynthetic && message.parent_tool_use_id === null) {
          summaryContexts.push(await session.getContextUsage({ detail: "summary" }));
          awaitingSummary = false;
          releaseAfterSummary();
        }
        if (message.type !== "result") continue;
        const context = await session.getContextUsage({ detail: "summary" });
        if (!warmups.includes(claudeResultUserMessageIds(message)[0]!)) contexts.push(context);
        const settled = messages.filter(({ type }) => type === "result").length;
        if (settled === allPrompts.length) return;
        send(allPrompts[settled]!, settled < warmups.length ? "PROMPT_WARMUP" : settled === warmups.length ? "PROMPT_FIRST" : "PROMPT_SECOND");
      }
    })();
    // Claude model defaults can grow across CLI releases. Size the fixture's
    // almost-full response from the actual window, never a hardcoded model limit.
    await session.initializationResult();
    const initialContext = await session.getContextUsage({ detail: "summary" });
    expect(initialContext.rawMaxTokens).toBeGreaterThan(0);
    initialInputTokens = Math.ceil(initialContext.rawMaxTokens * 0.9);
    // The reactive compactor keeps the newest group. Give it a completed
    // earlier group to summarize as well as the current near-limit exchange.
    send(warmups[0]!, "PROMPT_WARMUP");
    await consume;
    expect(errors).toEqual([]);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDirectory);
    const history = await readClaudeSessionMessages(sessionId, { dir: cwd }, { CLAUDE_CONFIG_DIR: configDirectory });
    const sdkHistory = await getSessionMessages(sessionId, { dir: cwd });
    expect(tokenCountRequests).toBe(0);
    return { messages, prompts, history, sdkHistory, contexts, summaryContexts };
  } finally {
    releaseAfterSummary();
    vi.unstubAllEnvs(); clearTimeout(timeout); input.close(); session.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

const boundaryIndex = (messages: readonly SDKMessage[]) =>
  messages.findIndex(message => message.type === "system" && message.subtype === "compact_boundary");

/** What the handle relies on live: the summary is the next main-thread
 * synthetic user frame, anchored by the boundary it follows. */
function liveCompaction(messages: readonly SDKMessage[]) {
  const boundary = boundaryIndex(messages);
  expect(messages.filter(message => message.type === "system" && message.subtype === "compact_boundary")).toHaveLength(1);
  const summaryIndex = messages.findIndex((message, index) => index > boundary && (message.type === "user" || message.type === "assistant"));
  const frame = messages[boundary] as Extract<SDKMessage, { subtype: "compact_boundary" }>;
  const summary = messages[summaryIndex] as SDKUserMessage;
  expect(frame).toMatchObject({ session_id: expect.any(String), compact_metadata: { trigger: "auto" } });
  expect(summary).toMatchObject({ type: "user", isSynthetic: true, parent_tool_use_id: null, session_id: frame.session_id });
  expect(JSON.stringify(summary.message.content)).toContain(CONTINUED);
  return { frame, summary };
}

it("compacts at a turn's start, keeps its prompt after the summary, and settles it by input identity", async () => {
  const { messages, prompts, history, sdkHistory, contexts, summaryContexts } = await compactingRun("turn-start");
  expect(summaryContexts).toHaveLength(1);
  expect(summaryContexts[0]!.totalTokens).toBeLessThan(contexts[0]!.rawMaxTokens * 0.5);
  expect(contexts).toHaveLength(2);
  expect(contexts[0]!.totalTokens).toBeGreaterThan(contexts[0]!.rawMaxTokens * 0.8);
  expect(contexts[1]!.totalTokens).toBeLessThan(contexts[0]!.totalTokens);
  for (const context of contexts) {
    expect(context.rawMaxTokens).toBeGreaterThan(0);
    expect(context.rawMaxTokens).toBeLessThanOrEqual(context.maxTokens);
    expect(Math.abs(context.percentage - context.totalTokens / context.rawMaxTokens * 100)).toBeLessThanOrEqual(1);
  }
  const { frame, summary } = liveCompaction(messages);
  // Claude Code keeps the new prompt verbatim and relinks it after the summary.
  expect(frame.compact_metadata.preserved_messages).toMatchObject({ anchor_uuid: summary.uuid,
    uuids: expect.arrayContaining([prompts[1]]) });
  const last = messages.filter(({ type }) => type === "result").at(-1)!;
  expect(claudeResultUserMessageIds(last as Extract<SDKMessage, { type: "result" }>)).toEqual([prompts[1]]);

  // Sedes reads the summarized turn, then exactly what the SDK reads.
  expect(history.slice(history.length - sdkHistory.length)).toEqual(sdkHistory);
  const summaryIndex = history.findIndex(message => message.uuid === summary.uuid);
  expect(history.findIndex(message => message.uuid === prompts[0])).toBeLessThan(summaryIndex);
  expect(history.findIndex(message => message.uuid === prompts[1])).toBeGreaterThan(summaryIndex);
  expect(claudeResumableHistoryStart(history)).toBe(summaryIndex);
  const projection = projectClaudeHistory(history);
  const { snapshot } = projection;
  expect(snapshot.orderedBackendTurnIds).toHaveLength(4);
  expect(snapshot.orderedBackendTurnIds.map(id => snapshot.turnsById[id]!.orderedBackendItemIds
    .map(itemId => snapshot.itemsById[itemId]!.semanticKind).sort())).toEqual([
    ["assistant_message", "user_message"],
    ["assistant_message", "user_message"],
    ["assistant_message", "compaction", "user_message"],
    ["assistant_message", "user_message"],
  ]);
  expect(Object.values(snapshot.itemsById).find(item => item.semanticKind === "compaction"))
    .toMatchObject({ summary: { text: expect.stringContaining("SYNTHETIC_SUMMARY") } });
  // The reactive compactor can keep the first answer after the summary.
  // Only native-preserved answers and the new answer remain forkable.
  const firstAnswer = messages.find(message => message.type === "assistant" && JSON.stringify(message.message.content).includes("FIRST_DONE"))!;
  const preserved = frame.compact_metadata.preserved_messages?.uuids ?? [];
  expect([...projection.terminalCheckpointUuidByBackendTurnId.keys()]).toEqual(
    snapshot.orderedBackendTurnIds.slice(preserved.includes(firstAnswer.uuid!) ? 2 : 3),
  );
}, 90_000);

it("compacts mid-turn after a tool round and keeps the turn's prompt", async () => {
  const { messages, prompts, history, sdkHistory, summaryContexts } = await compactingRun("mid-turn");
  expect(summaryContexts).toHaveLength(1);
  expect(summaryContexts[0]!.totalTokens).toBeLessThan(summaryContexts[0]!.rawMaxTokens * 0.5);
  const { summary } = liveCompaction(messages);
  const toolResult = messages.findIndex(message => message.type === "user" && JSON.stringify(message.message.content).includes("FIXTURE_OUTPUT"));
  expect(toolResult).toBeGreaterThanOrEqual(0);
  expect(toolResult).toBeLessThan(boundaryIndex(messages));
  const result = messages.filter(({ type }) => type === "result").at(-1)!;
  expect(claudeResultUserMessageIds(result as Extract<SDKMessage, { type: "result" }>)).toEqual([prompts[0]]);

  expect(history.slice(history.length - sdkHistory.length)).toEqual(sdkHistory);
  expect(history[4]?.uuid).toBe(prompts[0]);
  expect(sdkHistory.map(message => message.uuid)).not.toContain(prompts[0]);
  const { snapshot } = projectClaudeHistory(history);
  expect(snapshot.orderedBackendTurnIds).toHaveLength(3);
  const turn = snapshot.turnsById[snapshot.orderedBackendTurnIds[2]!]!;
  expect(turn.status).toBe("completed");
  const kinds = turn.orderedBackendItemIds.map(itemId => snapshot.itemsById[itemId]!.semanticKind);
  expect(kinds[0]).toBe("user_message");
  expect(kinds.filter(kind => kind === "compaction")).toHaveLength(1);
  expect(kinds.at(-1)).toBe("assistant_message");
  expect(history.find(message => message.uuid === summary.uuid)).toMatchObject({ isCompactSummary: true });
}, 90_000);

/**
 * Uses the real SDK and CLI, with every model request sent to the loopback
 * fixture. Subscription authentication is deliberately simulated at the
 * facade: this qualifies command handling, not a developer's live account.
 * Empty settings sources, hooks, tools, plugins and MCP keep the native child
 * independent of any installed account or executable tool configuration.
 */
class LoopbackCompactionSdk extends OfficialClaudeSdkFacade {
  constructor(readonly onNativeMessage: (message: SDKMessage) => void) { super(); }

  override async readCliAuthStatus() {
    return { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "loopback-fixture" };
  }

  override createQuery(input: ClaudeQueryInput): Query {
    expect(input.options.env?.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(input.options.env?.ANTHROPIC_API_KEY).toBe("sedes-local-fixture-only");
    const nativeQuery = super.createQuery({ ...input, options: {
      ...input.options, settingSources: [], settings: { disableAllHooks: true }, strictMcpConfig: true,
      mcpServers: {}, plugins: [], tools: [], maxTurns: 4,
      canUseTool: async () => ({ behavior: "deny", message: "The loopback compaction fixture cannot use tools." }),
    } });
    const nativeInitialization = nativeQuery.initializationResult.bind(nativeQuery);
    nativeQuery.initializationResult = async () => {
      const initialized = await nativeInitialization();
      return { ...initialized, account: { ...initialized.account, apiProvider: "firstParty", subscriptionType: "loopback-fixture" } };
    };
    const nativeIterator = nativeQuery[Symbol.asyncIterator].bind(nativeQuery);
    const onMessage = this.onNativeMessage;
    nativeQuery[Symbol.asyncIterator] = async function* () {
      for await (const message of { [Symbol.asyncIterator]: nativeIterator }) { onMessage(message); yield message; }
    };
    return nativeQuery;
  }
}

async function manualCompactingRun(scenario: "success" | "empty" | "failure" | "cancelled"): Promise<{
  readonly messages: SDKMessage[];
  readonly delivered: SDKMessage[];
  readonly operationId: string;
  readonly requests: number;
  readonly result?: ClaudeRuntimeCompactResult;
  readonly error?: unknown;
  readonly history: Awaited<ReturnType<typeof readClaudeSessionMessages>>;
  readonly sdkHistory: Awaited<ReturnType<typeof getSessionMessages>>;
  readonly reconciliation: Awaited<ReturnType<ClaudeSdkSession["reconcileCompact"]>>;
  readonly nextSendCompleted: boolean;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-manual-compaction-native-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "workspace");
  await mkdir(home); await mkdir(cwd);
  const errors: unknown[] = [];
  let requests = 0;
  let summaryRequests = 0;
  let summaryRequested!: () => void;
  const pendingSummary = new Promise<void>(resolve => { summaryRequested = resolve; });
  const server = createServer(async (request, response) => {
    try {
      if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
        response.writeHead(404).end(); return;
      }
      expect(request.headers["x-api-key"]).toBe("sedes-local-fixture-only");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: unknown; tools?: unknown[] };
      expect(body.tools ?? []).toEqual([]);
      // Claude can retry a failed summary once. Never permit unbounded work.
      expect(++requests).toBeLessThanOrEqual(4);
      const summary = JSON.stringify(body.messages).includes("Your task is to create a detailed summary");
      if (summary) { summaryRequests++; summaryRequested(); }
      if (summary && scenario === "cancelled") return; // Hold until native interrupt aborts the request.
      if (summary && scenario === "failure") {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "FIXTURE_SUMMARY_FAILURE" } }));
        return;
      }
      const reply = summary ? "<summary>MANUAL_FIXTURE_SUMMARY of the completed fixture exchanges</summary>" : "MANUAL_WARMUP_DONE";
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, rest: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
      send("message_start", { message: { id: `msg_manual_${requests}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1 } } });
      send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      send("message_stop", {}); response.end();
    } catch (error) { errors.push(error); response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address_missing");
  const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  Object.assign(env, { PATH: process.env.PATH, HOME: home, TMPDIR: root, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    ANTHROPIC_API_KEY: "sedes-local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", [CLAUDE_SESSION_STATE_EVENTS_VARIABLE]: "1" });
  const sessionId = randomUUID();
  const operationId = randomUUID();
  const messages: SDKMessage[] = [];
  const delivered: SDKMessage[] = [];
  const waiters = new Set<{ readonly predicate: (message: SDKMessage) => boolean; readonly resolve: (message: SDKMessage) => void }>();
  const waitForFrame = (predicate: (message: SDKMessage) => boolean, fromIndex = messages.length) => new Promise<SDKMessage>(resolve => {
    const existing = messages.slice(fromIndex).find(predicate);
    if (existing) resolve(existing);
    else waiters.add({ predicate, resolve });
  });
  const sdk = new LoopbackCompactionSdk(message => {
    messages.push(message);
    for (const waiter of waiters) if (waiter.predicate(message)) { waiters.delete(waiter); waiter.resolve(message); }
  });
  const session = new ClaudeSdkSession({ sdk, executablePath: process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude",
    initializationTimeoutMs: 10_000, sessionId, cwd, launch: "new", model: "claude-sonnet-5", effort: "low",
    permissionMode: "default", environment: env, onMessage: message => { delivered.push(message); },
  });
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timeout = setTimeout(() => {
    rejectDeadline(new Error("manual_compaction_loopback_deadline"));
    void session.close();
  }, 30_000);
  const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, deadline]);
  try {
    expect(CLAUDE_AGENT_SDK_RELEASE).toBe("0.3.287");
    await bounded(session.start());
    // The production startup marker must not perform a model call.
    expect(requests).toBe(0);
    const startupReceipt = await bounded(waitForFrame(message => message.type === "result" &&
      claudeResultUserMessageIds(message).includes(session.startupProbeUuid!), 0));
    await bounded(waitForFrame(message => message.type === "system" && message.subtype === "session_state_changed" &&
      message.state === "idle", messages.indexOf(startupReceipt) + 1));
    if (scenario !== "empty") for (let index = 0; index < 2; index++) {
      const warmupId = randomUUID();
      const receipt = waitForFrame(message => message.type === "result" && claudeResultUserMessageIds(message).includes(warmupId));
      const idle = waitForFrame(message => message.type === "system" && message.subtype === "session_state_changed" && message.state === "idle");
      session.send({ operationId: warmupId, content: `MANUAL_PROMPT_${index}` });
      await bounded(receipt); await bounded(idle);
    }
    let manualResultSeen = false;
    const compactionDeliveredStart = delivered.length;
    const idle = waitForFrame(message => {
      if (message.type === "result" && claudeResultUserMessageIds(message).includes(operationId)) manualResultSeen = true;
      return manualResultSeen && message.type === "system" && message.subtype === "session_state_changed" && message.state === "idle";
    });
    // Attach both arms before submitting: no rejection can become unhandled.
    const operation = session.compact({ operationId }).then(result => ({ result }), error => ({ error }));
    if (scenario === "cancelled") {
      await bounded(pendingSummary);
      await bounded(session.interrupt({ applicationOperationId: randomUUID(), deadlineAt: Date.now() + 5_000 }));
    }
    const outcome = await bounded(operation);
    await bounded(idle);
    const compactionMessages = [...messages];
    const compactionDelivered = delivered.slice(compactionDeliveredStart);
    const reconciliation = await session.reconcileCompact({ operationId });
    expect(errors).toEqual([]);
    expect(summaryRequests).toBe(scenario === "empty" ? 0 : scenario === "failure" ? 2 : 1);
    const history = await readClaudeSessionMessages(sessionId, { dir: cwd }, env);
    vi.stubEnv("CLAUDE_CONFIG_DIR", env.CLAUDE_CONFIG_DIR!);
    const sdkHistory = await getSessionMessages(sessionId, { dir: cwd });
    let nextSendCompleted = false;
    if (scenario === "cancelled") {
      const nextSendId = randomUUID();
      const receipt = waitForFrame(message => message.type === "result" && claudeResultUserMessageIds(message).includes(nextSendId));
      const idleAfterSend = waitForFrame(message => message.type === "system" && message.subtype === "session_state_changed" && message.state === "idle");
      session.send({ operationId: nextSendId, content: "MANUAL_AFTER_CANCEL" });
      await bounded(receipt); await bounded(idleAfterSend);
      nextSendCompleted = true;
      expect(errors).toEqual([]);
    }
    return { messages: compactionMessages, delivered: compactionDelivered, operationId, requests, ...outcome, history, sdkHistory, reconciliation, nextSendCompleted };
  } finally {
    clearTimeout(timeout); vi.unstubAllEnvs();
    await session.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

function manualFrames(messages: readonly SDKMessage[], operationId: string, terminal: "completed" | "cancelled" = "completed") {
  const first = messages.findIndex(message => claudeCommandLifecycle(message)?.commandUuid === operationId);
  expect(first).toBeGreaterThanOrEqual(0);
  const frames = messages.slice(first);
  expect(frames.map(claudeCommandLifecycle).filter(frame => frame?.commandUuid === operationId).map(frame => frame!.state))
    .toEqual(["queued", "started", terminal]);
  const receipt = frames.find(message => message.type === "result" && claudeResultUserMessageIds(message).includes(operationId));
  expect(receipt).toMatchObject({ type: "result", subtype: "success", is_error: false, num_turns: 0, local_command: "compact" });
  const resultIndex = frames.indexOf(receipt!);
  expect(frames.findIndex(message => claudeCommandLifecycle(message)?.state === terminal)).toBeGreaterThan(resultIndex);
  expect(frames.at(-1)).toMatchObject({ type: "system", subtype: "session_state_changed", state: "idle" });
  return { frames, receipt, resultIndex };
}

// The SDK attaches this native provenance field without declaring it.
const completedLocalCommand = (message: SessionMessage) =>
  (message as SessionMessage & { readonly isCompletedLocalCommand?: boolean }).isCompletedLocalCommand === true;

it("manual compaction completes through the production session with a native boundary and summary", async () => {
  const { messages, delivered, operationId, requests, result, error, history, sdkHistory, reconciliation } = await manualCompactingRun("success");
  expect(requests).toBe(3);
  expect(error).toBeUndefined();
  expect(result).toMatchObject({ outcome: "compacted", nativeResult: { num_turns: 0, local_command: "compact", user_message_uuid: operationId } });
  expect(reconciliation).toMatchObject({ outcome: "accepted", pending: false, nativeResult: result!.nativeResult });
  expect(result!.nativeResult?.modelUsage["claude-sonnet-5"]).toMatchObject({ inputTokens: 120, outputTokens: 3 });
  expect(result!.nativeResult).not.toHaveProperty("result");
  expect(result!.nativeResult).not.toHaveProperty("permission_denials");
  const { frames, resultIndex } = manualFrames(messages, operationId);
  const boundary = boundaryIndex(frames);
  expect(boundary).toBeGreaterThan(1);
  expect(frames[boundary]).toMatchObject({ compact_metadata: { trigger: "manual" } });
  expect(frames[boundary + 1]).toMatchObject({ type: "user", isSynthetic: true, parent_tool_use_id: null });
  expect(JSON.stringify(frames[boundary + 1])).toContain("MANUAL_FIXTURE_SUMMARY");
  expect(resultIndex).toBeGreaterThan(boundary + 1);
  expect(frames.some(message => message.type === "system" && message.subtype === "status" && message.status === "compacting")).toBe(true);
  expect(frames.some(message => message.type === "system" && message.subtype === "local_command_output")).toBe(false);
  expect(delivered.filter(message => message.type === "result")).toHaveLength(0);
  expect(delivered.filter(message => message.type === "user" && message.isSynthetic)).toHaveLength(1);
  expect(delivered.filter(message => message.type === "user" && JSON.stringify(message.message.content).includes("local-command-stdout"))).toHaveLength(0);
  expect(sdkHistory.filter(completedLocalCommand)).toHaveLength(2);
  // The native reader keeps provider provenance, and the projector excludes
  // those command/output rows from the browser conversation.
  expect(history.filter(completedLocalCommand)).toHaveLength(2);
  const { snapshot } = projectClaudeHistory(history);
  expect(snapshot.orderedBackendTurnIds).toHaveLength(2);
  expect(Object.values(snapshot.itemsById).filter(item => item.semanticKind === "compaction"))
    .toMatchObject([{ summary: { text: expect.stringContaining("MANUAL_FIXTURE_SUMMARY") } }]);
}, 45_000);

it("manual compaction with empty history returns an explicit no-op through the production session", async () => {
  const { messages, delivered, operationId, requests, result, error, history, reconciliation } = await manualCompactingRun("empty");
  expect(requests).toBe(0);
  expect(error).toBeUndefined();
  expect(result).toMatchObject({ outcome: "noop", message: expect.stringMatching(/not enough (?:conversation history|messages) to compact/iu) });
  expect(reconciliation).toMatchObject({ outcome: "accepted", pending: false, nativeResult: { user_message_uuid: operationId } });
  const { frames } = manualFrames(messages, operationId);
  expect(boundaryIndex(frames)).toBe(-1);
  expect(frames.find(message => message.type === "assistant")).toMatchObject({
    message: { model: "<synthetic>", content: [{ type: "text", text: "Not enough messages to compact." }] },
    local_command_run: { command: "compact", args: "" },
  });
  expect(delivered.filter(message => message.type === "assistant" || message.type === "result")).toEqual([]);
  expect(projectClaudeHistory(history).snapshot.orderedBackendTurnIds).toHaveLength(0);
}, 45_000);

it("manual compaction rejects a failed native summary despite the success-shaped command receipt", async () => {
  const { messages, delivered, operationId, requests, result, error, history, reconciliation } = await manualCompactingRun("failure");
  expect(requests).toBe(4);
  expect(result).toBeUndefined();
  expect(error).toBeInstanceOf(ClaudeRuntimeCompactError);
  expect(reconciliation).toMatchObject({ outcome: "not_applied", pending: false, nativeResult: { user_message_uuid: operationId } });
  const { frames, receipt } = manualFrames(messages, operationId);
  expect(boundaryIndex(frames)).toBe(-1);
  expect(frames.find(message => message.type === "system" && message.subtype === "status" && message.compact_result === "failed"))
    .toMatchObject({ compact_error: expect.stringContaining("FIXTURE_SUMMARY_FAILURE") });
  expect(receipt).toMatchObject({ result: expect.stringContaining("FIXTURE_SUMMARY_FAILURE") });
  expect(delivered.filter(message => message.type === "result")).toHaveLength(0);
  expect(projectClaudeHistory(history).snapshot.orderedBackendTurnIds).toHaveLength(2);
}, 45_000);

it("manual compaction stops a pending loopback summary without publishing a successful boundary", async () => {
  const { messages, delivered, operationId, requests, result, error, history, reconciliation, nextSendCompleted } = await manualCompactingRun("cancelled");
  expect(requests).toBe(4);
  expect(result).toBeUndefined();
  expect(error).toBeInstanceOf(ClaudeRuntimeCompactError);
  expect(reconciliation).toMatchObject({ outcome: "not_applied", pending: false, nativeResult: { user_message_uuid: operationId } });
  expect(nextSendCompleted).toBe(true);
  const { frames } = manualFrames(messages, operationId, "cancelled");
  expect(boundaryIndex(frames)).toBe(-1);
  expect(frames.find(message => message.type === "system" && message.subtype === "status" && message.compact_result === "failed"))
    .toMatchObject({ compact_error: "API Error: Request was aborted." });
  expect(delivered.filter(message => message.type === "assistant" || message.type === "result")).toEqual([]);
  expect(projectClaudeHistory(history).snapshot.orderedBackendTurnIds).toHaveLength(2);
}, 45_000);
