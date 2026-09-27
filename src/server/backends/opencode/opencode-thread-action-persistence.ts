import type { ThreadActionPersistenceProvider } from "../../conversations/thread-mutation-gateway.js";
import { DomainError } from "../../domain/errors.js";
import { QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY } from "../../provider-features/contracts.js";

export class OpenCodeThreadActionPersistence implements ThreadActionPersistenceProvider {
  async afterInterruptAccepted(): Promise<boolean> { return false; }
  driverAction(..._input: Parameters<ThreadActionPersistenceProvider["driverAction"]>): never { throw unavailable(); }
  persistAccepted(..._input: Parameters<ThreadActionPersistenceProvider["persistAccepted"]>): never { throw unavailable(); }
  async afterPersistAccepted(..._input: Parameters<ThreadActionPersistenceProvider["afterPersistAccepted"]>): Promise<never> { throw unavailable(); }
  providerFeatureConcurrency() { return QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY; }
}
function unavailable(): DomainError {
  return new DomainError("invalid_transition", "OpenCode conversation actions are unavailable.");
}
