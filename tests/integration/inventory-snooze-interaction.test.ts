import { randomUUID } from "node:crypto";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { describe, expect, it } from "vitest";
import type { ConversationActorListener } from "../../src/server/conversations/conversation-actor.js";
import { InteractionBroker } from "../../src/server/conversations/interaction-broker.js";
import { InventoryService } from "../../src/server/domain/inventory-service.js";
import { applicationSummaryFixture } from "../support/application-summary-fixture.js";

describe("snooze while a blocking interaction is open", () => {
  it.each(["confirmation", "text_input"] as const)(
    "guards fresh snoozes until the %s closes",
    async (kind) => {
      const { database, inventory, scope, ids } = applicationSummaryFixture(2);
      const [threadId, otherThreadId] = ids as [string, string];
      const interactions = new InteractionBroker();
      let emit!: ConversationActorListener;
      interactions.bind(
        scope,
        threadId,
        {
          subscribe(listener) {
            emit = listener;
            return () => undefined;
          },
          respond: async () => undefined,
        },
        { opened() {}, resolved() {} },
      );
      const service = new InventoryService(
        inventory,
        { publishMany() {}, publishApplicationThread() {} },
        undefined,
        undefined,
        interactions,
      );
      const snooze = {
        expectedRevision: 0,
        mutationId: "initial-snooze",
        change: { action: "snooze", snoozedUntil: 10_000 },
      } as const;
      const state = () => inventory.getInventory(scope, threadId);
      try {
        const original = await service.transition(scope, threadId, snooze, 1_000);
        emit({
          type: "backend_event",
          generation: "generation-1",
          event: {
            type: "interaction_opened",
            interaction: {
              backendInteractionId: "request-1",
              sourceLabel: { text: "Provider" },
              title: { text: "Response required" },
              openedAt: new Date(2_000).toISOString(),
              secret: false,
              destructive: false,
              cancellable: true,
              ...(kind === "confirmation"
                ? { kind, message: { text: "Confirm the command" } }
                : { kind, multiline: false }),
            },
          },
        });
        expect(interactions.hasPendingForThread(scope, threadId)).toBe(true);
        expect(interactions.hasPendingForThread({ ...scope, principalId: "other" }, threadId))
          .toBe(false);
        await expect(service.transition(scope, otherThreadId, {
          ...snooze,
          mutationId: "other-thread-snooze",
        }, 2_000)).resolves.toMatchObject({ inventoryState: "snoozed" });

        await expect(service.transition(scope, threadId, {
          ...snooze,
          expectedRevision: 1,
          mutationId: "noop-snooze",
        }, 2_000)).resolves.toEqual(original);
        await service.transition(scope, threadId, {
          expectedRevision: 1,
          mutationId: "wake",
          change: { action: "wake" },
        }, 2_000);
        await expect(service.transition(scope, threadId, snooze, 2_001))
          .resolves.toEqual(original);
        await expect(service.transition(scope, threadId, {
          ...snooze,
          mutationId: "stale-snooze",
        }, 2_001)).rejects.toMatchObject({ code: "inventory_revision_conflict" });

        const retry = {
          ...snooze, expectedRevision: 2, mutationId: "retry-snooze",
        };
        await expect(service.transition(scope, threadId, retry, 2_001))
          .rejects.toMatchObject({
            code: "invalid_transition",
            message: expect.stringContaining("awaits a response"),
          });
        expect(state()).toMatchObject({ inventoryState: "active", inventoryRevision: 2 });
        emit({
          type: "backend_event",
          generation: "generation-1",
          event: { type: "interaction_resolved", backendInteractionId: "request-1" },
        });
        expect(interactions.hasPendingForThread(scope, threadId)).toBe(false);
        await expect(service.transition(scope, threadId, retry, 2_002))
          .resolves.toMatchObject({ inventoryState: "snoozed", inventoryRevision: 3 });
      } finally {
        await interactions.close();
        database.close();
      }
    },
  );
});

describe("new blocking requests", () => {
  it("keeps a second Park across reconnect and wakes a self-park only for a fresh request", () => {
    const { database, scope, ids } = applicationSummaryFixture(2);
    const [threadId, otherThread] = ids as [string, string];
    const inventory = new InventoryRepository(database, () => "turn");
    const park = (id: string, revision: number) => inventory.parkThread(scope, id, {
      expectedRevision: revision, selfParkTurnId: "turn", mutationId: randomUUID(), now: 400 + revision,
    });
    const first = "a".repeat(43);
    const next = "b".repeat(43);
    try {
      expect(inventory.observeBlockingRequest(scope, threadId, first, 350)).toBeUndefined();
      park(threadId, 0);
      const replacement = new InventoryRepository(database);
      expect(replacement.observeBlockingRequest(scope, threadId, first, 500)).toBeUndefined();
      expect(() => replacement.observeBlockingRequest({ ...scope, principalId: "other" }, threadId, next, 500)).toThrow();
      expect(replacement.getInventory(scope, threadId)).toMatchObject({ inventoryState: "parked", inventoryRevision: 1 });
      expect(replacement.observeBlockingRequest(scope, threadId, next, 510)).toMatchObject({
        inventoryState: "active", inventoryRevision: 2, wokeAt: null, wakeReason: null,
      });
      expect(database.prepare(`SELECT parked_until_turn_id, park_keep_on_success, progress_park_revision
        FROM thread_principal_state WHERE thread_id = ?`).get(threadId)).toEqual({
        parked_until_turn_id: null, park_keep_on_success: 0, progress_park_revision: 1,
      });
      park(threadId, 2);
      expect(replacement.observeBlockingRequest(scope, threadId, next, 520)).toBeUndefined();
      park(otherThread, 0);
      expect(replacement.observeBlockingRequest(scope, otherThread, next, 525)?.inventoryState).toBe("active");
    } finally { database.close(); }
  });

  it("preserves the snooze reminder and wakes only once for the same request", () => {
    const { database, inventory, scope, ids } = applicationSummaryFixture(1);
    const threadId = ids[0]!;
    const request = "c".repeat(43);
    const snooze = (expectedRevision: number) => inventory.transitionInventory(scope, threadId, {
      expectedRevision, mutationId: randomUUID(), now: 600 + expectedRevision,
      change: { action: "snooze", snoozedUntil: 900, wakeReminderText: "Review the reply" },
    });
    try {
      snooze(0);
      expect(inventory.observeBlockingRequest(scope, threadId, request, 650)).toMatchObject({
        inventoryState: "active", inventoryRevision: 2, wokeAt: 650, wakeReason: "needs-input",
        snoozedUntil: null, wakeReminderText: "Review the reply",
      });
      snooze(2);
      expect(inventory.observeBlockingRequest(scope, threadId, request, 750)).toBeUndefined();
      expect(inventory.getInventory(scope, threadId)).toMatchObject({ inventoryState: "snoozed", inventoryRevision: 3 });
    } finally { database.close(); }
  });
});
