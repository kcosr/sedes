import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { directInputRequestSchema, type DirectInputRequest } from "../../src/shared/protocol/thread-input.js";
import { DirectInputRepository } from "../../src/server/db/repositories/direct-input-repository.js";
import { ThreadActivityService } from "../../src/server/conversations/thread-activity-service.js";
import { NotificationLifecycleObserver } from "../../src/server/domain/notification-lifecycle-observer.js";
import type { ThreadInputRuntimeObservation } from "../../src/server/events/thread-runtime-coordinator.js";
import { createInMemoryThreadRuntimeHarness } from "../support/in-memory-thread-runtime-harness.js";

type Harness = Awaited<ReturnType<typeof createInMemoryThreadRuntimeHarness>>;
const request = (text = "Spoken input"): DirectInputRequest => ({
  mutationId: randomUUID(), text, origin: { clientId: randomUUID() }, runningPolicy: { mode: "queue" },
});
async function draft(harness: Harness, initialText = "Keep this composer text") {
  return harness.lifecycle.createServerDraft(harness.scope, {
    workspaceId: harness.workspaceRecord.id, connectionProfileId: harness.connection.id,
    title: "Direct input", initialText,
  });
}
async function settled(harness: Harness, threadId: string) {
  await vi.waitFor(() => expect(harness.runtimes.observeInputRuntime(harness.scope, threadId)?.settled).toBe(true), { timeout: 15_000 });
  await Promise.all(harness.completionFollowUps.splice(0));
}

