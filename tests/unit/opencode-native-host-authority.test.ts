import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeHttpNativeAdapter } from "../../src/server/backends/opencode/opencode-http-native-adapter.js";
import { OpenCodeNativeHost } from "../../src/server/backends/opencode/opencode-native-host.js";
import type { OpenCodeNativePort } from "../../src/server/backends/opencode/opencode-native-port.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";
import { openCodeTestMutationControl } from "../helpers/opencode-native-port-fixture.js";
import { OpenCodeNativeMutationDeliveryError } from "../../src/server/backends/opencode/opencode-native-codecs.js";

const clients: OpenCodeHttpClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const wire = createOpenCodeApiFixture();
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch: wire.fetch }); clients.push(client);
  const assertCurrent = vi.fn(async () => {});
  const host = new OpenCodeNativeHost({ tenantId: "tenant", principalId: "principal", executionEnvironmentId: "environment",
    backendInstanceId: "backend", runtimeId: "runtime", nativeGeneration: "generation" }, new OpenCodeHttpNativeAdapter(client), {
    assertCurrent, installSessionEnvironment: async () => { throw new Error("unexpected environment write"); },
    ensureMcpRegistration: async () => { throw new Error("unexpected MCP write"); },
  }, client.lifetime);
  const directory = host.acquire({ directory: wire.directory });
  const session = host.acquire({ directory: wire.directory, session: {
    applicationThreadId: "thread", nativeSessionID: wire.sessionID, bindingFingerprint: "binding",
  } });
  return { wire, client, host, directory, session, assertCurrent };
}

const sessionReads: { name: string; read(port: OpenCodeNativePort): Promise<unknown> }[] = [
  { name: "history", read: port => port.read("getHistoryPage", { sessionID: "ses_foreign" }) },
  { name: "message", read: port => port.read("getMessage", { sessionID: "ses_foreign", messageID: "msg_foreign" }) },
  { name: "pending", read: port => port.read("getPending", { sessionID: "ses_foreign" }) },
  { name: "interactions", read: port => port.read("getInteractions", { sessionID: "ses_foreign" }) },
  { name: "permission", read: port => port.read("getPermission", { sessionID: "ses_foreign", requestID: "per_foreign" }) },
  { name: "form", read: port => port.read("getForm", { sessionID: "ses_foreign", formID: "frm_foreign" }) },
  { name: "native log", read: port => port.read("readLog", { sessionID: "ses_foreign" }) },
  { name: "activity", read: port => port.read("getActivity", { sessionID: "ses_foreign", directory: port.authority.directory }) },
];

