import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeMcpIngress } from "../../src/server/backends/opencode/opencode-mcp-ingress.js";
import { runSedesOpenCodeMcp } from "../../src/cli/sedes-opencode-mcp.js";
import { OPENCODE_MCP_CREDENTIAL, OPENCODE_MCP_ENDPOINT } from "../../src/internal/opencode-mcp/contracts.js";
import { BackendAgentToolRequestError } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const tools = new CanonicalInlineAgentToolService({ application: { readThreadStatus: async () => undefined } });
const catalog = tools.catalogSummaries("mcp", "thread_agent");
async function fixture(invoke: Parameters<OpenCodeMcpIngress["admit"]>[0]["invoke"]) {
  const ingress = new OpenCodeMcpIngress(); cleanups.push(() => ingress.close());
  const channel = await ingress.admit({ catalog, invoke });
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
      controller.enqueue(Buffer.from(`${JSON.stringify({ streamID: "00000000-0000-4000-8000-000000000001", catalog: [] })}\n`));
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
