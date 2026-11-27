import { captureTurnEarlyReply } from "../../src/server/domain/capture-turn-early-reply.js";
import { earlyReplyFrameSchema } from "../../src/shared/protocol/early-reply.js";
import { UserInputRevisionRepository } from "../../src/server/db/repositories/user-input-revision-repository.js";
import type { ResponseVoiceFreshness } from "../../src/server/conversations/response-voice-freshness.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DatabaseApplicationThreadSummaryReader } from "../../src/server/application/database-application-summary-reader.js";
import type { ConversationActorEvent } from "../../src/server/conversations/conversation-actor.js";
import { NotificationRepository } from "../../src/server/db/repositories/notification-repository.js";
import {
  SubmissionCompletionRepository,
  type SubmissionCompletionObservationRecord,
} from "../../src/server/db/repositories/submission-completion-repository.js";
import { NotificationLifecycleObserver } from "../../src/server/domain/notification-lifecycle-observer.js";
import { NotificationService, type VoiceNotificationPublication } from "../../src/server/domain/notification-service.js";
import { TurnReplySpeechService } from "../../src/server/domain/turn-reply-speech-service.js";
import type { executeNotificationScript } from "../../src/server/runtime/notification-script-executor.js";
import { voiceNotificationSchema } from "../../src/shared/protocol/notification.js";
import { createInMemoryThreadRuntimeHarness } from "../support/in-memory-thread-runtime-harness.js";
import { scriptDelivery } from "../support/notification-settings.js";

const voiceFrames = (frames: readonly string[]) => frames
  .filter((frame) => frame.startsWith("event: notification\n"))
  .map((frame) => voiceNotificationSchema.parse(JSON.parse(frame.split("\n")[1]!.slice("data: ".length))));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(observeNotifications = true) {
  const observations: Array<{
    observation: SubmissionCompletionObservationRecord;
    provenance: "live" | "recovered";
    responseVoice?: ResponseVoiceFreshness;
  }> = [];
  let observer: NotificationLifecycleObserver<Promise<VoiceNotificationPublication | undefined>>;
  let notifications: NotificationService;
  const harness = await createInMemoryThreadRuntimeHarness({
    retentionMilliseconds: 60_000,
    persistDeliveryInputSnapshots: true,
    onParked: (scope, id) => notifications.progressParked(scope, id),
    captureEarlyReply: (scope, threadId, source) => captureTurnEarlyReply(notifications, harness.inventoryRepository,
      completions, new UserInputRevisionRepository(harness.database), harness.mutations.activity, scope, threadId, source),
    onLiveProgress: (scope, threadId, input) => {
      const publication = observer.progress(scope, threadId, input);
      if (input.phase === "provisional") notifications.finishEarlyProgress(scope, threadId, input.applicationTurnId, input.applicationItemId, publication);
    },
    onLiveProgressSkipped: (scope, threadId, turnId, itemId) => notifications.finishEarlyProgress(scope, threadId, turnId, itemId),
    captureResponseVoiceContext: (scope, threadId, correlations) => ({
      ...new UserInputRevisionRepository(harness.database).capture(scope, threadId, correlations),
      subscriberWatermark: notifications.captureSubscriberWatermark(),
    }),
    onObservedCompletion(scope, observation, provenance, subscriberWatermark, responseVoice) {
      observations.push({ observation, provenance, responseVoice });
      if (observeNotifications) {
        const publication = observer.completion(scope, observation, provenance, subscriberWatermark, responseVoice);
        const turnId = observation.applicationTurnId;
        if (publication && turnId) void publication.then(receipt =>
          notifications.finishEarlyReply(scope, observation.applicationThreadId, turnId, receipt));
      }
    },
  });
  const executor = vi.fn<typeof executeNotificationScript>().mockResolvedValue({
    success: true, exitCode: 0, timedOut: false, stdout: "", stderr: "", error: null,
  });
  notifications = new NotificationService({
    repository: new NotificationRepository(harness.database), executor,
  });
  const publications: Promise<VoiceNotificationPublication | undefined>[] = [];
  observer = new NotificationLifecycleObserver(harness.inventoryRepository, (scope, payload, key, provenance, result, _recognitionThreadId, subscriberWatermark, responseVoice) => {
    const publication = notifications.emit(scope, payload, key, provenance, result, () =>
      harness.mutations.activity.notificationContext(scope, payload.thread!.id, payload.turn!.id), subscriberWatermark, responseVoice);
    publications.push(publication);
    return publication;
  });
  notifications.update(harness.scope, {
    enabled: true, scriptPath: "/test/notification-script", arguments: [], timeoutSeconds: 1,
    assistantResultPhases: ["unclassified"], delivery: scriptDelivery(["turn.completed"]), expectedRevision: 0,
  });
  const completions = new SubmissionCompletionRepository(harness.database);
  return {
    harness, notifications, executor, observations, publications, completions,
    enableObservation() { observeNotifications = true; },
    async start() {
      const created = await harness.lifecycle.createServerDraft(harness.scope, {
        workspaceId: harness.workspaceRecord.id, connectionProfileId: harness.connection.id,
        title: "Completion notifications", initialText: "Complete one observed turn",
      });
      const threadId = created.applicationThreadId;
      await expect(harness.mutations.mutate(harness.scope, threadId, {
        kind: "deliver", mode: "submit", mutationId: randomUUID(), origin: { clientId: randomUUID() },
        expectedThreadRevision: harness.inventoryRepository.getThread(harness.scope, threadId).thread.revision,
        expectedDraftRevision: created.draft.revision,
      })).resolves.toMatchObject({ status: "delivery_accepted" });
      return threadId;
    },
    async send() {
      const threadId = await this.start();
      await vi.waitFor(() => {
        expect(observations.length).toBeGreaterThan(0);
        expect(harness.actors.observeInputRuntime(harness.scope, threadId)?.settled).toBe(true);
      }, { timeout: 15_000 });
      await Promise.all(harness.completionFollowUps.splice(0));
      await Promise.all(publications);
      return threadId;
    },
    async close() {
      await notifications.close();
      await harness.close();
    },
  };
}

