import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { projectClaudeHistory } from "../../src/server/backends/claude/claude-history-projector.js";
import { claudeResultIsUnrelated } from "../../src/server/backends/claude/claude-result-lifecycle.js";

/** Actual SDK/native CLI, deterministic localhost provider, no account credentials.
 * This does not change the authenticated suite's no-tools preflight contract. */
it.each(["Bash", "mcp__fixture__check", "interrupt", "interrupt-stream"])(
  "native CLI handles %s without executing the tool",
  async (scenario) => {
    const toolName = scenario === "interrupt" ? "Bash" : scenario;
    let permissionAborted = false;
    let toolExecutions = 0;
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-claude-native-"));
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await mkdir(home, { mode: 0o700 });
    await mkdir(workspace, { mode: 0o700 });
    const marker = path.join(workspace, "must-not-exist");
    const requests: Record<string, unknown>[] = [];
    const errors: unknown[] = [];
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (
          !request.url?.startsWith("/v1/messages") ||
          request.url.includes("count_tokens")
        ) {
          response.writeHead(404).end();
          return;
        }
        expect(request.headers["x-api-key"]).toBe("sedes-local-fixture-only");
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push(body);
        expect(requests.length).toBeLessThanOrEqual(2);
        const tool = requests.length === 1 && scenario !== "interrupt-stream";
        const block = tool
          ? {
              type: "tool_use",
              id: "toolu_sedes_denial",
              name: toolName,
              input: {},
            }
          : { type: "text", text: "" };
        const usage = {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        };
        response.writeHead(200, { "content-type": "text/event-stream" });
        const send = (type: string, fields: Record<string, unknown>) =>
          response.write(
            `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`,
          );
        send("message_start", {
          message: {
            id: `msg_sedes_${requests.length}`,
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage,
          },
        });
        send("content_block_start", { index: 0, content_block: block });
        send("content_block_delta", {
          index: 0,
          delta: tool
            ? {
                type: "input_json_delta",
                partial_json: JSON.stringify(
                  toolName === "Bash"
                    ? {
                        command: `touch '${marker}'`,
                        description: "Create fixture marker",
                      }
                    : {},
                ),
              }
            : { type: "text_delta", text: "SEDES_PERMISSION_DENIED_OK" },
        });
        if (scenario === "interrupt-stream") return;
        send("content_block_stop", { index: 0 });
        send("message_delta", {
          delta: {
            stop_reason: tool ? "tool_use" : "end_turn",
            stop_sequence: null,
          },
          usage,
        });
        send("message_stop", {});
        response.end();
      } catch (error) {
        errors.push(error);
        response.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("fixture_address_missing");
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
      CLAUDE_CODE_EMIT_STARTUP_TIMING: "1",
    });
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 45_000);
    const permissions: {
      tool: string;
      input: Record<string, unknown>;
      optionKeys: string[];
      mcpServer?: { name: string; source: string };
    }[] = [];
    let endInput!: () => void;
    const inputClosed = new Promise<void>((resolve) => {
      endInput = resolve;
    });
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: "user",
        message: {
          role: "user",
          content: "Exercise the deterministic permission fixture.",
        },
        parent_tool_use_id: null,
        session_id: "",
        uuid: "22222222-2222-4222-8222-222222222222",
      };
      await inputClosed;
    }
    const messages: SDKMessage[] = [];
    const session = query({
      prompt: prompt(),
      options: {
        pathToClaudeCodeExecutable:
          process.env.SEDES_REAL_CLAUDE_EXECUTABLE ??
          "claude",
        cwd: workspace,
        env: environment,
        model: "claude-sonnet-5",
        effort: "low",
        settingSources: [],
        strictMcpConfig: true,
        mcpServers:
          toolName === "Bash"
            ? {}
            : {
                fixture: createSdkMcpServer({
                  name: "fixture",
                  tools: [
                    tool(
                      "check",
                      "Deterministic permission check",
                      {},
                      async () => {
                        toolExecutions++;
                        return {
                          content: [{ type: "text", text: "must not execute" }],
                        };
                      },
                    ),
                  ],
                }),
              },
        plugins: [],
        tools: ["Bash"],
        permissionMode: "default",
        persistSession: false,
        includePartialMessages: true,
        maxTurns: 2,
        abortController,
        canUseTool: async (tool, input, options) => {
          permissions.push({
            tool,
            input,
            optionKeys: Object.keys(options).sort(),
            mcpServer: options.mcpServer,
          });
          if (scenario === "interrupt") {
            const aborted = new Promise<void>((resolve) =>
              options.signal.addEventListener(
                "abort",
                () => {
                  permissionAborted = true;
                  resolve();
                },
                { once: true },
              ),
            );
            await session.interrupt();
            await aborted;
          }
          return { behavior: "deny", message: "SEDES_FIXTURE_DENIAL" };
        },
      },
    });
    try {
      for await (const message of session) {
        messages.push(message);
        if (scenario === "interrupt-stream" && message.type === "stream_event" && message.event.type === "content_block_delta") await session.interrupt();
        if (message.type === "result") break;
      }
      if (scenario === "interrupt" || scenario === "interrupt-stream") {
        const result = messages.find(message => message.type === "result")!;
        expect(result).toMatchObject({ type: "result",
          terminal_reason: scenario === "interrupt" ? "aborted_tools" : "aborted_streaming" });
        // The minimum supported CLI omits optional user-message result IDs.
        expect(claudeResultIsUnrelated(result, ["22222222-2222-4222-8222-222222222222"])).toBe(false);
        const history = [{ type: "user", uuid: "22222222-2222-4222-8222-222222222222",
          session_id: result.session_id, parent_tool_use_id: null, parent_agent_id: null,
          message: { role: "user", content: "Exercise the deterministic permission fixture." } },
          ...messages.filter(message => message.type === "assistant" || message.type === "user")
            .map(message => ({ ...message, parent_agent_id: null }))];
        const projected = projectClaudeHistory(history);
        expect(projected.snapshot.runState).toBe("idle");
        expect(projected.snapshot.orderedBackendTurnIds).toHaveLength(1);
        expect(Object.values(projected.snapshot.turnsById)[0]).toMatchObject({ status: "interrupted", endedBy: "interrupted",
          completionCorrelations: ["22222222-2222-4222-8222-222222222222"] });
        expect(JSON.stringify(projected.snapshot)).not.toContain("[Request interrupted");
      }
      if (scenario === "interrupt-stream") {
        expect(errors).toEqual([]);
        expect(requests).toHaveLength(1);
        expect(permissions).toHaveLength(0);
        return;
      }
      expect(errors).toEqual([]);
      expect(permissions).toHaveLength(1);
      expect(permissions[0]?.tool).toBe(toolName);
      if (toolName === "Bash")
        expect(permissions[0]?.input.command).toBe(`touch '${marker}'`);
      else
        expect(permissions[0]?.mcpServer).toEqual({
          name: "fixture",
          source: "sdk",
        });
      expect(toolExecutions).toBe(0);
      if (scenario === "interrupt") {
        expect(permissionAborted).toBe(true);
        expect(requests).toHaveLength(1);
        expect(messages.some((message) => message.type === "result")).toBe(
          true,
        );
      } else {
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[1])).toContain("SEDES_FIXTURE_DENIAL");
        expect(
          messages.some(
            (message) => message.type === "result" && !message.is_error,
          ),
        ).toBe(true);
      }
      if (scenario === "mcp__fixture__check") {
        expect(
          messages.find(
            (message) =>
              message.type === "system" && message.subtype === "init",
          ),
        ).toHaveProperty("startup_timing");
      }
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      clearTimeout(timer);
      endInput();
      session.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
