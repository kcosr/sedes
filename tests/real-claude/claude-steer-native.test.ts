import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { ClaudeInputQueue } from "../../src/server/backends/claude/claude-input-queue.js";
import { claudeCommandLifecycle, claudeResultUserMessageIds } from "../../src/server/backends/claude/claude-result-lifecycle.js";
import { cancelClaudeQueuedInput } from "../../src/server/backends/claude/claude-sdk-session.js";
import { readClaudeSessionMessages } from "../../src/server/backends/claude/claude-native-transcript.js";
import { projectClaudeHistory } from "../../src/server/backends/claude/claude-history-projector.js";

/** Actual native CLI with an isolated localhost provider and one finite command.
 * No subscription credentials or existing session state enter this fixture.
 * Sedes' Stop withdraws each steer (`cancelClaudeQueuedInput`), then interrupts.
 * `stop-pending`: a steer Claude has not started never reaches the provider or
 * history. `stop-after-fold`: one Claude folded into the turn before Stop
 * stays with that turn. `two-folded`: Claude starts two steers at one tool
 * boundary, which is where Sedes accepts and places each of them. */
it.each(["tool-boundary", "two-folded", "turn-finished", "stop-pending", "stop-after-fold", "slow-provider-history"] as const)("native next delivers at %s without preempting or duplicating", async scenario => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-steer-native-"));
  const home = path.join(root, "home"); const cwd = path.join(root, "workspace");
  await mkdir(home); await mkdir(cwd);
  const marker = path.join(cwd, "started"), release = path.join(cwd, "release"), finished = path.join(cwd, "finished");
  const command = `: > '${marker}'; i=0; while [ "$i" -lt 150 ]; do if [ -f '${release}' ]; then : > '${finished}'; printf 'TOOL_FINISHED'; exit 0; fi; i=$((i+1)); sleep 0.1; done; exit 42`;
  const toolScenario = scenario === "tool-boundary" || scenario === "two-folded" || scenario === "stop-pending" || scenario === "stop-after-fold";
  const persistSession = scenario === "slow-provider-history" || scenario === "stop-pending" || scenario === "two-folded";
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>(resolve => { releaseProvider = resolve; });
  const requests: { released: boolean; correction: boolean; followUp: boolean; finished: boolean }[] = [];
  const errors: unknown[] = [];
  let released = false;
  const stream = (response: ServerResponse, ordinal: number, command?: string) => {
    const usage = { input_tokens: 1, output_tokens: 1 };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, rest: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
    send("message_start", { message: { id: `msg_steer_${ordinal}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage } });
    send("content_block_start", { index: 0, content_block: command ? { type: "tool_use", id: `toolu_steer_${ordinal}`, name: "Bash", input: {} } : { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: command ? { type: "input_json_delta", partial_json: JSON.stringify({ command, description: "Finite local steer fixture", timeout: 20000 }) } : { type: "text_delta", text: "STEER_DONE" } });
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: command ? "tool_use" : "end_turn", stop_sequence: null }, usage });
    send("message_stop", {}); response.end();
  };
  const server = createServer(async (request, response) => {
    try {
      if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) { response.writeHead(404).end(); return; }
      expect(request.headers["x-api-key"]).toBe("sedes-local-fixture-only");
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const messages = JSON.stringify(JSON.parse(Buffer.concat(chunks).toString()).messages);
      requests.push({ released, correction: messages.includes("STEER_CORRECTION"), followUp: messages.includes("STEER_FOLLOW_UP"),
        finished: messages.includes("TOOL_FINISHED") });
      expect(requests.length).toBeLessThanOrEqual(3);
      if ((scenario === "slow-provider-history" && requests.length === 1) ||
          (scenario === "stop-after-fold" && requests.length === 2)) await providerGate;
      // Stop aborts a held request; its late answer has nowhere to go.
      if (response.destroyed) return;
      stream(response, requests.length, toolScenario && requests.length === 1 ? command : undefined);
    } catch (error) { errors.push(error); response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("address_missing");
  const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  Object.assign(env, { PATH: process.env.PATH, HOME: home, TMPDIR: root, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_API_KEY: "sedes-local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" });
  const input = new ClaudeInputQueue<SDKUserMessage>(); const firstId = randomUUID(), secondId = randomUUID(), thirdId = randomUUID();
  const user = (uuid: ReturnType<typeof randomUUID>, content: string, priority?: "next"): SDKUserMessage => ({ type: "user", uuid, session_id: "", parent_tool_use_id: null, message: { role: "user", content }, ...(priority ? { priority } : {}) });
  const abortController = new AbortController(); const timeout = setTimeout(() => abortController.abort(), 30_000);
  const session = query({ prompt: input, options: {
    pathToClaudeCodeExecutable: process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude", cwd, env,
    model: "claude-sonnet-5", effort: "low", settingSources: [], strictMcpConfig: true, mcpServers: {}, plugins: [],
    tools: ["Bash"], permissionMode: "default", persistSession, maxTurns: 4, abortController,
    canUseTool: async (name, toolInput) => name === "Bash" && toolInput.command === command
      ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: "Only the finite fixture command is allowed." },
  } });
  const events: SDKMessage[] = [];
  const consume = (async () => { for await (const message of session) events.push(message); })();
  void consume.catch(error => errors.push(error));
  const lifecycleOf = (uuid: string) => events.flatMap(event => {
    const lifecycle = claudeCommandLifecycle(event);
    return lifecycle?.commandUuid === uuid ? [lifecycle.state] : [];
  });
  const lifecycleAt = (uuid: string, state: string) => events.findIndex(event =>
    claudeCommandLifecycle(event)?.commandUuid === uuid && claudeCommandLifecycle(event)?.state === state);
  const sdkModule = new URL("../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs", import.meta.url).href;
  // Run the official history helper in the exact isolated CLI environment;
  // never inspect the developer's real profile or change process.env.
  const nativeHistory = async () => {
    const nativeSessionId = events.find(event => event.type === "system" && event.subtype === "init")?.session_id;
    expect(nativeSessionId).toBeTruthy();
    const script = `import { getSessionMessages } from ${JSON.stringify(sdkModule)}; process.stdout.write(JSON.stringify(await getSessionMessages(process.argv[1], { dir: process.argv[2] })));`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, nativeSessionId!, cwd], { env, timeout: 5000 });
    return JSON.parse(stdout) as Array<{ type: string; uuid: string }>;
  };
  const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 25000;
    while (!(await predicate())) { if (errors.length) throw errors[0]; if (Date.now() > deadline) throw new Error(`native_steer_timeout: ${JSON.stringify({ requests, results: events.filter(event => event.type === "result").map(event => ({ ids: claudeResultUserMessageIds(event), reason: event.terminal_reason })) })}`); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  try {
    input.push(user(firstId, "Run the finite fixture."));
    if (scenario === "slow-provider-history") {
      await waitFor(() => requests.length === 1);
      await waitFor(async () => (await nativeHistory()).some(message => message.type === "user" && message.uuid === firstId));
      expect(events.some(event => event.type === "assistant" || event.type === "result")).toBe(false);
      releaseProvider();
    }
    if (toolScenario) await waitFor(() => stat(marker).then(() => true, () => false));
    else await waitFor(() => events.some(event => event.type === "result"));
    input.push(user(secondId, "STEER_CORRECTION", "next"));
    if (scenario === "two-folded") input.push(user(thirdId, "STEER_FOLLOW_UP", "next"));
    if (toolScenario) {
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(requests).toHaveLength(1);
      expect(events.filter(event => event.type === "result")).toHaveLength(0);
      if (scenario === "stop-pending") {
        await waitFor(() => lifecycleOf(secondId).includes("queued"));
        await expect(cancelClaudeQueuedInput(session, secondId)).resolves.toBe(true);
        // Exact evidence: `cancelled` with no `started` for that input.
        await waitFor(() => lifecycleOf(secondId).includes("cancelled"));
        expect(lifecycleOf(secondId)).toEqual(["queued", "cancelled"]);
        const receipt = await session.interrupt();
        expect(receipt?.still_queued ?? []).not.toContain(secondId);
      }
      released = true; await writeFile(release, "release");
    }
    if (scenario === "two-folded") {
      await waitFor(() => events.some(event => event.type === "result"));
      const resultAt = events.findIndex(event => event.type === "result");
      const toolResultAt = events.findIndex(event => event.type === "user" && JSON.stringify(event.message.content).includes("TOOL_FINISHED"));
      const answerAt = events.findIndex(event => event.type === "assistant" && JSON.stringify(event.message.content).includes("STEER_DONE"));
      // Sedes accepts each steer at its own `started`: in order, after the
      // tool result and before the next reply and the turn's result. No
      // result came since the turn began, so both join it.
      expect(lifecycleOf(secondId)).toEqual(["queued", "started", "completed"]);
      expect(lifecycleOf(thirdId)).toEqual(["queued", "started", "completed"]);
      expect(toolResultAt).toBeLessThan(lifecycleAt(secondId, "started"));
      expect(lifecycleAt(secondId, "started")).toBeLessThan(lifecycleAt(thirdId, "started"));
      expect(lifecycleAt(thirdId, "started")).toBeLessThan(answerAt);
      expect(answerAt).toBeLessThan(resultAt);
      expect(events.slice(lifecycleAt(firstId, "started"), lifecycleAt(thirdId, "started")).some(event => event.type === "result")).toBe(false);
      // The result's consumption list agrees with that placement.
      const results = events.filter(event => event.type === "result");
      expect(results).toHaveLength(1);
      expect(claudeResultUserMessageIds(results[0]!)).toEqual([firstId, secondId, thirdId]);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({ correction: true, followUp: true, finished: true });
      // History keeps both where Claude took them, and Sedes projects them
      // there with the placement it recorded at each start.
      const nativeSessionId = events.find(event => event.type === "system" && event.subtype === "init")!.session_id;
      const history = await readClaudeSessionMessages(nativeSessionId, { dir: cwd }, env);
      const blocks = (message: { readonly message: unknown }) => {
        const content = (message.message as { content?: unknown }).content;
        return Array.isArray(content) ? content.map(block => (block as { type: string }).type).join(",") : "text";
      };
      expect(history.map(message => [firstId, secondId, thirdId].some(id => id === message.uuid) ? message.uuid : `${message.type}:${blocks(message)}`))
        .toEqual([firstId, "assistant:tool_use", "user:tool_result", secondId, thirdId, "assistant:text"]);
      expect(history.filter(message => message.uuid === secondId || message.uuid === thirdId))
        .toEqual([expect.objectContaining({ isQueuedCommand: true }), expect.objectContaining({ isQueuedCommand: true })]);
      const projected = projectClaudeHistory(history, [], {
        steerOperations: new Map([[secondId, firstId], [thirdId, firstId]]),
        attachmentProvenanceKey: new Uint8Array(32),
        forkBoundaryAuthentication: { installationKey: new Uint8Array(32).fill(1), tenantId: "fixture", principalId: "fixture", backendInstanceId: "fixture" },
      }).snapshot;
      expect(projected.orderedBackendTurnIds).toHaveLength(1);
      const turn = projected.turnsById[projected.orderedBackendTurnIds[0]!]!;
      expect(turn.completionCorrelations).toEqual([firstId, secondId, thirdId]);
      expect(turn.orderedBackendItemIds.map(id => {
        const item = projected.itemsById[id]!;
        return item.semanticKind === "user_message" ? item.deliveryOperationId : item.semanticKind;
      })).toEqual([firstId, "command", secondId, thirdId, "assistant_message"]);
      expect(errors).toEqual([]);
      return;
    }
    if (scenario === "stop-after-fold") {
      // Claude folds the steer into the turn at the tool boundary, then asks
      // the provider, which holds the answer until after Stop.
      await waitFor(() => requests.length === 2);
      expect(requests[1]).toMatchObject({ correction: true, finished: true });
      await waitFor(() => lifecycleOf(secondId).includes("started"));
      // Claude no longer holds it as queued input, so it withdraws nothing.
      await expect(cancelClaudeQueuedInput(session, secondId)).resolves.toBe(false);
      const receipt = await session.interrupt();
      expect(receipt?.still_queued ?? []).not.toContain(secondId);
      await waitFor(() => events.some(event => event.type === "result"));
      // The interrupted turn closes the inputs it started `cancelled`; the
      // result stamp still names the steer, so it stays with this turn.
      expect(lifecycleOf(secondId)).toEqual(["queued", "started", "cancelled"]);
      const results = events.filter(event => event.type === "result");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ is_error: true, terminal_reason: "aborted_streaming" });
      expect(claudeResultUserMessageIds(results[0]!)).toEqual([firstId, secondId]);
      expect(requests).toHaveLength(2);
      expect(errors).toEqual([]);
      return;
    }
    if (scenario === "stop-pending") {
      await waitFor(() => events.some(event => event.type === "result"));
      // Nothing was left to run: no later turn, request, or history row.
      await new Promise(resolve => setTimeout(resolve, 1_500));
      const results = events.filter(event => event.type === "result");
      expect(results).toHaveLength(1);
      expect(results[0]!.terminal_reason).toBe("aborted_tools");
      expect(claudeResultUserMessageIds(results[0]!)).not.toContain(secondId);
      expect(requests).toHaveLength(1);
      expect(lifecycleOf(secondId)).toEqual(["queued", "cancelled"]);
      const history = await nativeHistory();
      expect(history.some(message => message.uuid === secondId)).toBe(false);
      expect(JSON.stringify(history)).not.toContain("STEER_CORRECTION");
      expect(errors).toEqual([]);
      return;
    }
    await waitFor(() => events.some(event => event.type === "result" && claudeResultUserMessageIds(event).includes(secondId)));
    const results = events.filter(event => event.type === "result");
    expect(results.filter(event => claudeResultUserMessageIds(event).includes(secondId))).toHaveLength(1);
    expect(results.filter(event => claudeResultUserMessageIds(event).includes(secondId)).every(event => !event.is_error)).toBe(true);
    expect(results.every(event => !event.is_error)).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.correction).toBe(true);
    if (toolScenario) {
      expect(await stat(finished).then(() => true)).toBe(true);
      expect(requests[1]).toMatchObject({ released: true, finished: true });
      expect(results).toHaveLength(1);
      expect(claudeResultUserMessageIds(results[0]!)).toEqual([firstId, secondId]);
    } else {
      expect(results).toHaveLength(2);
      // Taken after the first turn's result, the steer starts the next turn.
      expect(lifecycleAt(secondId, "started")).toBeGreaterThan(events.indexOf(results[0]!));
      expect(claudeResultUserMessageIds(results[0]!)).toEqual([firstId]);
    }
    expect(errors).toEqual([]);
  } finally {
    clearTimeout(timeout); releaseProvider(); await writeFile(release, "cleanup"); input.close(); session.close(); await consume.catch(() => {});
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
  }
});
