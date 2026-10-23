import type Database from "better-sqlite3";
import { AutomaticModelRetryService } from "./automatic-model-retry-service.js";
import { createModelFailureRetryPolicy } from "../backends/model-failure-retry.js";
import { applicationTurnIdForBackendTurn } from "./conversation-projector.js";
import type { ConversationBindingRepository } from "../db/repositories/conversation-binding-repository.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { QueuedInputRepository } from "../db/repositories/queued-input-repository.js";
import type { ConversationOperationRepository } from "../db/repositories/conversation-operation-repository.js";
import type { ConversationActorManager } from "./conversation-actor-manager.js";
import type { ThreadRuntimeCoordinator } from "../events/thread-runtime-coordinator.js";
import type { InteractionBroker } from "./interaction-broker.js";
import type { QueuedInputDispatcher } from "./queued-input-dispatcher.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { prepareCached } from "../db/prepared-statements.js";

function hasCompletionCallback(database: Database.Database, scope: RequestScope, threadId: string, failureIdentity: string): boolean {
  return prepareCached(database, `
    SELECT 1 FROM thread_completion_callbacks AS callback
    JOIN submission_completion_observations AS completion
      ON completion.tenant_id = callback.tenant_id
      AND completion.owner_principal_id = callback.owner_principal_id
      AND completion.application_thread_id = callback.target_thread_id
      AND completion.operation_id = callback.target_operation_id
    WHERE completion.tenant_id = ? AND completion.owner_principal_id = ?
      AND completion.application_thread_id = ? AND completion.last_completion_identity = ?
    LIMIT 1
  `).get(scope.tenantId, scope.principalId, threadId, failureIdentity) !== undefined;
}

