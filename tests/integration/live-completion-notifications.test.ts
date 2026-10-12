import { UserInputRevisionRepository } from "../../src/server/db/repositories/user-input-revision-repository.js";
import type { ResponseVoiceFreshness } from "../../src/server/conversations/response-voice-freshness.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
  let observer: NotificationLifecycleObserver | undefined;
  let notifications: NotificationService;
  const harness = await createInMemoryThreadRuntimeHarness({
    retentionMilliseconds: 60_000,
    captureResponseVoiceContext: (scope, threadId, correlations) => ({
      ...new UserInputRevisionRepository(harness.database).capture(scope, threadId, correlations),
      subscriberWatermark: notifications.captureSubscriberWatermark(),
    }),
    onObservedCompletion(scope, observation, provenance, subscriberWatermark, responseVoice) {
      observations.push({ observation, provenance, responseVoice });
      if (observeNotifications) observer?.completion(scope, observation, provenance, subscriberWatermark, responseVoice);
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
    publications.push(notifications.emit(scope, payload, key, provenance, result, () =>
      harness.mutations.activity.notificationContext(scope, payload.thread!.id, payload.turn!.id), subscriberWatermark, responseVoice));
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
