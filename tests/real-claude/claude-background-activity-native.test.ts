import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";

/** Actual pinned SDK + native CLI against an isolated localhost Messages API.
 * Only the exact finite fixture command may execute; no provider credentials. */
it.each(["Bash", "Agent", "Foreground Agent", "Interrupted Agent"] as const)(
  "native %s task lifecycle reports authoritative start and completion",
  async (scenario) => {
    const agentScenario = scenario !== "Bash";
    const interruptAgent = scenario === "Interrupted Agent";
    const foregroundAgent = scenario === "Foreground Agent" || interruptAgent;
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-claude-background-"));
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await mkdir(home, { mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
    const releaseFile = path.join(workspace, "release");
    const startedFile = path.join(workspace, "started");
    const command = `: > '${startedFile}'; i=0; while [ "$i" -lt 300 ]; do if [ -f '${releaseFile}' ]; then printf 'SEDES_BACKGROUND_DONE\\n'; exit 0; fi; i=$((i + 1)); sleep 0.1; done; exit 42`;
    const errors: unknown[] = [];
    let parentRequests = 0;
    let childRequests = 0;
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
          response.writeHead(404).end();
          return;
        }
        expect(request.headers["x-api-key"]).toBe("sedes-local-fixture-only");
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const child = agentScenario && JSON.stringify(body.system).includes("SEDES_CHILD_SYSTEM");
        const ordinal = child ? ++childRequests : ++parentRequests;
        expect(parentRequests + childRequests).toBeLessThanOrEqual(8);
        if (ordinal === 1) {
          const isAgent = agentScenario && !child;
          stream(response, `${child ? "child" : "parent"}-${ordinal}`, {
            name: isAgent ? "Agent" : "Bash",
            input: isAgent
              ? { description: "Wait for fixture release", prompt: "SEDES_CHILD_WAIT", subagent_type: "fixture", run_in_background: !foregroundAgent }
              : { command, description: "Wait for fixture release", run_in_background: !child, timeout: 40_000 },
          });
        } else {
          stream(response, `${child ? "child" : "parent"}-${ordinal}`, child ? "SEDES_CHILD_DONE" : "SEDES_PARENT_DONE");
        }
      } catch (error) {
        errors.push(error);
        response.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_address_missing");
    const environment: Record<string, string | undefined> = Object.fromEntries(
      Object.keys(process.env).map((key) => [key, undefined]),
    );
    Object.assign(environment, {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: root,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      ANTHROPIC_API_KEY: "sedes-local-fixture-only",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    });
    let closeInput!: () => void;
    const closed = new Promise<void>((resolve) => { closeInput = resolve; });
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield { type: "user", message: { role: "user", content: `Exercise deterministic ${scenario} background fixture.` }, parent_tool_use_id: null, session_id: "" };
      await closed;
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 60_000);
    const messages: SDKMessage[] = [];
    const permissionTools: string[] = [];
    const session = query({
      prompt: prompt(),
      options: {
        pathToClaudeCodeExecutable: process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude",
        cwd: workspace,
        env: environment,
        model: "claude-sonnet-5",
        effort: "low",
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        plugins: [],
        tools: agentScenario ? ["Agent", "Bash"] : ["Bash"],
        ...(agentScenario ? { agents: { fixture: { description: "Deterministic fixture worker", prompt: "SEDES_CHILD_SYSTEM. Run the supplied finite fixture command and report completion.", tools: ["Bash"], model: "inherit" as const } } } : {}),
        permissionMode: "default",
        persistSession: false,
        maxTurns: 4,
        abortController,
        canUseTool: async (name, input) => {
          permissionTools.push(name);
          if ((name === "Bash" && input.command === command) ||
            (agentScenario && name === "Agent" && input.subagent_type === "fixture" && input.prompt === "SEDES_CHILD_WAIT")) {
            return { behavior: "allow", updatedInput: input };
          }
          return { behavior: "deny", message: "Only the exact deterministic fixture tool is permitted." };
        },
      },
    });
    let foregroundResult = -1;
    let activeInventory = -1;
    let emptyInventory = -1;
    let terminalNotification = -1;
    let trackedTaskId: string | undefined;
    let releaseWhenStarted: Promise<void> | undefined;
    try {
      for await (const message of session) {
        const index = messages.push(message) - 1;
        if (message.type === "system" && message.subtype === "background_tasks_changed") {
          const tasks = message.tasks.filter((task) => !task.ambient);
          if (tasks.length > 0) {
            if (activeInventory < 0) activeInventory = index;
            expect(tasks).toHaveLength(1);
            expect(tasks[0]!.task_type).toBe(agentScenario ? "local_agent" : "local_bash");
            trackedTaskId ??= tasks[0]!.task_id;
          } else if (activeInventory >= 0) {
            emptyInventory = index;
          }
        }
        if (foregroundAgent && message.type === "system" && message.subtype === "task_started" && message.task_type === "local_agent") {
          trackedTaskId = message.task_id;
          expect(message.is_backgrounded).toBe(false);
          releaseWhenStarted = waitForFile(startedFile).then(async () => {
            if (interruptAgent) await session.interrupt();
            else await writeFile(releaseFile, "release foreground child");
          });
          void releaseWhenStarted.catch(() => abortController.abort());
        }
        if (foregroundAgent && message.type === "system" && message.subtype === "task_updated" && message.task_id === trackedTaskId && message.patch.status === (interruptAgent ? "killed" : "completed")) {
          terminalNotification = index;
        }
        if (message.type === "result" && foregroundResult < 0) {
          foregroundResult = index;
          if (!interruptAgent) expect(message.is_error).toBe(false);
          if (foregroundAgent) {
            expect(terminalNotification, JSON.stringify(observations(messages))).toBeGreaterThanOrEqual(0);
          } else {
            expect(activeInventory, JSON.stringify(observations(messages))).toBeGreaterThanOrEqual(0);
            expect(terminalNotification).toBe(-1);
            await waitForFile(startedFile);
            await writeFile(releaseFile, "release");
          }
        }
        if (message.type === "system" && message.subtype === "task_notification" && message.task_id === trackedTaskId) {
          expect(message.status).toBe(interruptAgent ? "stopped" : "completed");
          terminalNotification = index;
        }
        if (foregroundResult >= 0 && terminalNotification >= 0 && (foregroundAgent || emptyInventory >= 0)) break;
      }
      expect(errors).toEqual([]);
      await releaseWhenStarted;
      if (foregroundAgent) {
        expect(activeInventory).toBe(-1);
        expect(foregroundResult).toBeGreaterThan(terminalNotification);
      } else {
        expect(foregroundResult, JSON.stringify(observations(messages))).toBeGreaterThan(activeInventory);
        expect(terminalNotification, JSON.stringify(observations(messages))).toBeGreaterThan(foregroundResult);
        expect(emptyInventory, JSON.stringify(observations(messages))).toBeGreaterThan(foregroundResult);
      }
      expect(messages.find((message) => message.type === "system" && message.subtype === "task_started")).toMatchObject({
        task_id: trackedTaskId,
        tool_use_id: "toolu_parent-1",
        is_backgrounded: !foregroundAgent,
      });
      if (interruptAgent) {
        expect(messages.some(message => message.type === "system" && message.subtype === "task_updated" &&
          message.task_id === trackedTaskId && message.patch.status === "killed"),
        JSON.stringify(observations(messages))).toBe(true);
      }
      expect(permissionTools).toContain("Bash");
      if (agentScenario) expect(childRequests).toBeGreaterThanOrEqual(interruptAgent ? 1 : 2);
    } finally {
      clearTimeout(timeout);
      await writeFile(releaseFile, "cleanup release");
      closeInput();
      session.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  75_000,
);

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

function observations(messages: readonly SDKMessage[]): unknown[] {
  return messages.flatMap<Record<string, unknown>>((message) => {
    if (message.type === "result") return [{ type: "result", error: message.is_error }];
    if (message.type !== "system") return [];
    if (message.subtype === "background_tasks_changed") return [{ type: message.subtype, tasks: message.tasks.map((task) => ({ type: task.task_type, ambient: task.ambient ?? false })) }];
    if (message.subtype === "task_started") return [{ type: message.subtype, background: message.is_backgrounded, taskType: message.task_type, toolUseId: message.tool_use_id }];
    if (message.subtype === "task_updated") return [{ type: message.subtype, status: message.patch.status }];
    if (message.subtype === "task_notification") return [{ type: message.subtype, status: message.status }];
    return [];
  });
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
