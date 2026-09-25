import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  type JSONRPCMessage,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { SedesMcpServer } from "../../src/cli/sedes-mcp-server.js";
import {
  SedesToolApiError,
  type SedesToolClient,
} from "../../src/cli/sedes-tool-client.js";
import type { SedesToolInvocationResult } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import {
  CanonicalAgentToolRequestError,
  CanonicalInlineAgentToolService,
} from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { createSavedAgentDeleteToolDefinition } from "../../src/server/agent-tools/tools/saved-agent-management-tools.js";
import { createTaskCreateToolDefinition } from "../../src/server/agent-tools/tools/task-management-tools.js";
import { createWebSearchToolDefinition } from "../../src/server/agent-tools/tools/web-search-tool.js";

const threadId = "10000000-0000-4000-8000-000000000001";

function catalog(toolIds?: readonly string[]) {
  const canonical = new CanonicalInlineAgentToolService({
    application: { readThreadStatus: async () => undefined },
    additionalDefinitions: [
      createTaskCreateToolDefinition({} as never),
      createSavedAgentDeleteToolDefinition({} as never),
      createWebSearchToolDefinition({} as never),
    ],
  });
  const enabled = (id: string) => toolIds === undefined || toolIds.includes(id);
  return {
    summaries: () =>
      canonical.catalogSummaries("mcp", "thread_agent").filter(({ id }) => enabled(id)),
    describe: (ids: readonly string[]) => {
      if (ids.some((id) => !enabled(id))) {
        throw new SedesToolApiError("not_found", "The requested tool is unavailable.", false, 404);
      }
      try {
        return canonical.describeMany("mcp", "thread_agent", ids);
      } catch (error) {
        if (error instanceof CanonicalAgentToolRequestError) {
          throw new SedesToolApiError(error.code, error.message, error.retryable, 404);
        }
        throw error;
      }
    },
  };
}

function fakeClient(
  current = catalog(),
  invoke: SedesToolClient["invoke"] = vi.fn(async (request) => ({
    invocationId: "invocation-1",
    state: "completed" as const,
    output:
      request.toolId === "thread.status"
        ? { threadId, backend: "codex_app_server", lifecycle: "active", activity: "idle" }
        : { backend: "codex_app_server", threadId, workspaceId: "workspace-1" },
  })),
) {
  return {
    listTools: vi.fn(async () => ({ tools: current.summaries() })),
    describeTools: vi.fn(async (ids: readonly string[]) => ({
      tools: current.describe(ids),
    })),
    invoke: vi.fn(invoke),
  } satisfies SedesToolClient;
}

/** Connects the official SDK client to one in-process Sedes MCP server. */
class InProcessTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  readonly server: SedesMcpServer;
  readonly sent: unknown[] = [];
  readonly received: JSONRPCMessage[] = [];

  constructor(
    client: SedesToolClient,
    mode: "progressive" | "individual",
  ) {
    this.server = new SedesMcpServer({
      client,
      mode,
      serverVersion: "0.0.0-test",
      requestId: () => "tool-request-1",
      send: async (message) => {
        this.sent.push(message);
        for (const item of Array.isArray(message) ? message : [message]) {
          queueMicrotask(() => this.onmessage?.(item as JSONRPCMessage));
        }
      },
    });
  }

  async start() {}

  async send(message: JSONRPCMessage) {
    this.received.push(message);
    this.server.receive(JSON.stringify(message));
  }

  async close() {
    await this.server.close();
    this.onclose?.();
  }
}

async function connect(
  client: SedesToolClient,
  mode: "progressive" | "individual" = "individual",
) {
  const transport = new InProcessTransport(client, mode);
  const mcp = new Client({ name: "sedes-test", version: "1.0.0" });
  await mcp.connect(transport);
  return { mcp, transport };
}

/** Raw exchange for protocol details the SDK client never sends. */
function raw(client: SedesToolClient = fakeClient(), mode: "progressive" | "individual" = "individual") {
  const replies: unknown[] = [];
  const server = new SedesMcpServer({
    client,
    mode,
    serverVersion: "0.0.0-test",
    send: async (message) => {
      replies.push(message);
    },
  });
  return {
    server,
    replies,
    async exchange(line: string | null) {
      const before = replies.length;
      server.receive(line);
      await vi.waitFor(() => expect(replies.length).toBeGreaterThan(before));
      return replies.at(-1) as Record<string, unknown>;
    },
    async initialize(protocolVersion = "2025-11-25") {
      return this.exchange(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "init",
          method: "initialize",
          params: {
            protocolVersion,
            capabilities: {},
            clientInfo: { name: "raw", version: "1" },
          },
        }),
      );
    },
  };
}

