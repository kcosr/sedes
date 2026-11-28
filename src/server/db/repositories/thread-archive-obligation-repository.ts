import type Database from "better-sqlite3";
import type { RequestScope } from "../../identity/identity-provider.js";
import { prepareCached } from "../prepared-statements.js";

/** Positive evidence survives a lost connection or main-server restart until retirement is proved. */
export class ThreadArchiveObligationRepository {
  constructor(readonly database: Database.Database) {}

  read(scope: RequestScope, threadId: string): { retainedOwner: string | null } | undefined {
    return prepareCached(this.database, `
      SELECT retained_owner AS retainedOwner FROM thread_archive_obligations
      WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
    `).get(scope.tenantId, scope.principalId, threadId) as { retainedOwner: string | null } | undefined;
  }

  remember(scope: RequestScope, threadId: string): void {
    prepareCached(this.database, `
      INSERT INTO thread_archive_obligations (tenant_id, principal_id, thread_id) VALUES (?, ?, ?)
      ON CONFLICT (tenant_id, principal_id, thread_id) DO NOTHING
    `).run(scope.tenantId, scope.principalId, threadId);
  }

  markRetained(scope: RequestScope, threadId: string, owner: string): void {
    const result = prepareCached(this.database, `
      INSERT INTO thread_archive_obligations (tenant_id, principal_id, thread_id, retained_owner)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (tenant_id, principal_id, thread_id) DO UPDATE SET retained_owner = excluded.retained_owner
      WHERE retained_owner IS NULL OR retained_owner = excluded.retained_owner
    `).run(scope.tenantId, scope.principalId, threadId, owner);
    if (!result.changes) throw new Error("archive_retained_owner_changed");
  }

  markSettled(scope: RequestScope, threadId: string, owner: string): void {
    if (!this.settleIfRetained(scope, threadId, owner)) throw new Error("archive_retained_owner_changed");
  }

  /** A normal observer may prove settlement of the same owner between archive attempts. */
  settleIfRetained(scope: RequestScope, threadId: string, owner: string): boolean {
    const result = prepareCached(this.database, `
      UPDATE thread_archive_obligations SET retained_owner = NULL
      WHERE tenant_id = ? AND principal_id = ? AND thread_id = ? AND retained_owner = ?
    `).run(scope.tenantId, scope.principalId, threadId, owner);
    return result.changes === 1;
  }

  clear(scope: RequestScope, threadId: string): void {
    prepareCached(this.database, `
      DELETE FROM thread_archive_obligations WHERE tenant_id = ? AND principal_id = ? AND thread_id = ? AND retained_owner IS NULL
    `).run(scope.tenantId, scope.principalId, threadId);
  }
}
