import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { ClaudeInputQueue } from "../../src/server/backends/claude/claude-input-queue.js";
import { readClaudeSessionMessages } from "../../src/server/backends/claude/claude-native-transcript.js";
import { projectClaudeHistory } from "../../src/server/backends/claude/claude-history-projector.js";

/**
 * Actual native CLI with an isolated localhost provider and no credentials.
 * Stop lands on one parallel tool batch; only the call Stop stopped may read
 * interrupted, live and from the transcript alike. `failed-sibling`: one
 * read-only command exits 1 while its sibling still runs. `denied-sibling`: the
 * permission callback denies one call, as Sedes does for a rejection, and
 * the next call runs. `open-prompt`: Stop closes a permission prompt that is
 * still open, and the callback then denies as Sedes' bridge does on abort.
 */
it.each(["failed-sibling", "denied-sibling", "open-prompt"] as const)("Stop interrupts only the stopped calls of a %s batch", async scenario => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-stopped-batch-native-"));
  const home = path.join(root, "home"); const cwd = path.join(root, "workspace");
  await mkdir(home); await mkdir(cwd);
  const fifo = path.join(cwd, "fifo"), started = path.join(cwd, "started");
  await promisify(execFile)("mkfifo", [fifo]);
  const running = `: > '${started}'; i=0; while [ "$i" -lt 150 ]; do i=$((i+1)); sleep 0.1; done; exit 42`;
  const denied = `printf DENIED_FIXTURE > '${path.join(cwd, "denied")}'`;
  const prompted = `printf PROMPTED_FIXTURE > '${path.join(cwd, "prompted")}'`;
  const batch = scenario === "failed-sibling"
    ? [`cat '${path.join(cwd, "missing.txt")}'`, `cat '${fifo}'`]
    : scenario === "denied-sibling" ? [denied, running] : [prompted];
  const errors: unknown[] = [];
  let requests = 0;
  const server = createServer(async (request, response) => {
    try {
      if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) { response.writeHead(404).end(); return; }
      expect(request.headers["x-api-key"]).toBe("sedes-local-fixture-only");
      for await (const _chunk of request) { /* drain */ }
      requests += 1;
      expect(requests).toBe(1);
      const usage = { input_tokens: 1, output_tokens: 1 };
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (type: string, rest: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
      send("message_start", { message: { id: "msg_stopped_batch", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage } });
      batch.forEach((command, index) => {
        send("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_stopped_batch_${index}`, name: "Bash", input: {} } });
        send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command, description: "Stopped batch fixture", timeout: 20000 }) } });
        send("content_block_stop", { index });
      });
      send("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage });
      send("message_stop", {}); response.end();
    } catch (error) { errors.push(error); response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("address_missing");
  const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
  Object.assign(env, { PATH: process.env.PATH, HOME: home, TMPDIR: root, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), ANTHROPIC_API_KEY: "sedes-local-fixture-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" });
  const input = new ClaudeInputQueue<SDKUserMessage>(); const promptId = randomUUID();
  const prompt: SDKUserMessage = { type: "user", uuid: promptId, session_id: "", parent_tool_use_id: null, message: { role: "user", content: "Run the batch." } };
  const permissions: string[] = [];
  const abortController = new AbortController(); const timeout = setTimeout(() => abortController.abort(), 30_000);
  const session = query({ prompt: input, options: {
    pathToClaudeCodeExecutable: process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude", cwd, env,
    model: "claude-sonnet-5", effort: "low", settingSources: [], strictMcpConfig: true, mcpServers: {}, plugins: [],
    tools: ["Bash"], permissionMode: "default", persistSession: true, maxTurns: 2, abortController,
    canUseTool: async (name, toolInput, options) => {
      const command = String(toolInput.command);
      permissions.push(command);
      // Sedes answers with its own denial text, never Claude Code's.
      if (command === denied) return { behavior: "deny", message: "User denied permission.", interrupt: false, toolUseID: options.toolUseID };
      if (command === prompted) {
        return new Promise(resolve => {
          const cancel = () => resolve({ behavior: "deny", message: "Permission request cancelled.", interrupt: false, toolUseID: options.toolUseID });
          if (options.signal.aborted) cancel(); else options.signal.addEventListener("abort", cancel, { once: true });
        });
      }
      return name === "Bash" && batch.includes(command)
        ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: "Only the fixture commands are allowed." };
    },
  } });
  const events: SDKMessage[] = [];
  const consume = (async () => { for await (const message of session) events.push(message); })();
  void consume.catch(error => errors.push(error));
  const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 25_000;
    while (!(await predicate())) { if (errors.length) throw errors[0]; if (Date.now() > deadline) throw new Error("stopped_batch_timeout"); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  const toolResults = () => events.filter(event => event.type === "user" && Array.isArray(event.message.content) &&
    event.message.content.some(block => block.type === "tool_result"));
  const authentication = {
    steerOperations: new Map(), attachmentProvenanceKey: new Uint8Array(32),
    forkBoundaryAuthentication: { installationKey: new Uint8Array(32).fill(1), tenantId: "fixture", principalId: "fixture", backendInstanceId: "fixture" },
  };
  const commands = (messages: readonly unknown[]) => Object.values(projectClaudeHistory(messages, [], authentication).snapshot.itemsById)
    .filter(item => item.semanticKind === "command");
  try {
    input.push(prompt);
    if (scenario === "failed-sibling") {
      // The failure is reported while its sibling still waits on the FIFO.
      await waitFor(() => toolResults().length === 1);
      await new Promise(resolve => setTimeout(resolve, 300));
    } else if (scenario === "denied-sibling") {
      await waitFor(() => stat(started).then(() => true, () => false));
      expect(toolResults()).toHaveLength(1);
    } else {
      await waitFor(() => permissions.includes(prompted));
    }
    await session.interrupt();
    await waitFor(() => events.some(event => event.type === "result"));
    expect(events.find(event => event.type === "result")).toMatchObject({ terminal_reason: "aborted_tools" });
    const sessionId = events.find(event => event.type === "system" && event.subtype === "init")!.session_id;
    // Live: the rows the handle observes, after the prompt it wrote itself.
    const live = [{ ...prompt, session_id: sessionId, parent_agent_id: null },
      ...events.filter(event => (event.type === "user" || event.type === "assistant") && event.parent_tool_use_id === null)
        .map(event => ({ ...event, parent_agent_id: null }))];
    const transcript = await readClaudeSessionMessages(sessionId, { dir: cwd }, env);
    const liveCommands = commands(live);
    expect(liveCommands.map(item => [item.status, "phase" in item ? item.phase : undefined]))
      .toEqual(scenario === "open-prompt" ? [["interrupted", "interrupted"]]
        : [["failed", "failed"], ["interrupted", "interrupted"]]);
    if (scenario !== "open-prompt") expect(liveCommands[0]).not.toHaveProperty("completedAt");
    expect(commands(transcript)).toEqual(liveCommands);
    expect(requests).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    clearTimeout(timeout); input.close(); session.close(); await consume.catch(() => {});
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
  }
});
