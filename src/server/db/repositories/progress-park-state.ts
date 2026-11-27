import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { prepareCached } from "../prepared-statements.js";

/** A Park invalidates already published progress even if playback checks after Unpark. */
export function readProgressParkState(database: Database.Database, scope: RequestScope, threadId: string) {
  const row = prepareCached(database, `
    SELECT inventory_state AS inventoryState, progress_park_revision AS progressParkRevision
    FROM thread_principal_state WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
  `).get(scope.tenantId, scope.principalId, threadId) as
    { inventoryState: string; progressParkRevision: number } | undefined;
  if (!row) throw new DomainError("not_found", "The progress source thread is unavailable.");
  return { progressMuted: row.inventoryState === "parked", progressParkRevision: row.progressParkRevision };
}
