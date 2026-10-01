import { describe, expect, it } from "vitest";
import { OpenCodeNativeObservationProof } from "../../src/server/backends/opencode/opencode-native-observation-proof.js";
import { parseOpenCodeNativeEvent } from "../../src/server/backends/opencode/opencode-native-codecs.js";
const event = (seq: number, type: string, data: Record<string, unknown>) => parseOpenCodeNativeEvent({ id: `evt_${seq}`,
  created: 1, type, durable: { aggregateID: "ses_owned", seq, version: 1 }, data: { sessionID: "ses_owned", ...data } });
const emptyInventory = (owners: readonly string[] = ["ses_owned"]) => ({ pending: new Set<string>(), checkedOwners: new Set(owners), work: new Map<string, string>() });
describe("OpenCode compact native proof", () => {
  it.each([
    ["permission.replied", "permission:per_child", { sessionID: "ses_child", requestID: "per_child", reply: "once" }],
    ["form.replied", "form:frm_child", { sessionID: "ses_child", id: "frm_child", answer: {} }],
    ["form.cancelled", "form:frm_child", { sessionID: "ses_child", id: "frm_child" }],
    ["shell.exited", "shell:sh_child", { id: "sh_child", status: "exited", exit: 0 }],
    ["shell.deleted", "shell:sh_child", { id: "sh_child" }],
    ["session.execution.succeeded", "execution:ses_child", { sessionID: "ses_child" }],
    ["session.execution.failed", "execution:ses_child", { sessionID: "ses_child", error: { type: "unknown", message: "failed" } }],
    ["session.execution.interrupted", "execution:ses_child", { sessionID: "ses_child", reason: "user" }],
    ["session.deleted", "execution:ses_child", { sessionID: "ses_child" }],
  ])("fences stale positive inventory after %s settles work whose start was missed", (type, marker, data) => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    proof.discontinuity(); const cut = proof.retentionCut();
    const inventory = { ...emptyInventory(["ses_child"]), work: new Map([[marker as string, "ses_child"]]) };
    // The read found active work, but its terminal arrives before applying that
    // read. No held marker or root authority epoch can stand in for this fence.
    proof.accept(parseOpenCodeNativeEvent({ id: "evt_terminal", created: 1, type, data,
      ...(String(type).startsWith("session.") ? { durable: { aggregateID: "ses_child", seq: 1, version: type === "session.deleted" ? 2 : 1 } } : {}) }));
    expect(proof.reconcileRetention(cut, inventory)).toBe(false);
    expect(proof.retentionCut().work).toEqual([]); expect(proof.hasWork).toBe(false);
  });

  it("reconciles child interactions and shells only against their exact checked owner", () => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    proof.accept(parseOpenCodeNativeEvent({ id: "evt_permission", created: 1, type: "permission.asked",
      data: { sessionID: "ses_child", id: "per_child", action: "write", resources: [] } }));
    proof.accept(parseOpenCodeNativeEvent({ id: "evt_form", created: 1, type: "form.created",
      data: { form: { id: "frm_child", sessionID: "ses_child", title: "Question", fields: [{ key: "answer", type: "string" }] } } }));
    proof.accept(parseOpenCodeNativeEvent({ id: "evt_shell", created: 1, type: "shell.created", data: { info: {
      id: "sh_other", status: "running", command: "sleep 60", cwd: "/other-workspace", shell: "/bin/sh", file: "/other-workspace/output",
      metadata: { sessionID: "ses_other_child" }, time: { started: 1 },
    } } }));
    proof.accept(parseOpenCodeNativeEvent({ id: "evt_execution", created: 1, type: "session.execution.started",
      durable: { aggregateID: "ses_other_child", seq: 1, version: 1 }, data: { sessionID: "ses_other_child" } }));
    proof.discontinuity();
    const work = proof.retentionCut().work;
    expect(work).toEqual([{ id: "permission:per_child", sessionID: "ses_child" }, { id: "form:frm_child", sessionID: "ses_child" },
      { id: "shell:sh_other", sessionID: "ses_other_child" }, { id: "execution:ses_other_child", sessionID: "ses_other_child" }]);
    expect(proof.reconcileRetention(proof.retentionCut(), emptyInventory())).toBe(true);
    expect(proof.retentionCut().work).toEqual(work);
    expect(proof.reconcileRetention(proof.retentionCut(), emptyInventory(["ses_child"]))).toBe(true);
    expect(proof.retentionCut().work).toEqual(work.slice(2)); expect(proof.hasWork).toBe(true);
    expect(proof.reconcileRetention(proof.retentionCut(), emptyInventory(["ses_other_child"]))).toBe(true);
    expect(proof.hasWork).toBe(false); expect(proof.bytes).toBe(1_024);
  });

  it("replaces consumed inbox pins with newly observed root, child and shell activity without granting input authority", () => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    proof.accept(event(1, "session.inbox.enqueued", { inboxID: "msg_known", item: { type: "user", delivery: "queue", payload: { text: "x" } } }));
    proof.discontinuity(); const before = proof.snapshot();
    const work = new Map([["execution:ses_owned", "ses_owned"], ["execution:ses_child", "ses_child"], ["shell:sh_child", "ses_child"]]);
    expect(proof.reconcileRetention(proof.retentionCut(), { ...emptyInventory(), work })).toBe(true);
    expect(proof.retentionCut().pending).toEqual([]); expect(proof.hasWork).toBe(true);
    expect(proof.retentionCut().work).toEqual([...work].map(([id, sessionID]) => ({ id, sessionID })));
    expect(proof.snapshot()).toEqual(before);
    proof.reconcileRetention(proof.retentionCut(), emptyInventory());
    expect(proof.hasWork).toBe(true); expect(proof.retentionCut().work).toHaveLength(2);
    proof.reconcileRetention(proof.retentionCut(), emptyInventory(["ses_child"])); expect(proof.hasWork).toBe(false);
  });

  it("preserves root pending and lost execution when a batch checked only a child", () => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    proof.accept(event(1, "session.inbox.delivered", { inboxID: "msg_active" }));
    proof.accept(event(2, "session.inbox.enqueued", { inboxID: "msg_known", item: { type: "user", delivery: "queue", payload: { text: "x" } } }));
    proof.discontinuity(); const cut = proof.retentionCut();
    expect(proof.reconcileRetention(cut, emptyInventory(["ses_child"]))).toBe(true);
    expect(proof.retentionCut()).toMatchObject({ pending: cut.pending, unknownExecution: true });
    expect(proof.reconcileRetention(proof.retentionCut(), { ...emptyInventory(), work: new Map([["execution:ses_owned", "ses_owned"]]) })).toBe(true);
    expect(proof.retentionCut()).toMatchObject({ pending: [], unknownExecution: true });
    expect(proof.reconcileRetention(proof.retentionCut(), emptyInventory())).toBe(true);
    expect(proof.retentionCut().unknownExecution).toBe(false); expect(proof.hasWork).toBe(false);
  });

  it("never applies a raced cut's positive work or clears collapsed inventory uncertainty", () => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    proof.prepareInput("msg_unknown", 4_096); const cut = proof.retentionCut();
    proof.discontinuity();
    expect(proof.reconcileRetention(cut, { ...emptyInventory(), work: new Map([["execution:ses_child", "ses_child"]]) })).toBe(false);
    expect(proof.retentionCut().work).toEqual([]);
    const beforeTrim = proof.retentionCut(); expect(proof.trim(1_024)).toBe(false);
    expect(proof.reconcileRetention(beforeTrim, emptyInventory())).toBe(false);
    expect(proof.reconcileRetention(proof.retentionCut(), emptyInventory())).toBe(true);
    expect(proof.hasWork).toBe(true);
  });

  it("reconciles only known native markers and keeps null dispatch pins", () => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    proof.prepareInput("msg_unknown", 4_096);
    proof.accept(event(1, "session.inbox.enqueued", { inboxID: "msg_known", item: { type: "user", delivery: "queue", payload: { text: "x" } } }));
    proof.accept(parseOpenCodeNativeEvent({ id: "evt_permission", created: 1, type: "permission.asked",
      data: { sessionID: "ses_owned", id: "per_known", action: "write", resources: [] } }));
    proof.discontinuity();
    expect(proof.reconcileRetention(proof.retentionCut(), emptyInventory())).toBe(true);
    expect(proof.hasWork).toBe(true); expect(proof.retentionCut().pending).toEqual([]); expect(proof.retentionCut().work).toEqual([]);
    expect(proof.currentInputId).toBeNull(); proof.refuseInput("msg_unknown"); expect(proof.hasWork).toBe(false);
  });
  it("rejects a retention cut raced by a new input or a repeated interaction ID", () => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    const permission = parseOpenCodeNativeEvent({ id: "evt_permission", created: 1, type: "permission.asked",
      data: { sessionID: "ses_owned", id: "per_known", action: "write", resources: [] } });
    proof.accept(permission); proof.discontinuity(); const cut = proof.retentionCut();
    proof.accept(permission);
    expect(proof.reconcileRetention(cut, emptyInventory())).toBe(false);
    expect(proof.retentionCut().work).toEqual([{ id: "permission:per_known", sessionID: "ses_owned" }]);
    const next = proof.retentionCut(); proof.prepareInput("msg_new", 4_096);
    expect(proof.reconcileRetention(next, emptyInventory())).toBe(false);
  });
  it("settles execution uncertainty after a native break using positive terminal evidence", () => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    proof.accept(event(1, "session.inbox.delivered", { inboxID: "msg_owned" }));
    proof.accept(event(2, "session.execution.started", {}));
    proof.discontinuity(); expect(proof.hasWork).toBe(true);
    proof.accept(event(3, "session.execution.succeeded", {})); expect(proof.hasWork).toBe(false);
  });
  it("settles an exact queued cancellation after a break without requiring a nonexistent execution", () => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    proof.prepareInput("msg_queued", 4_096); proof.discontinuity();
    expect(proof.hasWork).toBe(true);
    proof.accept(event(1, "session.inbox.cancelled", { inboxID: "msg_queued" })); expect(proof.hasWork).toBe(false);
  });
  it("keeps unknown dispatch pins and collapsed inventories after an unrelated execution ends", () => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    proof.prepareInput("msg_unknown", 4_096); proof.discontinuity();
    proof.accept(event(1, "session.execution.succeeded", {})); expect(proof.hasWork).toBe(true);
    expect(proof.trim(1_024)).toBe(false);
    proof.accept(event(2, "session.execution.succeeded", {})); expect(proof.hasWork).toBe(true);
  });
  it("reclaims only cached density proofs while preserving current and pending input authority", () => {
    const proof = new OpenCodeNativeObservationProof("ses_owned");
    proof.prepareInput("msg_queued", 4_096);
    proof.accept(event(1, "session.inbox.delivered", { inboxID: "msg_owned" }));
    const before = proof.snapshot();
    expect(proof.reclaimCachedProofBytes(4_096)).toBeGreaterThan(0);
    expect(proof.snapshot()).toMatchObject({ nativeFrontier: before.nativeFrontier, authorityEpoch: before.authorityEpoch, currentInputId: "msg_owned", proofs: [] });
    proof.accept(event(2, "session.execution.succeeded", {})); expect(proof.hasWork).toBe(true);
    proof.refuseInput("msg_queued"); expect(proof.hasWork).toBe(false);
  });
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
