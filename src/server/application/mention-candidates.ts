import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { MENTION_CANDIDATE_PAGE_SIZE, type ListMentionCandidatesQuery } from "../../shared/protocol/api.js";
import { prepareCached } from "../db/prepared-statements.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";

interface CandidatePosition { id: string; activity: number }

function readPosition(encoded: string, fingerprint: string): CandidatePosition {
  try {
    const [binding, activity, id] = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (binding === fingerprint && Number.isSafeInteger(activity) && typeof id === "string" && id) return { activity, id };
  } catch { /* Treat malformed cursors and search mismatches alike. */ }
  throw new DomainError("cursor_invalid", "Invalid cursor for this thread search. Restart the search.");
}

export function listMentionCandidateIds(
  database: Database.Database, scope: RequestScope, sourceId: string, input: ListMentionCandidatesQuery,
): { ids: string[]; nextCursor?: string } {
  const source = prepareCached(database, `
    SELECT workspace.project_id AS projectId
    FROM application_threads AS thread
    JOIN workspaces AS workspace ON workspace.tenant_id = thread.tenant_id
      AND workspace.owner_principal_id = thread.owner_principal_id AND workspace.id = thread.workspace_id
      AND workspace.removed_at IS NULL
    WHERE thread.tenant_id = ? AND thread.owner_principal_id = ? AND thread.id = ?
  `).get(scope.tenantId, scope.principalId, sourceId) as { projectId: string } | undefined;
  if (!source) throw new DomainError("not_found", "The thread was not found.");

  const query = (input.query ?? "").trim().toLowerCase();
  const projectId = input.scope === "project" ? source.projectId : null;
  const binding = createHash("sha256").update(JSON.stringify([
    scope.tenantId, scope.principalId, sourceId, source.projectId, input.scope, query,
  ])).digest("base64url");
  const after = input.cursor ? readPosition(input.cursor, binding) : undefined;
  const rows = prepareCached(database, `
    SELECT thread.id, thread.last_activity_at AS activity
    FROM application_threads AS thread
    JOIN thread_principal_state AS state ON state.tenant_id = thread.tenant_id
      AND state.principal_id = thread.owner_principal_id AND state.thread_id = thread.id
    JOIN workspaces AS workspace ON workspace.tenant_id = thread.tenant_id
      AND workspace.owner_principal_id = thread.owner_principal_id AND workspace.id = thread.workspace_id
    JOIN projects AS project ON project.tenant_id = workspace.tenant_id
      AND project.owner_principal_id = workspace.owner_principal_id AND project.id = workspace.project_id
    JOIN execution_environments AS environment ON environment.tenant_id = workspace.tenant_id
      AND environment.owner_principal_id = workspace.owner_principal_id AND environment.id = workspace.environment_id
    JOIN agent_backend_instances AS backend ON backend.tenant_id = thread.tenant_id AND backend.id = thread.backend_instance_id
    WHERE thread.tenant_id = @tenantId AND thread.owner_principal_id = @principalId AND thread.id != @sourceId
      AND state.inventory_state != 'archived' AND workspace.removed_at IS NULL AND project.removed_at IS NULL
      AND (@projectId IS NULL OR project.id = @projectId)
      AND (@activity IS NULL OR thread.last_activity_at < @activity OR (thread.last_activity_at = @activity AND thread.id > @id))
      AND NOT EXISTS (
        SELECT 1 FROM json_each(@terms) AS term
        WHERE instr(sedes_lower(thread.title || ' ' || backend.kind || ' ' || backend.label || ' ' || project.name || ' ' ||
          workspace.display_name || ' ' || workspace.canonical_path || ' ' || environment.label), term.value) = 0
      )
    ORDER BY thread.last_activity_at DESC, thread.id ASC LIMIT @limit
  `).all({
    tenantId: scope.tenantId, principalId: scope.principalId, sourceId, projectId,
    terms: JSON.stringify(query.split(/\s+/u).filter(Boolean)),
    activity: after?.activity ?? null, id: after?.id ?? null, limit: MENTION_CANDIDATE_PAGE_SIZE + 1,
  }) as CandidatePosition[];
  const ids = rows.slice(0, MENTION_CANDIDATE_PAGE_SIZE).map(row => row.id);
  const last = rows[MENTION_CANDIDATE_PAGE_SIZE - 1];
  return rows.length > ids.length && last
    ? { ids, nextCursor: Buffer.from(JSON.stringify([binding, last.activity, last.id])).toString("base64url") }
    : { ids };
}
