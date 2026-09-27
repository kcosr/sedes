import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeHttpNativeAdapter } from "../../src/server/backends/opencode/opencode-http-native-adapter.js";
import { OpenCodeObservationHub } from "../../src/server/backends/opencode/opencode-observation-hub.js";
import { parseOpenCodeObservationBoundary, parseOpenCodeObservationRecords } from "../../src/server/backends/opencode/opencode-native-codecs.js";
import type { OpenCodeNativeAuthority, OpenCodePortObservation } from "../../src/server/backends/opencode/opencode-native-port.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const authority = (sessionID = "ses_fixture"): OpenCodeNativeAuthority => ({ tenantId: "tenant", principalId: "principal",
  executionEnvironmentId: "environment", backendInstanceId: "backend", runtimeId: "runtime", nativeGeneration: "generation",
  directory: "/workspace", session: { applicationThreadId: `thread-${sessionID}`, nativeSessionID: sessionID, bindingFingerprint: "binding" } });
const event = (seq: number, type = "session.inbox.delivered", sessionID = "ses_fixture") => ({ id: `evt_${sessionID}_${seq}`,
  type, created: 1, durable: { aggregateID: sessionID, seq, version: 1 }, data: { sessionID,
    ...(type === "session.inbox.delivered" ? { inboxID: `msg_${seq}` } : { title: `title${seq}` }) } });
function setup(options: ConstructorParameters<typeof OpenCodeObservationHub>[1] = {}) {
  const wire = createOpenCodeApiFixture();
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch: wire.fetch });
  const hub = new OpenCodeObservationHub(new OpenCodeHttpNativeAdapter(client), options);
  hub.admitScope(authority()); cleanups.push(() => { hub.close(); client.close(); });
  return { wire, hub, client };
}
async function drain(observation: OpenCodePortObservation) { await observation.wait(); return observation.drain(); }

describe("resident OpenCode native observation journal", () => {
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
    expect((await drain(proof))[0]).toMatchObject({ event: event(1, "session.renamed") }); await proof.close();
  });
});
