import type Database from "better-sqlite3";
import {
  appliedToolPolicySetSchema,
  type AppliedToolPolicySet,
} from "../../../shared/protocol/conversation.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

/** Mutable current association, independent of the reusable definition's lifetime. */
export class ThreadAppliedToolPolicySetRepository {
  constructor(readonly database: Database.Database) {}

  get(scope: RequestScope, threadId: string): AppliedToolPolicySet | null {
    const row = this.database.prepare(`
      SELECT policy_set_id AS id,policy_set_name AS name,policy_set_revision AS revision
      FROM thread_applied_tool_policy_sets
      WHERE tenant_id=? AND owner_principal_id=? AND thread_id=?
    `).get(scope.tenantId, scope.principalId, threadId);
    return row ? appliedToolPolicySetSchema.parse(row) : null;
  }

  set(
    scope: RequestScope,
    threadId: string,
    policySet: AppliedToolPolicySet | null,
    now: number,
  ): AppliedToolPolicySet | null {
    this.#assertTransaction();
    this.#assertThread(scope, threadId);
    if (policySet === null) {
      this.clear(scope, threadId);
      return null;
    }
    const parsed = appliedToolPolicySetSchema.parse(policySet);
    if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) {
      throw new Error("thread_applied_tool_policy_set_timestamp_invalid");
    }
    this.database.prepare(`
      INSERT INTO thread_applied_tool_policy_sets(tenant_id,owner_principal_id,thread_id,
        policy_set_id,policy_set_name,policy_set_revision,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,owner_principal_id,thread_id) DO UPDATE SET
        policy_set_id=excluded.policy_set_id,policy_set_name=excluded.policy_set_name,
        policy_set_revision=excluded.policy_set_revision,updated_at=excluded.updated_at
    `).run(scope.tenantId, scope.principalId, threadId,
      parsed.id, parsed.name, parsed.revision, now);
    return parsed;
  }

  clear(scope: RequestScope, threadId: string): void {
    this.#assertTransaction();
    this.#assertThread(scope, threadId);
    this.database.prepare(`
      DELETE FROM thread_applied_tool_policy_sets
      WHERE tenant_id=? AND owner_principal_id=? AND thread_id=?
    `).run(scope.tenantId, scope.principalId, threadId);
  }

  copy(
    scope: RequestScope,
    sourceThreadId: string,
    childThreadId: string,
    now: number,
  ): AppliedToolPolicySet | null {
    this.#assertTransaction();
    this.#assertThread(scope, sourceThreadId);
    return this.set(scope, childThreadId, this.get(scope, sourceThreadId), now);
  }

  #assertThread(scope: RequestScope, threadId: string): void {
    const thread = this.database.prepare(`
      SELECT 1 FROM application_threads WHERE tenant_id=? AND owner_principal_id=? AND id=?
    `).get(scope.tenantId, scope.principalId, threadId);
    if (!thread) throw new DomainError("not_found", "The thread was not found.");
  }

  #assertTransaction(): void {
    if (!this.database.inTransaction) throw new Error("thread_applied_tool_policy_set_outside_transaction");
  }
}