describe("OpenCode native host authority", () => {
  it.each(["acquire", "acquireRetained"] as const)("re-admits a retained hub scope on %s before work settles", async acquire => {
    const f = fixture(), first = f.session.observe({ purpose: "evidence" }); await first.ready;
    f.wire.send({ id: "evt_delivered", created: 1, type: "session.inbox.delivered",
      durable: { aggregateID: f.wire.sessionID, seq: 1, version: 1 }, data: { sessionID: f.wire.sessionID, inboxID: "msg_before_detach" } });
    await first.wait(); await first.close(); f.host.release(f.session);
    const replacement = f.host[acquire]({ directory: f.wire.directory, session: f.session.authority.session });
    expect(replacement).toBe(f.session);
    const evidence = replacement.observe({ purpose: "evidence" }), boundary = await evidence.ready;
    evidence.drain();
    f.wire.send({ id: "evt_terminal", created: 2, type: "session.execution.succeeded",
      durable: { aggregateID: f.wire.sessionID, seq: 2, version: 1 }, data: { sessionID: f.wire.sessionID } });
    await evidence.wait(); const records = evidence.drain();
    await evidence.acknowledge({ journalId: boundary.journalId, sequence: records.at(-1)!.sequence }); await evidence.close();
    expect(replacement.lifetime.aborted).toBe(false);
    const reopened = replacement.observe({ purpose: "evidence" }); await reopened.ready;
    const control = openCodeTestMutationControl("prompt"), id = "msg_after_reconnect";
    f.wire.setResponse(`/api/session/${f.wire.sessionID}/prompt`, 200, { data: {
      id, sessionID: f.wire.sessionID, type: "user", delivery: "queue", payload: { text: "reconnected" }, time: { created: 3 },
    } });
    await expect(replacement.mutate("prompt", { sessionID: f.wire.sessionID, id, text: "reconnected", delivery: "queue", resume: false }, control)).resolves.toMatchObject({ id });
    f.wire.send({ id: "evt_enqueue", created: 3, type: "session.inbox.enqueued",
      durable: { aggregateID: f.wire.sessionID, seq: 3, version: 1 }, data: { sessionID: f.wire.sessionID,
        inboxID: id, item: { type: "user", delivery: "queue", payload: { text: "reconnected" } } } });
    await reopened.wait(); expect(reopened.drain()).toHaveLength(1); await reopened.close();
  });

  it.each(["not_sent", "sent_outcome_unknown"] as const)("reclaims a %s input pin only with matching native proof", async delivery => {
    const f = fixture(), control = openCodeTestMutationControl("prompt"), id = "msg_refused";
    vi.spyOn(f.host.adapter, "mutate").mockRejectedValueOnce(new OpenCodeNativeMutationDeliveryError(delivery, "opencode_request_failed"));
    await expect(f.session.mutate("prompt", { sessionID: f.wire.sessionID, id, text: "x", delivery: "queue", resume: false }, control)).rejects.toMatchObject({ delivery });
    await f.session.acknowledgeOperation({ applicationOperationId: control.identity.origin === "application" ? control.identity.applicationOperationId : "unexpected", operationKind: "action" });
    f.host.release(f.session);
    if (delivery === "not_sent") { expect(f.session.lifetime.aborted).toBe(true); return; }
    expect(f.session.lifetime.aborted).toBe(false);
    const evidence = f.session.observe({ purpose: "evidence" }), boundary = await evidence.ready;
    f.wire.send({ id: "evt_exact_cancel", created: 1, type: "session.inbox.cancelled",
      durable: { aggregateID: f.wire.sessionID, seq: 1, version: 1 }, data: { sessionID: f.wire.sessionID, inboxID: id } });
    await evidence.wait(); const records = evidence.drain();
    await evidence.acknowledge({ journalId: boundary.journalId, sequence: records.at(-1)!.sequence }); await evidence.close();
    expect(f.session.lifetime.aborted).toBe(true);
  });

  it("reads history without repeating full process identity probes and still probes mutations", async () => {
    const f = fixture();
    for (let page = 0; page < 4; page++) await f.session.read("getHistoryPage", { sessionID: f.wire.sessionID, order: "asc" });
    expect(f.assertCurrent).not.toHaveBeenCalled();
    expect(f.wire.requests.filter(request => request.pathname !== "/api/event")).toHaveLength(4);
    expect(f.wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(1);
    await f.session.mutate("interruptSession", { sessionID: f.wire.sessionID }, openCodeTestMutationControl("interrupt"));
    expect(f.assertCurrent).toHaveBeenCalledOnce();
  });
  it("reuses released scope capacity and never revives a retired port or its child routes", async () => {
    const f = fixture();
    for (let index = 0; index < 4_100; index++) {
      const port = f.host.acquire({ directory: `/workspace-${index}` });
      f.host.release(port); expect(port.lifetime.aborted).toBe(true);
    }
    const child = { ...f.wire.session, id: "ses_child", parentID: f.wire.sessionID };
    f.wire.sessions.push(child); f.wire.setResponse("/api/session/ses_child", 200, { data: child });
    await f.session.read("getActivity", { sessionID: f.wire.sessionID, directory: f.wire.directory });
    await expect(f.session.read("getSession", { sessionID: "ses_child" })).resolves.toMatchObject({ id: "ses_child" });
    const target = { directory: f.session.authority.directory, session: f.session.authority.session };
    f.host.release(f.session);
    const replacement = f.host.acquire(target);
    expect(replacement).not.toBe(f.session);
    await expect(f.session.read("getSession", { sessionID: f.wire.sessionID })).rejects.toMatchObject({ code: "opencode_request_authority_mismatch" });
    await expect(replacement.read("getSession", { sessionID: "ses_child" })).rejects.toMatchObject({ code: "opencode_request_authority_mismatch" });
    await expect(replacement.read("getSession", { sessionID: f.wire.sessionID })).resolves.toMatchObject({ id: f.wire.sessionID });
  });
  it("retains shared scopes until the final lease and active read release", async () => {
    const f = fixture(), second = f.host.acquire({ directory: f.wire.directory, session: f.session.authority.session });
    expect(second).toBe(f.session); f.host.release(f.session);
    expect(second.lifetime.aborted).toBe(false);
    const hold = f.wire.hold(`/api/session/${f.wire.sessionID}/message`);
    const reading = second.read("getHistoryPage", { sessionID: f.wire.sessionID });
    try {
      await hold.entered; f.host.release(second);
      expect(second.lifetime.aborted).toBe(false);
    } finally { hold.release(); await reading; }
    expect(second.lifetime.aborted).toBe(true);
  });
  it("retains critical evidence after presentation closes and reclaims its scope after evidence ACK", async () => {
    const f = fixture(), observation = f.session.observe({ purpose: "presentation" });
    try {
      await observation.ready; f.host.release(f.session);
      expect(f.session.lifetime.aborted).toBe(false);
      f.wire.send({ id: "evt_retained", created: 1, type: "session.synthetic",
        durable: { aggregateID: f.wire.sessionID, seq: 1, version: 1 }, data: { sessionID: f.wire.sessionID, text: "retained" } });
      await vi.waitFor(() => expect(observation.drain()).toHaveLength(1));
    } finally { await observation.close(); }
    expect(f.session.lifetime.aborted).toBe(false);
    const evidence = f.session.observe({ purpose: "evidence" });
    const boundary = await evidence.ready, records = evidence.drain();
    expect(records).toHaveLength(1);
    await evidence.acknowledge({ journalId: boundary.journalId, sequence: records[0]!.sequence });
    await evidence.close();
    expect(f.session.lifetime.aborted).toBe(true);
  });
  it("keeps completed journal evidence after lease release until its durable ACK", async () => {
    const f = fixture(), control = openCodeTestMutationControl("interrupt");
    await f.session.mutate("interruptSession", { sessionID: f.wire.sessionID }, control);
    f.host.release(f.session); expect(f.session.lifetime.aborted).toBe(false);
    await expect(f.session.outcome("interruptSession", control.identity)).resolves.toMatchObject({ status: "completed" });
    await f.session.acknowledgeMutation("interruptSession", control.identity);
    expect(f.session.lifetime.aborted).toBe(true);
    await expect(f.session.mutate("interruptSession", { sessionID: f.wire.sessionID }, control))
      .rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
  });
  it("keeps a pending terminally acknowledged mutation scoped until native settlement", async () => {
    const f = fixture(), control = openCodeTestMutationControl("interrupt");
    const hold = f.wire.hold(`/api/session/${f.wire.sessionID}/interrupt`);
    const mutation = f.session.mutate("interruptSession", { sessionID: f.wire.sessionID }, control);
    try {
      await hold.entered; f.host.release(f.session);
      await f.session.acknowledgeMutation("interruptSession", control.identity);
      expect(f.session.lifetime.aborted).toBe(false);
      expect(f.host.snapshot().operations).toHaveLength(1);
    } finally { hold.release(); await mutation; }
    expect(f.host.snapshot().operations).toHaveLength(0);
    expect(f.session.lifetime.aborted).toBe(true);
  });
  it("retains accepted input tracking after receipt ACK and detach before the first SSE frame", async () => {
    const f = fixture(), control = openCodeTestMutationControl("prompt"), id = "msg_delayed_event";
    f.wire.setResponse(`/api/session/${f.wire.sessionID}/prompt`, 200, { data: {
      id, sessionID: f.wire.sessionID, type: "user", delivery: "queue", payload: { text: "queued" }, time: { created: 1 },
    } });
    await f.session.mutate("prompt", { sessionID: f.wire.sessionID, id, text: "queued", delivery: "queue", resume: false }, control);
    await f.session.acknowledgeMutation("prompt", control.identity);
    f.host.release(f.session);
    expect(f.host.snapshot().operations).toHaveLength(0);
    expect(f.session.lifetime.aborted).toBe(false);
    const evidence = f.session.observe({ purpose: "evidence" }), boundary = await evidence.ready;
    f.wire.send({ id: "evt_late_enqueue", type: "session.inbox.enqueued", created: 1,
      durable: { aggregateID: f.wire.sessionID, seq: 1, version: 1 }, data: { sessionID: f.wire.sessionID,
        inboxID: id, item: { type: "user", delivery: "queue", payload: { text: "queued" } } } });
    await evidence.wait();
    const records = evidence.drain();
    expect(records).toHaveLength(1);
    await evidence.acknowledge({ journalId: boundary.journalId, sequence: records[0]!.sequence });
    await evidence.close();
    expect(f.session.lifetime.aborted).toBe(false);
    const settled = f.session.observe({ purpose: "evidence" }); await settled.ready;
    f.wire.send({ id: "evt_cancelled", type: "session.inbox.cancelled", created: 2,
      durable: { aggregateID: f.wire.sessionID, seq: 2, version: 1 }, data: { sessionID: f.wire.sessionID, inboxID: id } });
    await settled.wait();
    const cancelled = settled.drain(); expect(cancelled).toHaveLength(1);
    await settled.acknowledge({ journalId: boundary.journalId, sequence: cancelled[0]!.sequence });
    await settled.close();
    expect(f.session.lifetime.aborted).toBe(true);
  });
  it("admits creation preflight only after proving the returned workspace", async () => {
    const f = fixture();
    await expect(f.directory.read("getSession", { sessionID: f.wire.sessionID })).resolves.toEqual(f.wire.session);
    f.wire.session.location = { directory: "/another-workspace" };
    await expect(f.directory.read("getSession", { sessionID: f.wire.sessionID })).rejects.toMatchObject({ code: "opencode_session_location_changed" });
  });
  it.each(sessionReads)("refuses directory-only $name access before native I/O", async ({ read }) => {
    const f = fixture();
    await expect(read(f.directory)).rejects.toMatchObject({ code: "opencode_request_authority_mismatch" });
    expect(f.wire.requests.map(request => request.pathname)).toEqual(["/api/event"]);
  });
  it("does not let a bound session create another session", async () => {
    const f = fixture();
    await expect(f.session.mutate("createSession", { id: "ses_foreign", location: { directory: f.wire.directory } },
      openCodeTestMutationControl("create"))).rejects.toMatchObject({ delivery: "not_sent", code: "opencode_request_authority_mismatch" });
    expect(f.wire.requests.map(request => request.pathname)).toEqual(["/api/event"]);
  });
  it("keeps a completed effect unknown after owner loss instead of manufacturing a not-sent proof", async () => {
    const f = fixture(), control = openCodeTestMutationControl("interrupt");
    await expect(f.session.mutate("interruptSession", { sessionID: f.wire.sessionID }, control)).resolves.toEqual({ interrupted: true });
    f.host.close();
    await expect(f.session.mutate("interruptSession", { sessionID: f.wire.sessionID }, control))
      .rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    expect(f.wire.requests.filter(request => request.pathname.endsWith("/interrupt"))).toHaveLength(1);
  });
});