/** Shared admission and allowance; native recovery stays behind the actor. */
export function createAutomaticModelRetryRuntime(dependencies: {
  readonly database: Database.Database;
  readonly bindings: Pick<ConversationBindingRepository, "getBinding">;
  readonly inventory: Pick<InventoryRepository, "getThread" | "assertWorkspaceActive">;
  readonly queueRepository: QueuedInputRepository;
  readonly operations: Pick<ConversationOperationRepository, "hasBlockingThreadOperation">;
  readonly actors: Pick<ConversationActorManager, "observeInputRuntime">;
  readonly runtimes: Pick<ThreadRuntimeCoordinator, "acquire">;
  readonly interactions: Pick<InteractionBroker, "listPending">;
  readonly queueDispatcher: Pick<QueuedInputDispatcher, "dispatchAdmitted">;
  readonly onPendingChanged?: (scope: RequestScope, threadId: string, pending: boolean) => void;
}): AutomaticModelRetryService {
  return new AutomaticModelRetryService({
      resolvePolicy(eventScope, threadId) {
        const binding = dependencies.bindings.getBinding(eventScope, threadId);
        if (!binding) return undefined;
        const policy = createModelFailureRetryPolicy(dependencies.database, {
          ...binding, createdAt: new Date(binding.createdAt).toISOString(),
        });
        return { ...policy, claim: (failureIdentity: string) =>
          !hasCompletionCallback(dependencies.database, eventScope, threadId, failureIdentity) && policy.claim(failureIdentity) };
      },
      async enqueue(eventScope, threadId, input) {
        const before = dependencies.actors.observeInputRuntime(eventScope, threadId);
        if (!input.isCurrent() || !before?.authoritative || !before.settled) return;
        const acquired = await dependencies.runtimes.acquire(eventScope, threadId);
        try {
          const isCurrent = () => {
            const binding = dependencies.bindings.getBinding(eventScope, threadId);
            if (!binding || !input.isCurrent()) return false;
            const observed = dependencies.actors.observeInputRuntime(eventScope, threadId);
            const timeline = acquired.actor.timeline;
            const turnId = applicationTurnIdForBackendTurn({
              backendInstanceId: binding.backendInstanceId,
              sourceApplicationThreadId: threadId, backendTurnId: input.backendTurnId,
            });
            if (!observed?.authoritative || !observed.settled || observed.ownerGeneration !== before.ownerGeneration ||
                timeline.runState !== "failed" || timeline.orderedTurnIds.at(-1) !== turnId ||
                timeline.turnsById[turnId]?.status !== "failed" || acquired.actor.readOnly ||
                dependencies.interactions.listPending(eventScope, threadId).length > 0 ||
                dependencies.operations.hasBlockingThreadOperation(eventScope, threadId, "submit") ||
                dependencies.queueRepository.listActive(eventScope, threadId).some(item => item.state !== "failed")) return false;
            const aggregate = dependencies.inventory.getThread(eventScope, threadId);
            dependencies.inventory.assertWorkspaceActive(eventScope, aggregate.thread.workspaceId);
            // Retain automation execution limits without attributing this follow-up
            // to another scheduled automation delivery. A completion callback
            // already gives the caller this turn's terminal failure; exclude
            // every correlated callback even after its result was delivered.
            if (hasCompletionCallback(dependencies.database, eventScope, threadId, input.sourceFailureIdentity)) return false;
            return true;
          };
          if (input.nativeRecovery) {
            if (!isCurrent()) return;
            await acquired.actor.recoverModelFailure({
              backendTurnId: input.backendTurnId, mutationId: input.mutationId,
              isCurrent, onAdmitted: input.onAdmitted,
            });
            // Native uncertainty or rejection never permits a second action.
            return;
          }
          const admitted = dependencies.database.transaction(() => {
            if (!isCurrent()) return false;
            const aggregate = dependencies.inventory.getThread(eventScope, threadId);
            const previousInput = dependencies.database.prepare(`
              SELECT completion.operation_id AS mutationId,
                CASE WHEN q.id IS NOT NULL THEN q.trigger_kind ELSE creation.source_kind END AS triggerKind,
                coalesce(q.source_automation_id, creation.source_automation_id) AS automationId,
                coalesce(q.source_automation_run_id, creation.source_automation_run_id) AS automationRunId
              FROM submission_completion_observations AS completion
              LEFT JOIN queued_inputs AS q
                ON completion.tenant_id = q.tenant_id AND completion.owner_principal_id = q.owner_principal_id
                AND completion.application_thread_id = q.application_thread_id AND completion.operation_id = q.mutation_id
              LEFT JOIN conversation_creation_attempts AS creation
                ON completion.tenant_id = creation.tenant_id AND completion.owner_principal_id = creation.owner_principal_id
                AND completion.application_thread_id = creation.application_thread_id AND completion.operation_id = creation.mutation_id
              WHERE completion.tenant_id = ? AND completion.owner_principal_id = ? AND completion.application_thread_id = ?
                AND completion.last_completion_identity = ? AND completion.completion_outcome = 'failed'
                AND (q.id IS NOT NULL OR creation.phase = 'bound') ORDER BY completion.accepted_at DESC LIMIT 1
            `).get(eventScope.tenantId, eventScope.principalId, threadId, input.sourceFailureIdentity) as {
              triggerKind: string; automationId: string | null; automationRunId: string | null;
              mutationId: string;
            } | undefined;
            if (!previousInput) return false;
            const previous = dependencies.queueRepository.findByMutationId(eventScope, threadId, previousInput.mutationId);
            const executionSource = previousInput.triggerKind === "automation"
              ? { kind: "automation" as const, automationId: previousInput.automationId!, automationRunId: previousInput.automationRunId! }
              : previous?.automaticRetryExecutionSource ?? { kind: "user" as const };
            dependencies.queueRepository.enqueue(eventScope, threadId, {
              mutationId: input.mutationId, text: input.text, contextExcerpts: [], attachmentIds: [], taskReferences: [],
              source: { kind: "automatic_retry", expectedThreadRevision: aggregate.thread.revision,
                sourceFailureIdentity: input.sourceFailureIdentity, executionSource }, now: Date.now(),
            });
            return true;
          })();
          if (admitted) {
            input.onAdmitted();
            await dependencies.queueDispatcher.dispatchAdmitted(eventScope, threadId);
          }
        } finally { acquired.release(); }
      },
    onPendingChanged: dependencies.onPendingChanged,
  });
}
