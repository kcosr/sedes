import type Database from "better-sqlite3";
import {
  threadToolPolicyOriginSchema,
  type ThreadToolPolicyOrigin,
} from "../../../shared/protocol/conversation.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

type OriginRow = {
  readonly source: ThreadToolPolicyOrigin["source"];
  readonly policySetId: string | null;
  readonly policySetName: string | null;
  readonly policySetRevision: number | null;
};

/** Immutable source labels accompany each thread's independent policy snapshot. */
export class ThreadToolPolicyOriginRepository {
  constructor(readonly database: Database.Database) {}

  get(scope: RequestScope, threadId: string): ThreadToolPolicyOrigin | null {
    const row = this.database.prepare(`
      SELECT source,policy_set_id AS policySetId,policy_set_name AS policySetName,
        policy_set_revision AS policySetRevision
      FROM thread_tool_policy_origins
      WHERE tenant_id=? AND owner_principal_id=? AND thread_id=?
    `).get(scope.tenantId, scope.principalId, threadId) as OriginRow | undefined;
    if (!row) return null;
    return threadToolPolicyOriginSchema.parse({
      source: row.source,
      ...(row.policySetId === null ? {} : {
        policySet: { id: row.policySetId, name: row.policySetName, revision: row.policySetRevision },
      }),
    });
  }

  record(
    scope: RequestScope,
    threadId: string,
    origin: ThreadToolPolicyOrigin,
    now: number,
  ): ThreadToolPolicyOrigin {
    this.#assertTransaction();
    const parsed = threadToolPolicyOriginSchema.parse(origin);
    const thread = this.database.prepare(`
      SELECT 1 FROM application_threads WHERE tenant_id=? AND owner_principal_id=? AND id=?
    `).get(scope.tenantId, scope.principalId, threadId);
    if (!thread) throw new DomainError("not_found", "The thread was not found.");
    if (this.get(scope, threadId)) {
      throw new DomainError("conflict", "The thread tool policy origin has already been captured.");
    }
    this.database.prepare(`
      INSERT INTO thread_tool_policy_origins(tenant_id,owner_principal_id,thread_id,source,
        policy_set_id,policy_set_name,policy_set_revision,created_at) VALUES(?,?,?,?,?,?,?,?)
    `).run(scope.tenantId, scope.principalId, threadId, parsed.source,
      parsed.policySet?.id ?? null, parsed.policySet?.name ?? null,
      parsed.policySet?.revision ?? null, now);
    return parsed;
  }

  copy(
    scope: RequestScope,
    sourceThreadId: string,
    childThreadId: string,
    now: number,
  ): ThreadToolPolicyOrigin | null {
    this.#assertTransaction();
    const source = this.database.prepare(`
      SELECT 1 FROM application_threads WHERE tenant_id=? AND owner_principal_id=? AND id=?
    `).get(scope.tenantId, scope.principalId, sourceThreadId);
    if (!source) throw new DomainError("not_found", "The source thread was not found.");
    const origin = this.get(scope, sourceThreadId);
    return origin === null ? null : this.record(scope, childThreadId, origin, now);
  }

  #assertTransaction(): void {
    if (!this.database.inTransaction) throw new Error("thread_tool_policy_origin_outside_transaction");
  }
}
