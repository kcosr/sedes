import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeMcpIngress } from "../../src/server/backends/opencode/opencode-mcp-ingress.js";
import { runSedesOpenCodeMcp } from "../../src/cli/sedes-opencode-mcp.js";
import { OPENCODE_MCP_CREDENTIAL, OPENCODE_MCP_ENDPOINT, OPENCODE_MCP_MAXIMUM_BYTES } from "../../src/internal/opencode-mcp/contracts.js";
import { SEDES_MCP_MAXIMUM_INBOUND_LINE_BYTES } from "../../src/internal/agent-tool-mcp/mcp-protocol.js";
import { AGENT_TOOL_MAXIMUM_RESPONSE_BYTES } from "../../src/server/agent-tools/contracts/agent-tool-transport-limits.js";
import { BackendAgentToolRequestError } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { maximumPreviewResult } from "../helpers/page-preview-media-fixture.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const tools = new CanonicalInlineAgentToolService({ application: { readThreadStatus: async () => undefined } });
const catalog = tools.catalogSummaries("mcp", "thread_agent");
async function fixture(invoke: Parameters<OpenCodeMcpIngress["admit"]>[0]["invoke"], toolCatalog = catalog) {
  const ingress = new OpenCodeMcpIngress(); cleanups.push(() => ingress.close());
  const channel = await ingress.admit({ catalog: toolCatalog, invoke });
  const input = new PassThrough(); const replies: any[] = []; let stdout = "", stderr = "";
  const result = runSedesOpenCodeMcp([], { environment: { ...channel.environment }, input,
    output: { write: text => { stdout += text; for (const line of text.trim().split("\n")) replies.push(JSON.parse(line)); return true; }, once: () => {} },
    stderr: { write: text => { stderr += text; } } });
  cleanups.push(async () => { input.end(); channel.revoke(); await result; });
  const send = (id: number, method: string, params?: unknown) => input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
  const reply = async (id: number) => { await vi.waitFor(() => expect(replies.some(reply => reply.id === id)).toBe(true)); return replies.find(reply => reply.id === id); };
  send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }); await reply(1);
  return { ingress, channel, input, result, send, reply, stdout: () => stdout, stderr: () => stderr };
}
const call = (sessionID?: string) => ({ name: "sedes_catalog", arguments: { action: "list" },
  ...(sessionID ? { _meta: { "ai.opencode/sessionID": sessionID } } : {}) });

