import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { query, type Options, type SDKMessage, type SDKUserMessage, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { ClaudeInputQueue } from "../../src/server/backends/claude/claude-input-queue.js";
import { claudeCommandLifecycle, claudeResultUserMessageIds } from "../../src/server/backends/claude/claude-result-lifecycle.js";
import { CLAUDE_SESSION_STATE_EVENTS_VARIABLE } from "../../src/server/backends/claude/claude-sdk-session.js";
import { readClaudeSessionMessages } from "../../src/server/backends/claude/claude-native-transcript.js";
import { projectClaudeHistory } from "../../src/server/backends/claude/claude-history-projector.js";

/**
 * Actual pinned SDK + native CLI against an isolated localhost Messages API.
 * The CLI running a turn is killed with SIGKILL while its only tool, a finite
 * fixture command, waits; a fresh query then resumes the session the way
 * Sedes does, with its empty `shouldQuery: false` startup message. Qualifies
 * what the handle decides from: the unfinished turn in history, and the
 * frames Claude reports while it handles the startup message.
 */
it("leaves a killed turn unfinished and reports idle once the resumed CLI has handled the startup message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-process-loss-native-"));
  const home = path.join(root, "home"); const cwd = path.join(root, "workspace");
  const configDirectory = path.join(home, ".claude");
  await mkdir(home); await mkdir(cwd);
  const started = path.join(cwd, "started"), release = path.join(cwd, "release");
  const command = `: > '${started}'; i=0; while [ "$i" -lt 300 ]; do if [ -f '${release}' ]; then printf 'FIXTURE_DONE'; exit 0; fi; i=$((i+1)); sleep 0.1; done; exit 42`;
  const errors: unknown[] = [];
  let requests = 0;
  const server = createServer(async (request, response) => {
    try {
      if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) { response.writeHead(404).end(); return; }
      expect(request.headers["x-api-key"]).toBe("sedes-local-fixture-only");
      for await (const chunk of request) void chunk;
      // Only the killed turn's first request reaches the model.
      expect(++requests).toBe(1);
      const usage = { input_tokens: 1, output_tokens: 1 };
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, rest: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
      send("message_start", { message: { id: "msg_killed", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage } });
      send("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_killed", name: "Bash", input: {} } });
      send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command, description: "fixture wait" }) } });
      send("content_block_stop", { index: 0 });
      send("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage });
      send("message_stop", {}); response.end();
    } catch (error) { errors.push(error); response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address_missing");
  const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  Object.assign(env, { PATH: process.env.PATH, HOME: home, TMPDIR: root, CLAUDE_CONFIG_DIR: configDirectory,
    ANTHROPIC_API_KEY: "sedes-local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", [CLAUDE_SESSION_STATE_EVENTS_VARIABLE]: "1" });
  const sessionId = randomUUID(), prompt = randomUUID(), startup = randomUUID();
  const pids: number[] = [];
  const options = (launch: "new" | "resume"): Options => ({
    pathToClaudeCodeExecutable: process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude", cwd, env,
    ...(launch === "new" ? { sessionId } : { resume: sessionId }),
    model: "claude-sonnet-5", effort: "low", settingSources: [], strictMcpConfig: true, mcpServers: {}, plugins: [],
    tools: ["Bash"], permissionMode: "default", persistSession: true, maxTurns: 4, includePartialMessages: true,
    canUseTool: async (name, toolInput) => name === "Bash" && toolInput.command === command
      ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: "Only the finite fixture is allowed." },
    spawnClaudeCodeProcess: spawnOptions => {
      const child = spawn(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd, env: spawnOptions.env, stdio: ["pipe", "pipe", "ignore"] });
      if (child.pid !== undefined) pids.push(child.pid);
      return child as unknown as SpawnedProcess;
    },
  });
  const read = async () => projectClaudeHistory(await readClaudeSessionMessages(sessionId, { dir: cwd }, { CLAUDE_CONFIG_DIR: configDirectory }));
  const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 30_000;
    while (!(await predicate())) {
      if (errors.length) throw errors[0];
      if (Date.now() > deadline) throw new Error("native_process_loss_timeout");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const first = new ClaudeInputQueue<SDKUserMessage>();
  const killed = query({ prompt: first, options: options("new") });
  const second = new ClaudeInputQueue<SDKUserMessage>();
  let resumed: ReturnType<typeof query> | undefined;
  try {
    const drained = (async () => { for await (const message of killed) void message; })();
    first.push({ type: "user", uuid: prompt as ReturnType<typeof randomUUID>, session_id: "", parent_tool_use_id: null,
      message: { role: "user", content: "PROMPT_KILLED" } });
    await waitFor(() => stat(started).then(() => true, () => false));
    process.kill(pids[0]!, "SIGKILL");
    await expect(drained).rejects.toThrow();
    // History alone shows the turn unfinished: nothing will ever settle it.
    const orphaned = await read();
    expect(orphaned.snapshot.runState).toBe("running");
    expect(orphaned.snapshot.turnsById[orphaned.snapshot.activeBackendTurnId!]?.completionCorrelations).toEqual([prompt]);

    resumed = query({ prompt: second, options: options("resume") });
    const frames: SDKMessage[] = [];
    const consumed = (async () => { for await (const message of resumed!) frames.push(message); })();
    void consumed.catch(error => errors.push(error));
    second.push({ type: "user", uuid: startup as ReturnType<typeof randomUUID>, session_id: sessionId, parent_tool_use_id: null,
      message: { role: "user", content: "" }, isSynthetic: true, shouldQuery: false });
    const states = () => frames.flatMap((message, index) =>
      message.type === "system" && message.subtype === "session_state_changed" ? [{ index, state: message.state }] : []);
    await waitFor(() => states().some(({ state }) => state === "idle"));
    const startupCompleted = frames.findIndex(message =>
      claudeCommandLifecycle(message)?.commandUuid === startup && claudeCommandLifecycle(message)?.state === "completed");
    const idle = states().find(({ state }) => state === "idle")!.index;
    // Claude reports running only while it handles the startup message, and
    // that message's own result names only itself.
    expect(states().filter(({ index }) => index < idle).map(({ state }) => state)).toEqual(["running"]);
    expect(startupCompleted).toBeGreaterThanOrEqual(0);
    expect(startupCompleted).toBeLessThan(idle);
    const startupResults = frames.filter(message => message.type === "result");
    expect(startupResults.map(result => claudeResultUserMessageIds(result as Extract<SDKMessage, { type: "result" }>))).toEqual([[startup]]);
    expect(frames.some(message => message.type === "assistant" || message.type === "stream_event")).toBe(false);
    // Once resumed, Claude Code closes the dead tool call and the turn.
    await waitFor(async () => (await read()).snapshot.runState === "idle");
    const closed = await read();
    expect(closed.snapshot.turnsById[orphaned.snapshot.activeBackendTurnId!]).toMatchObject({ status: "interrupted" });
    expect(requests).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await writeFile(release, "cleanup");
    first.close(); second.close(); killed.close(); resumed?.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise(resolve => setTimeout(resolve, 300));
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
