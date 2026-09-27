import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeHostAgentTools, openCodeHostToolAdmissionSchema, openCodeHostToolAdmissionResultSchema,
  type OpenCodeHostToolEndpoint, type OpenCodeHostToolInvoker } from "../../src/server/backends/opencode/opencode-host-agent-tools.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeHttpNativeAdapter } from "../../src/server/backends/opencode/opencode-http-native-adapter.js";
import { OpenCodeNativeHost } from "../../src/server/backends/opencode/opencode-native-host.js";
import { OpenCodeMcpIngress } from "../../src/server/backends/opencode/opencode-mcp-ingress.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function fixture() {
  const wire = createOpenCodeApiFixture();
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch: wire.fetch });
  const adapter = new OpenCodeHttpNativeAdapter(client);
  const target = { directory: wire.directory, session: { applicationThreadId: "thread", nativeSessionID: wire.sessionID, bindingFingerprint: "b".repeat(64) } };
  const host = new OpenCodeNativeHost({ tenantId: "tenant", principalId: "principal", executionEnvironmentId: "environment",
    backendInstanceId: "backend", runtimeId: "runtime", nativeGeneration: "generation" }, adapter, {
    assertCurrent: async () => {}, installSessionEnvironment: async () => {}, ensureMcpRegistration: async () => {},
  }, client.lifetime);
  const port = host.acquire(target);
  let endpoint: OpenCodeHostToolEndpoint | undefined = { endpoint: "http://127.0.0.1:4784", executableDirectory: "/host/bin" };
  const invoke = vi.fn<OpenCodeHostToolInvoker>(async () => ({ ok: true }));
  const capture = vi.fn(host.captureToolInvocation.bind(host));
  const tools = new OpenCodeHostAgentTools({ adapter, cli: () => endpoint, capture, invoke, assertCurrent: async () => {} });
  let call!: Parameters<OpenCodeMcpIngress["admit"]>[0]["invoke"];
  vi.spyOn(OpenCodeMcpIngress.prototype, "admit").mockImplementation(async input => {
    call = input.invoke;
    return { environment: {}, revoked: false, revokedAt: undefined, connected: true, revoke: vi.fn() };
  });
  vi.spyOn(adapter, "listMcp").mockResolvedValue({ location: { directory: wire.directory }, data: [] });
  const register = vi.spyOn(adapter, "addMcp").mockResolvedValue(undefined);
  const admission = { sourceCapability: "mcp-capability", catalog: [] };
  const request = { operation: "invoke" as const, sessionID: wire.sessionID,
    request: { toolId: "agent.context", schemaVersion: 1, requestId: "request", input: {} } };
  const open = async () => {
    const result = await tools.admit(target, admission);
    await tools.ensureRegistration(target, result.registrationAdmissionId);
    await vi.waitFor(() => expect(host.captureToolInvocation(target).nativeConnected).toBe(true));
    return result;
  };
  const deliver = async (seq: number) => {
    wire.send({ id: `evt_${seq}`, type: "session.inbox.delivered", created: 1,
      durable: { aggregateID: wire.sessionID, seq, version: 1 }, data: { sessionID: wire.sessionID, inboxID: `msg_${seq}` } });
    await vi.waitFor(() => expect(host.captureToolInvocation(target).inputId).toBe(`msg_${seq}`));
  };
  cleanups.push(async () => { await tools.close(); host.close(); client.close(); });
  return { wire, host, port, tools, target, invoke, capture, admission, request, register, open, deliver,
    call: () => call(request, new AbortController().signal), route: () => call,
    setEndpoint: (value: OpenCodeHostToolEndpoint | undefined) => { endpoint = value; } };
}

