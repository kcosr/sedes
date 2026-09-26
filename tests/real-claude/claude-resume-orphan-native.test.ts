import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";

/** Actual pinned SDK + native CLI against an isolated localhost Messages API.
 * Qualifies the evidence Sedes uses to name background work a resumed query
 * reports its killed predecessor left unfinished: a task_notification for a
 * task the new query never started. No provider credentials are used. */
it("reports a background task a killed process left unfinished when its session resumes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-claude-orphan-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await mkdir(home, { mode: 0o700 });
  await mkdir(workspace, { mode: 0o700 });
  const releaseFile = path.join(workspace, "release");
  const startedFile = path.join(workspace, "started");
  const command = `: > '${startedFile}'; i=0; while [ "$i" -lt 300 ]; do if [ -f '${releaseFile}' ]; then printf 'SEDES_BACKGROUND_DONE\\n'; exit 0; fi; i=$((i + 1)); sleep 0.1; done; exit 42`;
  const errors: unknown[] = [];
  let requests = 0;
  const server = createServer(async (request, response) => {
    try {
      for await (const _chunk of request) { /* drain */ }
      if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
        response.writeHead(404).end();
        return;
      }
      expect(request.headers["x-api-key"]).toBe("sedes-local-fixture-only");
      const ordinal = ++requests;
      expect(ordinal).toBeLessThanOrEqual(8);
      if (ordinal === 1) stream(response, `r${ordinal}`, { name: "Bash", input: { command, description: "Wait for fixture release", run_in_background: true, timeout: 40_000 } });
      else stream(response, `r${ordinal}`, "SEDES_FIXTURE_DONE");
    } catch (error) {
      errors.push(error);
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address_missing");
  const environment: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
  Object.assign(environment, {
    PATH: process.env.PATH, HOME: home, TMPDIR: root, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    ANTHROPIC_API_KEY: "sedes-local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
  });
  const sessionId = randomUUID();
  const options = (abortController: AbortController) => ({
    pathToClaudeCodeExecutable: process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude",
    cwd: workspace, env: environment, model: "claude-sonnet-5", effort: "low" as const,
    settingSources: [], strictMcpConfig: true, mcpServers: {}, plugins: [], tools: ["Bash"],
    permissionMode: "default" as const, maxTurns: 4, abortController,
    canUseTool: async (name: string, input: Record<string, unknown>) => name === "Bash" && input.command === command
      ? { behavior: "allow" as const, updatedInput: input }
      : { behavior: "deny" as const, message: "Only the exact deterministic fixture tool is permitted." },
  });
  const prompt = (text: string, closed: Promise<void>) => (async function* (): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" };
    await closed;
  })();
  let closeFirst!: () => void;
  let closeSecond!: () => void;
  const first: SDKMessage[] = [];
  const second: SDKMessage[] = [];
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const timeout = setTimeout(() => { firstAbort.abort(); secondAbort.abort(); }, 60_000);
  try {
    let taskId: string | undefined;
    const original = query({ prompt: prompt("Start the background fixture.", new Promise(resolve => { closeFirst = resolve; })),
      options: { ...options(firstAbort), sessionId } });
    for await (const message of original) {
      first.push(message);
      if (message.type === "system" && message.subtype === "task_started") taskId = message.task_id;
      if (message.type === "result") break;
    }
    expect(taskId, JSON.stringify(first.map(summary))).toBeDefined();
    await waitForFile(startedFile);
    // The process dies while its background command is still running.
    firstAbort.abort();
    original.close();
    await writeFile(releaseFile, "release after the owner died");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const resumed = query({ prompt: prompt("Continue.", new Promise(resolve => { closeSecond = resolve; })),
      options: { ...options(secondAbort), resume: sessionId } });
    let orphan: SDKMessage | undefined;
    let results = 0;
    for await (const message of resumed) {
      second.push(message);
      if (message.type === "system" && message.subtype === "task_started") throw new Error("resumed_query_started_a_task");
      if (message.type === "system" && message.subtype === "task_notification" && message.task_id === taskId) orphan = message;
      if (message.type === "result" && ++results >= 1 && orphan) break;
    }
    expect(errors).toEqual([]);
    // The resumed query never started this task; its notification ends it.
    expect(orphan, JSON.stringify(second.map(summary))).toMatchObject({ task_id: taskId, status: expect.stringMatching(/^(stopped|failed)$/u) });
    expect(orphan && "ambient" in orphan ? orphan.ambient : undefined).not.toBe(true);
  } finally {
    clearTimeout(timeout);
    await writeFile(releaseFile, "cleanup release");
    closeFirst?.(); closeSecond?.();
    secondAbort.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

function summary(message: SDKMessage): unknown {
  if (message.type === "system") {
    const { subtype } = message;
    if (subtype === "task_notification") return { subtype, status: message.status, reason: message.reason, task: message.task_id };
    if (subtype === "task_started") return { subtype, task: message.task_id };
    return { subtype };
  }
  return { type: message.type };
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { await stat(file); return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("fixture_command_did_not_start");
}

function stream(response: ServerResponse, id: string, content: string | { name: string; input: Record<string, unknown> }): void {
  const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const tool = typeof content !== "string";
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type: string, fields: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  send("message_start", { message: { id: `msg_${id}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage } });
  send("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `toolu_${id}`, name: content.name, input: {} } : { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) } : { type: "text_delta", text: content } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage });
  send("message_stop", {});
  response.end();
}
