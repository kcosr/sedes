import type Database from "better-sqlite3";
import type { RequestScope } from "../../identity/identity-provider.js";
import { prepareCached } from "../prepared-statements.js";

/** Positive evidence survives a lost connection or main-server restart until retirement is proved. */
export class ThreadArchiveObligationRepository {
  constructor(readonly database: Database.Database) {}

  read(scope: RequestScope, threadId: string): { retainedOwner: string | null; evidenceToken: string } | undefined {
    return prepareCached(this.database, `
      SELECT retained_owner AS retainedOwner, evidence_token AS evidenceToken FROM thread_archive_obligations
      WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
    `).get(scope.tenantId, scope.principalId, threadId) as { retainedOwner: string | null; evidenceToken: string } | undefined;
  }

  remember(scope: RequestScope, threadId: string): string {
    const row = prepareCached(this.database, `
      INSERT INTO thread_archive_obligations (tenant_id, principal_id, thread_id) VALUES (?, ?, ?)
      ON CONFLICT (tenant_id, principal_id, thread_id) DO UPDATE SET evidence_token = excluded.evidence_token
      RETURNING evidence_token AS token
    `).get(scope.tenantId, scope.principalId, threadId) as { token: string };
    return row.token;
  }

  markRetained(scope: RequestScope, threadId: string, owner: string): string {
    const row = prepareCached(this.database, `
      INSERT INTO thread_archive_obligations (tenant_id, principal_id, thread_id, retained_owner) VALUES (?, ?, ?, ?)
      ON CONFLICT (tenant_id, principal_id, thread_id) DO UPDATE SET retained_owner = excluded.retained_owner, evidence_token = excluded.evidence_token
      WHERE retained_owner IS NULL OR retained_owner = excluded.retained_owner
      RETURNING evidence_token AS token
    `).get(scope.tenantId, scope.principalId, threadId, owner) as { token: string } | undefined;
    if (!row) throw new Error("archive_retained_owner_changed");
    return row.token;
  }

  markSettled(scope: RequestScope, threadId: string, owner: string): string {
    const token = this.settleIfRetained(scope, threadId, owner);
    if (!token) throw new Error("archive_retained_owner_changed");
    return token;
  }

  /** A normal observer may prove settlement of the same owner between archive attempts. */
  settleIfRetained(scope: RequestScope, threadId: string, owner: string): string | undefined {
    const row = prepareCached(this.database, `
      UPDATE thread_archive_obligations SET retained_owner = NULL, evidence_token = lower(hex(randomblob(16)))
      WHERE tenant_id = ? AND principal_id = ? AND thread_id = ? AND retained_owner = ?
      RETURNING evidence_token AS token
    `).get(scope.tenantId, scope.principalId, threadId, owner) as { token: string } | undefined;
    return row?.token;
  }

  clear(scope: RequestScope, threadId: string, token: string): boolean {
    return prepareCached(this.database, `
      DELETE FROM thread_archive_obligations
      WHERE tenant_id = ? AND principal_id = ? AND thread_id = ? AND evidence_token = ? AND retained_owner IS NULL
    `).run(scope.tenantId, scope.principalId, threadId, token).changes === 1;
  }
}
