import type Database from "better-sqlite3";
import type { ResponseVoiceFreshness } from "../../conversations/response-voice-freshness.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

/** User-written input admission, independent of dispatch and runtime lifecycle. */
export class UserInputRevisionRepository {
  constructor(readonly database: Database.Database) {}

  advance(scope: Pick<RequestScope, "tenantId" | "principalId">, threadId: string): void {
    if (!this.database.inTransaction) throw new Error("user_input_revision_requires_admission_transaction");
    const result = this.database.prepare(`UPDATE application_threads
      SET user_input_revision = user_input_revision + 1
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
    `).run(scope.tenantId, scope.principalId, threadId);
    if (result.changes !== 1) throw new DomainError("not_found", "The input target is unavailable.");
  }

  capture(scope: Pick<RequestScope, "tenantId" | "principalId">, threadId: string,
    backendCorrelations: readonly string[]): ResponseVoiceFreshness {
    const row = this.database.prepare(`SELECT thread.user_input_revision AS userInputRevision,
      EXISTS (SELECT 1 FROM queued_inputs q
        WHERE q.tenant_id = thread.tenant_id AND q.owner_principal_id = thread.owner_principal_id
          AND q.application_thread_id = thread.id AND q.is_user_input = 1
          AND (q.state IN ('pending', 'retry_wait') OR
            (q.state IN ('dispatching', 'uncertain') AND q.delivery_mode = 'steer'
              AND (q.reconciliation_token IS NULL OR q.reconciliation_token NOT IN
                (SELECT value FROM json_each(?)))))) AS superseded
      FROM application_threads thread
      WHERE thread.tenant_id = ? AND thread.owner_principal_id = ? AND thread.id = ?
    `).get(JSON.stringify(backendCorrelations), scope.tenantId, scope.principalId, threadId) as
      { userInputRevision: number; superseded: 0 | 1 } | undefined;
    if (!row) throw new DomainError("not_found", "The input target is unavailable.");
    return { userInputRevision: row.userInputRevision, superseded: row.superseded === 1 };
  }
}