describe("sedes mcp server", () => {
  it("negotiates the current protocol and advertises tools only", async () => {
    const { mcp } = await connect(fakeClient());
    expect(mcp.getServerVersion()).toEqual({
      name: "sedes",
      title: "Sedes",
      version: "0.0.0-test",
    });
    expect(mcp.getServerCapabilities()).toEqual({ tools: { listChanged: false } });
    expect(mcp.getInstructions()).toContain("current Sedes tool policy");
    await mcp.ping();
    await mcp.close();
  });

  it("lists one individual tool per canonical operation with truthful hints", async () => {
    const { mcp } = await connect(fakeClient());
    const { tools } = await mcp.listTools();
    expect(tools.map(({ name }) => name)).toEqual([
      "sedes_agent_context",
      "sedes_thread_status",
      "sedes_saved_agent_delete",
      "sedes_task_create",
      "sedes_research_web_search",
    ]);
    const status = tools.find(({ name }) => name === "sedes_thread_status")!;
    expect(status).toMatchObject({
      title: "Thread status",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", required: ["activity", "backend", "lifecycle", "threadId"] },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { "sedes/toolId": "thread.status", "sedes/schemaVersion": 2 },
    });
    expect(status.inputSchema).not.toHaveProperty("$schema");
    expect(status.outputSchema).not.toHaveProperty("$schema");
    expect(tools.find(({ name }) => name === "sedes_task_create")!.annotations).toEqual({
      title: "Create task",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(
      tools.find(({ name }) => name === "sedes_saved_agent_delete")!.annotations,
    ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(
      tools.find(({ name }) => name === "sedes_research_web_search")!.annotations,
    ).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    await mcp.close();
  });

  it("invokes an individual tool with structured output the SDK validates", async () => {
    const client = fakeClient();
    const { mcp } = await connect(client);
    await mcp.listTools();
    const result = await mcp.callTool({
      name: "sedes_thread_status",
      arguments: { threadId },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      threadId,
      backend: "codex_app_server",
      lifecycle: "active",
      activity: "idle",
    });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(
      result.structuredContent,
    );
    expect(client.invoke).toHaveBeenCalledWith(
      {
        toolId: "thread.status",
        schemaVersion: 2,
        requestId: "tool-request-1",
        input: { threadId },
      },
      expect.any(AbortSignal),
    );
    await mcp.close();
  });

  it("returns schema errors as tool errors without invoking", async () => {
    const client = fakeClient();
    const { mcp } = await connect(client);
    const result = await mcp.callTool({
      name: "sedes_thread_status",
      arguments: { threadId, extra: true },
    });
    expect(result.isError).toBe(true);
    const { error } = JSON.parse((result.content as { text: string }[])[0]!.text);
    expect(error).toMatchObject({ code: "invalid_input", retryable: false });
    expect(error.message).toContain("must NOT have additional properties");
    expect(client.invoke).not.toHaveBeenCalled();
    await mcp.close();
  });

  it("rejects a name outside the current catalog as a protocol error", async () => {
    const { mcp } = await connect(fakeClient(catalog(["agent.context"])));
    await expect(
      mcp.callTool({ name: "sedes_thread_status", arguments: { threadId } }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    await mcp.close();
  });

  it("maps failed invocations and transport errors to tool errors", async () => {
    const failed = fakeClient(catalog(), async () => ({
      invocationId: "invocation-2",
      state: "failed" as const,
      error: { code: "permission_denied", message: "Denied.", retryable: false },
    }));
    const first = await connect(failed);
    const denied = await first.mcp.callTool({ name: "sedes_agent_context", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(JSON.parse((denied.content as { text: string }[])[0]!.text)).toEqual({
      error: { code: "permission_denied", message: "Denied.", retryable: false },
    });
    await first.mcp.close();

    const unreachable = fakeClient(catalog(), async () => {
      throw new SedesToolApiError("transport_error", "Sedes is unreachable.", true);
    });
    const second = await connect(unreachable);
    const offline = await second.mcp.callTool({ name: "sedes_agent_context", arguments: {} });
    expect(JSON.parse((offline.content as { text: string }[])[0]!.text)).toEqual({
      error: { code: "transport_error", message: "Sedes is unreachable.", retryable: true },
    });
    await second.mcp.close();

    const hidden = fakeClient(catalog(), async () => {
      throw new Error("/secret/path");
    });
    const third = await connect(hidden);
    const internal = await third.mcp.callTool({ name: "sedes_agent_context", arguments: {} });
    expect((internal.content as { text: string }[])[0]!.text).not.toContain("secret");
    await third.mcp.close();
  });

  it("aborts the Sedes invocation when the client cancels the call", async () => {
    let observed: AbortSignal | undefined;
    const client = fakeClient(catalog(), (_request, signal) => {
      observed = signal;
      return new Promise<SedesToolInvocationResult<unknown>>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const { mcp, transport } = await connect(client);
    const controller = new AbortController();
    const call = mcp.callTool(
      { name: "sedes_agent_context", arguments: {} },
      undefined,
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(observed).toBeDefined());
    controller.abort(new Error("user stopped"));
    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(observed!.aborted).toBe(true));
    const callId = (
      transport.received.find(
        (message) => "method" in message && message.method === "tools/call",
      ) as { id: number }
    ).id;
    expect(transport.received).toContainEqual(
      expect.objectContaining({
        method: "notifications/cancelled",
        params: expect.objectContaining({ requestId: callId }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      transport.sent.some((message) => (message as { id?: unknown }).id === callId),
    ).toBe(false);
    await mcp.close();
  });

  it("serves progressive gateways with only the lanes the catalog needs", async () => {
    const reads = await connect(
      fakeClient(catalog(["agent.context", "thread.status"])),
      "progressive",
    );
    expect((await reads.mcp.listTools()).tools.map(({ name }) => name)).toEqual([
      "sedes_catalog",
      "sedes_read",
    ]);
    await reads.mcp.close();

    const all = await connect(fakeClient(), "progressive");
    const { tools } = await all.mcp.listTools();
    expect(tools.map(({ name }) => name)).toEqual([
      "sedes_catalog",
      "sedes_read",
      "sedes_act",
    ]);
    expect(tools[0]!.inputSchema).toMatchObject({ type: "object", required: ["action"] });
    expect(tools[2]!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(all.mcp.getInstructions()).toContain("sedes_catalog");
    await all.mcp.close();

    const empty = await connect(fakeClient(catalog([])), "progressive");
    expect((await empty.mcp.listTools()).tools).toEqual([]);
    await empty.mcp.close();
  });

  it("discovers and invokes through progressive gateways", async () => {
    const client = fakeClient();
    const { mcp } = await connect(client, "progressive");
    const listed = await mcp.callTool({
      name: "sedes_catalog",
      arguments: { action: "list" },
    });
    const summaries = (listed.structuredContent as { tools: Record<string, unknown>[] }).tools;
    expect(summaries.map(({ id }) => id)).toContain("thread.status");
    expect(summaries.every((summary) => !("cli" in summary))).toBe(true);

    const described = await mcp.callTool({
      name: "sedes_catalog",
      arguments: { action: "describe", toolIds: ["thread.status"] },
    });
    expect(described.structuredContent).toMatchObject({
      tools: [{ id: "thread.status", schemaVersion: 2 }],
    });

    const read = await mcp.callTool({
      name: "sedes_read",
      arguments: { toolId: "thread.status", schemaVersion: 2, input: { threadId } },
    });
    expect(read.structuredContent).toMatchObject({ threadId, lifecycle: "active" });

    const wrongLane = await mcp.callTool({
      name: "sedes_act",
      arguments: { toolId: "thread.status", schemaVersion: 2, input: { threadId } },
    });
    expect(wrongLane.isError).toBe(true);
    expect((wrongLane.content as { text: string }[])[0]!.text).toContain("sedes_read");

    const staleVersion = await mcp.callTool({
      name: "sedes_read",
      arguments: { toolId: "thread.status", schemaVersion: 1, input: { threadId } },
    });
    expect(JSON.parse((staleVersion.content as { text: string }[])[0]!.text)).toMatchObject({
      error: { code: "not_found" },
    });

    const malformed = await mcp.callTool({
      name: "sedes_catalog",
      arguments: { action: "describe" },
    });
    expect(malformed.isError).toBe(true);
    expect(client.invoke).toHaveBeenCalledTimes(1);
    await expect(
      mcp.callTool({ name: "sedes_thread_status", arguments: { threadId } }),
    ).rejects.toBeInstanceOf(McpError);
    await mcp.close();
  });

  it("omits newer tool fields for older negotiated protocol versions", async () => {
    const older = raw();
    expect(await older.initialize("2025-03-26")).toMatchObject({
      result: {
        protocolVersion: "2025-03-26",
        serverInfo: { name: "sedes", version: "0.0.0-test" },
      },
    });
    const listed = (await older.exchange(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    )) as { result: { tools: Record<string, unknown>[] } };
    const tool = listed.result.tools[0]!;
    expect(tool).toHaveProperty("annotations.readOnlyHint", true);
    expect(tool).not.toHaveProperty("title");
    expect(tool).not.toHaveProperty("outputSchema");
    expect(tool).not.toHaveProperty("_meta");
    const called = (await older.exchange(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "sedes_agent_context", arguments: {} },
      }),
    )) as { result: Record<string, unknown> };
    expect(called.result).not.toHaveProperty("structuredContent");

    const oldest = raw();
    await oldest.initialize("2024-11-05");
    const oldestList = (await oldest.exchange(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    )) as { result: { tools: Record<string, unknown>[] } };
    expect(oldestList.result.tools[0]).not.toHaveProperty("annotations");

    const future = raw();
    expect(await future.initialize("2099-01-01")).toMatchObject({
      result: { protocolVersion: "2025-11-25" },
    });
  });

  it("answers malformed, early, unknown, duplicate, and batched messages", async () => {
    const session = raw();
    expect(await session.exchange("{")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32_700, message: "Parse error" },
    });
    expect(await session.exchange(null)).toMatchObject({ error: { code: -32_700 } });
    expect(
      await session.exchange(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })),
    ).toMatchObject({ id: 1, error: { code: -32_600 } });
    expect(
      await session.exchange(JSON.stringify({ jsonrpc: "1.0", id: 9, method: "ping" })),
    ).toMatchObject({ id: 9, error: { code: -32_600 } });
    expect(
      await session.exchange(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })),
    ).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    await session.initialize();
    expect(await session.initialize()).toMatchObject({ error: { code: -32_600 } });
    expect(
      await session.exchange(
        JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/list" }),
      ),
    ).toMatchObject({ id: 3, error: { code: -32_601 } });
    expect(
      await session.exchange(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/list",
          params: { cursor: "next" },
        }),
      ),
    ).toMatchObject({ id: 4, error: { code: -32_602 } });
    expect(
      await session.exchange(
        JSON.stringify([
          { jsonrpc: "2.0", id: 5, method: "ping" },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 6, method: "ping" },
        ]),
      ),
    ).toEqual([
      { jsonrpc: "2.0", id: 5, result: {} },
      { jsonrpc: "2.0", id: 6, result: {} },
    ]);
    expect(await session.exchange("[]")).toMatchObject({ error: { code: -32_600 } });

    const blocked = fakeClient(
      catalog(),
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const duplicate = raw(blocked);
    await duplicate.initialize();
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "sedes_agent_context", arguments: {} },
    });
    duplicate.server.receive(call);
    await vi.waitFor(() => expect(blocked.invoke).toHaveBeenCalled());
    expect(await duplicate.exchange(call)).toMatchObject({
      id: 7,
      error: { code: -32_600 },
    });
    await duplicate.server.close();
  });

  it("reports an unavailable Sedes catalog as a listing failure", async () => {
    const client = fakeClient();
    client.listTools.mockRejectedValue(
      new SedesToolApiError("transport_error", "Sedes is unreachable.", true),
    );
    const session = raw(client);
    await session.initialize();
    expect(
      await session.exchange(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })),
    ).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32_603, message: "Sedes tools are unavailable (transport_error)." },
    });
  });
});