describe("OpenCode per-call MCP bridge", () => {
  it.each([
    { name: "65,537 ASCII units", content: "x".repeat(65_537) },
    { name: "262,144 emoji units", content: "🙂".repeat(131_072) },
    { name: "262,144 escaped control units", content: "\u0000".repeat(262_144) },
  ])("carries Workpad create, update and get through real Native ingress: $name", async ({ content }) => {
    const workpadTools = new CanonicalInlineAgentToolService({ application: {} as never, workpads: {} as never });
    const seen: string[] = [];
    let current = content;
    let revision = 0;
    const pad = () => ({ id: "pad", title: "Large", scope: { kind: "global" }, revision,
      author: { kind: "user", name: "You", nameSnapshot: "You", threadId: null, clientId: null },
      createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z", archivedAt: null, content: current });
    const f = await fixture(async request => {
      if (request.operation === "describe") return { tools: workpadTools.describeMany("mcp", "thread_agent", request.toolIds) };
      if (request.operation !== "invoke") throw new Error("Unexpected request");
      seen.push(request.request.toolId);
      const input = request.request.input as { content?: string; edit?: { content: string } };
      if (request.request.toolId === "workpad.create") expect(input.content).toBe(content);
      if (request.request.toolId === "workpad.update") { expect(input.edit?.content).toBe(content); current = input.edit!.content; revision++; }
      return { invocationId: "workpad-result", state: "completed", output: { workpad: pad() } };
    }, workpadTools.catalogSummaries("mcp", "thread_agent"));
    for (const [index, toolId, input] of [
      [2, "workpad.create", { title: "Large", scope: { kind: "global" }, content }],
      [3, "workpad.update", { workpadId: "pad", expectedRevision: 0, edit: { kind: "replace", content } }],
      [4, "workpad.get", { workpadId: "pad" }],
    ] as const) {
      f.send(index, "tools/call", { name: toolId === "workpad.get" ? "sedes_read" : "sedes_act",
        arguments: { toolId, schemaVersion: 2, input }, _meta: { "ai.opencode/sessionID": "ses_workpad" } });
      const response = await f.reply(index);
      expect(response.result.isError).toBeUndefined();
      expect(response.result.structuredContent).toEqual({ workpad: pad() });
    }
    expect(seen).toEqual(["workpad.create", "workpad.update", "workpad.get"]);
    expect(f.stderr()).toBe("");
  });

  it("preserves maximum preview PNG and escaped console through real private HTTP and MCP framing", async () => {
    const maximum = maximumPreviewResult();
    const pageTools = new CanonicalInlineAgentToolService({ application: { readThreadStatus: async () => undefined }, pages: {} as never });
    const description = pageTools.describeMany("mcp", "thread_agent", ["page.preview"])[0]!;
    const f = await fixture(async request => request.operation === "describe" ? { tools: [description] } : maximum);
    f.send(2, "tools/call", { name: "sedes_read", arguments: { toolId: "page.preview", schemaVersion: 1, input: { html: "<p>preview</p>" } }, _meta: { "ai.opencode/sessionID": "ses_a" } });
    const response = await f.reply(2);
    expect(response.result.isError).toBeUndefined();
    expect(response.result.structuredContent).toEqual(maximum.output);
    expect(response.result.content[1]).toEqual(maximum.modelContent[0]);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(4 * 1024 * 1024);
    expect(f.stderr()).toBe("");
  });
  it("delivers PNG blocks above the generic JSON-string bound", async () => {
    const description = tools.describeMany("mcp", "thread_agent", ["thread.status"])[0]!;
    const output = { threadId: "thread", backend: "opencode", lifecycle: "active", activity: "idle", pinned: false };
    const image = { type: "image", mimeType: "image/png",
      data: Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(70_000)]).toString("base64") };
    const f = await fixture(async request => request.operation === "describe" ? { tools: [description] }
      : { invocationId: "image-result", state: "completed", output, modelContent: [image] });
    f.send(2, "tools/call", { name: "sedes_read", arguments: { toolId: "thread.status", schemaVersion: description.schemaVersion,
      input: { threadId: "thread" } }, _meta: { "ai.opencode/sessionID": "ses_a" } });
    const response = await f.reply(2);
    expect(response.result.isError).toBeUndefined();
    expect(response.result.structuredContent).toEqual(output);
    expect(response.result.content[1]).toEqual(image);
  });
  it("preserves a completed act invocation and near-4 MiB result through both bridge transports", async () => {
    // Exercise aggregate transport size while retaining the canonical JSON
    // codec's independent per-string/depth/node limits.
    const chunks = Array.from({ length: 63 }, () => "x".repeat(65_536));
    const output = { chunks, committed: true };
    const completed = { invocationId: "large-completed-write", state: "completed", output };
    expect(Buffer.byteLength(JSON.stringify(completed))).toBeGreaterThan(4_000_000);
    expect(Buffer.byteLength(JSON.stringify(completed))).toBeLessThan(AGENT_TOOL_MAXIMUM_RESPONSE_BYTES);
    expect(OPENCODE_MCP_MAXIMUM_BYTES).toBe(SEDES_MCP_MAXIMUM_INBOUND_LINE_BYTES);
    const ordinary = tools.describeMany("mcp", "thread_agent", ["thread.status"])[0]!;
    const description = { ...ordinary, id: "fixture.write", effects: { application: "write", modelUsage: "none", external: "durable_side_effect" },
      inputSchema: { $schema: ordinary.inputSchema.$schema, type: "object", additionalProperties: false,
        required: ["chunks"], maxProperties: 1, properties: { chunks: { type: "array", minItems: 63, maxItems: 63,
          items: { type: "string", maxLength: 65_536 } } } },
      execution: { ...ordinary.execution, maximumInputBytes: AGENT_TOOL_MAXIMUM_RESPONSE_BYTES,
        maximumOutputBytes: AGENT_TOOL_MAXIMUM_RESPONSE_BYTES, uncertainExternalOutcome: true } };
    let mutations = 0;
    const f = await fixture(async request => {
      if (request.operation === "describe") return { tools: [description] };
      if (request.operation !== "invoke") throw new Error("unexpected request");
      expect(request.request.toolId).toBe("fixture.write");
      expect(request.request.input).toEqual({ chunks });
      mutations++;
      return completed;
    });
    f.send(2, "tools/call", { name: "sedes_act", arguments: {
      toolId: "fixture.write", schemaVersion: description.schemaVersion, input: { chunks },
    }, _meta: { "ai.opencode/sessionID": "ses_a" } });
    const response = await f.reply(2);
    expect(response.result.isError).toBeUndefined();
    expect(response.result.structuredContent).toEqual(output);
    expect(mutations).toBe(1);
    expect(f.stderr()).toBe("");
  });
  it("rejects an over-bound private request before invocation", async () => {
    const invoke = vi.fn(); const f = await fixture(invoke);
    const endpoint = f.channel.environment[OPENCODE_MCP_ENDPOINT]!;
    const authorization = `Bearer ${f.channel.environment[OPENCODE_MCP_CREDENTIAL]}`;
    const lifetime = new AbortController();
    const response = await fetch(`${endpoint}/lifetime`, { headers: { authorization }, signal: lifetime.signal });
    const reader = response.body!.getReader();
    const hello = JSON.parse(Buffer.from((await reader.read()).value!).toString().trim());
    try {
      const oversized = await fetch(`${endpoint}/tools`, { method: "POST", headers: {
        authorization, "content-type": "application/json", "x-sedes-stream": hello.streamID,
      }, body: JSON.stringify({ operation: "invoke", sessionID: "ses_a", request: {
        toolId: "fixture.write", schemaVersion: 1, requestId: "oversized",
        input: { chunks: Array.from({ length: 65 }, () => "x".repeat(65_536)) },
      } }) });
      expect(oversized.status).toBe(503); await oversized.body?.cancel();
      for (const request of [
        { toolId: "fixture.write", schemaVersion: 1, requestId: "generic-string", input: { content: "x".repeat(65_537) } },
        { toolId: "workpad.create", schemaVersion: 2, requestId: "unknown-field", input: {
          title: "Notes", scope: { kind: "global" }, content: "x".repeat(262_144), unknown: "x".repeat(65_537),
        } },
        { toolId: "workpad.create", schemaVersion: 2, requestId: "over-limit", input: {
          title: "Notes", scope: { kind: "global" }, content: "x".repeat(262_145),
        } },
      ]) {
        const rejected = await fetch(`${endpoint}/tools`, { method: "POST", headers: {
          authorization, "content-type": "application/json", "x-sedes-stream": hello.streamID,
        }, body: JSON.stringify({ operation: "invoke", sessionID: "ses_a", request }) });
        expect(rejected.status).toBe(503); await rejected.body?.cancel();
      }
      expect(invoke).not.toHaveBeenCalled();
    } finally { lifetime.abort(); await reader.cancel().catch(() => undefined); }
  });
  it("discovers three fixed gateways without a session and routes each concurrent call independently", async () => {
    const invoke = vi.fn(async request => {
      if (request.sessionID === "ses_a") { await new Promise(resolve => setTimeout(resolve, 25)); return { tools: catalog.filter(tool => tool.id === "thread.status") }; }
      if (request.sessionID === "ses_b") return { tools: catalog.filter(tool => tool.id === "agent.context") };
      throw new BackendAgentToolRequestError({ code: "permission_denied", message: "Unmapped session.", retryable: false });
    });
    const f = await fixture(invoke);
    f.send(2, "tools/list"); const listing = await f.reply(2);
    expect(listing.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["sedes_catalog", "sedes_read", "sedes_act"]);
    expect(invoke).not.toHaveBeenCalled();
    f.send(3, "tools/call", call("ses_a")); f.send(4, "tools/call", call("ses_b"));
    expect(JSON.stringify(await f.reply(3))).toContain("thread.status");
    expect(JSON.stringify(await f.reply(4))).toContain("agent.context");
    f.send(5, "tools/call", call()); f.send(6, "tools/call", call("ses_foreign"));
    expect((await f.reply(5)).result.isError).toBe(true);
    expect((await f.reply(6)).result.isError).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(f.stdout()).not.toContain(f.channel.environment[OPENCODE_MCP_CREDENTIAL]);
    expect(f.stdout()).not.toContain(f.channel.environment[OPENCODE_MCP_ENDPOINT]);
    expect(f.stderr()).toBe("");
  });
  it("cancels a pending tool and closes the child when the authenticated lifetime is revoked", async () => {
    let current: AbortSignal | undefined;
    const f = await fixture(async (_request, signal) => { current = signal; await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); });
    f.send(2, "tools/call", call("ses_a")); await vi.waitFor(() => expect(current).toBeDefined());
    f.channel.revoke(); await vi.waitFor(() => expect(current?.aborted).toBe(true));
    await expect(f.result).resolves.toBe(0);
  });
  it("rejects unauthenticated requests before reading session identity", async () => {
    const invoke = vi.fn(); const f = await fixture(invoke);
    const endpoint = f.channel.environment[OPENCODE_MCP_ENDPOINT]!;
    const response = await fetch(`${endpoint}/tools`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionID: "ses_a", operation: "list" }) });
    expect(response.status).toBe(401); await response.body?.cancel(); expect(invoke).not.toHaveBeenCalled();
    const foreignOrigin = await fetch(`${endpoint}/lifetime`, { headers: { authorization: `Bearer ${f.channel.environment[OPENCODE_MCP_CREDENTIAL]}`, origin: "https://untrusted.invalid" } });
    expect(foreignOrigin.status).toBe(403); await foreignOrigin.body?.cancel();
  });
  it("rejects invalid private startup environment with a fixed credential-free diagnostic", async () => {
    let stderr = "";
    expect(await runSedesOpenCodeMcp([], { environment: { SEDES_OPENCODE_MCP_ENDPOINT: "https://secret.invalid/secret" }, stderr: { write: text => { stderr += text; } } })).toBe(1);
    expect(stderr).toBe("Sedes OpenCode tools are unavailable.\n");
  });
});

