import { backendHistoryPageSchema, backendTurnSchema } from "../../shared/protocol/backend.js";
import type { InventoryPrincipalStateRecord, InventoryRepository, ParkedTurnOutcome } from "../db/repositories/inventory-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { MAXIMUM_TARGETED_TURN_LOOKUP_CANDIDATES } from "./conversation-actor.js";
import type { AcquireConversationActorInput } from "./conversation-actor-manager.js";
import { applicationTurnIdForBackendTurn, confirmedTurnOutcome } from "./conversation-projector.js";
import type { DatabaseActorTargetResolver } from "./database-conversation-adapters.js";

export interface ParkedTurnRetry {
  readonly parkRevision: number;
  readonly delay: number;
  readonly nextReadAt: number;
  readonly lastError?: string;
}

async function readParkedTurnOutcome(
  target: AcquireConversationActorInput,
  turnId: string,
  signal: AbortSignal,
  readAllowed: () => boolean,
): Promise<ParkedTurnOutcome | undefined> {
  const { scope, binding, workspace, opaqueBindingDetail, driver } = target;
  const matchesBackendTurnId = (backendTurnId: string) => applicationTurnIdForBackendTurn({
    backendInstanceId: binding.backendInstanceId, sourceApplicationThreadId: binding.applicationThreadId, backendTurnId,
  }) === turnId;
  const reader = await driver.openHistory({ scope, binding, workspace, opaqueBindingDetail, signal });
  try {
    if (!readAllowed()) return undefined;
    // Establish the reader's immutable cut before locating an older target.
    const { snapshot, history } = await reader.readSnapshot({ signal });
    if (!readAllowed()) return undefined;
    let id = snapshot.orderedBackendTurnIds.find(matchesBackendTurnId);
    let turns = snapshot.turnsById;
    if (id === undefined) {
      if (!history.operational || history.previousCursor === undefined) return undefined;
      const found = await reader.locateTurn({ matchesBackendTurnId, maximumTurnCandidates: MAXIMUM_TARGETED_TURN_LOOKUP_CANDIDATES, signal });
      if (found.status !== "found" || !readAllowed()) return undefined;
      const page = backendHistoryPageSchema.parse(found.page);
      id = page.orderedBackendTurnIds[0];
      if (page.orderedBackendTurnIds.length !== 1 || page.previousCursor !== undefined || !id || !matchesBackendTurnId(id)) return undefined;
      turns = page.turnsById;
    }
    const turn = turns[id];
    if (turn?.backendTurnId !== id) return undefined;
    const outcome = confirmedTurnOutcome(backendTurnSchema.parse(turn));
    if (outcome) return outcome;
    if (await reader.confirmTurnOwnerStopped?.({ backendTurnId: id, signal })) return "owner_stopped";
    return undefined;
  } finally { await reader.close(); }
}

/** One admitted read-only pass. Pending parks survive absence, partial history and failed reads. */
export async function recoverParkedTurns(input: {
  readonly scope: RequestScope;
  readonly backendInstanceId: string;
  /** Scoped to this principal and backend runtime. A new park bypasses the prior delay. */
  readonly retries: Map<string, ParkedTurnRetry>;
  readonly inventory: Pick<InventoryRepository, "listParkedTurnTargets" | "unparkIfTurnEnded">;
  readonly targets: Pick<DatabaseActorTargetResolver, "resolve">;
  readonly signal: AbortSignal;
  readonly isAdmitted: () => boolean;
  readonly hasLiveTurn: (threadId: string, turnId: string) => boolean;
  readonly publish: (state: InventoryPrincipalStateRecord) => void | Promise<void>;
  readonly onError: (threadId: string, error: unknown) => void;
}): Promise<boolean> {
  const { scope, backendInstanceId, inventory, retries, signal } = input;
  const obsolete = new Set(retries.keys());
  const pageSize = 16;
  const admitted = () => !signal.aborted && input.isAdmitted();
  let remaining = false;
  let after = "";
  while (admitted()) {
    const candidates = inventory.listParkedTurnTargets(scope, backendInstanceId, after, pageSize);
    for (const { threadId, turnId, progressParkRevision, readable } of candidates) {
      if (!admitted()) return remaining;
      after = threadId;
      obsolete.delete(threadId);
      const readAllowed = () => admitted() && !input.hasLiveTurn(threadId, turnId);
      if (!readable || !readAllowed()) { remaining = true; continue; }
      const previous = retries.get(threadId);
      const retry = previous?.parkRevision === progressParkRevision ? previous : undefined;
      if (retry && Date.now() < retry.nextReadAt) { remaining = true; continue; }
      let lastError: string | undefined;
      try {
        const target = await input.targets.resolve(scope, threadId);
        const { binding } = target;
        if (!readAllowed() || binding.applicationThreadId !== threadId || binding.backendInstanceId !== backendInstanceId ||
            binding.tenantId !== scope.tenantId || binding.ownerPrincipalId !== scope.principalId ||
            target.scope.tenantId !== scope.tenantId || target.scope.principalId !== scope.principalId) {
          remaining = true;
          continue;
        }
        const outcome = await readParkedTurnOutcome(target, turnId, signal, readAllowed);
        if (outcome && readAllowed()) {
          const changed = inventory.unparkIfTurnEnded(scope, threadId, id => id === turnId ? outcome : undefined, Date.now(), progressParkRevision);
          retries.delete(threadId);
          if (changed) await input.publish(changed);
          continue;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message.slice(0, 2048) : "unknown error";
        if (admitted() && retry?.lastError !== lastError) input.onError(threadId, error);
      }
      remaining = true;
      const delay = retry ? Math.min(retry.delay * 2, 30 * 60_000) : 30_000;
      retries.set(threadId, { parkRevision: progressParkRevision, nextReadAt: Date.now() + delay, delay, lastError });
    }
    if (candidates.length < pageSize) break;
  }
  if (admitted()) for (const threadId of obsolete) retries.delete(threadId);
  return remaining;
}
