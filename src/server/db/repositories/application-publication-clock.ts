import type Database from "better-sqlite3";
import type { RequestScope } from "../../identity/identity-provider.js";

/** Called inside the document/image transaction so visible ordering follows commit order. */
export function nextApplicationPublicationTime(database: Database.Database, scope: RequestScope, threadId: string, now: number): number {
  const row = database.prepare(`INSERT INTO application_publication_clocks(tenant_id,owner_principal_id,thread_id,last_published_at)
    VALUES(?,?,?,?) ON CONFLICT(tenant_id,owner_principal_id,thread_id)
    DO UPDATE SET last_published_at=MAX(excluded.last_published_at,application_publication_clocks.last_published_at+1)
    RETURNING last_published_at`).get(scope.tenantId, scope.principalId, threadId, now) as { last_published_at: number };
  return row.last_published_at;
}
