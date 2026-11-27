import { backendHistoryPageSchema, backendTurnSchema } from "../../shared/protocol/backend.js";
import type { InventoryPrincipalStateRecord, InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { MAXIMUM_TARGETED_TURN_LOOKUP_CANDIDATES } from "./conversation-actor.js";
import type { AcquireConversationActorInput } from "./conversation-actor-manager.js";
import { applicationTurnIdForBackendTurn, hasConfirmedTurnEnd } from "./conversation-projector.js";
import type { DatabaseActorTargetResolver } from "./database-conversation-adapters.js";

async function historyConfirmsEnd(
  target: AcquireConversationActorInput,
  turnId: string,
  signal: AbortSignal,
  readAllowed: () => boolean,
): Promise<boolean> {
  const { scope, binding, workspace, opaqueBindingDetail, driver } = target;
  const matchesBackendTurnId = (backendTurnId: string) => applicationTurnIdForBackendTurn({
    backendInstanceId: binding.backendInstanceId, sourceApplicationThreadId: binding.applicationThreadId, backendTurnId,
  }) === turnId;
  const reader = await driver.openHistory({ scope, binding, workspace, opaqueBindingDetail, signal });
  try {
    if (!readAllowed()) return false;
    // Establish the reader's immutable cut before locating an older target.
    const { snapshot, history } = await reader.readSnapshot({ signal });
    if (!readAllowed()) return false;
    const id = snapshot.orderedBackendTurnIds.find(matchesBackendTurnId);
    if (id !== undefined) {
      const turn = snapshot.turnsById[id];
      return turn?.backendTurnId === id && hasConfirmedTurnEnd(backendTurnSchema.parse(turn));
    }
    if (!history.operational || history.previousCursor === undefined) return false;
    const found = await reader.locateTurn({ matchesBackendTurnId, maximumTurnCandidates: MAXIMUM_TARGETED_TURN_LOOKUP_CANDIDATES, signal });
    if (found.status !== "found") return false;
    const page = backendHistoryPageSchema.parse(found.page);
    const [locatedId] = page.orderedBackendTurnIds;
    return page.orderedBackendTurnIds.length === 1 && page.previousCursor === undefined && locatedId !== undefined &&
      matchesBackendTurnId(locatedId) && hasConfirmedTurnEnd(page.turnsById[locatedId]);
  } finally { await reader.close(); }
}

/** One admitted read-only pass. Pending parks survive absence, partial history and failed reads. */
export async function recoverParkedTurns(input: {
  readonly scope: RequestScope;
  readonly backendInstanceId: string;
  readonly inventory: InventoryRepository;
  readonly targets: Pick<DatabaseActorTargetResolver, "resolve">;
  readonly signal: AbortSignal;
  readonly isAdmitted: () => boolean;
  readonly hasLiveTurn: (threadId: string, turnId: string) => boolean;
  readonly publish: (state: InventoryPrincipalStateRecord) => void | Promise<void>;
  readonly onError: (threadId: string, error: unknown) => void;
}): Promise<boolean> {
  const { scope, backendInstanceId, inventory, signal } = input;
  const pageSize = 16;
  const admitted = () => !signal.aborted && input.isAdmitted();
  let remaining = false;
  let after = "";
  while (admitted()) {
    const candidates = inventory.listParkedTurnTargets(scope, backendInstanceId, after, pageSize);
    for (const { threadId, turnId, progressParkRevision, readable } of candidates) {
      if (!admitted()) return remaining;
      after = threadId;
      const readAllowed = () => admitted() && !input.hasLiveTurn(threadId, turnId);
      if (!readable || !readAllowed()) { remaining = true; continue; }
      try {
        const target = await input.targets.resolve(scope, threadId);
        const { binding } = target;
        if (!readAllowed() || binding.applicationThreadId !== threadId || binding.backendInstanceId !== backendInstanceId ||
            binding.tenantId !== scope.tenantId || binding.ownerPrincipalId !== scope.principalId ||
            target.scope.tenantId !== scope.tenantId || target.scope.principalId !== scope.principalId) {
          remaining = true;
          continue;
        }
        const confirmed = await historyConfirmsEnd(target, turnId, signal, readAllowed);
        if (!confirmed || !readAllowed()) { remaining = true; continue; }
        const changed = inventory.unparkIfTurnEnded(scope, threadId, id => id === turnId, Date.now(), progressParkRevision);
        if (changed) await input.publish(changed);
      } catch (error) {
        remaining = true;
        if (admitted()) input.onError(threadId, error);
      }
    }
    if (candidates.length < pageSize) break;
  }
  return remaining;
}
