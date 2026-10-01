import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { getSessionMessages, query, type SDKMessage, type SDKUserMessage, type SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { expect, it, vi } from "vitest";
import { ClaudeInputQueue } from "../../src/server/backends/claude/claude-input-queue.js";
import { claudeResultUserMessageIds } from "../../src/server/backends/claude/claude-result-lifecycle.js";
import { CLAUDE_SESSION_STATE_EVENTS_VARIABLE } from "../../src/server/backends/claude/claude-sdk-session.js";
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
