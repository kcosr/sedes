import { openCodeRuntimeTarget } from "../../src/server/backends/opencode/opencode-conversation-context.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInboxUser, SessionMessageInfo } from "@opencode/client";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { openCodeOperationControl } from "../../src/server/backends/opencode/opencode-operation-control.js";
import { acquireOpenCodeInputObserver, findOpenCodeInputObserver, OpenCodeInputObserver } from "../../src/server/backends/opencode/opencode-input-observer.js";
import { OpenCodeInputEvidenceRepository, openCodePreparedPayloadFingerprint, type OpenCodeInputKind } from "../../src/server/backends/opencode/opencode-input-evidence.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.useRealTimers(); vi.restoreAllMocks(); }
});
const admission = (id = "msg_owned", text = "prepared text"): SessionInboxUser =>
  ({ id, sessionID: "ses_fixture", type: "user", payload: { text }, delivery: "queue", time: { created: 1 } });
const user = (id = "msg_owned", text = "prepared text"): SessionMessageInfo => ({ id, type: "user", text, time: { created: 1 } });
function event(seq: number, type: string, data: Record<string, unknown>) {
  return { id: `evt_${seq}`, type, created: 1, durable: { aggregateID: "ses_fixture", seq, version: 1 }, data: { sessionID: "ses_fixture", ...data } };
}
const enqueue = (seq: number, id = "msg_owned", text = "prepared text") => event(seq, "session.inbox.enqueued", {
  inboxID: id, item: { type: "user", delivery: "queue", payload: { text } },
});
const delivered = (seq: number, id = "msg_owned") => event(seq, "session.inbox.delivered", { inboxID: id });
const cancelled = (seq: number, id = "msg_owned") => event(seq, "session.inbox.cancelled", { inboxID: id });
const renamed = (seq: number) => event(seq, "session.renamed", { title: "title" });
const reverted = (seq: number, to = "msg_boundary") => event(seq, "session.revert.committed", { to });
function fixture(input: { autoConnect?: boolean } = {}) {
  const wire = createOpenCodeApiFixture(input);
  let onDelete: ((id: string) => void) | undefined;
  let log: unknown[] | undefined;
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture-only-canary", fetch: async (value, init) => {
    const url = new URL(String(value));
    if (url.pathname.endsWith("/log") && log) {
      return new Response(log.map(item => `data: ${JSON.stringify(item)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (init?.method === "DELETE" && url.pathname.includes("/inbox/")) {
      wire.requests.push({ method: "DELETE", pathname: url.pathname, query: url.searchParams });
      onDelete?.(url.pathname.split("/").at(-1)!); return new Response(null, { status: 204 });
    }
    return wire.fetch(value, init);
  } });
  const native = createOpenCodeConversationFixture({ native: { client, sessionID: wire.sessionID, directory: wire.directory } });
  const evidence = new OpenCodeInputEvidenceRepository(native.repository);
  const controllers: OpenCodeInputObserver[] = [];
  const lifetime = new AbortController(); const lease = native.runtime.acquire(openCodeRuntimeTarget(native.target));
  const observed = vi.fn(); const changed = vi.fn();
  const attach = { ...native.target, onSubmissionObserved: observed };
  const createObserver = () => {
    const observer = new OpenCodeInputObserver(native.context, attach, native.runtime, lease, lifetime.signal, { onProofChanged: changed });
    controllers.push(observer); return observer;
  };
  const observer = createObserver();
  const reserve = (operationId = "operation", id = "msg_owned", kind: OpenCodeInputKind = "submit", dispatch = true, controller = observer) => {
    native.repository.reserveOperation(scope, { applicationThreadId: threadID, connectionProfileId: native.target.binding.connectionProfileId,
      executionEnvironmentId: native.target.binding.executionEnvironmentId, nativeSessionId: wire.sessionID,
      applicationOperationId: operationId, operationKind: kind, nativeInputId: id, requestFingerprint: "a".repeat(64), requestSource: { kind: "user" }, deadlineAt: null }, Date.now());
    const row = evidence.begin(scope, threadID, operationId, kind, controller.trackerId, kind === "steer" ? "steer" : "queue");
    controller.track(row);
    if (dispatch) native.repository.markDispatched(scope, threadID, operationId, kind, Date.now());
    return row;
  };
  const row = (operationId = "operation", kind: OpenCodeInputKind = "submit") => evidence.get(scope, threadID, operationId, kind);
  const pending = (items: SessionInboxUser[]) => wire.setResponse(`/api/session/${wire.sessionID}/inbox`, 200, { data: items });
  cleanups.push(async () => { lifetime.abort(); controllers.forEach(controller => controller.close()); lease.release(); await native.dispose(); });
  return { ...native, wire, evidence, lifetime, lease, attach, observed, changed, observer, createObserver, reserve, row, pending,
    onDelete: (callback: (id: string) => void) => { onDelete = callback; },
    log: (events: unknown[], seq: number) => { log = [...events, { type: "log.synced", aggregateID: wire.sessionID, seq }]; } };
}
async function consumed(f: ReturnType<typeof fixture>, operationId = "operation", kind: OpenCodeInputKind = "submit") {
  await vi.waitFor(() => expect(f.row(operationId, kind).consumedFingerprint).toMatch(/^[a-f0-9]{64}$/u));
}

describe("OpenCode independent private input observation", () => {
  it("ACKs a detached backlog once per committed batch instead of once per record", async () => {
    const f = fixture();
    const acknowledge = vi.fn();
    const observer = new OpenCodeInputObserver(f.context, f.attach, f.runtime, {
      ...f.lease, client: { ...f.lease.client, observe: options => {
        const observation = f.lease.client.observe(options);
        return { ...observation, acknowledge: async cursor => {
          acknowledge(cursor);
          await new Promise(resolve => setTimeout(resolve, 10));
          await observation.acknowledge(cursor);
        } };
      } },
    }, f.lifetime.signal);
    cleanups.push(async () => observer.close());
    // Wait for native SSE to connect, then accumulate evidence with main absent.
    await f.observer.start(); f.observer.close();
    for (let sequence = 1; sequence <= 500; sequence++) f.wire.send(renamed(sequence));
    await vi.waitFor(() => expect(f.host.retentionSnapshot().observation.pendingEvidenceCount).toBe(500));
    await observer.start();
    await vi.waitFor(() => expect(f.host.retentionSnapshot().observation.pendingEvidenceCount).toBe(0));
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ sequence: 500 }));
    expect(f.database.prepare("SELECT sequence FROM opencode_observation_cursors").get()).toEqual({ sequence: 500 });
  });

  it("commits evidence and cursor together and never ACKs or notifies on SQL rollback", async () => {
    const f = fixture(); await f.observer.start(); f.reserve();
    f.wire.send(enqueue(1)); await vi.waitFor(() => expect(f.row().enqueueSequence).toBe(1));
    await vi.waitFor(() => expect(f.host.retentionSnapshot().observation.pendingEvidenceCount).toBe(0));
    f.database.exec(`CREATE TRIGGER reject_observation_cursor BEFORE UPDATE ON opencode_observation_cursors
      WHEN NEW.sequence = 2 BEGIN SELECT RAISE(ABORT,'cursor fixture rollback'); END`);
    f.wire.send(delivered(2));
    await vi.waitFor(() => expect(f.host.retentionSnapshot().observation.pendingEvidenceCount).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(f.row().consumedFingerprint).toBeNull(); expect(f.observed).not.toHaveBeenCalled();
    expect(f.database.prepare("SELECT sequence FROM opencode_observation_cursors").get()).toEqual({ sequence: 1 });
    f.database.exec("DROP TRIGGER reject_observation_cursor");
    await consumed(f);
    await vi.waitFor(() => expect(f.host.retentionSnapshot().observation.pendingEvidenceCount).toBe(0));
    expect(f.database.prepare("SELECT sequence FROM opencode_observation_cursors").get()).toEqual({ sequence: 2 });
    expect(f.observed).toHaveBeenCalledExactlyOnceWith({ backendCorrelation: "operation" });
  });

  it("replays detached consumption before granting replacement observer authority without a native history read", async () => {
    const f = fixture(); await f.observer.start(); f.reserve();
    const tracker = f.observer.trackerId; f.observer.close();
    f.wire.send(enqueue(1)); f.wire.send(delivered(2));
    await vi.waitFor(() => expect(f.host.retentionSnapshot().observation.pendingEvidenceCount).toBe(2));
    const replacement = f.createObserver(); await replacement.start();
    expect(replacement.trackerId).toBe(tracker); expect(f.row().consumedFingerprint).not.toBeNull();
    const authority = await replacement.accessDecisionAuthority(f.host.captureToolInvocation(openCodeRuntimeTarget(f.attach))).acquire(new AbortController().signal);
    expect(authority.isCurrent()).toBe(true); authority.release();
    expect(f.wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(1);
    expect(f.wire.requests.filter(request => request.pathname.endsWith("/message"))).toHaveLength(0);
  });

  it("owns a separate main lease while any shared actor or reader still observes", async () => {
    const f = fixture(); const acquire = vi.mocked(f.runtime.acquire).getMockImplementation()!;
    const ports: AbortController[] = [];
    vi.spyOn(f.runtime, "acquire").mockImplementation(target => {
      const source = acquire(target), lifetime = new AbortController(); ports.push(lifetime);
      return { ...source, client: { ...source.client, lifetime: AbortSignal.any([source.client.lifetime, lifetime.signal]) },
        release: () => { lifetime.abort(); source.release(); } };
    });
    const first = f.runtime.acquire(openCodeRuntimeTarget(f.attach)), second = f.runtime.acquire(openCodeRuntimeTarget(f.attach));
    const owner = new AbortController();
    const a = acquireOpenCodeInputObserver(f.context, f.attach, f.runtime, first, owner.signal);
    const b = acquireOpenCodeInputObserver(f.context, f.attach, f.runtime, second, owner.signal);
    await b.observer.start(); const tracker = b.observer.trackerId;
    a.release(); first.release();
    await b.observer.start(); expect(b.observer.trackerId).toBe(tracker);
    expect(ports.map(port => port.signal.aborted)).toEqual([true, false, false]);
    b.release(); second.release(); expect(ports.every(port => port.signal.aborted)).toBe(true);
  });

  it("actor detach alone never creates false native continuity loss", async () => {
    const f = fixture(); await f.observer.start(); f.reserve(); const tracker = f.observer.trackerId;
    f.observer.close(); const replacement = f.createObserver(); await replacement.start();
    expect(replacement.trackerId).toBe(tracker);
    expect((await replacement.reconcile("operation", "submit")).status).toBe("unresolved");
    expect(f.row().terminalLostAt).toBeNull();
  });

  it("releases retained prompt evidence on exact cancellation without an enqueue event", async () => {
    const f = fixture(); await f.observer.start(); const row = f.reserve();
    f.wire.setResponse(`/api/session/${f.wire.sessionID}/prompt`, 200, { data: admission() });
    await f.lease.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_owned", text: "prepared text", delivery: "queue", resume: true },
      openCodeOperationControl(row.receipt, "prompt"));
    expect(f.host.snapshot().operations).toHaveLength(1);
    expect(f.row().receipt.disposition).toBe("dispatched");
    f.wire.send(cancelled(1));
    await vi.waitFor(() => expect(f.row().withdrawalKind).toBe("cancelled"));
    expect(f.row()).toMatchObject({ receipt: { disposition: "accepted" }, enqueueSequence: null, consumedFingerprint: null });
    await vi.waitFor(() => expect(f.host.snapshot().operations).toEqual([]));
    expect(await f.observer.reconcile("operation", "submit")).toMatchObject({ status: "not_accepted", retryable: false });
    expect(f.observed).not.toHaveBeenCalled();
  });
  it("persists exact delivered proof and notifies before history or model completion", async () => {
    const f = fixture(); await f.observer.start(); f.reserve();
    const held = f.wire.hold(`/api/session/${f.wire.sessionID}/message`);
    f.wire.send(enqueue(1)); f.wire.send(delivered(2)); await consumed(f);
    expect(f.observed).toHaveBeenCalledExactlyOnceWith({ backendCorrelation: "operation" });
    expect(f.observer.correlations()).toEqual(new Map([["msg_owned", "operation"]]));
    expect(await f.observer.reconcile("operation", "submit")).toEqual({ status: "accepted" });
    expect(f.wire.requests.some(request => request.pathname.endsWith("/message"))).toBe(false); held.release();
  });

  it("ACK, enqueued and pending establish admission only, using the hook-prepared payload", async () => {
    const f = fixture(); await f.observer.start(); f.reserve();
    f.pending([admission("msg_owned", "hook transformed")]);
    f.observer.recordAdmission("operation", "submit", admission("msg_owned", "hook transformed"));
    f.wire.send(enqueue(1, "msg_owned", "hook transformed"));
    await vi.waitFor(() => expect(f.row().enqueueSequence).toBe(1));
    expect(f.row()).toMatchObject({ preparedPayloadFingerprint: openCodePreparedPayloadFingerprint({ text: "hook transformed" }), consumedFingerprint: null });
    expect((await f.observer.reconcile("operation", "submit")).status).toBe("unresolved");
    expect(f.observed).not.toHaveBeenCalled();
    f.wire.messages.push(user("msg_owned", "hook transformed"));
    expect(await f.observer.reconcile("operation", "submit")).toEqual({ status: "accepted" });
  });

  it("ignores foreign IDs, forged metadata and reserved-but-undispatched inputs", async () => {
    const f = fixture(); await f.observer.start(); f.reserve("operation", "msg_owned", "submit", false);
    f.wire.send(enqueue(1)); f.wire.send(delivered(2)); f.wire.send(delivered(3, "msg_foreign"));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.row()).toMatchObject({ consumedFingerprint: null, preparedPayloadFingerprint: null });
    expect((await f.observer.reconcile("operation", "submit")).status).toBe("unresolved");
    expect(f.observed).not.toHaveBeenCalled();
  });

  it("preserves consumption irreversibly through cancellation, revert and restart", async () => {
    const f = fixture(); await f.observer.start(); f.reserve();
    f.wire.send(enqueue(1)); f.wire.send(delivered(2)); await consumed(f);
    f.wire.send(cancelled(3)); f.wire.send(reverted(4, "msg_owned"));
    f.observer.close(); const recovery = f.createObserver(); await recovery.start();
    expect(await recovery.reconcile("operation", "submit")).toEqual({ status: "accepted" });
    expect(recovery.correlations().get("msg_owned")).toBe("operation");
  });

  it("returns exact nonretryable cancellation proof but not native DELETE acknowledgement", async () => {
    const f = fixture(); await f.observer.start(); f.reserve(); f.pending([admission()]);
    await f.observer.withdrawPending(new AbortController().signal, Date.now() + 1_000, `stop-${Date.now() + 1_000}`);
    f.pending([]);
    expect((await f.observer.reconcile("operation", "submit")).status).toBe("unresolved");
    f.wire.send(cancelled(1));
    await vi.waitFor(() => expect(f.row().withdrawalKind).toBe("cancelled"));
    expect(await f.observer.reconcile("operation", "submit")).toMatchObject({ status: "not_accepted", retryable: false });
  });

  it("a fresh Stop cancels only exact owned pending inputs, including an idle second attempt", async () => {
    const f = fixture(); await f.observer.start(); f.reserve(); f.pending([admission(), admission("msg_foreign")]);
    await f.observer.withdrawPending(new AbortController().signal, Date.now() + 1_000, `stop-${Date.now() + 1_000}`);
    f.onDelete(id => { f.wire.send(cancelled(1, id)); f.pending([admission("msg_foreign")]); });
    await f.observer.withdrawPending(new AbortController().signal, Date.now() + 1_000, `stop-${Date.now() + 1_000}`);
    await vi.waitFor(() => expect(f.row().withdrawalKind).toBe("cancelled"));
    expect(f.wire.requests.filter(request => request.method === "DELETE").map(request => request.pathname)).toEqual([
      "/api/session/ses_fixture/inbox/msg_owned", "/api/session/ses_fixture/inbox/msg_owned",
    ]);
    expect(f.wire.requests.some(request => request.pathname.endsWith("/interrupt"))).toBe(false);
  });

  it("a promotion racing cancellation remains consumed", async () => {
    const f = fixture(); await f.observer.start(); f.reserve(); f.pending([admission()]);
    f.onDelete(() => { f.wire.messages.push(user()); f.pending([]); f.wire.send(delivered(1)); });
    await f.observer.withdrawPending(new AbortController().signal, Date.now() + 1_000, `stop-${Date.now() + 1_000}`); await consumed(f);
    expect(await f.observer.reconcile("operation", "submit")).toEqual({ status: "accepted" });
  });

  it("declines withdrawal without a positive boundary insertion and dense event interval", async () => {
    const f = fixture(); await f.observer.start(); f.reserve();
    f.wire.send(enqueue(1)); f.wire.send(reverted(2));
    await vi.waitFor(() => expect(f.row().enqueueSequence).toBe(1));
    expect((await f.observer.reconcile("operation", "submit")).status).toBe("unresolved");
    expect(f.row().withdrawnFingerprint).toBeNull();
  });

  it("proves unconsumed revert erasure from exact enqueue, earlier insertion and a dense interval", async () => {
    const f = fixture(); await f.observer.start(); f.reserve();
    f.wire.send(delivered(0, "msg_boundary")); f.wire.send(renamed(1)); f.wire.send(enqueue(2)); f.wire.send(renamed(3)); f.wire.send(reverted(4));
    await vi.waitFor(() => expect(f.row().withdrawalKind).toBe("reverted"));
    expect(await f.observer.reconcile("operation", "submit")).toMatchObject({ status: "not_accepted", retryable: false });
  });

  it("preserves exact revert density through compact tool-output evidence without retaining its payload", async () => {
    const f = fixture(); await f.observer.start(); f.reserve();
    const output = { ...event(2, "session.tool.success", { assistantMessageID: "msg_answer", id: "tool_result", executed: true,
      content: [{ type: "text", text: "large output".repeat(100_000) }] }), durable: { aggregateID: "ses_fixture", seq: 2, version: 2 } };
    f.wire.send(delivered(0, "msg_boundary")); f.wire.send(enqueue(1)); f.wire.send(output); f.wire.send(reverted(3));
    await vi.waitFor(() => expect(f.row().withdrawalKind).toBe("reverted"));
    expect(await f.observer.reconcile("operation", "submit")).toMatchObject({ status: "not_accepted", retryable: false });
    expect(f.row().consumedFingerprint).toBeNull();
  });

  it.each(["gap", "later", "reuse"])("declines revert erasure with %s evidence", async mode => {
    const f = fixture(); await f.observer.start(); f.reserve();
    if (mode === "later") { f.wire.send(enqueue(0)); f.wire.send(delivered(1, "msg_boundary")); }
    else { f.wire.send(delivered(0, "msg_boundary")); f.wire.send(enqueue(1)); }
    if (mode === "reuse") f.wire.send(enqueue(2));
    f.wire.send(reverted(3)); await vi.waitFor(() => expect(f.row().enqueueSequence).not.toBeNull());
    expect((await f.observer.reconcile("operation", "submit")).status).toBe(mode === "reuse" ? "unresolved" : "failed_unknown");
    expect(f.row().withdrawnFingerprint).toBeNull();
  });

  it("reports payload conflicts as unresolved without projecting a correlation", async () => {
    const f = fixture(); await f.observer.start(); f.reserve(); f.observer.recordAdmission("operation", "submit", admission());
    f.wire.messages.push(user("msg_owned", "conflicting payload"));
    expect((await f.observer.reconcile("operation", "submit")).status).toBe("unresolved");
    expect(f.row()).toMatchObject({ payloadConflict: true });
    expect(f.row().consumedFingerprint).not.toBeNull(); expect(f.observer.correlations().size).toBe(0); expect(f.observed).not.toHaveBeenCalled();
  });

  it("slow continuous missing observations never become terminal tracker loss", async () => {
    const f = fixture(); await f.observer.start(); f.reserve();
    expect((await f.observer.reconcile("operation", "submit")).status).toBe("unresolved");
    expect((await f.observer.awaitConsumption("operation", "submit", 20)).status).toBe("unresolved");
    expect((await f.observer.reconcile("operation", "submit")).status).toBe("unresolved");
  });

  it("restarts a broken live tracker in the same runtime and reports missing lifecycle as failed unknown", async () => {
    const f = fixture(); await f.observer.start(); f.reserve(); const tracker = f.observer.trackerId;
    f.wire.disconnect(); await vi.waitFor(() => expect(f.observer.trackerId).not.toBe(tracker)); await f.observer.start();
    const result = await f.observer.reconcile("operation", "submit");
    expect(result.status).toBe("failed_unknown"); expect(JSON.stringify(result)).toContain("delayed request");
    expect(f.wire.requests.every(request => request.method === "GET")).toBe(true);
  });

  it("retires lost inputs from polling and retention while a later live consumption still recovers", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.observer.start(); f.reserve(); f.observer.close(); f.wire.disconnect(); await vi.advanceTimersByTimeAsync(200); f.log([], 2);
    const recovery = f.createObserver(); await recovery.start();
    expect((await recovery.reconcile("operation", "submit")).status).toBe("failed_unknown");
    expect(f.row().terminalLostAt).not.toBeNull(); expect(f.evidence.hasUnresolved(scope, threadID)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const reads = f.wire.requests.length;
    await vi.advanceTimersByTimeAsync(5_000); expect(f.wire.requests).toHaveLength(reads);
    f.wire.send(delivered(3)); await vi.advanceTimersByTimeAsync(0);
    expect(await recovery.reconcile("operation", "submit")).toEqual({ status: "accepted" });
    expect(f.observed).toHaveBeenCalledExactlyOnceWith({ backendCorrelation: "operation" });
    expect(recovery.correlations().get("msg_owned")).toBe("operation");
    expect(f.evidence.unresolved(scope, threadID)).toEqual([]);
  });

  it("retires conflicted inputs from polling without converting later consumption into an unsafe correlation", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.observer.start(); f.reserve();
    f.observer.recordAdmission("operation", "submit", admission());
    f.observer.recordAdmission("operation", "submit", admission("msg_owned", "conflict"));
    expect(f.evidence.hasUnresolved(scope, threadID)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000); const reads = f.wire.requests.length;
    await vi.advanceTimersByTimeAsync(5_000); expect(f.wire.requests).toHaveLength(reads);
    f.wire.send(delivered(3)); await vi.advanceTimersByTimeAsync(0);
    expect(f.row().consumedFingerprint).not.toBeNull();
    expect((await f.observer.reconcile("operation", "submit")).status).toBe("unresolved");
    expect(f.observer.correlations().size).toBe(0); expect(f.observed).not.toHaveBeenCalled();
    expect(f.row().terminalLostAt).toBeNull(); expect(f.evidence.unresolved(scope, threadID)).toEqual([]);
  });

  it.each(["enqueue", "ack"] as const)("does not declare tracker loss when a new %s arrives after the inbox/message cut", async mode => {
    const f = fixture(); await f.observer.start(); f.reserve(); f.observer.close(); f.log([], 2);
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }); const reached = new Promise<void>(resolve => { entered = resolve; });
    const original = vi.mocked(f.runtime.assertCurrent).getMockImplementation()!; let blocked = false;
    vi.spyOn(f.runtime, "assertCurrent").mockImplementation(async signal => {
      await original(signal);
      if (!blocked && f.wire.requests.some(request => request.pathname === "/api/session/ses_fixture/message/msg_owned")) {
        blocked = true; entered(); await held;
      }
    });
    const recovery = f.createObserver(); await recovery.start(); const reconciling = recovery.reconcile("operation", "submit");
    await reached;
    if (mode === "enqueue") {
      f.wire.send(enqueue(1)); await vi.waitFor(() => expect(f.row().enqueueSequence).toBe(1));
    } else recovery.recordAdmission("operation", "submit", admission());
    f.pending([admission()]); release();
    expect((await reconciling).status).toBe("unresolved"); expect(f.row().terminalLostAt).toBeNull();
    expect(f.evidence.hasUnresolved(scope, threadID)).toBe(true);
    f.wire.send(delivered(2)); await consumed(f);
    expect(await recovery.reconcile("operation", "submit")).toEqual({ status: "accepted" });
  });

  it("does not start an inbox cut when the ready subscription disconnects during its identity check", async () => {
    const f = fixture({ autoConnect: false }); const starting = f.observer.start();
    await vi.waitFor(() => expect(f.wire.requests.some(request => request.pathname === "/api/event")).toBe(true));
    f.wire.connected(); await starting; f.reserve(); const tracker = f.observer.trackerId;
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }); const reached = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(f.runtime, "assertCurrent").mockImplementationOnce(async () => { entered(); await held; });
    const reconciling = f.observer.reconcile("operation", "submit"); await reached;
    f.wire.disconnect(); await vi.waitFor(() => expect(f.observer.trackerId).not.toBe(tracker));
    await vi.waitFor(() => expect(f.wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(2));
    release(); expect((await reconciling).status).toBe("unresolved");
    expect(f.wire.requests.some(request => request.pathname.endsWith("/inbox"))).toBe(false);
    f.pending([admission()]); f.wire.connected(); await f.observer.start();
    expect((await f.observer.reconcile("operation", "submit")).status).toBe("unresolved");
    const paths = f.wire.requests.map(request => request.pathname);
    expect(paths.lastIndexOf("/api/event")).toBeLessThan(paths.indexOf("/api/session/ses_fixture/inbox"));
    expect(f.row().terminalLostAt).toBeNull();
  });

  it("keeps known pending recovery unresolved and consumes automatically without history hydration", async () => {
    const f = fixture(); await f.observer.start(); f.reserve(); f.pending([admission()]); const tracker = f.observer.trackerId;
    f.wire.disconnect(); await vi.waitFor(() => expect(f.observer.trackerId).not.toBe(tracker)); await f.observer.start();
    expect((await f.observer.reconcile("operation", "submit")).status).toBe("unresolved");
    f.pending([]); f.wire.messages.push(user()); await consumed(f);
    expect(f.observed).toHaveBeenCalledExactlyOnceWith({ backendCorrelation: "operation" });
  });

  it("orders recovery subscription, inbox and exact message to catch promotion between reads", async () => {
    const f = fixture(); await f.observer.start(); f.reserve(); f.observer.close();
    const inbox = f.wire.hold("/api/session/ses_fixture/inbox"); const recovery = f.createObserver();
    await recovery.start(); const result = recovery.reconcile("operation", "submit");
    await inbox.entered; f.wire.messages.push(user()); inbox.release();
    expect(await result).toEqual({ status: "accepted" });
    const relevant = f.wire.requests.map(request => request.pathname);
    const subscription = relevant.lastIndexOf("/api/event"); const pending = relevant.indexOf("/api/session/ses_fixture/inbox", subscription);
    const message = relevant.indexOf("/api/session/ses_fixture/message/msg_owned", pending);
    expect(subscription).toBeLessThan(pending); expect(pending).toBeLessThan(message);
  });

  it("honors exact live delivery while a recovery message read is blocked", async () => {
    const f = fixture(); await f.observer.start(); f.reserve(); f.observer.close();
    const message = f.wire.hold("/api/session/ses_fixture/message/msg_owned"); const recovery = f.createObserver();
    await recovery.start(); const result = recovery.reconcile("operation", "submit");
    await message.entered; f.wire.send(delivered(2)); await consumed(f); message.release();
    expect(await result).toEqual({ status: "accepted" });
  });

  it("recovers positive cancellation from a validated retained log but treats watermark-only history as gaps", async () => {
    const f = fixture(); await f.observer.start(); f.reserve(); f.observer.close(); f.wire.disconnect();
    await vi.waitFor(() => expect(f.wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(2));
    f.log([cancelled(3)], 3); const recovery = f.createObserver(); await recovery.start();
    expect(await recovery.reconcile("operation", "submit")).toMatchObject({ status: "not_accepted", retryable: false });
    f.reserve("second", "msg_second", "submit", true, recovery); recovery.close(); f.wire.disconnect();
    await vi.waitFor(() => expect(f.wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(3)); f.log([], 9);
    const secondRecovery = f.createObserver(); await secondRecovery.start();
    expect((await secondRecovery.reconcile("second", "submit")).status).toBe("failed_unknown");
  });

  it("cancels a caller wait without interrupting shared observation and bounds waiting for readiness", async () => {
    const f = fixture({ autoConnect: false }); f.reserve();
    expect((await f.observer.awaitConsumption("operation", "submit", 20)).status).toBe("unresolved");
    const abort = new AbortController(); const waiting = f.observer.start(abort.signal); abort.abort(new Error("caller stopped"));
    await expect(waiting).rejects.toThrow("caller stopped");
    f.wire.connected(); await f.observer.start(); f.wire.send(delivered(1)); await consumed(f);
    expect(f.client.lifetime.aborted).toBe(false);
  });

  it("does not dispatch cancellation after its original deadline or caller cancellation", async () => {
    const f = fixture(); await f.observer.start(); f.reserve(); f.pending([admission()]);
    const abort = new AbortController(); abort.abort();
    await expect(f.observer.withdrawPending(abort.signal, Date.now() + 1_000, `stop-${Date.now() + 1_000}`)).rejects.toThrow();
    await expect(f.observer.withdrawPending(new AbortController().signal, Date.now() - 1, `stop-${Date.now() - 1}`)).rejects.toThrow();
    expect(f.wire.requests.some(request => request.method === "DELETE")).toBe(false);
  });

  it("shares tracker continuity and callback fanout across reader and actor leases", async () => {
    const f = fixture(); f.observer.close();
    const readerLifetime = new AbortController(); const actorLifetime = new AbortController();
    const reader = acquireOpenCodeInputObserver(f.context, { ...f.attach, onSubmissionObserved: undefined }, f.runtime, f.lease, readerLifetime.signal);
    const actor = acquireOpenCodeInputObserver(f.context, f.attach, f.runtime, { ...f.lease, client: { ...f.lease.client } }, actorLifetime.signal);
    expect(reader.observer).toBe(actor.observer); expect(findOpenCodeInputObserver(f.port, f.attach)).toBe(actor.observer);
    await actor.observer.start(); f.reserve("operation", "msg_owned", "submit", true, actor.observer);
    const tracker = actor.observer.trackerId; readerLifetime.abort(); expect(actor.observer.trackerId).toBe(tracker);
    f.wire.send(delivered(1)); await consumed(f); expect(f.observed).toHaveBeenCalledExactlyOnceWith({ backendCorrelation: "operation" });
    actor.release(); expect(findOpenCodeInputObserver(f.port, f.attach)).toBeUndefined();
    const next = acquireOpenCodeInputObserver(f.context, f.attach, f.runtime, { ...f.lease, client: { ...f.lease.client } }, f.lifetime.signal);
    expect(next.observer.trackerId).not.toBe(tracker); await vi.waitFor(() => expect(f.observed).toHaveBeenCalledTimes(2)); next.release();
  });

  it("catches subscriber exceptions and fences a replaced binding before observing further proof", async () => {
    const f = fixture(); f.observed.mockImplementation(() => { throw new Error("listener"); });
    await f.observer.start(); f.reserve(); f.wire.send(delivered(1)); await consumed(f);
    f.database.prepare("UPDATE conversation_bindings SET backend_conversation_id='ses_replaced'").run();
    expect(() => f.observer.correlations()).toThrow();
  });
});

describe("OpenCode current-input access decisions", () => {
  it("waits for the invocation cut to commit and cannot grant authority from rolled back consumption", async () => {
    const f = fixture(); await f.observer.start(); f.reserve();
    f.wire.send(enqueue(1)); await vi.waitFor(() => expect(f.row().enqueueSequence).toBe(1));
    f.database.exec(`CREATE TRIGGER hold_invocation_cursor BEFORE UPDATE ON opencode_observation_cursors
      WHEN NEW.sequence = 2 BEGIN SELECT RAISE(ABORT,'hold invocation cut'); END`);
    f.wire.send(delivered(2));
    await vi.waitFor(() => expect(f.host.captureToolInvocation(openCodeRuntimeTarget(f.attach)).throughSequence).toBe(2));
    const stamp = f.host.captureToolInvocation(openCodeRuntimeTarget(f.attach));
    let settled = false;
    const acquiring = f.observer.accessDecisionAuthority(stamp).acquire(new AbortController().signal).then(value => { settled = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 125));
    expect(settled).toBe(false); expect(f.row().consumedFingerprint).toBeNull();
    f.database.exec("DROP TRIGGER hold_invocation_cursor");
    const lease = await acquiring; expect(lease.isCurrent()).toBe(true); lease.release();
  });
  it("does not borrow a later Sedes input for an invocation from a foreign native input", async () => {
    const f = fixture(); await f.observer.start(); f.reserve();
    f.wire.send(delivered(1, "msg_foreign"));
    await vi.waitFor(() => expect(f.host.captureToolInvocation(openCodeRuntimeTarget(f.attach)).inputId).toBe("msg_foreign"));
    const stamp = f.host.captureToolInvocation(openCodeRuntimeTarget(f.attach));
    f.wire.send(enqueue(2)); f.wire.send(delivered(3)); await consumed(f);
    await expect(f.observer.accessDecisionAuthority(stamp).acquire(new AbortController().signal))
      .rejects.toMatchObject({ toolError: { code: "permission_denied" } });
  });
  it("rejects a reused input ID after the host authority epoch changes", async () => {
    const f = fixture(); await f.observer.start(); f.reserve(); f.wire.send(enqueue(1)); f.wire.send(delivered(2)); await consumed(f);
    const stamp = f.host.captureToolInvocation(openCodeRuntimeTarget(f.attach));
    f.wire.send(delivered(3));
    await vi.waitFor(() => expect(f.host.captureToolInvocation(openCodeRuntimeTarget(f.attach)).authorityEpoch).toBe(stamp.authorityEpoch + 1));
    await vi.waitFor(() => expect(f.database.prepare("SELECT sequence FROM opencode_observation_cursors").get()).toEqual({ sequence: 3 }));
    await expect(f.observer.accessDecisionAuthority(stamp).acquire(new AbortController().signal))
      .rejects.toMatchObject({ toolError: { code: "permission_denied" } });
  });
  it("rejects a stale native owner even when the input and observation coordinates match", async () => {
    const f = fixture(); await f.observer.start(); f.reserve(); f.wire.send(enqueue(1)); f.wire.send(delivered(2)); await consumed(f);
    const stamp = f.host.captureToolInvocation(openCodeRuntimeTarget(f.attach));
    await expect(f.observer.accessDecisionAuthority({ ...stamp, authority: { ...stamp.authority, nativeGeneration: "old-generation" } })
      .acquire(new AbortController().signal)).rejects.toMatchObject({ toolError: { code: "permission_denied" } });
  });
  it("requires consumption plus prepared private user provenance and loses the lease on foreign delivery", async () => {
    const f = fixture(); await f.observer.start(); f.reserve();
    const authority = f.observer.accessDecisionAuthority(f.host.captureToolInvocation(openCodeRuntimeTarget(f.attach))); const signal = new AbortController().signal;
    await expect(authority.acquire(signal)).rejects.toMatchObject({ toolError: { code: "permission_denied", retryable: false } });
    f.wire.send(enqueue(1)); f.wire.send(delivered(2)); await consumed(f);
    const lease = await f.observer.accessDecisionAuthority(f.host.captureToolInvocation(openCodeRuntimeTarget(f.attach))).acquire(signal);
    expect(lease.isCurrent()).toBe(true);
    f.wire.send(delivered(3, "msg_foreign"));
    await vi.waitFor(() => expect(lease.signal.aborted).toBe(true));
    expect(lease.isCurrent()).toBe(false);
    await expect(authority.acquire(signal)).rejects.toMatchObject({ toolError: { code: "permission_denied" } });
    lease.release();
  });
  it("recovers current-input authority from the resident host after actor detach", async () => {
    const f = fixture(); await f.observer.start(); f.reserve();
    f.wire.send(enqueue(1)); f.wire.send(delivered(2)); await consumed(f);
    f.wire.messages.push(user()); f.observer.close();
    const cold = f.createObserver(); await cold.start(); cold.observeHistory(f.wire.messages);
    const authority = await cold.accessDecisionAuthority(f.host.captureToolInvocation(openCodeRuntimeTarget(f.attach))).acquire(new AbortController().signal);
    expect(authority.isCurrent()).toBe(true); authority.release();
    expect(f.wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(1);
  });
  it("invalidates pending access decisions on an observation gap", async () => {
    const f = fixture(); await f.observer.start(); f.reserve();
    f.wire.send(enqueue(1)); f.wire.send(delivered(2)); await consumed(f);
    const lease = await f.observer.accessDecisionAuthority(f.host.captureToolInvocation(openCodeRuntimeTarget(f.attach))).acquire(new AbortController().signal);
    f.wire.send(renamed(4));
    await vi.waitFor(() => expect(lease.signal.aborted).toBe(true)); expect(lease.isCurrent()).toBe(false);
  });
});
