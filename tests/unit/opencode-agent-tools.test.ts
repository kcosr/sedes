import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeAgentTools } from "../../src/server/backends/opencode/opencode-agent-tools.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeMcpIngress, type OpenCodeMcpChannel } from "../../src/server/backends/opencode/opencode-mcp-ingress.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";
import { createOpenCodeConversationFixture } from "../support/opencode-conversation-fixture.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { OPENCODE_MCP_CREDENTIAL, OPENCODE_MCP_ENDPOINT } from "../../src/internal/opencode-mcp/contracts.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(options: { inventory?: unknown; beforeInventory?: () => Promise<void>; dropAck?: boolean; cli?: boolean } = {}) {
  const wire = createOpenCodeApiFixture();
  const registrations: { name: string; config: { command: string[]; environment: Record<string, string>; codemode: boolean; protocol: string } }[] = [];
  const mutations: string[] = [];
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "test-only", fetch: async (value, init) => {
    const url = new URL(String(value));
    if (url.pathname === "/api/mcp") {
      await options.beforeInventory?.();
      return Response.json(options.inventory ?? { location: { directory: wire.directory }, data: [] });
    }
    if (url.pathname.startsWith("/api/experimental/mcp/")) {
      mutations.push(init?.method ?? "GET");
      registrations.push({ name: url.pathname.split("/").at(-1)!, ...JSON.parse(String(init?.body)) });
      if (options.dropAck) throw new Error("lost acknowledgement");
      return new Response(null, { status: 204 });
    }
    return wire.fetch(value, init);
  } });
  const f = createOpenCodeConversationFixture({ native: { client, sessionID: wire.sessionID, directory: wire.directory } });
  // Creation provenance itself is covered by repository tests. Exercise the manager lifecycle here.
  vi.spyOn(f.repository, "hasCreatedRoot").mockReturnValue(true);
  const canonical = new CanonicalInlineAgentToolService({ application: { readThreadStatus: async () => undefined } });
  const facade = { eligibleCatalog: () => canonical.catalog("mcp", "thread_agent"),
    catalogSummaries: vi.fn(() => canonical.catalogSummaries("mcp", "thread_agent")),
    describeMany: vi.fn((_source, _adapter, ids) => canonical.describeMany("mcp", "thread_agent", ids)),
    readPolicy: vi.fn(() => ({ enabled: true, presentation: { surface: options.cli ? "cli" as const : "native" as const, mode: "progressive" as const },
      accessBoundary: "thread" as const, enabledToolIds: ["agent.context"] })),
    invoke: vi.fn(async () => { throw new Error("unexpected invocation"); }) };
  const tools = new OpenCodeAgentTools({ facade, cli: { availability: "available", endpoint: "http://127.0.0.1:4784", executableDirectory: "/bundled/bin", inheritedPath: "/bin" } });
  cleanups.push(() => f.dispose()); cleanups.push(() => tools.close());
  const context = { ...f.context, tools };
  const admit = () => tools.admit(context, f.target, f.runtime);
  return { ...f, wire, context, tools, facade, registrations, mutations, admit };
}
async function connect(environment: Record<string, string>) {
  const endpoint = environment[OPENCODE_MCP_ENDPOINT]!; const authorization = `Bearer ${environment[OPENCODE_MCP_CREDENTIAL]}`;
  const controller = new AbortController();
  const response = await fetch(`${endpoint}/lifetime`, { headers: { authorization }, signal: controller.signal });
  const reader = response.body!.getReader();
  const hello = JSON.parse(Buffer.from((await reader.read()).value!).toString().trim());
  cleanups.push(async () => { controller.abort(); await reader.cancel().catch(() => undefined); });
  return { call: (sessionID: string) => fetch(`${endpoint}/tools`, { method: "POST", headers: { authorization, "content-type": "application/json", "x-sedes-stream": hello.streamID },
    body: JSON.stringify({ operation: "list", sessionID }) }) };
}
describe("OpenCode MCP runtime admission", () => {
  it("fences initial admission released while its session read is pending", async () => {
    const f = fixture(); const read = f.wire.hold(`/api/session/${f.wire.sessionID}`);
    const admission = f.admit(); await read.entered;
    f.tools.release(f.target.binding.applicationThreadId); read.release(); await admission;
    expect(f.registrations).toEqual([]); expect(f.mutations).toEqual([]);
    expect(f.runtime.snapshot().references).toBe(0);
    await f.admit(); expect(f.registrations).toHaveLength(1);
  });
  it("reprobes native identity after a delayed session read before serving a tool call", async () => {
    const f = fixture(); await f.admit();
    const channel = await connect(f.registrations[0]!.config.environment);
    const read = f.wire.hold(`/api/session/${f.wire.sessionID}`);
    const response = channel.call(f.wire.sessionID);
    await read.entered;
    // A native replacement is discovered by probing, not by the cached generation.
    const cached = f.runtime.snapshot();
    vi.mocked(f.runtime.assertCurrent).mockRejectedValue(new Error("native identity changed"));
    read.release();
    const result = await response;
    expect(result.status).toBe(503); await result.body?.cancel();
    expect(f.runtime.snapshot().generation).toBe(cached.generation);
    expect(f.facade.catalogSummaries).not.toHaveBeenCalled();
    expect(f.facade.invoke).not.toHaveBeenCalled();
  });
  it.each(["native replacement", "residency release"] as const)("does not register after %s during inventory", async reason => {
    const entered = deferred(); const release = deferred();
    const f = fixture({ beforeInventory: async () => { entered.resolve(); await release.promise; } });
    const admission = f.admit(); await entered.promise;
    if (reason === "native replacement") vi.mocked(f.runtime.assertCurrent).mockRejectedValue(new Error("native identity changed"));
    else f.tools.release(f.target.binding.applicationThreadId);
    release.resolve(); await admission;
    expect(f.registrations).toEqual([]); expect(f.mutations).toEqual([]);
  });
  it("revokes a newly opened bridge if residency ends while ingress starts", async () => {
    const original = OpenCodeMcpIngress.prototype.admit;
    const entered = deferred(); const release = deferred();
    let channel: OpenCodeMcpChannel | undefined;
    vi.spyOn(OpenCodeMcpIngress.prototype, "admit").mockImplementation(async function (this: OpenCodeMcpIngress, input) {
      channel = await original.call(this, input); entered.resolve(); await release.promise;
      return channel;
    });
    const f = fixture(); const admission = f.admit(); await entered.promise;
    expect(channel?.revoked).toBe(false);
    f.tools.release(f.target.binding.applicationThreadId); release.resolve(); await admission;
    expect(channel?.revoked).toBe(true);
    expect(f.registrations).toEqual([]); expect(f.mutations).toEqual([]);
  });
  it("reuses one registration across concurrent admission and residency release without native deletion", async () => {
    const f = fixture(); await Promise.all([f.admit(), f.admit()]);
    expect(f.registrations).toHaveLength(1);
    expect(f.registrations[0]!.config).toMatchObject({ command: ["/bundled/bin/sedes", "opencode-mcp"], codemode: false, protocol: "legacy" });
    const channel = await connect(f.registrations[0]!.config.environment);
    let response = await channel.call(f.target.binding.backendConversationId); expect(response.status).toBe(200); await response.body?.cancel();
    f.tools.release(f.target.binding.applicationThreadId);
    response = await channel.call(f.target.binding.backendConversationId); expect(response.status).toBe(403); await response.body?.cancel();
    await f.admit(); expect(f.registrations).toHaveLength(1);
    response = await channel.call("ses_foreign"); expect(response.status).toBe(403); await response.body?.cancel();
    expect(f.facade.catalogSummaries).toHaveBeenCalledTimes(1);
    await f.tools.close(); expect(f.mutations).toEqual(["PUT"]);
  });
  it("keeps controls usable after unreadable native inventory without mutating it", async () => {
    const f = fixture({ inventory: { invalid: true } }); await expect(f.admit()).resolves.toBeUndefined();
    expect(f.registrations).toHaveLength(0); expect(f.tools.diagnostic(f.target.binding.applicationThreadId)).toContain("unavailable");
  });
  it("does not issue a second registration after uncertain PUT acknowledgement", async () => {
    const f = fixture({ dropAck: true }); await f.admit(); await f.admit();
    expect(f.registrations).toHaveLength(1); expect(f.tools.diagnostic(f.target.binding.applicationThreadId)).toContain("unavailable");
    await connect(f.registrations[0]!.config.environment); await f.admit();
    expect(f.registrations).toHaveLength(1); expect(f.tools.diagnostic(f.target.binding.applicationThreadId)).toBeUndefined();
  });
  it("admits CLI provenance without registering MCP and rejects access decisions without current user proof", async () => {
    const f = fixture({ cli: true }); await f.admit(); expect(f.registrations).toHaveLength(0);
    const source = { scope: f.target.scope, sourceThreadId: f.target.binding.applicationThreadId,
      sourceWorkspaceId: f.target.workspace.summary.id, sourceEnvironmentId: f.target.binding.executionEnvironmentId, backendKind: "opencode" as const };
    await expect(f.tools.accessDecisionAuthority(source).acquire(new AbortController().signal)).rejects.toMatchObject({ toolError: { code: "permission_denied" } });
    f.tools.release(source.sourceThreadId);
    await expect(f.tools.accessDecisionAuthority(source).acquire(new AbortController().signal)).rejects.toMatchObject({ toolError: { code: "permission_denied" } });
  });
});
