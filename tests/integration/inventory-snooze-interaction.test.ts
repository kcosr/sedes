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
