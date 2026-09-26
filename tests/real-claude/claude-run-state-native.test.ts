import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { ClaudeInputQueue } from "../../src/server/backends/claude/claude-input-queue.js";
import { claudeCommandLifecycle, claudeResultUserMessageIds } from "../../src/server/backends/claude/claude-result-lifecycle.js";
import { CLAUDE_SESSION_STATE_EVENTS_VARIABLE } from "../../src/server/backends/claude/claude-sdk-session.js";

/**
 * Actual pinned SDK + native CLI against an isolated localhost Messages API,
 * with Sedes' run-state environment. Qualifies the native frames Sedes uses
 * for exact acceptance and for turns Claude starts itself. Only the exact
 * finite fixture commands may execute; no provider credentials are used.
 */
type Scenario = "notification" | "steer" | "agent";
type Reply = string | { readonly name: "Bash" | "Agent"; readonly input: Record<string, unknown> };

interface NativeRun {
  readonly messages: readonly SDKMessage[];
  send(uuid: string, content: string, priority?: "next"): void;
  waitFor(predicate: () => boolean | Promise<boolean>): Promise<void>;
  toolStarted(): Promise<boolean>;
  releaseTool(): Promise<void>;
  heldRequests(): number;
  releaseHeld(): void;
}

async function nativeRun(scenario: Scenario, drive: (run: NativeRun) => Promise<void>): Promise<SDKMessage[]> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-run-state-native-"));
  const home = path.join(root, "home"); const cwd = path.join(root, "workspace");
  await mkdir(home); await mkdir(cwd);
  const started = path.join(cwd, "started"), release = path.join(cwd, "release");
  const command = `: > '${started}'; i=0; while [ "$i" -lt 300 ]; do if [ -f '${release}' ]; then printf 'FIXTURE_DONE'; exit 0; fi; i=$((i+1)); sleep 0.1; done; exit 42`;
  let releaseHeld!: () => void;
  const held = new Promise<void>(resolve => { releaseHeld = resolve; });
  let heldRequests = 0;
  const errors: unknown[] = [];
  const stream = (response: ServerResponse, id: string, reply: Reply) => {
    const usage = { input_tokens: 1, output_tokens: 1 };
    const tool = typeof reply !== "string";
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, rest: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
    send("message_start", { message: { id: `msg_${id}`, type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage } });
    send("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id: `toolu_${id}`, name: reply.name, input: {} } : { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(reply.input) } : { type: "text_delta", text: reply } });
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage });
    send("message_stop", {}); response.end();
  };
  let ordinal = 0;
  const server = createServer(async (request, response) => {
    try {
      if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) { response.writeHead(404).end(); return; }
      expect(request.headers["x-api-key"]).toBe("sedes-local-fixture-only");
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { system: unknown; messages: unknown[] };
      const transcript = JSON.stringify(body.messages);
      const id = String(++ordinal);
      expect(ordinal).toBeLessThanOrEqual(10);
      // Stand in for time to first token, so dequeue evidence is observable first.
      await new Promise(resolve => setTimeout(resolve, 400));
      if (JSON.stringify(body.system).includes("SEDES_CHILD_SYSTEM")) {
        stream(response, `c${id}`, transcript.includes("toolu_c") ? "CHILD_DONE"
          : { name: "Bash", input: { command, description: "child wait", timeout: 40000 } });
      } else if (transcript.includes("PROMPT_SECOND") && !transcript.includes("SECOND_DONE")) {
        stream(response, `s${id}`, "SECOND_DONE");
      } else if (transcript.includes("task-notification") && !transcript.includes("NOTIFIED")) {
        heldRequests++;
        if (scenario === "notification") await held;
        stream(response, `n${id}`, "NOTIFIED");
      } else if (!transcript.includes("toolu_f")) {
        stream(response, `f${id}`, scenario === "agent"
          ? { name: "Agent", input: { description: "wait", prompt: "SEDES_CHILD_WAIT", subagent_type: "fixture", run_in_background: true } }
          : { name: "Bash", input: { command, description: "fixture wait", run_in_background: scenario === "notification", timeout: 40000 } });
      } else stream(response, `x${id}`, "FIRST_DONE");
    } catch (error) { errors.push(error); response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address_missing");
  const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  Object.assign(env, { PATH: process.env.PATH, HOME: home, TMPDIR: root, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    ANTHROPIC_API_KEY: "sedes-local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", [CLAUDE_SESSION_STATE_EVENTS_VARIABLE]: "1" });
  const input = new ClaudeInputQueue<SDKUserMessage>();
  const abortController = new AbortController(); const timeout = setTimeout(() => abortController.abort(), 50_000);
  const session = query({ prompt: input, options: {
    pathToClaudeCodeExecutable: process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude", cwd, env,
    model: "claude-sonnet-5", effort: "low", settingSources: [], strictMcpConfig: true, mcpServers: {}, plugins: [],
    tools: scenario === "agent" ? ["Agent", "Bash"] : ["Bash"],
    ...(scenario === "agent" ? { agents: { fixture: { description: "Deterministic fixture worker",
      prompt: "SEDES_CHILD_SYSTEM. Run the supplied finite fixture command.", tools: ["Bash"], model: "inherit" as const } } } : {}),
    permissionMode: "default", persistSession: false, maxTurns: 6, abortController, includePartialMessages: true,
    canUseTool: async (name, toolInput) =>
      (name === "Bash" && toolInput.command === command) || (name === "Agent" && toolInput.prompt === "SEDES_CHILD_WAIT")
        ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: "Only the finite fixture is allowed." },
  } });
  const messages: SDKMessage[] = [];
  const consume = (async () => { for await (const message of session) messages.push(message); })();
  void consume.catch(error => errors.push(error));
  const run: NativeRun = {
    messages,
    send: (uuid, content, priority) => input.push({ type: "user", uuid: uuid as ReturnType<typeof randomUUID>, session_id: "",
      parent_tool_use_id: null, message: { role: "user", content }, ...(priority ? { priority } : {}) }),
    waitFor: async predicate => {
      const deadline = Date.now() + 30_000;
      while (!(await predicate())) {
        if (errors.length) throw errors[0];
        if (Date.now() > deadline) throw new Error(`native_run_state_timeout: ${JSON.stringify(outline(messages))}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
    toolStarted: () => stat(started).then(() => true, () => false),
    releaseTool: () => writeFile(release, "release"),
    heldRequests: () => heldRequests,
    releaseHeld,
  };
  try {
    await drive(run);
    expect(errors).toEqual([]);
    return messages;
  } finally {
    clearTimeout(timeout); releaseHeld(); await writeFile(release, "cleanup"); input.close(); session.close(); await consume.catch(() => {});
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
  }
}

const lifecycleIndex = (messages: readonly SDKMessage[], uuid: string, state: string) => messages.findIndex(message =>
  claudeCommandLifecycle(message)?.commandUuid === uuid && claudeCommandLifecycle(message)?.state === state);
const stateIndexes = (messages: readonly SDKMessage[], state: string) => messages.flatMap((message, index) =>
  message.type === "system" && message.subtype === "session_state_changed" && message.state === state ? [index] : []);
const modelStarts = (messages: readonly SDKMessage[]) => messages.flatMap((message, index) =>
  message.type === "stream_event" && message.parent_tool_use_id === null && message.event.type === "message_start" ? [index] : []);
const results = (messages: readonly SDKMessage[]) => messages.flatMap((message, index) =>
  message.type === "result" ? [{ index, message }] : []);
function outline(messages: readonly SDKMessage[]): unknown[] {
  return messages.map(message => {
    const lifecycle = claudeCommandLifecycle(message);
    if (lifecycle) return `lifecycle:${lifecycle.state}`;
    if (message.type === "system") return `system:${message.subtype}${"state" in message ? `:${String(message.state)}` : ""}`;
    if (message.type === "stream_event") return `stream:${message.event.type}`;
    return message.type;
  });
}

it("reports dequeue and run state before model output and marks turns Claude starts itself", async () => {
  const first = randomUUID(), second = randomUUID();
  const messages = await nativeRun("notification", async run => {
    run.send(first, "PROMPT_FIRST");
    await run.waitFor(() => run.messages.some(message => message.type === "result"));
    await run.waitFor(run.toolStarted);
    await run.releaseTool();
    await run.waitFor(() => run.heldRequests() > 0);
    run.send(second, "PROMPT_SECOND");
    await run.waitFor(() => lifecycleIndex(run.messages, second, "queued") >= 0);
    run.releaseHeld();
    await run.waitFor(() => {
      const last = results(run.messages).at(-1);
      return last !== undefined && claudeResultUserMessageIds(last.message).includes(second) &&
        stateIndexes(run.messages, "idle").some(index => index > last.index);
    });
  });
  const [firstResult, notificationResult, secondResult, ...others] = results(messages);
  expect(others).toEqual([]);
  const starts = modelStarts(messages);
  // Exact dequeue evidence and Claude's running state precede the first token.
  expect(stateIndexes(messages, "running")[0]).toBeLessThan(starts[0]!);
  expect(lifecycleIndex(messages, first, "queued")).toBeLessThan(lifecycleIndex(messages, first, "started"));
  expect(lifecycleIndex(messages, first, "started")).toBeLessThan(starts[0]!);
  expect(messages[starts[0]!]).toMatchObject({ user_message_uuid: first });
  // Without --replay-user-messages the CLI never echoes a Sedes prompt.
  expect(messages.some(message => message.type === "user" && (message.uuid === first || message.uuid === second))).toBe(false);
  expect(claudeResultUserMessageIds(firstResult!.message)).toEqual([first]);
  // A background command lets Claude go idle; its notification starts a
  // turn with a running edge, unstamped output, and task-notification origin.
  const notification = messages.findIndex(message => message.type === "system" && message.subtype === "task_notification");
  expect(stateIndexes(messages, "idle").find(index => index > firstResult!.index)).toBeLessThan(notification);
  const notificationStart = starts.find(index => index > notification)!;
  expect(stateIndexes(messages, "running").find(index => index > notification)).toBeLessThan(notificationStart);
  expect(messages[notificationStart]).not.toHaveProperty("user_message_uuid");
  expect(notificationResult!.message).toMatchObject({ origin: { kind: "task-notification" } });
  expect(claudeResultUserMessageIds(notificationResult!.message)).toEqual([]);
  // An input queued behind that turn is admitted at once but starts only
  // after its result, on its own stamped turn.
  expect(lifecycleIndex(messages, second, "queued")).toBeLessThan(notificationResult!.index);
  expect(lifecycleIndex(messages, second, "started")).toBeGreaterThan(notificationResult!.index);
  expect(messages[starts.find(index => index > notificationResult!.index)!]).toMatchObject({ user_message_uuid: second });
  expect(claudeResultUserMessageIds(secondResult!.message)).toEqual([second]);
}, 70_000);

it("reports a folded steer's start at the fold and its consumption on the turn result", async () => {
  const first = randomUUID(), steer = randomUUID();
  const messages = await nativeRun("steer", async run => {
    run.send(first, "PROMPT_FIRST");
    await run.waitFor(run.toolStarted);
    run.send(steer, "STEER_CORRECTION", "next");
    await run.waitFor(() => lifecycleIndex(run.messages, steer, "queued") >= 0);
    await run.releaseTool();
    await run.waitFor(() => run.messages.some(message => message.type === "result"));
  });
  const [result, ...others] = results(messages);
  expect(others).toEqual([]);
  const toolResult = messages.findIndex(message => message.type === "user" && JSON.stringify(message.message.content).includes("FIXTURE_DONE"));
  const secondStart = modelStarts(messages)[1]!;
  expect(lifecycleIndex(messages, steer, "started")).toBeGreaterThan(toolResult);
  expect(lifecycleIndex(messages, steer, "started")).toBeLessThan(secondStart);
  // Reply frames of a typed turn are not re-stamped for the folded steer.
  expect(messages.slice(secondStart, result!.index).some(message =>
    claudeResultUserMessageIds(message as { user_message_uuid?: string }).includes(steer))).toBe(false);
  expect(claudeResultUserMessageIds(result!.message)).toEqual([first, steer]);
}, 70_000);

it("keeps Claude's state running across a background agent's wait until its notification turn ends", async () => {
  const first = randomUUID();
  const messages = await nativeRun("agent", async run => {
    run.send(first, "PROMPT_FIRST");
    await run.waitFor(() => run.messages.some(message => message.type === "result"));
    await run.waitFor(run.toolStarted);
    await run.releaseTool();
    await run.waitFor(() => {
      const [, notificationResult] = results(run.messages);
      return notificationResult !== undefined && stateIndexes(run.messages, "idle").some(index => index > notificationResult.index);
    });
  });
  const [firstResult, notificationResult] = results(messages);
  // No idle edge separates the foreground result from the notification turn,
  // so Sedes also detects that turn from its first unstamped output.
  expect(stateIndexes(messages, "idle").filter(index => index > firstResult!.index && index < notificationResult!.index)).toEqual([]);
  const notificationStart = modelStarts(messages).find(index => index > firstResult!.index)!;
  expect(messages[notificationStart]).not.toHaveProperty("user_message_uuid");
  expect(notificationResult!.message).toMatchObject({ origin: { kind: "task-notification" } });
}, 70_000);
