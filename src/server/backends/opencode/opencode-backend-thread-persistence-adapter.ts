import type { BackendThreadPersistenceAdapter } from "../../conversations/conversation-lifecycle-service.js";
import type { BackendBindingDetailReader } from "../../conversations/database-conversation-adapters.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { parseOpenCodeBindingDetail } from "./opencode-binding-detail.js";
import { OpenCodeThreadRepository } from "./opencode-thread-repository.js";

/** Binding persistence is usable independently of conversation execution. */
export class OpenCodeBackendThreadPersistenceAdapter implements BackendThreadPersistenceAdapter, BackendBindingDetailReader {
  readonly database;
  constructor(readonly repository: OpenCodeThreadRepository) { this.database = repository.database; }
  initializeThread(..._input: Parameters<BackendThreadPersistenceAdapter["initializeThread"]>): never { throw unavailable(); }
  initializeForkThread(..._input: Parameters<BackendThreadPersistenceAdapter["initializeForkThread"]>): never { throw unavailable(); }
  readForkSettings(..._input: Parameters<BackendThreadPersistenceAdapter["readForkSettings"]>): never { throw unavailable(); }
  initializeNewThread(..._input: Parameters<BackendThreadPersistenceAdapter["initializeNewThread"]>): never { throw unavailable(); }
  validateInitialization(..._input: Parameters<BackendThreadPersistenceAdapter["validateInitialization"]>): never { throw unavailable(); }
  initializationActions(..._input: Parameters<BackendThreadPersistenceAdapter["initializationActions"]>): never { throw unavailable(); }
  recordSubmissionIntent(..._input: Parameters<BackendThreadPersistenceAdapter["recordSubmissionIntent"]>): never { throw unavailable(); }
  hasSubmissionIntent(..._input: Parameters<BackendThreadPersistenceAdapter["hasSubmissionIntent"]>): never { throw unavailable(); }
  saveBoundBindingDetail(scope: RequestScope, applicationThreadId: string, value: string): void {
    this.repository.saveBinding(scope, applicationThreadId, parseOpenCodeBindingDetail(value));
  }
  getBindingDetail(scope: RequestScope, applicationThreadId: string): string | undefined {
    return this.repository.getBinding(scope, applicationThreadId);
  }
}
function unavailable(): DomainError {
  return new DomainError("invalid_transition", "OpenCode conversation integration is unavailable.");
}