describe("OpenCode execution-host tool ingress", () => {
  it("freezes current input before the first native metadata await", async () => {
    const f = fixture(); await f.open(); await f.deliver(1);
    const held = f.wire.hold(`/api/session/${f.wire.sessionID}`);
    const pending = f.call(); await held.entered;
    await f.deliver(2); held.release(); await pending;
    expect(f.invoke).toHaveBeenCalledOnce();
    const stamp = f.invoke.mock.calls[0]![3]!;
    expect(stamp).toMatchObject({ inputId: "msg_1", throughSequence: 1, nativeConnected: true,
      authority: { session: { applicationThreadId: "thread" } } });
    expect(Object.isFrozen(stamp)).toBe(true); expect(Object.isFrozen(stamp.authority.session)).toBe(true);
    expect(f.capture).toHaveBeenCalledOnce();
  });

  it("cannot borrow a later input when ingress had no current input", async () => {
    const f = fixture(); await f.open();
    const held = f.wire.hold(`/api/session/${f.wire.sessionID}`);
    const pending = f.call(); await held.entered; await f.deliver(1); held.release(); await pending;
    expect(f.invoke.mock.calls[0]![3]).toMatchObject({ inputId: null, throughSequence: 0 });
  });

  it("captures a native continuity break without recovering authority from history", async () => {
    const f = fixture(); await f.open(); await f.deliver(1);
    const before = f.host.captureToolInvocation(f.target);
    f.wire.disconnect();
    await vi.waitFor(() => expect(f.host.captureToolInvocation(f.target).nativeConnected).toBe(false));
    const broken = f.host.captureToolInvocation(f.target);
    expect(broken.inputId).toBeNull(); expect(broken.authorityEpoch).toBeGreaterThan(before.authorityEpoch);
    expect(broken.nativeContinuity).not.toBe(before.nativeContinuity);
    expect(before.inputId).toBe("msg_1");
    expect(() => f.host.captureToolInvocation({ ...f.target, session: { ...f.target.session, bindingFingerprint: "c".repeat(64) } })).toThrow();
    expect(f.wire.requests.filter(request => request.pathname.endsWith("/message"))).toEqual([]);
  });

  it("does not dispatch a route replaced while native validation is pending", async () => {
    const f = fixture(); await f.open();
    const held = f.wire.hold(`/api/session/${f.wire.sessionID}`);
    const pending = f.call(); const failure = expect(pending).rejects.toThrow(); await held.entered;
    f.tools.release(f.target); held.release(); await failure;
    await f.tools.admit(f.target, { ...f.admission, sourceCapability: "replacement" });
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it("keeps host routing across relay detach and never resends an uncertain invocation", async () => {
    const f = fixture(); await f.open(); await f.deliver(1);
    f.invoke.mockRejectedValueOnce(new Error("detached relay"));
    await expect(f.call()).rejects.toThrow("detached relay");
    expect(f.invoke).toHaveBeenCalledOnce();
    // A new explicit invocation is allowed after carrier replacement; the failed
    // invocation was neither queued nor replayed by the host bridge.
    await expect(f.call()).resolves.toEqual({ ok: true });
    expect(f.invoke).toHaveBeenCalledTimes(2); expect(f.register).toHaveBeenCalledOnce();
  });

  it("routes only opaque admitted CLI capabilities and retains revoked recognition", async () => {
    const f = fixture(); const cli = { sourceCapability: "cli-first", mode: "progressive" as const };
    await f.tools.admit(f.target, { ...f.admission, cli }); await f.deliver(1);
    const before = f.wire.requests.length;
    expect(f.tools.captureCliInvocation(cli.sourceCapability)).toMatchObject({ inputId: "msg_1" });
    expect(f.wire.requests).toHaveLength(before);
    expect(f.tools.captureCliInvocation("unknown")).toBeUndefined();
    await f.tools.admit(f.target, { ...f.admission, cli: { ...cli, sourceCapability: "cli-second" } });
    expect(() => f.tools.captureCliInvocation("cli-first")).toThrow();
    expect(f.tools.ownsCliCapability("cli-first")).toBe(true);
    f.tools.release(f.target);
    expect(() => f.tools.captureCliInvocation("cli-second")).toThrow();
  });

  it("rejects capability reassignment across threads, including concurrent admissions", async () => {
    const f = fixture(), cli = { sourceCapability: "same-capability", mode: "individual" as const };
    const other = { ...f.target, session: { ...f.target.session, applicationThreadId: "other" } };
    const held = f.wire.hold(`/api/session/${f.wire.sessionID}`);
    const first = f.tools.admit(f.target, { ...f.admission, cli }); await held.entered;
    const second = f.tools.admit(other, { ...f.admission, cli });
    const result = Promise.allSettled([first, second]); held.release();
    expect((await result).map(value => value.status).sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("rejects child sessions and ambiguous native session routes", async () => {
    const f = fixture(); await f.open();
    f.wire.session.parentID = "ses_parent";
    await expect(f.call()).rejects.toThrow(); expect(f.invoke).not.toHaveBeenCalled();
    delete f.wire.session.parentID;
    await f.tools.admit({ ...f.target, session: { ...f.target.session, applicationThreadId: "other-thread" } }, f.admission);
    await expect(f.call()).rejects.toThrow(); expect(f.invoke).not.toHaveBeenCalled();
    await expect(f.route()({ ...f.request, sessionID: "ses_unadmitted" }, new AbortController().signal)).rejects.toThrow();
  });

  it("resolves the host CLI endpoint at use and accepts no endpoint in the wire admission", async () => {
    const f = fixture(); f.setEndpoint(undefined);
    const result = await f.tools.admit(f.target, { ...f.admission, cli: { sourceCapability: "cli", mode: "individual" } });
    expect(() => f.tools.cliEnvironment(f.target, result.cliAdmissionId!)).toThrow();
    f.setEndpoint({ endpoint: "http://127.0.0.1:6789", executableDirectory: "/execution-host/bin" });
    expect(f.tools.cliEnvironment(f.target, result.cliAdmissionId!)).toMatchObject({ executableDirectory: "/execution-host/bin",
      generated: { SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:6789" } });
    expect(openCodeHostToolAdmissionResultSchema.parse(result)).toEqual(result);
    expect(() => openCodeHostToolAdmissionSchema.parse({ ...f.admission, endpoint: "http://main:4784" })).toThrow();
    expect(() => openCodeHostToolAdmissionResultSchema.parse({ ...result, processId: 1 })).toThrow();
  });
});
