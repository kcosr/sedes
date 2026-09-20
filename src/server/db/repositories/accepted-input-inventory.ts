import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

/**
 * Applies the application-owned inventory consequence of accepting new input.
 * Callers must invoke this inside the same SQLite transaction that first
 * records durable acceptance. The conditional update makes receipt replay a
 * no-op and lets a later manual Settle remain authoritative.
 */
export function activateSettledThreadForAcceptedInput(
  database: Database.Database,
  scope: RequestScope,
  applicationThreadId: string,
  acceptedAt: number,
): boolean {
  const changed = database
    .prepare(
      `
        UPDATE thread_principal_state
        SET inventory_state = 'active',
          inventory_revision = inventory_revision + 1,
          state_changed_at = ?
        WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          AND inventory_state = 'settled'
      `,
    )
    .run(
      acceptedAt,
      scope.tenantId,
      scope.principalId,
      applicationThreadId,
    );
  if (changed.changes === 0) return false;
  if (changed.changes !== 1) {
    throw new DomainError(
      "conflict",
      "Accepted input matched more than one scoped inventory record.",
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
