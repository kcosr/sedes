import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ConversationBinding } from "../../backends/contracts.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export const NATIVE_ARCHIVE_OPERATION_KIND = "conversation_native_archive";

/** Uses ordinary uncertain-operation recovery and force reset; no separate job state. */
export class NativeArchiveOperationRepository {
  constructor(readonly database: Database.Database) {}

  hasUncertain(scope: RequestScope, threadId: string): boolean {
    return this.database.prepare(`
      SELECT 1 FROM mutation_receipts
      WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
        AND operation_kind = ? AND result_code = 'uncertain'
      LIMIT 1
    `).get(scope.tenantId, scope.principalId, threadId, NATIVE_ARCHIVE_OPERATION_KIND) !== undefined;
  }

  begin(
    scope: RequestScope,
    binding: ConversationBinding,
    action: "archive" | "restore",
    now = Date.now(),
  ): string | undefined {
    return this.database.transaction(() => {
      const authorized = this.database.prepare(`
        SELECT 1 FROM conversation_bindings
        WHERE tenant_id = ? AND owner_principal_id = ?
          AND application_thread_id = ? AND backend_instance_id = ?
          AND backend_conversation_id = ? AND connection_profile_id = ?
          AND execution_environment_id = ?
      `).get(
        scope.tenantId, scope.principalId, binding.applicationThreadId,
        binding.backendInstanceId, binding.backendConversationId,
        binding.connectionProfileId, binding.executionEnvironmentId,
      );
      if (!authorized || binding.tenantId !== scope.tenantId || binding.ownerPrincipalId !== scope.principalId) {
        throw new DomainError("not_found", "The thread binding was not found.");
      }
      if (this.hasUncertain(scope, binding.applicationThreadId)) return undefined;
      const mutationId = randomUUID();
      const fingerprint = createHash("sha256").update(JSON.stringify([
        NATIVE_ARCHIVE_OPERATION_KIND, binding.applicationThreadId,
        binding.backendInstanceId, binding.backendConversationId, action,
      ])).digest("hex");
      // Store uncertainty before calling the provider. A crash during dispatch
      // must block execution after restart just like a lost native response.
      this.database.prepare(`
        INSERT INTO mutation_receipts(
          tenant_id, principal_id, thread_id, mutation_id, operation_kind,
          request_fingerprint, result_code, result_json, replayable, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'uncertain', ?, 0, ?)
      `).run(
        scope.tenantId, scope.principalId, binding.applicationThreadId,
        mutationId, NATIVE_ARCHIVE_OPERATION_KIND, fingerprint,
        JSON.stringify({
          version: 1, action, backendInstanceId: binding.backendInstanceId,
          backendConversationId: binding.backendConversationId,
          diagnostic: "Native archive synchronization may still be in progress. Inspect the provider and use Force reset before continuing this thread.",
        }), now,
      );
      return mutationId;
    })();
  }

  complete(scope: RequestScope, mutationId: string): void {
    this.database.prepare(`
      UPDATE mutation_receipts SET result_code = 'accepted'
      WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
        AND operation_kind = ? AND result_code = 'uncertain'
    `).run(scope.tenantId, scope.principalId, mutationId, NATIVE_ARCHIVE_OPERATION_KIND);
  }
}
