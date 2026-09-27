import { describe, expect, it } from "vitest";
import { OpenCodeNativeObservationProof } from "../../src/server/backends/opencode/opencode-native-observation-proof.js";
import { parseOpenCodeNativeEvent } from "../../src/server/backends/opencode/opencode-native-codecs.js";
const event = (seq: number, type: string, data: Record<string, unknown>) => parseOpenCodeNativeEvent({ id: `evt_${seq}`,
  created: 1, type, durable: { aggregateID: "ses_owned", seq, version: 1 }, data: { sessionID: "ses_owned", ...data } });
describe("OpenCode compact native proof", () => {
  it("retains current input independently from payload trimming but revokes it on native loss", () => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    proof.accept(event(1, "session.inbox.delivered", { inboxID: "msg_owned" }));
    expect(proof.trim(1_024)).toBe(true);
    expect(proof.snapshot()).toMatchObject({ currentInputId: "msg_owned", proofs: [], coverageFloor: null });
    expect(proof.hasWork).toBe(true);
    proof.discontinuity(); expect(proof.snapshot().currentInputId).toBeNull(); expect(proof.hasWork).toBe(true);
  });
  it("keeps exact density evidence across native breaks and distinguishes replay from conflicting or regressed sequences", () => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    const original = event(2, "session.inbox.delivered", { inboxID: "msg_owned" }); proof.accept(original);
    expect(proof.isDuplicate(original)).toBe(true);
    proof.discontinuity(); expect(proof.snapshot().proofs).toHaveLength(1);
    expect(proof.isConflict(event(2, "session.inbox.delivered", { inboxID: "msg_other" }))).toBe(true);
    proof.trim(1_024);
    expect(proof.isConflict(event(1, "session.inbox.delivered", { inboxID: "msg_old" }))).toBe(true);
  });
  it("bounds pending work without silently claiming dropped IDs completed", () => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    proof.accept(event(1, "session.inbox.enqueued", { inboxID: "msg_owned", item: { type: "user", delivery: "queue", payload: { text: "x" } } }));
    expect(proof.trim(1_024)).toBe(false);
    expect(proof.bytes).toBe(1_024); expect(proof.hasWork).toBe(true);
    expect(proof.snapshot().currentInputId).toBeNull();
  });
  it("cannot reserve an input outside the runtime proof budget and reclaims only a known refusal", () => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    expect(proof.prepareInput("msg_owned", 1_024)).toBe(false); expect(proof.hasWork).toBe(false);
    expect(proof.prepareInput("msg_owned", 2_048)).toBe(true); expect(proof.hasWork).toBe(true);
    proof.refuseInput("msg_owned"); expect(proof.hasWork).toBe(false); expect(proof.bytes).toBe(1_024);
    proof.prepareInput("msg_owned", 2_048);
    proof.accept(event(1, "session.inbox.enqueued", { inboxID: "msg_owned", item: { type: "user", delivery: "queue", payload: { text: "x" } } }));
    proof.refuseInput("msg_owned"); expect(proof.hasWork).toBe(true);
  });
});
