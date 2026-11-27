import type { DriverInteraction } from "../../shared/protocol/backend.js";
import type { InventoryPrincipalStateRecord, InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ConversationActorManager } from "./conversation-actor-manager.js";
import { blockingRequestWakeIdentity, type InteractionBroker } from "./interaction-broker.js";

/** Snooze checks the live actor even when no viewer owns a broker subscription. */
export function pendingBlockingRequests(broker: InteractionBroker, actors: ConversationActorManager) {
  return {
    hasPendingForThread(scope: RequestScope, threadId: string): boolean {
      return broker.hasPendingForThread(scope, threadId) ||
        (actors.observeInputRuntime(scope, threadId)?.blockingInteractionIds.length ?? 0) > 0;
    },
  };
}

export class BlockingRequestInventory {
  constructor(
    private readonly inventory: InventoryRepository,
    private readonly publish: (scope: RequestScope, state: InventoryPrincipalStateRecord) => void,
  ) {}

  observeUnbound(
    broker: InteractionBroker | undefined, scope: RequestScope, threadId: string, interaction: DriverInteraction,
  ): void {
    // An attached broker reports requests after capacity and cancellation checks.
    // The actor observes requests before subscription and while a released binding drains.
    if (!broker?.hasActiveBindingForThread(scope, threadId)) {
      this.observe(scope, threadId, blockingRequestWakeIdentity(interaction));
    }
  }

  observe(scope: RequestScope, threadId: string, requestIdentity: string): void {
    const state = this.inventory.observeBlockingRequest(scope, threadId, requestIdentity, Date.now());
    if (state) this.publish(scope, state);
  }
}
