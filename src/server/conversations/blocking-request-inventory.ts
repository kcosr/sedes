import type { DriverInteraction } from "../../shared/protocol/backend.js";
import type { InventoryPrincipalStateRecord, InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { blockingRequestWakeIdentity, type InteractionBroker } from "./interaction-broker.js";

export class BlockingRequestInventory {
  constructor(
    private readonly inventory: InventoryRepository,
    private readonly publish: (scope: RequestScope, state: InventoryPrincipalStateRecord) => void,
  ) {}

  observeUnbound(
    broker: InteractionBroker | undefined, scope: RequestScope, threadId: string, interaction: DriverInteraction,
  ): void {
    // An attached broker reports requests after capacity and cancellation checks.
    // Actors without a viewer can receive a request before a broker binds.
    if (!broker?.hasBindingForThread(scope, threadId)) {
      this.observe(scope, threadId, blockingRequestWakeIdentity(interaction));
    }
  }

  observe(scope: RequestScope, threadId: string, requestIdentity: string): void {
    const state = this.inventory.observeBlockingRequest(scope, threadId, requestIdentity, Date.now());
    if (state) this.publish(scope, state);
  }
}
