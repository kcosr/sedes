import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeAgentTools } from "../../src/server/backends/opencode/opencode-agent-tools.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeMcpIngress, type OpenCodeMcpChannel } from "../../src/server/backends/opencode/opencode-mcp-ingress.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";
import { createOpenCodeConversationFixture } from "../support/opencode-conversation-fixture.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { OPENCODE_MCP_CREDENTIAL, OPENCODE_MCP_ENDPOINT, OPENCODE_MCP_WATCHDOG_MS } from "../../src/internal/opencode-mcp/contracts.js";
import { findOpenCodeInputObserver } from "../../src/server/backends/opencode/opencode-input-observer.js";
import { OpenCodeInputEvidenceRepository } from "../../src/server/backends/opencode/opencode-input-evidence.js";
import { PassThrough } from "node:stream";
import { runSedesOpenCodeMcp } from "../../src/cli/sedes-opencode-mcp.js";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import type { BackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";
import type { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { ScopedThreadEventHubRegistry, ThreadRuntimeCoordinator } from "../../src/server/events/thread-runtime-coordinator.js";
import type { ConversationEventBridge } from "../../src/server/events/conversation-event-bridge.js";
import type { InteractionBroker } from "../../src/server/conversations/interaction-broker.js";
import type { AgentToolApplicationReader } from "../../src/server/agent-tools/tools/agent-tool-readers.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(options: { inventory?: unknown; beforeInventory?: () => Promise<void>; dropAck?: boolean; cli?: boolean; retentionMilliseconds?: number } = {}) {
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
  const f = createOpenCodeConversationFixture({ native: { client, sessionID: wire.sessionID, directory: wire.directory },
    ...(options.retentionMilliseconds === undefined ? {} : { retentionMilliseconds: options.retentionMilliseconds }) });
  // Creation provenance itself is covered by repository tests. Exercise the manager lifecycle here.
  vi.spyOn(f.repository, "hasCreatedRoot").mockReturnValue(true);
  const canonical = new CanonicalInlineAgentToolService({ application: { readThreadStatus: async () => undefined } });
  const facade = { eligibleCatalog: () => canonical.catalog("mcp", "thread_agent"),
    catalogSummaries: vi.fn(() => canonical.catalogSummaries("mcp", "thread_agent")),
    describeMany: vi.fn((_source, _adapter, ids) => canonical.describeMany("mcp", "thread_agent", ids)),
    readPolicy: vi.fn(() => ({ enabled: true, presentation: { surface: options.cli ? "cli" as const : "native" as const, mode: "progressive" as const },
      accessBoundary: "thread" as const, enabledToolIds: ["agent.context"] })),
    invoke: vi.fn<BackendAgentToolFacade["invoke"]>(async () => { throw new Error("unexpected invocation"); }) as
      ReturnType<typeof vi.fn<BackendAgentToolFacade["invoke"]>> & BackendAgentToolFacade["invoke"] };
  const tools = new OpenCodeAgentTools({ facade, cli: { availability: "available", endpoint: "http://127.0.0.1:4784", executableDirectory: "/bundled/bin", inheritedPath: "/bin" } });
  cleanups.push(() => f.dispose()); cleanups.push(() => tools.close());
  const context = Object.assign(f.context, { tools });
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
  it.each(["access decision", "approved execution"] as const)("blocks automatic eviction during a bridge %s and returns typed cancellation on explicit close without replay", async phase => {
    const f = fixture({ retentionMilliseconds: 0 });
    const { scope, binding, workspace } = f.target;
    const coordinator = new ThreadRuntimeCoordinator({ actors: f.manager, targets: { resolve: async () => f.target },
      bridge: { bind: () => ({ ready: Promise.resolve(), publishAuthoritativeReplacement: vi.fn(), release: async () => {} }) } as unknown as ConversationEventBridge,
      interactions: { bind: () => ({ publishPending: vi.fn(), release: async () => {} }) } as unknown as InteractionBroker,
      hubs: new ScopedThreadEventHubRegistry(), retentionMilliseconds: 0 });
    cleanups.push(() => coordinator.close());
    const acquired = await coordinator.acquire(scope, binding.applicationThreadId);
    const handle = await f.handle();
    const observer = findOpenCodeInputObserver(f.client, f.target)!;
    const evidence = new OpenCodeInputEvidenceRepository(f.repository);
    f.repository.reserveOperation(scope, { applicationThreadId: binding.applicationThreadId,
      connectionProfileId: binding.connectionProfileId, executionEnvironmentId: binding.executionEnvironmentId,
      nativeSessionId: f.wire.sessionID, applicationOperationId: "approval-eviction-input", operationKind: "submit",
      nativeInputId: "msg_current", requestFingerprint: "b".repeat(64), requestSource: { kind: "user" }, deadlineAt: null }, Date.now());
    observer.track(evidence.begin(scope, binding.applicationThreadId, "approval-eviction-input", "submit", observer.trackerId, "queue"));
    f.repository.markDispatched(scope, binding.applicationThreadId, "approval-eviction-input", "submit", Date.now());
    observer.recordAdmission("approval-eviction-input", "submit", { id: "msg_current", sessionID: f.wire.sessionID,
      type: "user", payload: { text: "current user" }, delivery: "queue", time: { created: 1 } });
    f.wire.send({ id: "evt_approval_eviction_delivered", type: "session.inbox.delivered", created: 1,
      durable: { aggregateID: f.wire.sessionID, seq: 1, version: 1 }, data: { sessionID: f.wire.sessionID, inboxID: "msg_current" } });
    await vi.waitFor(() => expect(evidence.get(scope, binding.applicationThreadId, "approval-eviction-input", "submit").consumedFingerprint).not.toBeNull());
    const source = { scope, sourceThreadId: binding.applicationThreadId, sourceWorkspaceId: workspace.summary.id,
      sourceEnvironmentId: binding.executionEnvironmentId, backendKind: "opencode" as const };
    const readThreadStatus = vi.fn<AgentToolApplicationReader["readThreadStatus"]>(async (_scope, _id, _authority, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const decision = vi.fn(({ signal }: { signal: AbortSignal }) => phase === "approved execution" ? Promise.resolve("allow" as const)
      : new Promise<"allow" | "deny">((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
    const facade = new SourceScopedAgentToolService(new CanonicalInlineAgentToolService({ application: { readThreadStatus } }),
      { get: () => ({ enabled: true, enabledToolIds: ["thread.status"], presentation: { surface: "native", mode: "progressive" },
        accessBoundary: "thread", revision: 1 }) } as unknown as ThreadAgentToolPolicyRepository,
      new AgentToolEnvironmentAuthorityResolver({
        resolveEnvironment: () => undefined, resolveWorkspace: () => undefined,
        resolveThread: (_scope, id) => ({ id, environmentId: binding.executionEnvironmentId, label: "Other thread" }),
        resolveThreadFamily: () => undefined, resolveSavedAgent: () => undefined, resolveWorkpad: () => undefined,
        resolveTask: () => undefined, listEnvironments: () => [{ id: binding.executionEnvironmentId, environmentId: binding.executionEnvironmentId, label: "Local" }],
      }), { resolveInScope: () => source }, coordinator, { requestApplicationDecision: decision });
    f.facade.invoke.mockImplementation(input => facade.invoke(input));
    const stdin = new PassThrough(); const replies: Record<string, any>[] = [];
    const child = runSedesOpenCodeMcp([], { environment: f.registrations[0]!.config.environment, input: stdin,
      output: { write: text => { for (const line of text.trim().split("\n")) replies.push(JSON.parse(line)); return true; }, once: () => {} },
      stderr: { write: () => {} } });
    cleanups.push(async () => { stdin.end(); await child; });
    const send = (id: number, method: string, params: unknown) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    send(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    await vi.waitFor(() => expect(replies.some(reply => reply.id === 1)).toBe(true));
    send(2, "tools/call", { name: "sedes_read", arguments: { toolId: "thread.status", schemaVersion: 2, input: { threadId: "other-thread" } },
      _meta: { "ai.opencode/sessionID": f.wire.sessionID } });
    await vi.waitFor(() => {
      expect(replies.find(reply => reply.id === 2)).toBeUndefined();
      expect(decision).toHaveBeenCalledOnce();
      expect(readThreadStatus).toHaveBeenCalledTimes(phase === "approved execution" ? 1 : 0);
    });
    acquired.release(); // The approval borrow is now the only application runtime reference.
    expect(acquired.actor.canAutomaticallyEvict).toBe(true); // Native state itself is idle.
    expect(coordinator.tryReclaimOldestIdleRuntime({ budgetScope: { ...scope, executionEnvironmentId: binding.executionEnvironmentId } })).toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 15)); // Also cross the zero-retention timer.
    expect(acquired.actor.closed).toBe(false); expect(findOpenCodeInputObserver(f.client, f.target)).toBe(observer);
    expect(readThreadStatus).toHaveBeenCalledTimes(phase === "approved execution" ? 1 : 0);
    await acquired.actor.close();
    await vi.waitFor(() => expect(replies.some(reply => reply.id === 2)).toBe(true));
    const response = replies.find(reply => reply.id === 2)!;
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(response.result.content[0].text)).toMatchObject({ error: { code: "cancelled", retryable: false } });
    expect(findOpenCodeInputObserver(f.client, f.target)).toBeUndefined();
    expect(f.runtime.snapshot().references).toBe(0);
    expect(f.facade.invoke).toHaveBeenCalledOnce(); expect(decision).toHaveBeenCalledOnce();
    expect(readThreadStatus).toHaveBeenCalledTimes(phase === "approved execution" ? 1 : 0);
    expect(f.wire.requests.filter(request => request.pathname.endsWith("/prompt") || request.pathname.endsWith("/interrupt"))).toEqual([]);
    expect(handle.retirementBlocked).toBe(false);
  });
  it("retains routing after the last handle closes without retaining a lease or native event subscription", async () => {
    const f = fixture(); await f.admit();
    expect(f.runtime.snapshot().references).toBe(0);
    expect(f.wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(0);
    const channel = await connect(f.registrations[0]!.config.environment);
    const first = await f.driver.attach(f.target), second = await f.driver.attach(f.target);
    cleanups.push(async () => { await first.close(); await second.close(); });
    await first.establishProjection({ signal: new AbortController().signal });
    await second.establishProjection({ signal: new AbortController().signal });
    const observer = findOpenCodeInputObserver(f.client, f.target);
    expect(observer).toBeDefined(); expect(f.runtime.snapshot().references).toBe(2);
    expect(f.wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(3);
    await first.close();
    expect(findOpenCodeInputObserver(f.client, f.target)).toBe(observer);
    await second.close();
    expect(findOpenCodeInputObserver(f.client, f.target)).toBeUndefined();
    expect(f.runtime.snapshot().references).toBe(0);
    const response = await channel.call(f.wire.sessionID);
    expect(response.status).toBe(200); await response.body?.cancel();
    expect(f.runtime.snapshot().references).toBe(0);
    expect(f.wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(3);
    expect(f.registrations).toHaveLength(1);
  });
  it("revokes approval authority with the last live handle and requires fresh input proof after reattach", async () => {
    const f = fixture({ cli: true }); const handle = await f.driver.attach(f.target);
    cleanups.push(() => handle.close());
    await handle.establishProjection({ signal: new AbortController().signal });
    const observer = findOpenCodeInputObserver(f.client, f.target)!;
    const { scope, binding, workspace } = f.target;
    const evidence = new OpenCodeInputEvidenceRepository(f.repository);
    f.repository.reserveOperation(scope, { applicationThreadId: binding.applicationThreadId,
      connectionProfileId: binding.connectionProfileId, executionEnvironmentId: binding.executionEnvironmentId,
      nativeSessionId: f.wire.sessionID, applicationOperationId: "approval-input", operationKind: "submit",
      nativeInputId: "msg_current", requestFingerprint: "a".repeat(64), requestSource: { kind: "user" }, deadlineAt: null }, Date.now());
    observer.track(evidence.begin(scope, binding.applicationThreadId, "approval-input", "submit", observer.trackerId, "queue"));
    f.repository.markDispatched(scope, binding.applicationThreadId, "approval-input", "submit", Date.now());
    observer.recordAdmission("approval-input", "submit", { id: "msg_current", sessionID: f.wire.sessionID,
      type: "user", payload: { text: "current user" }, delivery: "queue", time: { created: 1 } });
    f.wire.send({ id: "evt_delivered", type: "session.inbox.delivered", created: 1,
      durable: { aggregateID: f.wire.sessionID, seq: 1, version: 1 }, data: { sessionID: f.wire.sessionID, inboxID: "msg_current" } });
    await vi.waitFor(() => expect(evidence.get(scope, binding.applicationThreadId, "approval-input", "submit").consumedFingerprint).not.toBeNull());
    const source = { scope, sourceThreadId: binding.applicationThreadId, sourceWorkspaceId: workspace.summary.id,
      sourceEnvironmentId: binding.executionEnvironmentId, backendKind: "opencode" as const };
    const authority = f.tools.accessDecisionAuthority(source);
    const approval = await authority.acquire(new AbortController().signal);
    expect(approval.isCurrent()).toBe(true);
    await handle.close(); expect(approval.signal.aborted).toBe(true); expect(approval.isCurrent()).toBe(false); approval.release();
    await expect(authority.acquire(new AbortController().signal)).rejects.toMatchObject({ toolError: { code: "permission_denied" } });
    const replacement = await f.driver.attach(f.target); cleanups.push(() => replacement.close());
    await replacement.establishProjection({ signal: new AbortController().signal });
    expect(findOpenCodeInputObserver(f.client, f.target)?.trackerId).not.toBe(observer.trackerId);
    await expect(authority.acquire(new AbortController().signal)).rejects.toMatchObject({ toolError: { code: "permission_denied" } });
  });
  it.each([0, OPENCODE_MCP_WATCHDOG_MS + 1])("readmits using elapsed time since actual revocation (%i ms)", async elapsed => {
    const channels: OpenCodeMcpChannel[] = [];
    const original = OpenCodeMcpIngress.prototype.admit;
    vi.spyOn(OpenCodeMcpIngress.prototype, "admit").mockImplementation(async function (this: OpenCodeMcpIngress, input) {
      const channel = await original.call(this, input); channels.push(channel); return channel;
    });
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture(); await f.admit(); channels[0]!.revoke();
    const revokedAt = channels[0]!.revokedAt; expect(revokedAt).toBe(now);
    now += elapsed; channels[0]!.revoke(); expect(channels[0]!.revokedAt).toBe(revokedAt);
    await f.admit();
    expect(f.registrations).toHaveLength(elapsed ? 2 : 1);
    if (!elapsed) { now += OPENCODE_MCP_WATCHDOG_MS + 1; await f.admit(); expect(f.registrations).toHaveLength(2); }
    expect(f.tools.diagnostic(f.target.binding.applicationThreadId)).toBeUndefined();
  });
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