it("supersedes an authenticated child stream and aborts its accepted calls without accepting old stream IDs", async () => {
  const ingress = new OpenCodeMcpIngress(); cleanups.push(() => ingress.close());
  let pending: AbortSignal | undefined;
  const channel = await ingress.admit({ catalog: [], invoke: async (request, signal) => {
    if (request.sessionID === "ses_wait") {
      pending = signal; await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    }
    return { tools: [] };
  } });
  const endpoint = channel.environment[OPENCODE_MCP_ENDPOINT]!;
  const authorization = `Bearer ${channel.environment[OPENCODE_MCP_CREDENTIAL]}`;
  const open = async () => {
    const controller = new AbortController();
    const response = await fetch(`${endpoint}/lifetime`, { headers: { authorization }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const hello = JSON.parse(Buffer.from((await reader.read()).value!).toString().trim());
    cleanups.push(async () => { controller.abort(); await reader.cancel().catch(() => undefined); });
    return hello.streamID as string;
  };
  const call = (stream: string, sessionID: string) => fetch(`${endpoint}/tools`, { method: "POST",
    headers: { authorization, "content-type": "application/json", "x-sedes-stream": stream }, body: JSON.stringify({ operation: "list", sessionID }) });
  const first = await open();
  const request = call(first, "ses_wait");
  await vi.waitFor(() => expect(pending).toBeDefined());
  const second = await open(); expect(second).not.toBe(first);
  await vi.waitFor(() => expect(pending?.aborted).toBe(true));
  const cancelled = await request; expect(cancelled.status).toBe(503); await cancelled.body?.cancel();
  const stale = await call(first, "ses_ok"); expect(stale.status).toBe(403); await stale.body?.cancel();
  const live = await call(second, "ses_ok"); expect(live.status).toBe(200); await live.body?.cancel();
});

it("exits on a silent lifetime watchdog without waiting for stdin EOF", async () => {
  vi.useFakeTimers();
  try {
    const input = new PassThrough(); let stdout = "";
    const wire = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(Buffer.from(`${JSON.stringify({ protocolVersion: 3, streamID: "00000000-0000-4000-8000-000000000001", catalog: [] })}\n`));
    } });
    const running = runSedesOpenCodeMcp([], { input, environment: { SEDES_OPENCODE_MCP_ENDPOINT: "http://127.0.0.1:4096", SEDES_OPENCODE_MCP_CREDENTIAL: "a".repeat(43) },
      fetch: vi.fn(async () => new Response(wire, { headers: { "content-type": "application/x-ndjson" } })),
      output: { write: chunk => { stdout += chunk; return true; }, once: () => {} }, stderr: { write: () => {} } });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`);
    await vi.waitFor(() => expect(stdout).toContain('"id":1'));
    await vi.advanceTimersByTimeAsync(3_001);
    await expect(running).resolves.toBe(0); input.destroy();
  } finally { vi.useRealTimers(); }
});
