import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeHttpNativeAdapter } from "../../src/server/backends/opencode/opencode-http-native-adapter.js";
import { OpenCodeObservationHub } from "../../src/server/backends/opencode/opencode-observation-hub.js";
import { parseOpenCodeObservationBoundary, parseOpenCodeObservationRecords } from "../../src/server/backends/opencode/opencode-native-codecs.js";
import type { OpenCodeNativeAuthority, OpenCodePortObservation } from "../../src/server/backends/opencode/opencode-native-port.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";
import { openCodeNativeFactFingerprint } from "../../src/server/backends/opencode/opencode-native-observation-proof.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const authority = (sessionID = "ses_fixture"): OpenCodeNativeAuthority => ({ tenantId: "tenant", principalId: "principal",
  executionEnvironmentId: "environment", backendInstanceId: "backend", runtimeId: "runtime", nativeGeneration: "generation",
  directory: "/workspace", session: { applicationThreadId: `thread-${sessionID}`, nativeSessionID: sessionID, bindingFingerprint: "binding" } });
const event = (seq: number, type = "session.inbox.delivered", sessionID = "ses_fixture") => ({ id: `evt_${sessionID}_${seq}`,
  type, created: 1, durable: { aggregateID: sessionID, seq, version: 1 }, data: { sessionID,
    ...(type === "session.inbox.delivered" ? { inboxID: `msg_${seq}` } : { title: `title${seq}` }) } });
function setup(options: ConstructorParameters<typeof OpenCodeObservationHub>[1] = {}) {
  const wire = createOpenCodeApiFixture({ directory: authority().directory });
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch: wire.fetch });
  const hub = new OpenCodeObservationHub(new OpenCodeHttpNativeAdapter(client), options);
  hub.admitScope(authority()); cleanups.push(() => { hub.close(); client.close(); });
  return { wire, hub, client };
}
async function drain(observation: OpenCodePortObservation) { await observation.wait(); return observation.drain(); }

