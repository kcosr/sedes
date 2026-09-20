import type { QueueEventPublisher } from "../conversations/queued-input-dispatcher.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ScopedThreadEventHubRegistry } from "./thread-runtime-coordinator.js";

export class ThreadQueueEventPublisher implements QueueEventPublisher {
  constructor(readonly hubs: ScopedThreadEventHubRegistry) {}

  publish(
    scope: RequestScope,
    applicationThreadId: string,
    event: Parameters<QueueEventPublisher["publish"]>[2],
  ): void {
    this.hubs.thread(scope, applicationThreadId).publish(event);
  }
}