describe("live completion notification provenance", { timeout: 30_000 }, () => {
  it("delivers ordinary progress once after a restored live stream and suppresses the abandoned item at turn settlement", async () => {
    const current = await fixture();
    const { harness, notifications } = current;
    const { driver, scope } = harness;
    const capabilities = driver.capabilities.bind(driver);
    vi.spyOn(driver, "capabilities").mockImplementation(revision => ({
      ...capabilities(revision), liveSpeechStarts: { final: true, provisional: true },
    }));
    const responses = vi.spyOn(driver, "scheduleScriptedResponse").mockImplementation(() => {});
    const { revision, silenced: _silenced, ...settings } = notifications.read(scope);
    notifications.update(scope, {...settings, expectedRevision: revision, delivery: scriptDelivery(["turn.progress", "turn.completed"])});
    const frames: string[] = [];
    notifications.subscribe(scope, frame => frames.push(frame),
      notifications.reserveVoiceStream(scope, randomUUID(), { enabled: true, revision: 0 }));
    const earlyFrames = () => frames.filter(frame => frame.startsWith("event: voice_early_reply\n"))
      .map(frame => earlyReplyFrameSchema.parse(JSON.parse(frame.split("\n")[1]!.slice("data: ".length))));
    try {
      const threadId = await current.start();
      const runtime = await harness.runtimes.acquire(scope, threadId);
      try {
        const baseline = await runtime.actor.captureSnapshotState();
        expect(baseline.backendCapabilities.liveSpeechStarts.provisional).toBe(true);
        expect(baseline.timeline.runState).toBe("running");
        const [record, turn] = responses.mock.calls[0]!;
        const commentary = (id: string, sourceOrder: number) => ({
          backendTurnId: turn.backendTurnId, backendItemId: id, semanticKind: "assistant_message" as const,
          responsePhase: "provisional" as const, status: "streaming" as const, sourceOrder,
          markdown: { text: "Checking " + id + ". More to come." },
        });
        const first = commentary("recovering", 1), abandoned = commentary("abandoned", 2);
        for (const item of [first, abandoned]) {
          record.snapshot.itemsById[item.backendItemId] = item;
          turn.orderedBackendItemIds.push(item.backendItemId);
          driver.emit(record, { type: "item_started", item, liveSpeechStart: "provisional" });
        }
        const before = await runtime.actor.captureSnapshotState();
        await vi.waitFor(() => expect(earlyFrames()).toMatchObject([{kind: "begin"}, {kind: "begin"}]));
        const [firstId, abandonedId] = earlyFrames().map(frame => frame.replyId);
        const firstItemId = earlyFrames()[0]!.itemId;
        driver.emit(record, { type: "resnapshot_required", reason: "history_changed" });
        const after = await runtime.actor.captureSnapshotState();
        expect(after.timeline.generation).not.toBe(before.timeline.generation);
        expect(after.timeline.itemsById[firstItemId]).toMatchObject({kind: "assistant_message", markdown: first.markdown});
        expect(earlyFrames().filter(frame => frame.kind === "cancel")).toMatchObject([
          {replyId: firstId, reason: "authority_lost"}, {replyId: abandonedId, reason: "authority_lost"},
        ]);
        expect(voiceFrames(frames)).toEqual([]);

        const completed = {...first, status: "completed" as const, markdown: {text: first.markdown.text + " It is ready."}};
        record.snapshot.itemsById[first.backendItemId] = completed;
        for (let i = 0; i < 2; i++) driver.emit(record, {type: "item_completed", item: completed, liveProgress: true});
        await runtime.actor.captureSnapshotState();
        await vi.waitFor(() => expect(voiceFrames(frames)).toMatchObject([{
          sourceEventId: firstId, payload: {event: "turn.progress", progress: {itemId: firstItemId, text: completed.markdown.text}},
        }]));
        expect(current.executor.mock.calls.map(([call]) => call.payload)).toMatchObject([{
          event: "turn.progress", progress: {itemId: firstItemId, text: completed.markdown.text},
        }]);

        const terminal = {...turn, status: "completed" as const, endedBy: "agent_settled" as const};
        record.snapshot.turnsById[turn.backendTurnId] = terminal;
        record.snapshot.runState = "idle";
        delete record.snapshot.activeBackendTurnId;
        driver.emit(record, {type: "turn_completed", turn: terminal});
        driver.emit(record, {type: "run_state_changed", state: "idle"});
        await vi.waitFor(() => expect(earlyFrames().filter(frame => frame.kind === "cancel" && frame.reason === "publication_suppressed"))
          .toMatchObject([{replyId: abandonedId}]));
        expect(voiceFrames(frames).map(frame => frame.payload.event)).toEqual(["turn.progress", "turn.completed"]);
      } finally { runtime.release(); }
    } finally { await current.close(); }
  });

  it("drops progress spanning Park and Unpark, then speaks new progress and an early final", async () => {
    const current = await fixture();
    const { harness, notifications } = current;
    const { driver, scope } = harness;
    const capabilities = driver.capabilities.bind(driver);
    vi.spyOn(driver, "capabilities").mockImplementation(revision => ({
      ...capabilities(revision), liveSpeechStarts: { final: true, provisional: true },
    }));
    const responses = vi.spyOn(driver, "scheduleScriptedResponse").mockImplementation(() => {});
    const { revision, silenced: _silenced, ...settings } = notifications.read(scope);
    notifications.update(scope, { ...settings, expectedRevision: revision, assistantResultPhases: ["final"],
      delivery: scriptDelivery(["turn.progress", "turn.completed"]) });
    const frames: string[] = [];
    notifications.subscribe(scope, frame => frames.push(frame),
      notifications.reserveVoiceStream(scope, randomUUID(), { enabled: true, revision: 0 }));
    const early = () => frames.filter(frame => frame.startsWith("event: voice_early_reply\n"))
      .map(frame => earlyReplyFrameSchema.parse(JSON.parse(frame.split("\n")[1]!.slice("data: ".length))));
    try {
      const id = await current.start();
      const runtime = await harness.runtimes.acquire(scope, id);
      try {
        const [record, turn] = responses.mock.calls[0]!;
        const change = (action: "park" | "unpark") => harness.inventory.transition(scope, id, {
          expectedRevision: harness.inventoryRepository.getInventory(scope, id).inventoryRevision,
          change: { action }, mutationId: randomUUID(),
        });
        const open = (key: string, phase: "final" | "provisional" = "provisional") => {
          const item = { backendTurnId: turn.backendTurnId, backendItemId: key,
            semanticKind: "assistant_message" as const, responsePhase: phase, status: "streaming" as const,
            sourceOrder: turn.orderedBackendItemIds.length, markdown: { text: key + ". More follows." } };
          record.snapshot.itemsById[key] = item;
          turn.orderedBackendItemIds.push(key);
          driver.emit(record, {type: "item_started", item, liveSpeechStart: phase});
          return item;
        };
        const close = (item: ReturnType<typeof open>) => {
          const completed = {...item, status: "completed" as const};
          record.snapshot.itemsById[item.backendItemId] = completed;
          driver.emit(record, {type: "item_completed", item: completed,
            ...(item.responsePhase === "provisional" ? {liveProgress: true as const} : {})});
        };

        const first = open("Already speaking");
        await vi.waitFor(() => expect(early()).toMatchObject([{kind: "begin", progressParkRevision: 0}]));
        await change("park");
        expect(frames.filter(frame => frame.startsWith("event: progress_parked\n"))).toHaveLength(1);
        expect(early().some(frame => frame.kind === "cancel" && frame.replyId === early()[0]!.replyId)).toBe(true);
        const muted = open("Started while parked");
        await runtime.actor.captureSnapshotState();
        await change("unpark");
        close(first);
        close(muted);
        const audible = open("Started after unpark");
        await vi.waitFor(() => expect(early().filter(frame => frame.kind === "begin")).toMatchObject([
          {progressParkRevision: 0}, {progressParkRevision: 1, text: expect.stringContaining("Started after unpark")},
        ]));
        close(audible);
        await vi.waitFor(() => expect(voiceFrames(frames)).toMatchObject([
          {progressParkRevision: 1, payload: {event: "turn.progress", progress: {text: audible.markdown.text}}},
        ]));
        await vi.waitFor(() => expect(current.executor).toHaveBeenCalledTimes(3));

        await change("park");
        const final = open("Finished the review", "final");
        await vi.waitFor(() => expect(early().at(-1)).toMatchObject({kind: "begin", event: "turn.completed"}));
        expect(harness.inventoryRepository.getInventory(scope, id).inventoryState).toBe("parked");
        close(final);
        const terminal = {...turn, status: "completed" as const, endedBy: "agent_settled" as const};
        record.snapshot.turnsById[turn.backendTurnId] = terminal;
        record.snapshot.runState = "idle";
        delete record.snapshot.activeBackendTurnId;
        driver.emit(record, {type: "turn_completed", turn: terminal});
        driver.emit(record, {type: "run_state_changed", state: "idle"});
        await vi.waitFor(() => expect(voiceFrames(frames).map(frame => frame.payload.event)).toEqual(["turn.progress", "turn.completed"]));
        await Promise.all(harness.completionFollowUps.splice(0));
        expect(harness.inventoryRepository.getInventory(scope, id).inventoryState).toBe("active");
        const afterUnpark = await harness.mutations.inputContext(scope, id);
        expect(afterUnpark.automaticListenEligible).toBe(true);
        expect(voiceFrames(frames).at(-1)?.recognitionTarget).toMatchObject({
          threadId: id, sourceTurnId: afterUnpark.sourceTurnId, activityToken: afterUnpark.activityToken,
        });
      } finally { runtime.release(); }
    } finally { await current.close(); }
  });

  it.each(["before submit", "during the turn"] as const)(
    "checks the root submission before speaking a recovered progress item after parking %s", async parkTime => {
      const current = await fixture();
      const { harness, notifications } = current;
      const { driver, scope } = harness;
      try {
        const id = await current.send();
        const frames: string[] = [];
        notifications.subscribe(scope, frame => frames.push(frame),
          notifications.reserveVoiceStream(scope, randomUUID()));
        const responses = vi.spyOn(driver, "scheduleScriptedResponse").mockImplementation(() => {});
        const change = (action: "park" | "unpark") => harness.inventory.transition(scope, id, {
          expectedRevision: harness.inventoryRepository.getInventory(scope, id).inventoryRevision,
          change: { action }, mutationId: randomUUID(),
        });
        if (parkTime === "before submit") {
          await change("park");
          await change("unpark");
        }
        await harness.mutations.admitInput(scope, id, {
          mutationId: randomUUID(), origin: { clientId: randomUUID() }, text: "Check the next change", runningPolicy: { mode: "queue" },
        });
        await vi.waitFor(() => expect(responses).toHaveBeenCalledOnce());
        const runtime = await harness.runtimes.acquire(scope, id);
        try {
          if (parkTime === "during the turn") await change("park");
          const [record, turn] = responses.mock.calls[0]!;
          // The provider snapshot already contains an item whose start Sedes missed.
          const item = { backendTurnId: turn.backendTurnId, backendItemId: "recovered-progress",
            semanticKind: "assistant_message" as const, responsePhase: "provisional" as const, status: "streaming" as const,
            sourceOrder: turn.orderedBackendItemIds.length, markdown: { text: "Reviewing the next change." } };
          record.snapshot.itemsById[item.backendItemId] = item;
          turn.orderedBackendItemIds.push(item.backendItemId);
          if (parkTime === "during the turn") await change("unpark");
          driver.emit(record, {type: "resnapshot_required", reason: "history_changed"});
          const replacement = await runtime.actor.captureSnapshotState();
          expect(Object.values(replacement.timeline.itemsById)).toContainEqual(expect.objectContaining({ markdown: item.markdown }));
          const publicationsBeforeProgress = current.publications.length;
          const completed = {...item, status: "completed" as const};
          record.snapshot.itemsById[item.backendItemId] = completed;
          driver.emit(record, {type: "item_completed", item: completed, liveProgress: true});
          await runtime.actor.captureSnapshotState();
          await vi.waitFor(() => expect(current.publications.length).toBeGreaterThan(publicationsBeforeProgress));
          await Promise.all(current.publications);
          expect(voiceFrames(frames).map(notice => notice.progressParkRevision)).toEqual(parkTime === "before submit" ? [1] : []);
        } finally { runtime.release(); }
      } finally { await current.close(); }
    },
  );

  it.each(["held prompt", "reconciling foreground"] as const)(
    "offers and stores the same park target for a %s",
    async scenario => {
      const current = await fixture(false);
      const { driver, scope, runtimes, actors, threads, inventoryRepository, database } = current.harness;
      const responses = vi.spyOn(driver, "scheduleScriptedResponse").mockImplementation(() => {});
      try {
        const id = await current.start();
        const runtime = await runtimes.acquire(scope, id);
        try {
          const foreground = (await runtime.actor.captureSnapshotState()).timeline.activeTurnId!;
          const [record, turn] = responses.mock.calls[0]!;
          const settled = { ...turn, status: "completed" as const, endedBy: "agent_settled" as const };
          const held = scenario === "held prompt";
          if (held) {
            // The foreground finishes while the provider still holds Send.
            const events: ConversationActorEvent[] = [];
            const unsubscribe = runtime.actor.subscribe(event => events.push(event));
            try {
              record.snapshot.turnsById[turn.backendTurnId] = settled;
              driver.emit(record, { type: "turn_completed", turn: settled });
              await runtime.actor.captureSnapshotState();
              expect(events).toContainEqual(expect.objectContaining({ type: "backend_event",
                event: expect.objectContaining({ type: "capabilities_changed" }) }));
              delete record.snapshot.activeBackendTurnId;
            } finally { unsubscribe(); }
          } else {
            record.snapshot.runState = "reconciling";
          }
          driver.emit(record, { type: "resnapshot_required", reason: "history_changed" });
          await runtime.actor.captureSnapshotState();
          const snapshot = await threads.snapshot(scope, id);
          expect(snapshot.runState).toBe(held ? "running" : "reconciling");
          expect(snapshot.capabilities.operations.find(op => op.id === "park")).toMatchObject({
            available: true, label: { text: held ? "Park" : "Park until done" },
          });
          expect(actors.currentTurnForParking(scope, id)).toBe(held ? undefined : foreground);
          if (!held) expect(actors.observeInputRuntime(scope, id)?.authoritative).toBe(false);
          inventoryRepository.parkThread(scope, id, { expectedRevision: snapshot.thread.inventoryRevision,
            mutationId: randomUUID(), now: Date.now() });
          expect(database.prepare("SELECT parked_until_turn_id AS target FROM thread_principal_state WHERE tenant_id=? AND principal_id=? AND thread_id=?")
            .get(scope.tenantId, scope.principalId, id)).toEqual({ target: held ? null : foreground });
          record.snapshot.turnsById[turn.backendTurnId] = settled;
          record.snapshot.runState = "idle";
          delete record.snapshot.activeBackendTurnId;
          driver.emit(record, { type: "resnapshot_required", reason: "history_changed" });
          await runtime.actor.captureSnapshotState();
          expect(inventoryRepository.getInventory(scope, id).inventoryState).toBe(held ? "parked" : "active");
        } finally { runtime.release(); }
      } finally { await current.close(); }
    },
  );

  it("keeps an agent self-park admitted while the same owner refreshes its running turn", async () => {
    const current = await fixture();
    const { driver, scope, runtimes, actors, inventoryRepository, database } = current.harness;
    const responses = vi.spyOn(driver, "scheduleScriptedResponse").mockImplementation(() => {});
    try {
      const id = await current.start();
      const runtime = await runtimes.acquire(scope, id);
      try {
        const targetId = (await runtime.actor.captureSnapshotState()).timeline.activeTurnId!;
        const [record] = responses.mock.calls[0]!;
        let sourceTurnId: string | undefined;
        const unsubscribe = actors.subscribeInputActivity((eventScope, threadId) => {
          if (threadId === id && actors.observeInputRuntime(eventScope, id)?.reestablishing) {
            sourceTurnId = actors.currentTurnForParking(eventScope, id);
          }
        });
        try {
          driver.emit(record, { type: "resnapshot_required", reason: "history_changed" });
          await runtime.actor.captureSnapshotState();
          expect(sourceTurnId).toBe(targetId);
          inventoryRepository.parkThread(scope, id, { selfParkTurnId: sourceTurnId, mutationId: randomUUID(),
            expectedRevision: inventoryRepository.getInventory(scope, id).inventoryRevision, now: Date.now() });
          expect(database.prepare("SELECT park_keep_on_success AS keep FROM thread_principal_state WHERE tenant_id=? AND principal_id=? AND thread_id=?")
            .get(scope.tenantId, scope.principalId, id)).toEqual({ keep: 1 });
        } finally { unsubscribe(); }
      } finally { runtime.release(); }
    } finally { await current.close(); }
  });

  it.each([
    ["ordinary", "completed"], ["ordinary", "failed"], ["ordinary", "interrupted"],
    ["self", "completed"], ["self", "failed"], ["self", "interrupted"],
  ] as const)(
    "settles a %s park when a replacement snapshot confirms the captured turn %s",
    async (parkedBy, outcome) => {
      const current = await fixture();
      const { harness } = current;
      const { driver, scope, inventoryRepository } = harness;
      const responses = vi.spyOn(driver, "scheduleScriptedResponse").mockImplementation(() => {});
      try {
        const id = await current.start();
        const runtime = await harness.runtimes.acquire(scope, id);
        try {
          const before = await runtime.actor.captureSnapshotState();
          const targetId = before.timeline.activeTurnId!;
          const [record, turn] = responses.mock.calls[0]!;
          const inventory = () => inventoryRepository.getInventory(scope, id);
          const park = () => inventoryRepository.parkThread(scope, id, {
            ...(parkedBy === "self" ? { selfParkTurnId: targetId } : {}),
            mutationId: randomUUID(), expectedRevision: inventory().inventoryRevision, now: Date.now(),
          });
          const parked = park();
          const storedTarget = () => harness.database.prepare(
            "SELECT parked_until_turn_id AS target, progress_park_revision AS revision FROM thread_principal_state WHERE tenant_id=? AND principal_id=? AND thread_id=?",
          ).get(scope.tenantId, scope.principalId, id);
          expect(storedTarget()).toEqual({ target: targetId, revision: 1 });
          expect(inventoryRepository.unparkIfTurnEnded({ ...scope, principalId: randomUUID() }, id, () => "completed", Date.now())).toBeUndefined();

          const oldTurn = { backendTurnId: "older-turn", orderedBackendItemIds: [], status: "completed" as const };
          record.snapshot.orderedBackendTurnIds.unshift(oldTurn.backendTurnId);
          record.snapshot.turnsById[oldTurn.backendTurnId] = oldTurn;
          const replace = async () => {
            driver.emit(record, { type: "resnapshot_required", reason: "history_changed" });
            return runtime.actor.captureSnapshotState();
          };
          const replaced = await replace();
          expect(replaced.timeline.generation).not.toBe(before.timeline.generation);
          expect(replaced.timeline.activeTurnId).toBe(targetId);
          expect(inventory()).toMatchObject({ inventoryState: "parked", inventoryRevision: parked.state.inventoryRevision });

          // A provider-originated turn need not retain an application input
          // correlation. Its confirmed normalized end still fulfills this park.
          const terminal = { ...turn, status: outcome, endedBy: outcome === "completed" ? "agent_settled" as const : outcome };
          delete terminal.completionCorrelations;
          record.snapshot.turnsById[turn.backendTurnId] = terminal;
          record.snapshot.runState = "idle";
          delete record.snapshot.activeBackendTurnId;
          const ended = await replace();
          expect(ended.timeline.turnsById[targetId]?.status).toBe(outcome);
          const keep = parkedBy === "self" && outcome === "completed";
          expect(inventory()).toMatchObject({ inventoryState: keep ? "parked" : "active",
            inventoryRevision: parked.state.inventoryRevision + (keep ? 0 : 1), wokeAt: null });
          expect(storedTarget()).toEqual({ target: null, revision: 1 });
          await Promise.all(harness.completionFollowUps.splice(0));

          if (keep) {
            expect(inventoryRepository.unparkIfTurnEnded(scope, id, () => "failed", Date.now())).toBeUndefined();
            expect(inventory()).toEqual(parked.state);
            inventoryRepository.transitionInventory(scope, id, { expectedRevision: inventory().inventoryRevision,
              mutationId: randomUUID(), change: { action: "unpark" }, now: Date.now() });
          }
          const idlePark = park();
          await replace();
          expect(storedTarget()).toEqual({ target: null, revision: 2 });
          expect(inventory()).toEqual(idlePark.state);
        } finally { runtime.release(); }
      } finally { await current.close(); }
    },
  );

  it("keeps a running thread snoozed when its accepted reply completes and shows unread attention", async () => {
    const current = await fixture();
    const { harness } = current;
    let release: (() => void) | undefined;
    const stages = vi.spyOn(harness.driver, "deliverScriptedAssistantStage").mockImplementation(
      (_text, stage, deliver) => {
        if (stage === "settled") release = deliver;
        else deliver();
      },
    );
    try {
      const threadId = await current.start();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      const before = await harness.threads.snapshot(harness.scope, threadId);
      expect(before.runState).toBe("running");
      expect(before.capabilities.operations.find(({ id }) => id === "snooze")?.available).toBe(true);
      expect(before.capabilities.operations.find(({ id }) => id === "park")).toMatchObject({
        available: true, label: { text: "Park until done" },
      });
      const snoozedAt = Date.now() + 1;
      const snoozedUntil = snoozedAt + 60_000;
      await harness.inventory.transition(harness.scope, threadId, {
        expectedRevision: before.thread.inventoryRevision,
        mutationId: randomUUID(),
        change: { action: "snooze", snoozedUntil, wakeReminderText: "Review the reply" },
      }, snoozedAt);
      const settle = release!;
      release = undefined;
      settle();
      await vi.waitFor(() => expect(current.observations).toHaveLength(1));
      await Promise.all(harness.completionFollowUps.splice(0));
      const { observation } = current.observations[0]!;
      expect(observation.acceptedAt).toBeLessThan(snoozedAt);
      expect(observation).toMatchObject({
        completionOutcome: "completed",
        attentionCreatedAt: expect.any(Number),
        acknowledgedAt: null,
      });
      expect(harness.inventoryRepository.getInventory(harness.scope, threadId)).toMatchObject({
        inventoryState: "snoozed",
        snoozedUntil,
        wokeAt: null,
        wakeReminderText: "Review the reply",
      });
      const summaries = new DatabaseApplicationThreadSummaryReader({
        inventory: harness.inventoryRepository,
        queue: harness.queueRepository,
        completion: current.completions,
      });
      expect(summaries.listByIds(harness.scope, [threadId])).toMatchObject([
        { id: threadId, inventoryState: "snoozed", attention: { unseenCompletion: true, wake: false } },
      ]);
    } finally {
      stages.mockRestore();
      release?.();
      await current.close();
    }
  });

  it("reobserves a newly classified actor reply without changing its frozen completion or blocking follow-ups", async () => {
    const current = await fixture();
    const { harness } = current;
    const emitted = vi.spyOn(harness.driver, "emit");
    const dispatch = vi.spyOn(harness.queueDispatcher, "onAuthoritativeCompletion");
    const recover = vi.spyOn(harness.mutations, "recoverThread");
    const wake = vi.spyOn(harness.inventory, "wakeForRuntimeSignal");
    try {
      const threadId = await current.send();
      const original = current.observations[0]!.observation;
      expect(original.classifiedResult).toEqual({ partial: null, provisional: null, final: null, unclassified: original.assistantResult });
      const record = emitted.mock.calls[0]![0];
      await harness.runtimes.runWithRuntimeRetired(harness.scope, threadId, async () => {
        // Model a newer backend projector reading the same native messages:
        // only classification changes; turn identity and reply text stay fixed.
        for (const item of Object.values(record.snapshot.itemsById)) {
          if (item.semanticKind === "assistant_message") record.snapshot.itemsById[item.backendItemId] = { ...item, responsePhase: "final" };
        }
      });
      dispatch.mockClear(); recover.mockClear(); wake.mockClear();
      const before = current.observations.length;
      const runtime = await harness.runtimes.acquire(harness.scope, threadId);
      try {
        const actorEvents: ConversationActorEvent[] = [];
        const unsubscribe = runtime.actor.subscribe(event => actorEvents.push(event));
        try {
          expect(actorEvents).toContainEqual(expect.objectContaining({ type: "authoritative_completion",
            classifiedResult: { partial: null, provisional: null, final: original.assistantResult, unclassified: null },
          }));
          await vi.waitFor(() => expect(current.observations.length).toBeGreaterThan(before));
          await Promise.all(harness.completionFollowUps.splice(0));
          expect(dispatch.mock.calls[0]![2].classifiedResult).toEqual({ partial: null, provisional: null, final: original.assistantResult, unclassified: null });
          expect(await dispatch.mock.results[0]!.value).toEqual({ changed: false, record: original });
          for (const { observation } of current.observations.slice(before)) expect(observation).toEqual(original);
          expect(current.completions.get(harness.scope, threadId, original.operationId)).toEqual(original);
          expect(recover).toHaveBeenCalledWith(harness.scope, threadId);
          expect(wake).toHaveBeenCalledWith(harness.scope, threadId, {
            kind: "submission_completion",
            acceptedAt: original.acceptedAt,
            completionObservedAt: original.completionObservedAt,
            outcome: "completed",
          });
          expect(current.executor).toHaveBeenCalledOnce();

          const writes = () => (harness.database.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
          const stable = writes();
          const observations = current.observations.length;
          await runtime.actor.replayAuthoritativeCompletions();
          await vi.waitFor(() => expect(current.observations.length).toBeGreaterThan(observations));
          await Promise.all(harness.completionFollowUps.splice(0));
          expect(writes()).toBe(stable);
          expect(current.executor).toHaveBeenCalledOnce();
        } finally { unsubscribe(); }
      } finally { runtime.release(); }
    } finally {
      emitted.mockRestore(); dispatch.mockRestore(); recover.mockRestore(); wake.mockRestore();
      await current.close();
    }
  });

  it("replays several completed turns without more authoritative captures or inventory publications", async () => {
    const current = await fixture();
    const { harness } = current;
    try {
      const threadId = await current.send();
      const runtime = await harness.runtimes.acquire(harness.scope, threadId);
      try {
        for (const text of ["Second accepted input", "Third accepted input"]) {
          const prior = current.observations.length;
          await harness.mutations.admitInput(harness.scope, threadId, {
            mutationId: randomUUID(), origin: { clientId: randomUUID() }, text, runningPolicy: { mode: "queue" },
          });
          await vi.waitFor(() => {
            expect(current.observations.length).toBeGreaterThan(prior);
            expect(harness.actors.observeInputRuntime(harness.scope, threadId)?.settled).toBe(true);
          });
          await Promise.all(harness.completionFollowUps.splice(0));
        }
        const capture = vi.spyOn(runtime.actor, "captureSnapshotState");
        const publish = vi.spyOn(harness.threadSnapshots, "publishMany");
        const before = current.observations.length;
        const writes = () => (harness.database.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
        const initialWrites = writes();
        for (let replay = 0; replay < 10; replay += 1) {
          await runtime.actor.replayAuthoritativeCompletions();
          await Promise.all(harness.completionFollowUps.splice(0));
        }
        expect(current.observations.length - before).toBe(30);
        expect(capture).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(writes()).toBe(initialWrites);
        expect(current.executor).toHaveBeenCalledTimes(3);
      } finally { runtime.release(); }
    } finally { await current.close(); }
  });

  it("keeps the original admission revision when another message arrives during delayed publication", async () => {
    const current = await fixture();
    const { harness, notifications } = current;
    const frames: string[] = [];
    const unsubscribe = notifications.subscribe(harness.scope, frame => frames.push(frame));
    const entered = deferred(), release = deferred();
    let sourceTurnId: string | undefined;
    const original = harness.queueDispatcher.onAuthoritativeCompletion.bind(harness.queueDispatcher);
    const observe = vi.spyOn(harness.queueDispatcher, "onAuthoritativeCompletion").mockImplementationOnce(async (...args) => {
      sourceTurnId = args[2].applicationTurnId;
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    try {
      const threadId = await current.start();
      await entered.promise;
      const before = await harness.mutations.inputContext(harness.scope, threadId);
      expect(before.userInputRevision).toBe(1);
      await harness.mutations.admitInput(harness.scope, threadId, {
        mutationId: randomUUID(), origin: { clientId: randomUUID() }, text: "A later typed or recognized message", runningPolicy: { mode: "queue" },
      });
      expect((await harness.mutations.inputContext(harness.scope, threadId)).userInputRevision).toBe(2);
      await vi.waitFor(() => expect(harness.actors.observeInputRuntime(harness.scope, threadId)?.sourceTurnId).not.toBe(sourceTurnId));
      release.resolve();
      await vi.waitFor(() => expect(voiceFrames(frames).some(frame => frame.payload.turn?.id === sourceTurnId)).toBe(true));
      const source = voiceFrames(frames).find(frame => frame.payload.turn?.id === sourceTurnId)!;
      expect(source.userInputRevision).toBe(1);
      expect(source).not.toHaveProperty("recognitionTarget");
      expect(current.observations.find(item => item.observation.applicationTurnId === sourceTurnId)?.responseVoice)
        .toEqual({ userInputRevision: 1, superseded: false });
      await vi.waitFor(() => expect(current.executor.mock.calls.filter(call => call[0].payload.turn?.id === sourceTurnId)).toHaveLength(1));
      await vi.waitFor(() => expect(harness.actors.observeInputRuntime(harness.scope, threadId)?.settled).toBe(true));
      await Promise.all(harness.completionFollowUps.splice(0));
    } finally {
      release.resolve(); observe.mockRestore(); unsubscribe(); await current.close();
    }
  });

  it("suppresses an answer overtaken by a pending human follow-up while preserving its script", async () => {
    const current = await fixture();
    const { harness, notifications } = current;
    const frames: string[] = [];
    const unsubscribe = notifications.subscribe(harness.scope, frame => frames.push(frame));
    const held: (() => void)[] = [];
    const stages = vi.spyOn(harness.driver, "deliverScriptedAssistantStage").mockImplementation((text, stage, deliver) => {
      if (text === "Complete one observed turn" && stage === "settled") held.push(deliver); else deliver();
    });
    try {
      const threadId = await current.start();
      await vi.waitFor(() => expect(held).toHaveLength(1));
      const sourceTurnId = harness.actors.observeInputRuntime(harness.scope, threadId)!.sourceTurnId;
      const followUp = await harness.mutations.admitInput(harness.scope, threadId, {
        mutationId: randomUUID(), origin: { clientId: randomUUID() }, text: "Follow-up already sent", runningPolicy: { mode: "queue" },
      });
      expect(followUp.status).toBe("queued");
      expect(harness.database.prepare("SELECT state FROM queued_inputs WHERE id = ?").get(followUp.queuedInputId!))
        .toEqual({ state: "pending" });
      const before = await harness.mutations.inputContext(harness.scope, threadId);
      expect(before.userInputRevision).toBe(2);
      held.shift()!();
      await vi.waitFor(() => expect(current.observations.some(item => item.observation.applicationTurnId === sourceTurnId)).toBe(true));
      await Promise.all(current.publications);
      expect(current.observations.find(item => item.observation.applicationTurnId === sourceTurnId)?.responseVoice)
        .toEqual({ userInputRevision: 2, superseded: true });
      expect(voiceFrames(frames).filter(frame => frame.payload.turn?.id === sourceTurnId)).toEqual([]);
      await vi.waitFor(() => expect(current.executor.mock.calls.filter(call => call[0].payload.turn?.id === sourceTurnId)).toHaveLength(1));
      await vi.waitFor(() => expect(harness.actors.observeInputRuntime(harness.scope, threadId)?.settled).toBe(true));
      await Promise.all(harness.completionFollowUps.splice(0));
    } finally {
      stages.mockRestore(); for (const release of held) release(); unsubscribe(); await current.close();
    }
  });

  it("excludes streams joining while the durable completion observer is delayed", async () => {
    const current = await fixture();
    const { harness, notifications } = current;
    const before: string[] = [], after: string[] = [];
    const disconnectBefore = notifications.subscribe(harness.scope, frame => before.push(frame));
    let disconnectAfter = () => {};
    const entered = deferred();
    const release = deferred();
    const original = harness.queueDispatcher.onAuthoritativeCompletion.bind(harness.queueDispatcher);
    const observe = vi.spyOn(harness.queueDispatcher, "onAuthoritativeCompletion").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    try {
      const sending = current.send();
      await entered.promise;
      disconnectAfter = notifications.subscribe(harness.scope, frame => after.push(frame));
      release.resolve();
      await sending;
      expect(voiceFrames(before)).toHaveLength(1);
      expect(voiceFrames(after)).toEqual([]);
      await vi.waitFor(() => expect(current.executor).toHaveBeenCalledOnce());
    } finally {
      release.resolve();
      observe.mockRestore();
      disconnectBefore(); disconnectAfter();
      await current.close();
    }
  });

  it("reuses the first live audience when an unconsumed completion is published again", async () => {
    const current = await fixture(false);
    const { harness, notifications, observations, publications } = current;
    const before: string[] = [], after: string[] = [];
    const disconnectBefore = notifications.subscribe(harness.scope, frame => before.push(frame));
    let disconnectAfter = () => {};
    try {
      const threadId = await current.send();
      expect(voiceFrames(before)).toEqual([]);
      disconnectAfter = notifications.subscribe(harness.scope, frame => after.push(frame));
      current.enableObservation();
      const runtime = await harness.runtimes.acquire(harness.scope, threadId);
      try {
        const previous = observations.length;
        await runtime.actor.replayAuthoritativeCompletions();
        await vi.waitFor(() => expect(observations.length).toBeGreaterThan(previous));
        await Promise.all(publications);
        expect(voiceFrames(before)).toHaveLength(1);
        expect(voiceFrames(after)).toEqual([]);
        await vi.waitFor(() => expect(current.executor).toHaveBeenCalledOnce());
      } finally { runtime.release(); }
    } finally {
      disconnectBefore(); disconnectAfter();
      await current.close();
    }
  });

  it("speaks and scripts a live completion once without replaying it to reopened subscribers", async () => {
    const current = await fixture();
    const { harness, notifications, observations, executor, publications } = current;
    const frames: string[] = [];
    const unsubscribe = notifications.subscribe(harness.scope, (frame) => frames.push(frame));
    try {
      const threadId = await current.send();
      await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce());
      expect(voiceFrames(frames)).toHaveLength(1);
      expect(observations.every(({ provenance }) => provenance === "live")).toBe(true);
      const observed = observations[0]!.observation;
      expect(current.completions.get(harness.scope, threadId, observed.operationId)).toMatchObject({
        completionOutcome: "completed", applicationTurnId: observed.applicationTurnId,
        assistantResult: { text: expect.stringContaining("Complete one observed turn") },
      });
      expect(executor.mock.calls[0]?.[0].payload).toMatchObject({
        event: "turn.completed", turn: { id: observed.applicationTurnId },
        assistantResult: { unclassified: observed.assistantResult },
      });
      expect(voiceFrames(frames)[0]).toMatchObject({
        voice: "speakThenListen", payload: { event: "turn.completed", thread: { id: threadId } },
        recognitionTarget: { threadId, sourceTurnId: observed.applicationTurnId },
      });

      unsubscribe();
      const reconnected: string[] = [];
      const disconnect = notifications.subscribe(harness.scope, (frame) => reconnected.push(frame));
      const runtime = await harness.runtimes.acquire(harness.scope, threadId);
      try {
        const reopened: ConversationActorEvent[] = [];
        const stopObserving = runtime.actor.subscribe((event) => reopened.push(event));
        expect(reopened).toContainEqual(expect.objectContaining({ type: "authoritative_completion", provenance: "live" }));
        const previousObservations = observations.length;
        await runtime.actor.replayAuthoritativeCompletions();
        await vi.waitFor(() => expect(observations.length).toBeGreaterThan(previousObservations));
        await Promise.all(publications);
        expect(reconnected).toHaveLength(1);
        expect(reconnected[0]).toContain("event: notification_policy\n");
        expect(voiceFrames(frames)).toHaveLength(1);
        expect(executor).toHaveBeenCalledOnce();
        stopObserving();
      } finally {
        runtime.release();
        disconnect();
      }
    } finally {
      unsubscribe();
      await current.close();
    }
  });

  it("commits and scripts an unconsumed recovered completion without voice, retaining explicit reply playback", async () => {
    const current = await fixture(false);
    const { harness, notifications, observations, executor, publications } = current;
    try {
      const threadId = await current.send();
      const original = observations[0]!.observation;
      expect(executor).not.toHaveBeenCalled();
      // Restore the crash boundary: acceptance committed, native history ended,
      // but the server has neither observed nor consumed the completion.
      await harness.runtimes.runWithRuntimeRetired(harness.scope, threadId, async () => {
        harness.database.transaction(() => {
          harness.database.prepare(`DELETE FROM submission_completion_observations
            WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ? AND operation_id = ?`)
            .run(harness.scope.tenantId, harness.scope.principalId, threadId, original.operationId);
          current.completions.recordAccepted(harness.scope, threadId, {
            operationId: original.operationId, acceptedAt: original.acceptedAt,
            ...(original.backendCorrelation ? { backendCorrelation: original.backendCorrelation } : {}),
          });
        })();
      });
      expect(current.completions.get(harness.scope, threadId, original.operationId).assistantResult).toBeNull();
      expect(harness.database.prepare("SELECT count(*) AS count FROM notification_event_consumption").get()).toEqual({ count: 0 });
      observations.length = 0;
      current.enableObservation();
      const frames: string[] = [];
      const disconnect = notifications.subscribe(harness.scope, (frame) => frames.push(frame));
      const runtime = await harness.runtimes.acquire(harness.scope, threadId);
      try {
        await vi.waitFor(() => expect(executor).toHaveBeenCalledOnce());
        await Promise.all(publications);
        expect(observations.length).toBeGreaterThan(0);
        expect(observations.every(({ provenance }) => provenance === "recovered")).toBe(true);
        expect(current.completions.get(harness.scope, threadId, original.operationId)).toMatchObject({
          applicationTurnId: original.applicationTurnId, completionOutcome: "completed",
          completionObservedAt: expect.any(Number), assistantResult: original.assistantResult,
        });
        expect(executor.mock.calls[0]?.[0].payload).toMatchObject({
          event: "turn.completed", turn: { id: original.applicationTurnId },
          assistantResult: { unclassified: original.assistantResult },
        });
        expect(voiceFrames(frames)).toEqual([]);
        expect(harness.database.prepare("SELECT count(*) AS count FROM notification_event_consumption").get()).toEqual({ count: 1 });
        const previousObservations = observations.length;
        await runtime.actor.replayAuthoritativeCompletions();
        await vi.waitFor(() => expect(observations.length).toBeGreaterThan(previousObservations));
        await Promise.all(publications);
        expect(executor).toHaveBeenCalledOnce();
        expect(voiceFrames(frames)).toEqual([]);

        const replies = new TurnReplySpeechService({
          inventory: harness.inventoryRepository, completions: current.completions, notifications,
        });
        expect(replies.latestReplyTurnId(harness.scope, threadId)).toBe(original.applicationTurnId);
        expect(replies.read(harness.scope, threadId, original.applicationTurnId!)).toEqual({
          assistantResult: { unclassified: original.assistantResult },
        });
        expect(executor).toHaveBeenCalledOnce();
        expect(voiceFrames(frames)).toEqual([]);
      } finally {
        runtime.release();
        disconnect();
      }
    } finally {
      await current.close();
    }
  });
});
