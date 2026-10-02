import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NormalizedThreadStore } from "../../src/client/stores/NormalizedThreadStore.js";
import type {
  NormalizedThreadEvent,
  ThreadEventEnvelope,
} from "../../src/shared/protocol/conversation.js";
import { createInMemoryThreadRuntimeHarness } from "../support/in-memory-thread-runtime-harness.js";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("in-memory canonical thread stream", () => {
  it("streams one bound send from a current checkpoint as an exact replayable incremental suffix", async () => {
    const harness = await createInMemoryThreadRuntimeHarness();
    const {
      scope,
      workspaceRecord,
      connection,
      driver,
      usage,
      inventoryRepository,
      queueRepository,
      lifecycle,
      runtimes,
      threadSnapshots,
      inventory,
      mutations,
      applicationRunStates,
      completionFollowUps,
    } = harness;

    try {
      const controller = await lifecycle.createServerDraft(scope, {
        workspaceId: workspaceRecord.id,
        connectionProfileId: connection.id,
        title: "Agent controller",
        initialText: "",
      });
      const agentCreated = await lifecycle.createServerDraft(scope, {
        workspaceId: workspaceRecord.id,
        connectionProfileId: connection.id,
        title: "Agent-created background thread",
        initialText: "",
      });

      // No thread hub or browser SSE subscriber is attached here. The direct
      // first-send gateway must still establish runtime observation so the
      // application-wide sidebar projection sees both active and settled run
      // states for the newly bound thread.
      await expect(
        mutations.sendDirect(scope, {
          initiator: {
            kind: "thread_agent",
            sourceThreadId: controller.applicationThreadId,
            sourceWorkspaceId: workspaceRecord.id,
          },
          targetThreadId: agentCreated.applicationThreadId,
          message: "Work without being opened in the browser.",
          mutationId: randomUUID(),
        }),
      ).resolves.toMatchObject({ status: "delivery_accepted" });
      await vi.waitFor(
        () =>
          expect(
            applicationRunStates.get(agentCreated.applicationThreadId),
          ).toContain("running"),
        { timeout: 15_000 },
      );
      await vi.waitFor(
        () =>
          expect(
            applicationRunStates.get(agentCreated.applicationThreadId),
          ).toContain("idle"),
        { timeout: 15_000 },
      );

      const backgroundUsage = usage.read(scope, agentCreated.applicationThreadId);
      expect(backgroundUsage.summary.reasons).not.toContain("capture_failed");
      expect(backgroundUsage.state).toBe("complete");
      expect(backgroundUsage.summary.metrics.input.value).toBe("11");
      expect(backgroundUsage.summary.metrics.output.value).toBe("7");

      const created = await lifecycle.createServerDraft(scope, {
        workspaceId: workspaceRecord.id,
        connectionProfileId: connection.id,
        title: "Send lifecycle",
        initialText: "hello first turn",
      });
      const threadId = created.applicationThreadId;

      // Subscribe like a browser SSE attach before any send so every hub
      // frame of both send lifecycles is observed.
      const hubHandle = runtimes.quiet(scope, threadId);
      const envelopes: ThreadEventEnvelope[] = [];
      const subscription = hubHandle.hub.subscribe((envelope) => {
        envelopes.push(envelope);
      });
      await threadSnapshots.publishAuthoritativeReplacement(scope, threadId);
      const eventsOf = (frames: readonly ThreadEventEnvelope[]) =>
        frames.map(({ event }) => event as NormalizedThreadEvent);

      try {
        const backendEmit = vi.spyOn(driver, "emit");
        const boundThread = inventoryRepository.getThread(scope, threadId);
        const first = await mutations.mutate(scope, threadId, {
          kind: "deliver",
          mode: "submit",
          mutationId: randomUUID(),
          expectedThreadRevision: boundThread.thread.revision,
          expectedDraftRevision: created.draft.revision,
        });
        expect(first.status).toBe("delivery_accepted");
        await vi.waitFor(
          () => {
            const events = eventsOf(envelopes);
            expect(
              events.some(
                (event) =>
                  event.type === "turn_upsert" &&
                  event.turn.status === "completed",
              ),
            ).toBe(true);
            expect(events.at(-1)).toBeDefined();
            expect(
              events.some(
                (event) => event.type === "run_state" && event.state === "idle",
              ),
            ).toBe(true);
          },
          { timeout: 15_000 },
        );
        await Promise.all(completionFollowUps.splice(0));
        await sleep(200);

        const firstPhase = eventsOf(envelopes);
        // First send is the load-bearing unbound-to-bound boundary: it retires
        // the quiet application generation and publishes the bound runtime's
        // one imported projection baseline.
        const firstSnapshots = firstPhase.filter(
          ({ type }) => type === "snapshot",
        );
        expect(firstSnapshots).toHaveLength(2);
        expect(
          new Set(firstSnapshots.map(({ generation }) => generation)).size,
        ).toBe(firstSnapshots.length);
        const firstGeneration = firstSnapshots.at(-1)!.generation;

        // The browser attached while the thread was still unbound. That same
        // open subscription must pin the newly established backend observer
        // after the idle threshold, including events initiated outside Sedes.
        const externalStart = envelopes.length;
        const backendRecord = backendEmit.mock.calls[0]![0];
        driver.emit(backendRecord, {
          type: "notice",
          notice: {
            id: "external-after-idle",
            tone: "info",
            message: { text: "External backend event after idle" },
            createdAt: new Date().toISOString(),
          },
        });
        await vi.waitFor(() => {
          expect(
            eventsOf(envelopes.slice(externalStart)).some(
              (event) =>
                event.type === "notice" &&
                event.notice.id === "external-after-idle",
            ),
          ).toBe(true);
        });

        // Borrowing the already-pinned runtime must not establish another
        // generation or publish another baseline.
        const boundRuntime = await runtimes.acquire(scope, threadId);
        const canonicalFrames: ThreadEventEnvelope[] = [];
        const liveListener = vi.fn((envelope: ThreadEventEnvelope) => {
          canonicalFrames.push(envelope);
        });
        const canonicalSubscription =
          hubHandle.hub.subscribeFromCurrentSnapshot(liveListener);
        const checkpoint = canonicalSubscription.checkpoint!;
        expect(checkpoint.projectionGeneration).toBe(
          firstGeneration,
        );
        expect(checkpoint.snapshot).toEqual(hubHandle.hub.snapshot);
        expect(canonicalSubscription.replay).toEqual([]);
        const anchorLength = canonicalFrames.length;
        expect(
          canonicalFrames.filter(({ event }) => event.type === "snapshot"),
        ).toHaveLength(0);
        const draftBefore = inventoryRepository.getDraft(scope, threadId);
        const savedDraft = inventoryRepository.saveDraft(scope, threadId, {
          text: "second turn over the queue",
          contextExcerpts: [],
          taskReferenceIds: [],
          attachmentIds: [],
          expectedRevision: draftBefore.revision,
          now: Date.now(),
        });
        const threadBefore = inventoryRepository.getThread(scope, threadId);
        const secondPhaseStart = envelopes.length;
        const second = await mutations.mutate(scope, threadId, {
          kind: "deliver",
          mode: "submit",
          mutationId: randomUUID(),
          expectedThreadRevision: threadBefore.thread.revision,
          expectedDraftRevision: savedDraft.revision,
        });
        expect(second.status).toBe("delivery_queued");

        await vi.waitFor(
          () => {
            const events = eventsOf(envelopes.slice(secondPhaseStart));
            expect(
              events.filter(
                (event) =>
                  event.type === "turn_upsert" &&
                  event.turn.status === "completed",
              ).length,
            ).toBeGreaterThanOrEqual(1);
            expect(
              events.some(
                (event) => event.type === "run_state" && event.state === "idle",
              ),
            ).toBe(true);
          },
          { timeout: 15_000 },
        );
        await Promise.all(completionFollowUps.splice(0));
        await sleep(300);
        expect(queueRepository.list(scope, threadId)).toEqual(
          expect.arrayContaining([]),
        );

        const secondPhase = eventsOf(envelopes.slice(secondPhaseStart));
        const observedTypes = new Set(secondPhase.map(({ type }) => type));
        expect(observedTypes.has("queue_changed")).toBe(true);
        expect(observedTypes.has("run_state")).toBe(true);
        expect(observedTypes.has("turn_upsert")).toBe(true);
        expect(observedTypes.has("item_upsert")).toBe(true);
        expect(observedTypes.has("capabilities_changed")).toBe(true);
        // The checkpoint is the only transcript replacement. Queue/application
        // overlays and the complete backend lifecycle remain incremental.
        expect(
          canonicalFrames.filter(({ event }) => event.type === "snapshot"),
        ).toHaveLength(0);
        expect(
          canonicalFrames
            .slice(anchorLength)
            .some(({ event }) =>
              event.type === "item_upsert" && event.item.kind === "user_message"
                ? event.item.content.some(
                    (part) =>
                      part.kind === "text" &&
                      part.text.text === "second turn over the queue",
                  )
                : false,
            ),
        ).toBe(true);
        expect(
          backendEmit.mock.calls.some(
            ([, event]) =>
              event.type === "item_completed" &&
              event.item.semanticKind === "user_message" &&
              event.item.content.some(
                (part) =>
                  part.kind === "text" &&
                  part.text.text === "second turn over the queue",
              ),
          ),
        ).toBe(true);
        const backendUserCall = backendEmit.mock.calls.findIndex(
          ([, event]) =>
            event.type === "item_completed" &&
            event.item.semanticKind === "user_message" &&
            event.item.content.some(
              (part) =>
                part.kind === "text" &&
                part.text.text === "second turn over the queue",
            ),
        );
        const normalizedUserCall = liveListener.mock.calls.findIndex(
          ([{ event }]) =>
            event.type === "item_upsert" &&
            event.item.kind === "user_message" &&
            event.item.content.some(
              (part) =>
                part.kind === "text" &&
                part.text.text === "second turn over the queue",
            ),
        );
        expect(backendUserCall).toBeGreaterThanOrEqual(0);
        expect(normalizedUserCall).toBeGreaterThanOrEqual(0);
        expect(
          backendEmit.mock.invocationCallOrder[backendUserCall],
        ).toBeLessThan(
          liveListener.mock.invocationCallOrder[normalizedUserCall]!,
        );

        const incrementalItems = canonicalFrames
          .slice(anchorLength)
          .filter(({ event }) => event.type === "item_upsert")
          .map(({ event }) =>
            event.type === "item_upsert" ? event.item : undefined,
          )
          .filter((item) => item !== undefined);
        expect(incrementalItems.some(({ kind }) => kind === "tool")).toBe(true);
        expect(
          incrementalItems.some(({ kind }) => kind === "assistant_message"),
        ).toBe(true);

        // Every envelope applies to the real browser store without repair.
        const browserStore = new NormalizedThreadStore();
        expect(browserStore.applyCheckpoint(checkpoint).kind).toBe("applied");
        for (const envelope of canonicalFrames) {
          const result = browserStore.apply(envelope);
          expect(
            result.kind,
            `browser store rejected ${envelope.event.type}: ${JSON.stringify(result)}`,
          ).not.toBe("resnapshot_required");
        }
        browserStore.confirmReplayCaughtUp();
        expect(browserStore.state.authoritative).toBe(true);

        const finalSnapshot = browserStore.state.snapshot!;
        const finalTurn =
          finalSnapshot.turnsById[finalSnapshot.orderedTurnIds.at(-1)!]!;
        const finalUsage = usage.read(scope, threadId, finalTurn.id);
        expect(finalUsage).toMatchObject({state:"complete",turnState:"completed",measurementScope:"whole_turn",summary:{reasons:[],metrics:{input:{value:"11"},output:{value:"7"}},costs:[{amount:"0.0002",currency:"USD"}]}});
        expect(usage.read(scope,threadId).summary.metrics.input.value).toBe("22");
        const finalItems = finalTurn.orderedItemIds.map(
          (itemId) => finalSnapshot.itemsById[itemId]!,
        );
        expect(
          finalItems.filter(({ kind }) => kind === "user_message"),
        ).toHaveLength(1);
        expect(
          finalItems.filter(({ kind }) => kind === "assistant_message"),
        ).toHaveLength(1);
        expect(finalItems.filter(({ kind }) => kind === "tool")).toHaveLength(
          1,
        );
        expect(new Set(finalItems.map(({ id }) => id)).size).toBe(
          finalItems.length,
        );

        // A reconnect from a cursor inside the send receives the strict suffix
        // only: no anchor replay and no already-applied identity.
        const midIndex = canonicalFrames.findIndex(
          ({ event }, index) =>
            index >= anchorLength &&
            event.type === "item_upsert" &&
            event.item.kind === "user_message",
        );
        expect(midIndex).toBeGreaterThanOrEqual(anchorLength);
        const reconnect = hubHandle.hub.subscribe(
          () => undefined,
          canonicalFrames[midIndex]!.eventId,
        );
        expect(reconnect.replay.map(({ eventId }) => eventId)).toEqual(
          canonicalFrames.slice(midIndex + 1).map(({ eventId }) => eventId),
        );
        expect(
          reconnect.replay.some(({ event }) => event.type === "snapshot"),
        ).toBe(false);
        reconnect.close();
        canonicalSubscription.close();
        boundRuntime.release();
      } finally {
        subscription.close();
        hubHandle.release();
      }
    } finally {
      await harness.close();
    }
  }, 60_000);
});
