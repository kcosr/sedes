import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

/**
 * Returns a parked thread to Active when input is accepted, its captured
 * turn ends, or an anchored automation fails or becomes uncertain.
 * Callers verify the triggering fact inside the same transaction so replay
 * cannot undo a later manual Park.
 */
export function activateParkedThread(
  database: Database.Database,
  scope: RequestScope,
  applicationThreadId: string,
  activatedAt: number,
): boolean {
  const changed = database
    .prepare(
      `
        UPDATE thread_principal_state
        SET inventory_state = 'active',
          inventory_revision = inventory_revision + 1,
          state_changed_at = ?
        WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          AND inventory_state = 'parked'
      `,
    )
    .run(
      activatedAt,
      scope.tenantId,
      scope.principalId,
      applicationThreadId,
    );
  if (changed.changes === 0) return false;
  if (changed.changes !== 1) {
    throw new DomainError(
      "conflict",
      "Thread activation matched more than one scoped inventory record.",
    );
  }
  const generation = database
    .prepare(
      `
        UPDATE principal_generations
        SET inventory_generation = inventory_generation + 1
        WHERE tenant_id = ? AND principal_id = ?
      `,
    )
    .run(scope.tenantId, scope.principalId);
  if (generation.changes !== 1) {
    throw new DomainError(
      "conflict",
      "The principal inventory generation is missing.",
    );
  }
  return true;
}
