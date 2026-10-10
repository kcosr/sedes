import { largeDirectInputText, largeDirectInputWithPrefix } from "../support/large-direct-input.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MAX_DIRECT_INPUT_TEXT_BYTES, directInputRequestSchema, type DirectInputRequest } from "../../src/shared/protocol/thread-input.js";
import { DirectInputRepository } from "../../src/server/db/repositories/direct-input-repository.js";
import { BackendError } from "../../src/server/backends/contracts.js";
import { ThreadActivityService } from "../../src/server/conversations/thread-activity-service.js";
import { ThreadMutationGateway } from "../../src/server/conversations/thread-mutation-gateway.js";
import { ConversationActor } from "../../src/server/conversations/conversation-actor.js";
import { projectApiError } from "../../src/server/http/errors.js";
import { NotificationLifecycleObserver } from "../../src/server/domain/notification-lifecycle-observer.js";
import type { ConversationInputRuntimeObservation } from "../../src/server/conversations/conversation-actor-manager.js";
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
  await vi.waitFor(() => expect(harness.actors.observeInputRuntime(harness.scope, threadId)?.settled).toBe(true), { timeout: 15_000 });
  await Promise.all(harness.completionFollowUps.splice(0));
}

describe("direct thread input admission", { timeout: 30_000 }, () => {
  it("dispatches a bound 256 KiB input through its immutable snapshot and retained receipt", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000, persistDeliveryInputSnapshots: true });
    try {
      const id = (await draft(h)).applicationThreadId;
      await h.mutations.admitInput(h.scope, id, request("Bind before the large recording"));
      await settled(h, id);
      const before = h.inventoryRepository.getDraft(h.scope, id);
      const input = request(largeDirectInputText);
      const admitted = await h.mutations.admitInput(h.scope, id, input);
      await vi.waitFor(() => expect(h.mutations.readInputReceipt(h.scope, input.mutationId)).toMatchObject({
        status: "found", receipt: { status: "accepted" },
      }));
      await settled(h, id);
      expect(admitted.queuedInputId).toBeDefined();
      expect(h.database.prepare("SELECT text FROM queued_inputs WHERE id = ?").get(admitted.queuedInputId!))
        .toEqual({ text: largeDirectInputText });
      expect(h.database.prepare("SELECT original_text AS text FROM delivery_input_snapshots WHERE application_operation_id = ?")
        .get(input.mutationId)).toEqual({ text: largeDirectInputText });
      expect(h.inventoryRepository.getDraft(h.scope, id)).toEqual(before);
      expect(new DirectInputRepository(h.database).lookup(h.scope, input.mutationId))
        .toMatchObject({ status: "found", receipt: { status: "accepted", queuedInputId: admitted.queuedInputId } });
      await expect(h.mutations.admitInput(h.scope, id, input)).resolves.toMatchObject({ status: "accepted" });
    } finally { await h.close(); }
  });

  it.each((["first", "bound"] as const).flatMap(mode => [
    { mode, backendCode: "claude_slash_commands_unavailable", category: "unavailable" as const, prefix: " \n/not-supported " },
    { mode, backendCode: "grok_slash_command_unsupported", category: "rejected" as const, prefix: " \n/rename " },
    { mode, backendCode: "grok_submission_text_invalid", category: "rejected" as const, prefix: "\u0000" },
  ]))("keeps a rejected 256 KiB $mode delivery server-owned for $backendCode", async ({ mode, backendCode, category, prefix }) => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000, persistDeliveryInputSnapshots: true });
    // Native driver tests establish these content restrictions. This shared
    // admission layer must retain ownership regardless of the rejection code.
    const submit = vi.fn(async () => { throw new BackendError({ category, retryable: false,
      crossedSubmissionBoundary: false, backendCode, safeMessage: "Provider rejected this input." }); });
    const attach = h.driver.attach.bind(h.driver);
    let handle: Awaited<ReturnType<typeof attach>> | undefined;
    vi.spyOn(h.driver, "attach").mockImplementation(async input => {
      handle = await attach(input);
      if (mode === "first") vi.spyOn(handle, "submit").mockImplementation(submit);
      return handle;
    });
    try {
      const id = (await draft(h)).applicationThreadId;
      if (mode === "bound") {
        await h.mutations.admitInput(h.scope, id, request("Bind before rejection"));
        await settled(h, id);
        vi.spyOn(handle!, "submit").mockImplementation(submit);
      }
      const before = h.inventoryRepository.getDraft(h.scope, id);
      const input = request(largeDirectInputWithPrefix(prefix));
      expect(directInputRequestSchema.parse(input).text).toBe(input.text);
      const admitted = await h.mutations.admitInput(h.scope, id, input);
      expect(admitted.mutationId).toBe(input.mutationId);
      const status = mode === "first" ? "recovery_required" : "failed";
      await vi.waitFor(() => expect(h.mutations.readInputReceipt(h.scope, input.mutationId)).toMatchObject({
        status: "found", receipt: { status, diagnostic: "Provider rejected this input." },
      }));
      const replayed = await h.mutations.admitInput(h.scope, id, input);
      expect(replayed).toMatchObject({ status, mutationId: input.mutationId, operationId: admitted.operationId });
      expect(new DirectInputRepository(h.database).lookup(h.scope, input.mutationId)).toEqual({ status: "found", receipt: replayed });
      expect(h.inventoryRepository.getDraft(h.scope, id)).toEqual(before);
      expect(submit).toHaveBeenCalledOnce();
      expect(h.database.prepare("SELECT COUNT(*) AS count FROM direct_input_receipts WHERE mutation_id = ?").get(input.mutationId))
        .toEqual({ count: 1 });
    } finally { vi.restoreAllMocks(); await h.close(); }
  });

  it("observes a composer first send without requiring an open thread view", async () => {
    const contexts: ReturnType<ThreadActivityService["notificationContext"]>[] = [];
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000,
      onCompletion: (scope, threadId, turnId) => contexts.push(h.mutations.activity.notificationContext(scope, threadId, turnId)),
    });
    try {
      const created = await draft(h, "First composer input");
      const id = created.applicationThreadId;
      const origin = { clientId: randomUUID() };
      await expect(h.mutations.mutate(h.scope, id, {
        kind: "deliver", mode: "submit", mutationId: randomUUID(), origin,
        expectedThreadRevision: h.inventoryRepository.getThread(h.scope, id).thread.revision,
        expectedDraftRevision: h.inventoryRepository.getDraft(h.scope, id).revision,
      })).resolves.toMatchObject({ status: "delivery_accepted" });
      await settled(h, id);
      const context = await h.mutations.inputContext(h.scope, id);
      expect(context).toMatchObject({
        authority: "current", automaticListenEligible: true,
      });
      await vi.waitFor(() => expect(contexts.length).toBeGreaterThan(0));
      expect(contexts[0]).toMatchObject({ origin, recognitionTarget: {
        threadId: id, activityToken: context.activityToken, sourceTurnId: context.sourceTurnId,
      } });
      if (contexts[0]!.settlement) await expect(contexts[0]!.settlement).resolves.toEqual(contexts[0]!.recognitionTarget);
      expect(h.runtimes.observeRuntimes(h.scope, [id]).has(id)).toBe(false);
    } finally { await h.close(); }
  });

  it("submits an unopened unbound thread, preserves the draft, and binds principal-wide replay and initiating origin", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000, persistDeliveryInputSnapshots: true });
    try {
      const first = await draft(h);
      const second = await draft(h);
      const id = first.applicationThreadId;
      const originalDraft = h.inventoryRepository.getDraft(h.scope, id);
      const input = request(largeDirectInputText);
      const receipt = await h.mutations.admitInput(h.scope, id, input);
      expect(receipt.diagnostic).toBeUndefined();
      expect(receipt).toMatchObject({ mutationId: input.mutationId, threadId: id, admittedMode: "submit", status: "accepted" });
      expect(h.inventoryRepository.getDraft(h.scope, id)).toEqual(originalDraft);
      await settled(h, id);
      const observed = h.actors.observeInputRuntime(h.scope, id)!;
      expect(h.mutations.activity.originForTurn(h.scope, id, observed.sourceTurnId!)).toEqual(input.origin);
      expect(await h.mutations.inputContext(h.scope, id)).toMatchObject({ authority: "current", automaticListenEligible: true });
      expect(await h.mutations.admitInput(h.scope, id, input)).toEqual(receipt);
      expect(h.mutations.readInputReceipt(h.scope, input.mutationId)).toEqual({ status: "found", receipt });
      expect(h.database.prepare("SELECT original_text AS text FROM delivery_input_snapshots WHERE application_operation_id = ?")
        .get(input.mutationId)).toEqual({ text: largeDirectInputText });
      for (const changed of [
        { ...input, text: input.text.replace("Recording", "recording") },
        { ...input, origin: { clientId: randomUUID() } },
        { ...input, runningPolicy: { mode: "steer" as const, target: { kind: "conversation" as const }, onUnavailable: "queue" as const } },
      ]) await expect(h.mutations.admitInput(h.scope, id, changed)).rejects.toMatchObject({ code: "conflict" });
      await expect(h.mutations.admitInput(h.scope, second.applicationThreadId, input)).rejects.toMatchObject({ code: "conflict" });
      const other = { ...h.scope, principalId: randomUUID() };
      expect(h.mutations.readInputReceipt(other, input.mutationId)).toEqual({ status: "notObserved" });
      await expect(h.mutations.inputContext(other, id)).rejects.toThrow();
      await expect(h.mutations.admitInput(other, id, request())).rejects.toThrow();
      expect(h.database.prepare("SELECT COUNT(*) AS count FROM conversation_creation_attempts WHERE mutation_id = ?").get(input.mutationId)).toEqual({ count: 1 });
    } finally { await h.close(); }
  });

  it("keeps readiness reads non-attaching and applies cached settings and current durable policy", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    try {
      const created = await draft(h);
      const id = created.applicationThreadId;
      const acquire = vi.spyOn(h.actors, "acquire");
      const catalog = vi.spyOn(h.driver, "catalog");
      expect(await h.mutations.inputContext(h.scope, id)).toMatchObject({ authority: "unbound", automaticListenEligible: false, manualListenEligible: true });
      expect(acquire).not.toHaveBeenCalled();
      expect(catalog).not.toHaveBeenCalled();
      await h.mutations.admitInput(h.scope, id, request());
      await settled(h, id);
      const presentation = h.mutations.input.presentation;
      const current = await presentation.readCached(h.scope, id);
      const cached = vi.spyOn(presentation, "readCached");
      cached.mockResolvedValueOnce({ ...current, interactionMode: "read_only" });
      expect(await h.mutations.inputContext(h.scope, id)).toMatchObject({ authority: "current", automaticListenEligible: false, manualListenEligible: false });
      cached.mockResolvedValueOnce({ ...current, settingDescriptors: [{
        id: "model", label: { text: "Model" }, requiredForFirstSubmission: true,
        available: true, options: [],
      }] });
      expect(await h.mutations.inputContext(h.scope, id)).toMatchObject({ authority: "current", automaticListenEligible: false, manualListenEligible: false });
      expect(await h.mutations.inputContext(h.scope, id)).toMatchObject({ automaticListenEligible: true, manualListenEligible: true });

      let release!: (value: typeof current) => void;
      cached.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const pending = h.mutations.inputContext(h.scope, id);
      const before = h.inventoryRepository.getThread(h.scope, id);
      h.inventoryRepository.transitionInventory(h.scope, id, {
        mutationId: randomUUID(), expectedRevision: before.inventory.inventoryRevision,
        change: { action: "snooze", snoozedUntil: Date.now() + 60_000 }, now: Date.now(),
      });
      release(current);
      expect(await pending).toMatchObject({ automaticListenEligible: false, manualListenEligible: false });
      acquire.mockClear(); catalog.mockClear();
      expect(await h.mutations.inputContext(h.scope, id)).toMatchObject({ automaticListenEligible: false, manualListenEligible: false });
      expect(acquire).not.toHaveBeenCalled();
      expect(catalog).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); await h.close(); }
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
      const initial = request(largeDirectInputText);
      await h.mutations.admitInput(h.scope, id, initial);
      await vi.waitFor(async () => expect((await h.mutations.inputContext(h.scope, id)).steer.availability).toBe("available"), { timeout: 15_000 });
      const active = await h.mutations.inputContext(h.scope, id);
      expect(active).toMatchObject({ automaticListenEligible: false, manualListenEligible: true });
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
      const exact = { ...request(largeDirectInputText), runningPolicy: { mode: "steer" as const, target: active.steer.target, onUnavailable: "queue" as const } };
      await expect(h.mutations.admitInput(h.scope, id, exact)).resolves.toMatchObject({ admittedMode: "steer" });
      const queue = request(largeDirectInputText);
      const queued = await h.mutations.admitInput(h.scope, id, queue);
      expect(queued).toMatchObject({ admittedMode: "queue", currentMode: "queue" });
      for (const admitted of [exact, queue]) {
        expect(h.database.prepare("SELECT text FROM queued_inputs WHERE mutation_id = ?").get(admitted.mutationId))
          .toEqual({ text: largeDirectInputText });
      }
      const stale = { ...request("Stale steer queues"), runningPolicy: { mode: "steer" as const, target: { kind: "turn" as const, turnId: randomUUID() }, onUnavailable: "queue" as const } };
      await expect(h.mutations.admitInput(h.scope, id, stale)).resolves.toMatchObject({ admittedMode: "queue" });
      expect(h.inventoryRepository.getDraft(h.scope, id)).toEqual(before);
      const firstTurn = active.sourceTurnId!;
      expect(h.mutations.activity.originForTurn(h.scope, id, firstTurn)).toEqual(initial.origin);
      expect((await h.mutations.inputContext(h.scope, id)).automaticListenEligible).toBe(false);
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
      let observation: ConversationInputRuntimeObservation | undefined = { ...h.actors.observeInputRuntime(h.scope, id)!, runState: "running", settled: false, sourceTurnStatus: "in_progress" };
      activity = new ThreadActivityService({ database: h.database, actors: { observeInputRuntime: () => observation,
        isInputRuntimeDormant: () => observation === undefined, subscribeInputActivity: () => () => undefined }, presentation: h.mutations.input.presentation });
      const running = await activity.capture(h.scope, id);
      observation = { ...observation, sourceTurnStatus: "completed" };
      const terminal = await activity.capture(h.scope, id);
      expect(terminal.activityToken).not.toBe(running.activityToken);
      const context = activity.notificationContext(h.scope, id, observation.sourceTurnId);
      expect(context.settlement).toBeDefined();
      observation = { ...observation, runState: "idle", settled: true };
      expect(await activity.capture(h.scope, id)).toMatchObject({ activityToken: terminal.activityToken, automaticListenEligible: true });
      await expect(context.settlement).resolves.toMatchObject({ threadId: id, activityToken: terminal.activityToken });
      h.database.prepare("UPDATE application_threads SET title = ?, revision = revision + 1 WHERE id = ?").run("Metadata only", id);
      expect((await activity.capture(h.scope, id)).activityToken).toBe(terminal.activityToken);
      // An equivalent replacement snapshot under the same owner is not new activity.
      observation = { ...observation, generation: `${observation.ownerGeneration}:replacement-projection` };
      expect(await activity.capture(h.scope, id)).toMatchObject({ activityToken: terminal.activityToken, automaticListenEligible: true });
      const presentation = await h.mutations.input.presentation.readCached(h.scope, id);
      let release!: (value: typeof presentation) => void;
      const cached = vi.spyOn(h.mutations.input.presentation, "readCached")
        .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const inFlight = activity.capture(h.scope, id);
      observation = { ...observation, ownerGeneration: "replacement-owner", generation: "replacement-owner:projection" };
      release(presentation);
      expect(await inFlight).toMatchObject({ authority: "current", automaticListenEligible: false, steer: { availability: "unavailable" } });
      expect(await activity.capture(h.scope, id)).toMatchObject({ automaticListenEligible: true });
      cached.mockRestore();
      observation = { ...observation, runState: "running", settled: false, sourceTurnStatus: "in_progress" };
      const again = await activity.capture(h.scope, id);
      expect(again.activityToken).not.toBe(running.activityToken);
      expect(again.activityToken).not.toBe(terminal.activityToken);
      observation = undefined;
      expect(await activity.capture(h.scope, id)).toMatchObject({ authority: "unavailable", automaticListenEligible: false });
      const reboot = new ThreadActivityService({ database: h.database, actors: { observeInputRuntime: () => observation,
        isInputRuntimeDormant: () => observation === undefined, subscribeInputActivity: () => () => undefined }, presentation: h.mutations.input.presentation });
      expect((await reboot.capture(h.scope, id)).activityToken).not.toBe((await activity.capture(h.scope, id)).activityToken);
      reboot.close();
    } finally { activity?.close(); await h.close(); }
  });

  it("queues a valid Steer behind blocking queue work and reports Steer unavailable meanwhile", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    const held: (() => void)[] = [];
    try {
      const created = await draft(h);
      const id = created.applicationThreadId;
      vi.spyOn(h.driver, "deliverScriptedAssistantStage").mockImplementation((_text, stage, deliver) => {
        if (stage === "settled") held.push(deliver); else deliver();
      });
      await h.mutations.admitInput(h.scope, id, request(largeDirectInputText));
      await vi.waitFor(async () => expect((await h.mutations.inputContext(h.scope, id)).steer.availability).toBe("available"), { timeout: 15_000 });
      const active = await h.mutations.inputContext(h.scope, id);
      if (active.steer.availability !== "available") throw new Error("missing_test_steer");
      const target = active.steer.target;
      vi.spyOn(h.queueDispatcher, "dispatchAdmitted").mockResolvedValue();
      const steer = (text: string): DirectInputRequest => ({ ...request(text), runningPolicy: { mode: "steer", target, onUnavailable: "queue" } });
      const cancelPending = async () => {
        for (const row of h.database.prepare("SELECT id FROM queued_inputs WHERE application_thread_id = ? AND state = 'pending'").all(id) as { id: string }[]) {
          await h.mutations.mutate(h.scope, id, { kind: "cancel_queued_input", queuedInputId: row.id,
            mutationId: randomUUID(), expectedThreadRevision: h.inventoryRepository.getThread(h.scope, id).thread.revision });
        }
      };

      // A pending non-Steer row.
      await expect(h.mutations.admitInput(h.scope, id, request("Queued before the Steer"))).resolves.toMatchObject({ admittedMode: "queue" });
      expect((await h.mutations.inputContext(h.scope, id)).steer).toEqual({ availability: "unavailable" });
      await expect(h.mutations.admitInput(h.scope, id, steer("Steer behind pending input")))
        .resolves.toMatchObject({ admittedMode: "queue", currentMode: "queue", status: "queued" });
      await cancelPending();
      expect((await h.mutations.inputContext(h.scope, id)).steer).toEqual({ availability: "available", target });

      // An unacknowledged failure.
      const failing = await h.mutations.admitInput(h.scope, id, request("This input fails"));
      h.database.prepare("UPDATE queued_inputs SET state = 'failed', resolved_at = ?, diagnostic = ? WHERE id = ?")
        .run(Date.now(), "Test delivery failure.", failing.queuedInputId);
      expect((await h.mutations.inputContext(h.scope, id)).steer).toEqual({ availability: "unavailable" });
      await expect(h.mutations.admitInput(h.scope, id, steer("Steer behind a failure"))).resolves.toMatchObject({ admittedMode: "queue" });
      await cancelPending();
      h.database.prepare("UPDATE queued_inputs SET failure_acknowledged_at = resolved_at WHERE id = ?").run(failing.queuedInputId);
      expect((await h.mutations.inputContext(h.scope, id)).steer).toEqual({ availability: "available", target });
      await expect(h.mutations.admitInput(h.scope, id, steer("Exact steer"))).resolves.toMatchObject({ admittedMode: "steer" });
      await cancelPending();
      vi.restoreAllMocks();
      for (const release of held.splice(0)) release();
      await settled(h, id);
    } finally {
      vi.restoreAllMocks();
      for (const release of held) release();
      await h.close();
    }
  });

  it("fails Steer closed for unbound and submit-only backends while preserving their 256 KiB queue path", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    const held: (() => void)[] = [];
    try {
      const unbound = (await draft(h)).applicationThreadId;
      const turnSteer = (turnId: string): DirectInputRequest => ({ ...request(largeDirectInputText), runningPolicy: { mode: "steer", target: { kind: "turn", turnId }, onUnavailable: "queue" } });
      const attempt = turnSteer(randomUUID());
      await expect(h.mutations.admitInput(h.scope, unbound, attempt)).rejects.toMatchObject({ code: "invalid_transition" });
      expect(h.mutations.readInputReceipt(h.scope, attempt.mutationId)).toEqual({ status: "notObserved" });
      expect(h.bindings.getTarget(h.scope, unbound).backingState).toBe("unbound");

      const capabilities = h.driver.capabilities.bind(h.driver);
      vi.spyOn(h.driver, "capabilities").mockImplementation(revision => ({ ...capabilities(revision), deliveryModes: ["submit"], steerTarget: null }));
      vi.spyOn(h.driver, "deliverScriptedAssistantStage").mockImplementation((_text, stage, deliver) => {
        if (stage === "settled") held.push(deliver); else deliver();
      });
      const id = (await draft(h)).applicationThreadId;
      await h.mutations.admitInput(h.scope, id, request("Start without Steer"));
      await vi.waitFor(async () => expect((await h.mutations.inputContext(h.scope, id)).runState).toBe("running"), { timeout: 15_000 });
      const running = await h.mutations.inputContext(h.scope, id);
      expect(running.steer).toEqual({ availability: "unsupported" });
      const unsupported = turnSteer(running.sourceTurnId!);
      await expect(h.mutations.admitInput(h.scope, id, unsupported)).rejects.toMatchObject({ code: "invalid_transition" });
      expect(h.mutations.readInputReceipt(h.scope, unsupported.mutationId)).toEqual({ status: "notObserved" });
      const queued = request(largeDirectInputText);
      const admitted = await h.mutations.admitInput(h.scope, id, queued);
      expect(admitted).toMatchObject({ status: "queued" });
      expect(h.database.prepare("SELECT text FROM queued_inputs WHERE id = ?").get(admitted.queuedInputId!))
        .toEqual({ text: largeDirectInputText });
      vi.restoreAllMocks();
      for (const release of held.splice(0)) release();
      await settled(h, id);
      await vi.waitFor(() => expect(h.mutations.readInputReceipt(h.scope, queued.mutationId)).toMatchObject({
        status: "found", receipt: { status: "accepted" },
      }));
    } finally {
      vi.restoreAllMocks();
      for (const release of held) release();
      await h.close();
    }
  });

  it("applies first-send readiness and revalidates it when the revision moves before commit", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    try {
      const id = (await draft(h)).applicationThreadId;
      const presentation = h.mutations.input.presentation;
      const current = await presentation.read(h.scope, id);
      const unreadyPresentation: typeof current = { ...current, settingDescriptors: [{
        id: "model", label: { text: "Model" }, requiredForFirstSubmission: true, available: true, options: [],
      }] };
      const read = vi.spyOn(presentation, "read");
      read.mockResolvedValueOnce(unreadyPresentation);
      const unready = request();
      await expect(h.mutations.admitInput(h.scope, id, unready)).rejects.toMatchObject({ code: "invalid_transition" });
      read.mockResolvedValueOnce({ ...current, interactionMode: "read_only" });
      await expect(h.mutations.admitInput(h.scope, id, unready)).rejects.toMatchObject({ code: "invalid_transition" });
      expect(h.mutations.readInputReceipt(h.scope, unready.mutationId)).toEqual({ status: "notObserved" });
      const attempts = () => h.database.prepare("SELECT COUNT(*) AS count FROM conversation_creation_attempts WHERE application_thread_id = ?").get(id);
      expect(attempts()).toEqual({ count: 0 });

      // A settings change lands during the catalog await after readiness passed:
      // the moved revision re-runs readiness, which now rejects.
      const catalog = h.driver.catalog.bind(h.driver);
      const bump = (title: string) => h.database.prepare("UPDATE application_threads SET title = ?, revision = revision + 1 WHERE id = ?").run(title, id);
      read.mockResolvedValueOnce(current).mockResolvedValueOnce(unreadyPresentation);
      vi.spyOn(h.driver, "catalog").mockImplementationOnce(async input => { bump("Settings changed meanwhile"); return catalog(input); });
      const changed = request();
      await expect(h.mutations.admitInput(h.scope, id, changed)).rejects.toMatchObject({ code: "invalid_transition" });
      expect(read).toHaveBeenCalledTimes(4);
      expect(h.mutations.readInputReceipt(h.scope, changed.mutationId)).toEqual({ status: "notObserved" });
      expect(attempts()).toEqual({ count: 0 });
      vi.restoreAllMocks();

      // Persistent churn is bounded and retryable rather than a definitive rejection.
      vi.spyOn(h.driver, "catalog").mockImplementation(async input => { bump("Churning"); return catalog(input); });
      const churned = request();
      await expect(h.mutations.admitInput(h.scope, id, churned)).rejects.toMatchObject({
        code: "runtime_unavailable", retryable: true,
        message: "The thread kept changing while the input was validated. Retry the same input.",
      });
      expect(h.mutations.readInputReceipt(h.scope, churned.mutationId)).toEqual({ status: "notObserved" });
      vi.restoreAllMocks();

      // A rename during slow initialization re-validates and still sends.
      vi.spyOn(h.driver, "catalog").mockImplementationOnce(async input => { bump("Renamed meanwhile"); return catalog(input); });
      await expect(h.mutations.admitInput(h.scope, id, request())).resolves.toMatchObject({ admittedMode: "submit", status: "accepted" });
      expect(h.inventoryRepository.getThread(h.scope, id).thread.title).toBe("Renamed meanwhile");
      vi.restoreAllMocks();
      await settled(h, id);
    } finally { vi.restoreAllMocks(); await h.close(); }
  });

  it("answers transitional admission as retryable 503 and inadmissible states as definitive 400", async () => {
    const completed: string[] = [];
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000,
      onCompletion: (_scope, _threadId, turnId) => { completed.push(turnId); } });
    const outcome = (admission: Promise<unknown>) => admission.then(() => undefined, (error: unknown) => projectApiError(error));
    const transient = { status: 503, body: { error: { code: "runtime_unavailable", retryable: true } } };
    const definitive = { status: 400, body: { error: { code: "invalid_transition", retryable: false } } };
    try {
      const unbound = (await draft(h)).applicationThreadId;
      const steer = (turnId: string): DirectInputRequest => ({ ...request(), runningPolicy: { mode: "steer", target: { kind: "turn", turnId }, onUnavailable: "queue" } });
      expect(await outcome(h.mutations.admitInput(h.scope, unbound, steer(randomUUID())))).toMatchObject(definitive);
      const presentation = h.mutations.input.presentation;
      const current = await presentation.read(h.scope, unbound);
      vi.spyOn(presentation, "read").mockResolvedValueOnce({ ...current, interactionMode: "read_only" });
      expect(await outcome(h.mutations.admitInput(h.scope, unbound, request()))).toMatchObject(definitive);
      vi.restoreAllMocks();

      const snoozed = (await draft(h)).applicationThreadId;
      const inventory = h.inventoryRepository.getThread(h.scope, snoozed);
      h.inventoryRepository.transitionInventory(h.scope, snoozed, { mutationId: randomUUID(), expectedRevision: inventory.inventory.inventoryRevision,
        change: { action: "snooze", snoozedUntil: Date.now() + 60_000 }, now: Date.now() });
      expect(await outcome(h.mutations.admitInput(h.scope, snoozed, request()))).toMatchObject(definitive);

      const creating = (await draft(h)).applicationThreadId;
      h.database.prepare("UPDATE application_threads SET backing_state = 'creating' WHERE id = ?").run(creating);
      expect(await outcome(h.mutations.admitInput(h.scope, creating, request()))).toMatchObject(transient);
      h.database.prepare("UPDATE application_threads SET backing_state = 'creation_unknown' WHERE id = ?").run(creating);
      expect(await outcome(h.mutations.admitInput(h.scope, creating, request()))).toMatchObject(definitive);

      const id = (await draft(h)).applicationThreadId;
      await h.mutations.admitInput(h.scope, id, request("Bind the thread"));
      await settled(h, id);
      // Wrong steering shape for this backend.
      const conversation: DirectInputRequest = { ...request(), runningPolicy: { mode: "steer", target: { kind: "conversation" }, onUnavailable: "queue" } };
      expect(await outcome(h.mutations.admitInput(h.scope, id, conversation))).toMatchObject(definitive);
      // Runtime authority moves between the planning read and the commit.
      const observe = h.actors.observeInputRuntime.bind(h.actors);
      let reads = 0;
      vi.spyOn(h.actors, "observeInputRuntime").mockImplementation((scope, threadId, turnId) => {
        const observed = observe(scope, threadId, turnId);
        return observed && { ...observed, generation: `${observed.ownerGeneration}:moved-${reads++}` };
      });
      const moved = request();
      expect(await outcome(h.mutations.admitInput(h.scope, id, moved))).toMatchObject(transient);
      expect(h.mutations.readInputReceipt(h.scope, moved.mutationId)).toEqual({ status: "notObserved" });
      vi.restoreAllMocks();
      // A starting mutation is awaiting idle while the projected run state is still idle.
      vi.spyOn(ConversationActor.prototype, "authoritativelySettled", "get").mockReturnValue(false);
      expect(await outcome(h.mutations.admitInput(h.scope, id, request()))).toMatchObject(transient);
      vi.restoreAllMocks();
      // The same input retried once the runtime settles is admitted normally.
      const before = completed.length;
      await expect(h.mutations.admitInput(h.scope, id, moved)).resolves.toMatchObject({ admittedMode: "submit" });
      await vi.waitFor(() => expect(completed.length).toBeGreaterThan(before), { timeout: 15_000 });
      await settled(h, id);
    } finally { vi.restoreAllMocks(); await h.close(); }
  });

  it("resumes an interrupted first-send reservation on replay and presents abandoned reservations as failed", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    try {
      const id = (await draft(h)).applicationThreadId;
      const input = request("Interrupted first send");
      // The reservation commits, then the process stops before any provider step.
      vi.spyOn(h.lifecycle, "recoverFirstSend").mockRejectedValueOnce(new Error("simulated_process_loss"));
      await expect(h.mutations.admitInput(h.scope, id, input)).resolves.toMatchObject({ admittedMode: "submit", status: "submitting" });
      expect(h.mutations.readInputReceipt(h.scope, input.mutationId)).toMatchObject({ status: "found", receipt: { status: "submitting" } });
      expect(h.bindings.getTarget(h.scope, id).backingState).not.toBe("bound");
      vi.restoreAllMocks();
      await expect(h.mutations.admitInput(h.scope, id, input)).resolves.toMatchObject({ admittedMode: "submit", status: "accepted" });
      expect(h.bindings.getTarget(h.scope, id).backingState).toBe("bound");
      expect(h.database.prepare("SELECT COUNT(*) AS count FROM conversation_creation_attempts WHERE mutation_id = ?").get(input.mutationId)).toEqual({ count: 1 });
      await settled(h, id);

      const abandonedThread = (await draft(h)).applicationThreadId;
      const abandoned = request("Abandoned first send");
      vi.spyOn(h.lifecycle, "recoverFirstSend").mockRejectedValueOnce(new Error("simulated_process_loss"));
      await h.mutations.admitInput(h.scope, abandonedThread, abandoned);
      vi.restoreAllMocks();
      h.database.prepare(`UPDATE conversation_creation_attempts SET force_reset_at = ?, force_reset_mutation_id = ?,
        diagnostic = 'The user force-reset this unresolved Sedes creation.' WHERE mutation_id = ?`).run(Date.now(), randomUUID(), abandoned.mutationId);
      const resume = vi.spyOn(h.lifecycle, "recoverFirstSend");
      const failed = { status: "failed", diagnostic: "The user force-reset this unresolved Sedes creation." };
      expect(h.mutations.readInputReceipt(h.scope, abandoned.mutationId)).toMatchObject({ status: "found", receipt: failed });
      await expect(h.mutations.admitInput(h.scope, abandonedThread, abandoned)).resolves.toMatchObject(failed);
      expect(resume).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); await h.close(); }
  });

  it("follows explicit queue retries, preserves their origin, and bounds diagnostics to the wire contract", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    const held: (() => void)[] = [];
    try {
      const id = (await draft(h)).applicationThreadId;
      vi.spyOn(h.driver, "deliverScriptedAssistantStage").mockImplementation((_text, stage, deliver) => {
        if (stage === "settled") held.push(deliver); else deliver();
      });
      await h.mutations.admitInput(h.scope, id, request("Running turn"));
      await vi.waitFor(async () => expect((await h.mutations.inputContext(h.scope, id)).runState).toBe("running"), { timeout: 15_000 });
      vi.spyOn(h.queueDispatcher, "dispatchAdmitted").mockResolvedValue();
      const input = request("Queued then retried");
      const queued = await h.mutations.admitInput(h.scope, id, input);
      // Stored diagnostics are bounded in code points; astral text exceeds 500 UTF-16 units.
      const diagnostic = "\u{1F600}".repeat(400);
      h.database.prepare("UPDATE queued_inputs SET state = 'failed', resolved_at = ?, diagnostic = ? WHERE id = ?")
        .run(Date.now(), diagnostic, queued.queuedInputId);
      const failed = h.mutations.readInputReceipt(h.scope, input.mutationId);
      if (failed.status !== "found") throw new Error("missing_test_receipt");
      expect(failed.receipt).toMatchObject({ status: "failed", diagnostic: "\u{1F600}".repeat(250) });
      const retryId = randomUUID();
      const retried = h.queueRepository.retryFailed(h.scope, id, queued.queuedInputId!, { mutationId: retryId, now: Date.now() });
      expect(h.mutations.readInputReceipt(h.scope, input.mutationId)).toEqual({ status: "found", receipt: {
        mutationId: input.mutationId, threadId: id, operationId: input.mutationId, admittedMode: "queue",
        queuedInputId: queued.queuedInputId, currentMode: "queue", status: "queued",
      } });
      expect(h.database.prepare("SELECT client_id AS clientId FROM input_client_origins WHERE operation_id = ?").get(retryId))
        .toEqual({ clientId: input.origin.clientId });
      await h.mutations.mutate(h.scope, id, { kind: "cancel_queued_input", queuedInputId: retried.item.id,
        mutationId: randomUUID(), expectedThreadRevision: h.inventoryRepository.getThread(h.scope, id).thread.revision });
      expect(h.mutations.readInputReceipt(h.scope, input.mutationId)).toMatchObject({ receipt: { status: "cancelled" } });
      vi.restoreAllMocks();
      for (const release of held.splice(0)) release();
      await settled(h, id);
    } finally {
      vi.restoreAllMocks();
      for (const release of held) release();
      await h.close();
    }
  });

  it("keeps the completion target across real replacement snapshots between terminal and idle and before the re-check", async () => {
    const contexts: ReturnType<ThreadActivityService["notificationContext"]>[] = [];
    const completed: string[] = [];
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000,
      onCompletion: (scope, threadId, turnId) => {
        completed.push(turnId);
        contexts.push(h.mutations.activity.notificationContext(scope, threadId, turnId));
      },
    });
    try {
      const id = (await draft(h)).applicationThreadId;
      const emit = h.driver.emit.bind(h.driver);
      let conversation: Parameters<typeof h.driver.emit>[0] | undefined;
      vi.spyOn(h.driver, "emit").mockImplementation((record, event) => {
        conversation = record;
        emit(record, event);
        // A backend that replaces its projection between its terminal bookend and idle.
        if (event.type === "turn_completed") emit(record, { type: "resnapshot_required", reason: "buffer_overflow" });
      });
      await h.mutations.admitInput(h.scope, id, request());
      await settled(h, id);
      await vi.waitFor(() => expect(contexts.length).toBeGreaterThan(0));
      const context = await h.mutations.inputContext(h.scope, id);
      expect(context).toMatchObject({ authority: "current", automaticListenEligible: true });
      for (const completion of contexts) {
        expect(completion.recognitionTarget).toMatchObject({ threadId: id, activityToken: context.activityToken, sourceTurnId: context.sourceTurnId });
        if (completion.settlement) await expect(completion.settlement).resolves.toEqual(completion.recognitionTarget);
      }

      // A replacement snapshot after the notification, held open while native
      // makes its single re-check inside the window.
      const before = h.actors.observeInputRuntime(h.scope, id)!;
      const [handle] = [...conversation!.handles];
      const establish = handle!.establishProjection.bind(handle);
      let release: (() => void) | undefined;
      vi.spyOn(handle!, "establishProjection").mockImplementationOnce(async input => {
        await new Promise<void>(resolve => { release = resolve; });
        return establish(input);
      });
      emit(conversation!, { type: "resnapshot_required", reason: "buffer_overflow" });
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(h.actors.observeInputRuntime(h.scope, id)).toMatchObject({ authoritative: false, reestablishing: true });
      const recheck = h.mutations.inputContext(h.scope, id);
      await new Promise(resolve => setTimeout(resolve, 50));
      release!();
      expect(await recheck).toMatchObject({
        activityToken: context.activityToken, authority: "current", automaticListenEligible: true,
      });
      const after = h.actors.observeInputRuntime(h.scope, id)!;
      expect(after.generation).not.toBe(before.generation);
      expect(after.ownerGeneration).toBe(before.ownerGeneration);
      vi.restoreAllMocks();
      // Newer work still invalidates the old target.
      await h.mutations.admitInput(h.scope, id, request("Next turn"));
      expect((await h.mutations.inputContext(h.scope, id)).activityToken).not.toBe(context.activityToken);
      // The queued submit dispatches after admission returns; wait for its own completion.
      await vi.waitFor(() => expect(completed.some(turnId => turnId !== context.sourceTurnId)).toBe(true), { timeout: 15_000 });
      await settled(h, id);
    } finally { vi.restoreAllMocks(); await h.close(); }
  });

  it("answers as closed when activity authority is first requested after gateway close", async () => {
    const h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    try {
      const id = (await draft(h)).applicationThreadId;
      await h.mutations.admitInput(h.scope, id, request());
      await settled(h, id);
      const subscribe = h.actors.subscribeInputActivity.bind(h.actors);
      const unsubscribe = vi.fn();
      vi.spyOn(h.actors, "subscribeInputActivity").mockImplementation(listener => {
        const off = subscribe(listener);
        unsubscribe.mockImplementation(off);
        return unsubscribe;
      });
      // A second gateway over the same dependencies, closed before its first activity read.
      const gateway = new ThreadMutationGateway(h.mutations.input);
      await gateway.close();
      const turnId = h.actors.observeInputRuntime(h.scope, id)?.sourceTurnId;
      expect(turnId).toBeDefined();
      expect(gateway.activity.notificationContext(h.scope, id, turnId)).not.toHaveProperty("recognitionTarget");
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(await gateway.inputContext(h.scope, id)).toMatchObject({ automaticListenEligible: false });
      expect(await h.mutations.inputContext(h.scope, id)).toMatchObject({ automaticListenEligible: true });
    } finally { vi.restoreAllMocks(); await h.close(); }
  });

  it("enforces text bytes independently of JSON escaping and rejects extra authority fields", () => {
    const valid = request("é".repeat(MAX_DIRECT_INPUT_TEXT_BYTES / 2));
    expect(directInputRequestSchema.safeParse(valid).success).toBe(true);
    expect(directInputRequestSchema.safeParse({ ...valid, text: valid.text + "é" }).success).toBe(false);
    expect(directInputRequestSchema.safeParse({ ...valid, text: " \n\t" }).success).toBe(false);
    expect(directInputRequestSchema.safeParse({ ...valid, principalId: randomUUID() }).success).toBe(false);
  });
});