describe("resident OpenCode native observation journal", () => {
  it("reclaims known input and interaction markers settled inside a native stream gap after exact inventory and ACK", async () => {
    const { wire, hub } = setup(); const observation = hub.subscribe(authority(), { purpose: "evidence" });
    const before = await observation.ready;
    wire.send({ ...event(1), type: "session.inbox.enqueued", data: { sessionID: "ses_fixture", inboxID: "msg_known",
      item: { type: "user", delivery: "queue", payload: { text: "x" } } } });
    wire.send({ id: "evt_permission", created: 1, type: "permission.asked",
      data: { sessionID: "ses_fixture", id: "per_known", action: "write", resources: [] } });
    await vi.waitFor(() => expect(hub.retentionSnapshot().evidenceRecords).toBe(2));
    observation.drain(); await observation.acknowledge({ journalId: before.journalId, sequence: 2 }); await observation.close();
    hub.releaseScope(authority()); expect(hub.hasRetainedAuthority(authority())).toBe(true);
    // Native delivery/permission reply happen while disconnected; stock SSE has
    // no replay. Successful empty inventories settle only resident markers.
    wire.disconnect();
    await vi.waitFor(() => expect(wire.requests.filter(request => request.pathname.endsWith("/permission"))).toHaveLength(1));
    expect(wire.requests.filter(request => request.pathname.endsWith("/inbox"))).toHaveLength(1);
    expect(hub.hasRetainedAuthority(authority())).toBe(true); // loss record still unACKed
    const recovered = hub.subscribe(authority(), { purpose: "evidence" }); const boundary = await recovered.ready;
    const records = recovered.drain(); expect(records).toHaveLength(1); expect(records[0]!.kind).toBe("native_break");
    await recovered.acknowledge({ journalId: boundary.journalId, sequence: records[0]!.sequence }); await recovered.close();
    await vi.waitFor(() => expect(hub.hasRetainedAuthority(authority())).toBe(false));
    expect(boundary.proof.currentInputId).toBeNull();
  });

  it("replaces a consumed pending marker with positively observed running work after a stream gap", async () => {
    const { wire, hub } = setup(); const first = hub.subscribe(authority(), { purpose: "evidence" }); await first.ready;
    wire.send({ ...event(1), type: "session.inbox.enqueued", data: { sessionID: "ses_fixture", inboxID: "msg_known",
      item: { type: "user", delivery: "queue", payload: { text: "x" } } } });
    await first.wait(); wire.setResponse("/api/session/active", 200, { data: { ses_fixture: { type: "running" } } }); wire.disconnect();
    await vi.waitFor(() => expect(wire.requests.some(request => request.pathname === "/api/session/active")).toBe(true));
    const recovered = hub.subscribe(authority(), { purpose: "evidence" }); const boundary = await recovered.ready;
    const records = recovered.drain(); await recovered.acknowledge({ journalId: boundary.journalId, sequence: records.at(-1)!.sequence });
    await recovered.close(); await first.close(); hub.releaseScope(authority());
    expect(hub.hasRetainedAuthority(authority())).toBe(true);
    expect(wire.requests.findIndex(request => request.pathname.endsWith("/inbox")))
      .toBeLessThan(wire.requests.findIndex(request => request.pathname === "/api/session/active"));
    wire.send({ ...event(3), type: "session.execution.succeeded", data: { sessionID: "ses_fixture" } });
    const terminal = hub.subscribe(authority(), { purpose: "evidence" }); const final = await terminal.ready;
    await terminal.wait(); const ended = terminal.drain();
    await terminal.acknowledge({ journalId: final.journalId, sequence: ended.at(-1)!.sequence }); await terminal.close();
    await vi.waitFor(() => expect(hub.hasRetainedAuthority(authority())).toBe(false));
  });

  it("reads a child interaction from its exact session and directory instead of erasing it from root absence", async () => {
    const { wire, hub } = setup({ route: (_authority, event) => "sessionID" in event.data &&
      ["ses_fixture", "ses_child"].includes(event.data.sessionID) });
    const permission = { id: "per_child", sessionID: "ses_child", action: "write", resources: [] };
    wire.setResponse("/api/session/ses_child", 200, { data: { ...wire.session, id: "ses_child", parentID: wire.sessionID, location: { directory: "/child" } } });
    wire.setResponse("/api/session/ses_child/permission", 200, { data: [permission] });
    wire.setResponse("/api/session/ses_child/form", 200, { data: [] });
    wire.setResponse("/api/shell", 200, { location: { directory: "/child" }, data: [] });
    const first = hub.subscribe(authority(), { purpose: "evidence" }); await first.ready;
    wire.send({ id: "evt_child_permission", created: 1, type: "permission.asked", data: permission });
    await first.wait(); wire.disconnect();
    await vi.waitFor(() => expect(wire.requests.filter(request => request.pathname === "/api/session/ses_child/permission")).toHaveLength(1));
    const retained = hub.subscribe(authority(), { purpose: "evidence" }); const boundary = await retained.ready;
    const records = retained.drain(); await retained.acknowledge({ journalId: boundary.journalId, sequence: records.at(-1)!.sequence });
    await retained.close(); await first.close(); hub.releaseScope(authority());
    expect(hub.hasRetainedAuthority(authority())).toBe(true);
    expect(wire.requests.find(request => request.pathname === "/api/shell")!.query.toString()).toContain(encodeURIComponent("/child"));
    wire.setResponse("/api/session/ses_child/permission", 200, { data: [] }); wire.disconnect();
    await vi.waitFor(() => expect(wire.requests.filter(request => request.pathname === "/api/session/ses_child/permission")).toHaveLength(2));
    const recovered = hub.subscribe(authority(), { purpose: "evidence" }); const final = await recovered.ready;
    const lost = recovered.drain(); await recovered.acknowledge({ journalId: final.journalId, sequence: lost.at(-1)!.sequence }); await recovered.close();
    await vi.waitFor(() => expect(hub.hasRetainedAuthority(authority())).toBe(false));
  });

  it("retains a known native marker when reconnect inventory fails", async () => {
    const { wire, hub } = setup(); const observation = hub.subscribe(authority(), { purpose: "evidence" }); await observation.ready;
    wire.send({ ...event(1), type: "session.inbox.enqueued", data: { sessionID: "ses_fixture", inboxID: "msg_known",
      item: { type: "user", delivery: "queue", payload: { text: "x" } } } });
    await observation.wait(); wire.setResponse("/api/session/ses_fixture/inbox", 503, { error: "unavailable" }); wire.disconnect();
    await vi.waitFor(() => expect(wire.requests.some(request => request.pathname.endsWith("/inbox"))).toBe(true));
    const recovered = hub.subscribe(authority(), { purpose: "evidence" }); const boundary = await recovered.ready;
    const records = recovered.drain(); await recovered.acknowledge({ journalId: boundary.journalId, sequence: records.at(-1)!.sequence });
    await recovered.close(); await observation.close(); hub.releaseScope(authority());
    expect(hub.hasRetainedAuthority(authority())).toBe(true);
  });

  it("retains detached tool output as exact compact facts while presentation keeps the full native payload", async () => {
    const { wire, hub } = setup({ maximumCriticalBytes: 32_768, maximumCriticalRecords: 2 });
    const first = hub.subscribe(authority(), { purpose: "evidence" }); const ready = await first.ready; await first.close();
    const presentation = hub.subscribe(authority(), { purpose: "presentation" }); await presentation.ready;
    const outputs = Array.from({ length: 6 }, (_, index) => ({ id: `evt_tool_${index}`, created: 1, type: "session.tool.success",
      durable: { aggregateID: "ses_fixture", seq: index + 2, version: 2 }, data: { sessionID: "ses_fixture", assistantMessageID: "msg_answer",
        id: `tool_${index}`, executed: true, content: [{ type: "text", text: "result".repeat(90_000) }] } }));
    wire.send(event(1)); for (const output of outputs) wire.send(output);
    wire.send({ ...event(8), type: "session.execution.succeeded", data: { sessionID: "ses_fixture" } });
    await vi.waitFor(() => expect(hub.retentionSnapshot().evidenceRecords).toBe(8));
    expect(hub.retentionSnapshot()).toMatchObject({ retentionExhausted: false, currentInputScopes: 0 });
    expect(hub.retentionSnapshot().evidenceBytes).toBeLessThan(32_768);
    const replay = hub.subscribe(authority(), { purpose: "evidence", after: { journalId: ready.journalId, sequence: 0 } });
    await replay.ready; const records = parseOpenCodeObservationRecords(await drain(replay));
    expect(records.map(record => record.kind)).toEqual(["native", ...outputs.map(() => "native_fact"), "native"]);
    expect(records[1]).toMatchObject({ sessionID: "ses_fixture", fact: { nativeSequence: 2, type: "session.tool.success",
      fingerprint: openCodeNativeFactFingerprint(outputs[0]) } });
    expect(JSON.stringify(records)).not.toContain("resultresult");
    const displayed = await drain(presentation);
    expect(displayed.find(record => record.kind === "native" && record.event.type === "session.tool.success"))
      .toMatchObject({ event: outputs[0] });
    await replay.close(); await presentation.close();
  });

  it("reclaims another scope's cached facts to admit a new scope and input without discarding pending work", async () => {
    const { wire, hub } = setup({ maximumProofBytes: 4_096 }); await hub.ensureListening();
    wire.send(event(1)); for (let seq = 2; seq <= 30; seq++) wire.send(event(seq, "session.renamed"));
    await vi.waitFor(() => expect(hub.retentionSnapshot().evidenceRecords).toBe(30));
    const old = hub.subscribe(authority(), { purpose: "evidence" }); const before = await old.ready;
    expect(before.proof.currentInputId).toBe("msg_1"); expect(hub.retentionSnapshot().proofBytes).toBeGreaterThan(3_500);
    await drain(old); await old.acknowledge({ journalId: before.journalId, sequence: 30 }); await old.close();
    const fresh = authority("ses_fresh"); expect(() => hub.admitScope(fresh)).not.toThrow();
    expect(() => hub.beginInput(fresh, "msg_pending")).not.toThrow();
    hub.releaseScope(fresh); expect(hub.hasRetainedAuthority(fresh)).toBe(true);
    const retained = hub.subscribe(authority(), { purpose: "evidence" }); const after = await retained.ready;
    expect(after.proof.currentInputId).toBe("msg_1");
    expect(after.proof.proofs.length).toBeLessThan(before.proof.proofs.length);
    expect(hub.retentionSnapshot().proofBytes).toBeLessThanOrEqual(4_096);
    expect(hub.retentionSnapshot().retentionExhausted).toBe(false); await retained.close();
  });

  it("resnapshots the slow reader retaining bytes instead of starving a different active scope", async () => {
    const { wire, hub } = setup({ maximumPresentationBytes: 10_000 }); const other = authority("ses_other"); hub.admitScope(other);
    const slow = hub.subscribe(authority(), { purpose: "presentation" }), active = hub.subscribe(other, { purpose: "presentation" });
    await Promise.all([slow.ready, active.ready]);
    const delta = (sessionID: string, length: number) => ({ id: `evt_${sessionID}`, type: "session.text.delta", created: 1,
      data: { sessionID, assistantMessageID: "msg_answer", ordinal: 0, delta: "x".repeat(length) } });
    wire.send(delta("ses_fixture", 7_000)); await slow.wait();
    wire.send(delta("ses_other", 2_500));
    expect((await drain(active))[0]).toMatchObject({ kind: "native", event: delta("ses_other", 2_500) });
    expect(await slow.ended).toMatchObject({ reason: "resnapshot_required" }); expect(active.failure).toBeUndefined();
    wire.send(delta("ses_other", 2_500)); expect(await drain(active)).toHaveLength(1);
    expect(active.failure).toBeUndefined(); await active.close();
  });

  it("leaves undrained evidence in place when a multiplexed poll has insufficient byte headroom", async () => {
    const { wire, hub } = setup(); const observation = hub.subscribe(authority(), { purpose: "evidence" }); const ready = await observation.ready;
    wire.send(event(1)); await observation.wait(); expect(observation.drain(2)).toEqual([]);
    await expect(observation.acknowledge({ journalId: ready.journalId, sequence: 1 })).rejects.toThrow("opencode_request_authority_mismatch");
    const records = observation.drain(); expect(records).toHaveLength(1);
    await observation.acknowledge({ journalId: ready.journalId, sequence: 1 }); await observation.close();
  });
  it("keeps a single native subscription and replay/current-input proof across subscriber detach and ACK", async () => {
    const { wire, hub } = setup();
    const first = hub.subscribe(authority(), { purpose: "evidence" }); const ready = await first.ready;
    await first.close(); wire.send(event(1)); wire.send(event(2));
    await vi.waitFor(() => expect(hub.retentionSnapshot().evidenceRecords).toBe(2));
    const resumed = hub.subscribe(authority(), { purpose: "evidence", after: { journalId: ready.journalId, sequence: 0 } });
    const baseline = parseOpenCodeObservationBoundary(await resumed.ready);
    expect(baseline).toMatchObject({ journalId: ready.journalId, throughSequence: 2, nativeContinuity: ready.nativeContinuity,
      proof: { currentInputId: "msg_2", nativeFrontier: 2 } });
    expect(parseOpenCodeObservationRecords(await drain(resumed)).map(record => record.sequence)).toEqual([1, 2]);
    await resumed.acknowledge({ journalId: ready.journalId, sequence: 2 }); await resumed.close();
    hub.releaseScope(authority()); expect(hub.hasRetainedAuthority(authority())).toBe(true);
    expect(hub.retentionSnapshot()).toMatchObject({ evidenceRecords: 0, currentInputScopes: 1 });
    const replacement = hub.subscribe(authority(), { purpose: "evidence", after: { journalId: ready.journalId, sequence: 2 } });
    expect((await replacement.ready).proof.currentInputId).toBe("msg_2");
    expect(wire.requests.filter(request => request.pathname === "/api/event")).toHaveLength(1);
    await replacement.close();
  });

  it("captures evidence synchronously before an immediate EOF discards presentation", async () => {
    const { wire, hub } = setup(); const first = hub.subscribe(authority(), { purpose: "evidence" });
    const ready = await first.ready; await first.close();
    wire.send(event(1)); wire.disconnect();
    await vi.waitFor(() => expect(hub.retentionSnapshot().evidenceRecords).toBe(2));
    const recovered = hub.subscribe(authority(), { purpose: "evidence", after: { journalId: ready.journalId, sequence: 0 } });
    const boundary = await recovered.ready;
    expect(boundary.nativeContinuity).not.toBe(ready.nativeContinuity);
    expect(boundary.proof.currentInputId).toBeNull();
    const records = await drain(recovered);
    expect(records.map(record => record.kind)).toEqual(["native", "native_break"]);
    expect(records[0]).toMatchObject({ event: event(1) });
    await recovered.close();
  });

  it("uses dense independent scope cursors and fences stale controllers and ACKs", async () => {
    const { wire, hub } = setup(); const other = authority("ses_other"); hub.admitScope(other);
    const first = hub.subscribe(authority(), { purpose: "evidence" }); const ready = await first.ready;
    wire.send(event(1, "session.renamed", "ses_other")); wire.send(event(1, "session.renamed"));
    expect((await drain(first)).map(record => record.sequence)).toEqual([1]);
    const next = hub.subscribe(authority(), { purpose: "evidence", after: { journalId: ready.journalId, sequence: 0 } });
    await next.ready; expect(await first.ended).toMatchObject({ reason: "superseded" });
    await expect(first.acknowledge({ journalId: ready.journalId, sequence: 1 })).rejects.toMatchObject({ code: "opencode_observation_controller_superseded" });
    await expect(next.acknowledge({ journalId: ready.journalId, sequence: 1 })).rejects.toMatchObject({ code: "opencode_request_authority_mismatch" });
    await drain(next); await next.acknowledge({ journalId: ready.journalId, sequence: 1 });
    expect(() => hub.subscribe(authority(), { purpose: "evidence", after: { journalId: ready.journalId, sequence: 0 } })).toThrow("opencode_observation_continuity_lost");
    await next.close(); hub.releaseScope(authority()); expect(hub.hasRetainedAuthority(authority())).toBe(false);
    hub.admitScope(authority()); const renewed = hub.subscribe(authority(), { purpose: "evidence" });
    expect((await renewed.ready).journalId).not.toBe(ready.journalId); await renewed.close();
  });

  it("preserves retained positive evidence and emits an explicit bounded loss marker at capacity", async () => {
    const { wire, hub } = setup({ maximumCriticalRecords: 1 });
    const observation = hub.subscribe(authority(), { purpose: "evidence" }); const ready = await observation.ready;
    wire.send(event(1)); wire.send(event(2)); wire.send(event(3));
    await vi.waitFor(() => expect(hub.retentionSnapshot()).toMatchObject({ evidenceRecords: 2, retentionExhausted: true }));
    await expect(hub.ensureListening()).rejects.toThrow("opencode_observation_retention_full");
    const replacement = hub.subscribe(authority(), { purpose: "evidence", after: { journalId: ready.journalId, sequence: 0 } });
    const baseline = await replacement.ready; const records = await drain(replacement);
    expect(records).toHaveLength(2); expect(records[0]).toMatchObject({ kind: "native", event: event(1) });
    expect(records[1]).toMatchObject({ kind: "native_break", reason: "overflow" });
    expect(baseline.proof.currentInputId).toBeNull();
    await replacement.acknowledge({ journalId: baseline.journalId, sequence: records.at(-1)!.sequence });
    expect(hub.retentionSnapshot().evidenceRecords).toBe(0); await replacement.close();
  });

  it("pins a native input until observed settlement even when its receipt was ACKed before SSE delivery", async () => {
    const { wire, hub } = setup(); await hub.ensureListening();
    hub.beginInput(authority(), "msg_1"); hub.releaseScope(authority());
    expect(hub.hasRetainedAuthority(authority())).toBe(true);
    wire.send(event(1)); await vi.waitFor(() => expect(hub.retentionSnapshot().evidenceRecords).toBe(1));
    const observation = hub.subscribe(authority(), { purpose: "evidence" }); const ready = await observation.ready;
    expect(ready.proof.currentInputId).toBe("msg_1"); await observation.close();
    const refused = authority("ses_refused"); hub.admitScope(refused); hub.beginInput(refused, "msg_refused");
    hub.releaseScope(refused); expect(hub.hasRetainedAuthority(refused)).toBe(true);
    hub.refuseInput(refused, "msg_refused"); expect(hub.hasRetainedAuthority(refused)).toBe(false);
  });

  it("presentation has no evidence ACK authority and can close without losing retained evidence", async () => {
    const { wire, hub } = setup(); const presentation = hub.subscribe(authority(), { purpose: "presentation" });
    const ready = await presentation.ready;
    wire.send(event(1, "session.renamed")); await drain(presentation);
    await expect(presentation.acknowledge({ journalId: ready.journalId, sequence: 1 })).rejects.toThrow("opencode_request_authority_mismatch");
    await presentation.close(); expect(hub.retentionSnapshot().evidenceRecords).toBe(1);
    const proof = hub.subscribe(authority(), { purpose: "evidence" }); await proof.ready;
    expect((await drain(proof))[0]).toMatchObject({ kind: "native_fact", fact: { nativeSequence: 1, type: "session.renamed",
      fingerprint: openCodeNativeFactFingerprint(event(1, "session.renamed")) } }); await proof.close();
  });
});