describe("direct thread input admission", { timeout: 30_000 }, () => {
  it("submits an unopened unbound thread, preserves the draft, and binds principal-wide replay and initiating origin", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    try {
      const first = await draft(h);
      const second = await draft(h);
      const id = first.applicationThreadId;
      const originalDraft = h.inventoryRepository.getDraft(h.scope, id);
      const input = request("Voice content distinct from the composer");
      const receipt = await h.mutations.admitInput(h.scope, id, input);
      expect(receipt).toMatchObject({ mutationId: input.mutationId, threadId: id, admittedMode: "submit", status: "accepted" });
      expect(h.inventoryRepository.getDraft(h.scope, id)).toEqual(originalDraft);
      await settled(h, id);
      const observed = h.runtimes.observeInputRuntime(h.scope, id)!;
      expect(h.mutations.activity.originForTurn(h.scope, id, observed.sourceTurnId!)).toEqual(input.origin);
      expect(h.mutations.inputContext(h.scope, id)).toMatchObject({ authority: "current", automaticListenEligible: true });
      expect(await h.mutations.admitInput(h.scope, id, input)).toEqual(receipt);
      expect(h.mutations.readInputReceipt(h.scope, input.mutationId)).toEqual({ status: "found", receipt });
      for (const changed of [
        { ...input, text: input.text + "!" },
        { ...input, origin: { clientId: randomUUID() } },
        { ...input, runningPolicy: { mode: "steer" as const, target: { kind: "conversation" as const }, onUnavailable: "queue" as const } },
      ]) await expect(h.mutations.admitInput(h.scope, id, changed)).rejects.toMatchObject({ code: "conflict" });
      await expect(h.mutations.admitInput(h.scope, second.applicationThreadId, input)).rejects.toMatchObject({ code: "conflict" });
      const other = { ...h.scope, principalId: randomUUID() };
      expect(h.mutations.readInputReceipt(other, input.mutationId)).toEqual({ status: "notObserved" });
      expect(() => h.mutations.inputContext(other, id)).toThrow();
      await expect(h.mutations.admitInput(other, id, request())).rejects.toThrow();
      expect(h.database.prepare("SELECT COUNT(*) AS count FROM conversation_creation_attempts WHERE mutation_id = ?").get(input.mutationId)).toEqual({ count: 1 });
    } finally { await h.close(); }
  });

  it("rolls first-send preparation back with a failed receipt write and never touches the composer", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    try {
      const created = await draft(h);
      const id = created.applicationThreadId;
      const before = h.inventoryRepository.getDraft(h.scope, id);
      const input = request();
      h.database.exec("CREATE TRIGGER reject_test_input BEFORE INSERT ON direct_input_receipts BEGIN SELECT RAISE(ABORT, 'test_receipt_failure'); END");
      await expect(h.mutations.admitInput(h.scope, id, input)).rejects.toThrow("test_receipt_failure");
      expect(h.bindings.getTarget(h.scope, id).backingState).toBe("unbound");
      expect(h.inventoryRepository.getDraft(h.scope, id)).toEqual(before);
      expect(h.mutations.readInputReceipt(h.scope, input.mutationId)).toEqual({ status: "notObserved" });
      expect(h.database.prepare("SELECT COUNT(*) AS count FROM conversation_creation_attempts WHERE mutation_id = ?").get(input.mutationId)).toEqual({ count: 0 });
      expect(h.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      h.database.exec("DROP TRIGGER reject_test_input");
      await expect(h.mutations.admitInput(h.scope, id, input)).resolves.toMatchObject({ status: "accepted" });
      await settled(h, id);
    } finally { await h.close(); }
  });

  it("rechecks inventory after asynchronous first-send initialization before creating a receipt", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    try {
      const created = await draft(h);
      const id = created.applicationThreadId;
      const read = h.inventoryRepository.getThread.bind(h.inventoryRepository);
      vi.spyOn(h.inventoryRepository, "getThread").mockImplementationOnce((scope, threadId) => {
        const result = read(scope, threadId);
        queueMicrotask(() => h.inventoryRepository.transitionInventory(h.scope, id, {
          mutationId: randomUUID(), expectedRevision: result.inventory.inventoryRevision,
          change: { action: "snooze", snoozedUntil: Date.now() + 60_000 }, now: Date.now(),
        }));
        return result;
      });
      const input = request();
      await expect(h.mutations.admitInput(h.scope, id, input)).rejects.toMatchObject({ code: "invalid_transition" });
      expect(h.mutations.readInputReceipt(h.scope, input.mutationId)).toEqual({ status: "notObserved" });
      expect(h.bindings.getTarget(h.scope, id).backingState).toBe("unbound");
    } finally { vi.restoreAllMocks(); await h.close(); }
  });

  it("resolves frozen queue and exact-turn steer policy against current authority while preserving admission identity", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    const held: (() => void)[] = [];
    try {
      const created = await draft(h);
      const id = created.applicationThreadId;
      vi.spyOn(h.driver, "deliverScriptedAssistantStage").mockImplementation((_text, stage, deliver) => {
        if (stage === "settled") held.push(deliver); else deliver();
      });
      const initial = request("Initial voice turn");
      await h.mutations.admitInput(h.scope, id, initial);
      await vi.waitFor(() => expect(h.mutations.inputContext(h.scope, id).steer.availability).toBe("available"), { timeout: 15_000 });
      const active = h.mutations.inputContext(h.scope, id);
      if (active.steer.availability !== "available") throw new Error("missing_test_steer");
      const emit = vi.fn();
      const notifications = new NotificationLifecycleObserver(h.inventoryRepository, emit);
      const progress = { applicationTurnId: active.sourceTurnId!, applicationItemId: "progress-item",
        backendCorrelations: [initial.mutationId], text: { text: "Working" } };
      notifications.progress(h.scope, id, progress);
      expect(emit).toHaveBeenCalledOnce();
      notifications.progress({ ...h.scope, principalId: randomUUID() }, id, progress);
      notifications.progress(h.scope, id, { ...progress, backendCorrelations: ["provider-only"] });
      expect(emit).toHaveBeenCalledOnce();
      const before = h.inventoryRepository.getDraft(h.scope, id);
      await expect(h.mutations.admitInput(h.scope, id, { ...request(), runningPolicy: { mode: "steer", target: { kind: "conversation" }, onUnavailable: "queue" } })).rejects.toMatchObject({ code: "invalid_transition" });
      vi.spyOn(h.queueDispatcher, "dispatchAdmitted").mockResolvedValue();
      const exact = { ...request("Steer this voice input"), runningPolicy: { mode: "steer" as const, target: active.steer.target, onUnavailable: "queue" as const } };
      await expect(h.mutations.admitInput(h.scope, id, exact)).resolves.toMatchObject({ admittedMode: "steer" });
      const queue = request("Queue this voice input");
      const queued = await h.mutations.admitInput(h.scope, id, queue);
      expect(queued).toMatchObject({ admittedMode: "queue", currentMode: "queue" });
      const stale = { ...request("Stale steer queues"), runningPolicy: { mode: "steer" as const, target: { kind: "turn" as const, turnId: randomUUID() }, onUnavailable: "queue" as const } };
      await expect(h.mutations.admitInput(h.scope, id, stale)).resolves.toMatchObject({ admittedMode: "queue" });
      expect(h.inventoryRepository.getDraft(h.scope, id)).toEqual(before);
      const firstTurn = active.sourceTurnId!;
      expect(h.mutations.activity.originForTurn(h.scope, id, firstTurn)).toEqual(initial.origin);
      expect(h.mutations.inputContext(h.scope, id).automaticListenEligible).toBe(false);
      const receipts = new DirectInputRepository(h.database);
      expect(receipts.lookup(h.scope, queue.mutationId)).toMatchObject({ status: "found", receipt: { queuedInputId: queued.queuedInputId, admittedMode: "queue" } });
      for (const row of h.database.prepare("SELECT id FROM queued_inputs WHERE application_thread_id = ? AND state = 'pending'").all(id) as { id: string }[]) {
        await h.mutations.mutate(h.scope, id, { kind: "cancel_queued_input", queuedInputId: row.id,
          mutationId: randomUUID(), expectedThreadRevision: h.inventoryRepository.getThread(h.scope, id).thread.revision });
      }
      vi.restoreAllMocks();
      for (const release of held.splice(0)) release();
      await settled(h, id);
      notifications.progress(h.scope, id, progress);
      expect(emit).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      for (const release of held) release();
      await h.close();
    }
  });

  it("keeps one terminal activity token through matching settlement, rejects ABA, and ignores metadata edits", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    let activity: ThreadActivityService | undefined;
    try {
      const created = await draft(h);
      const id = created.applicationThreadId;
      await h.mutations.admitInput(h.scope, id, request());
      await settled(h, id);
      let observation: ThreadInputRuntimeObservation | undefined = { ...h.runtimes.observeInputRuntime(h.scope, id)!, runState: "running", settled: false, sourceTurnStatus: "in_progress" };
      activity = new ThreadActivityService({ database: h.database, runtimes: { observeInputRuntime: () => observation, subscribeInputActivity: () => () => undefined } });
      const running = activity.capture(h.scope, id);
      observation = { ...observation, sourceTurnStatus: "completed" };
      const terminal = activity.capture(h.scope, id);
      expect(terminal.activityToken).not.toBe(running.activityToken);
      const context = activity.notificationContext(h.scope, id, observation.sourceTurnId);
      expect(context.settlement).toBeDefined();
      observation = { ...observation, runState: "idle", settled: true };
      expect(activity.capture(h.scope, id)).toMatchObject({ activityToken: terminal.activityToken, automaticListenEligible: true });
      await expect(context.settlement).resolves.toMatchObject({ threadId: id, activityToken: terminal.activityToken });
      h.database.prepare("UPDATE application_threads SET title = ?, revision = revision + 1 WHERE id = ?").run("Metadata only", id);
      expect(activity.capture(h.scope, id).activityToken).toBe(terminal.activityToken);
      observation = { ...observation, runState: "running", settled: false, sourceTurnStatus: "in_progress" };
      const again = activity.capture(h.scope, id);
      expect(again.activityToken).not.toBe(running.activityToken);
      expect(again.activityToken).not.toBe(terminal.activityToken);
      observation = undefined;
      expect(activity.capture(h.scope, id)).toMatchObject({ authority: "unavailable", automaticListenEligible: false });
      const reboot = new ThreadActivityService({ database: h.database, runtimes: { observeInputRuntime: () => observation, subscribeInputActivity: () => () => undefined } });
      expect(reboot.capture(h.scope, id).activityToken).not.toBe(activity.capture(h.scope, id).activityToken);
      reboot.close();
    } finally { activity?.close(); await h.close(); }
  });

  it("enforces text bytes independently of JSON escaping and rejects extra authority fields", () => {
    const valid = request("é".repeat(32_768));
    expect(directInputRequestSchema.safeParse(valid).success).toBe(true);
    expect(directInputRequestSchema.safeParse({ ...valid, text: valid.text + "é" }).success).toBe(false);
    expect(directInputRequestSchema.safeParse({ ...valid, text: " \n\t" }).success).toBe(false);
    expect(directInputRequestSchema.safeParse({ ...valid, principalId: randomUUID() }).success).toBe(false);
  });
});
