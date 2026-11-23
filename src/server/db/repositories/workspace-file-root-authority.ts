import type Database from "better-sqlite3";
import { hostExecutionPolicy } from "../../configuration-admin/configuration-execution-policy.js";
import { DomainError } from "../../domain/errors.js";
import { canonicalLocalWorkspaceRoots } from "../../execution/local-workspace-roots.js";
import { workspaceRootGrant } from "../../execution/workspace-root-grant.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { prepareCached } from "../prepared-statements.js";

export type FileRootAdmission = {readonly authorityRootId: string; readonly authorityRevision: number};

export function workspaceFileRootAuthority(database: Database.Database, scope: RequestScope, workspaceId: string) {
  const environment = prepareCached(database, `SELECT e.id, e.kind FROM workspaces w
    JOIN execution_environments e ON e.tenant_id = w.tenant_id AND e.owner_principal_id = w.owner_principal_id AND e.id = w.environment_id
    WHERE w.tenant_id = ? AND w.owner_principal_id = ? AND w.id = ?`).get(scope.tenantId, scope.principalId, workspaceId) as
    {id: string; kind: string} | undefined;
  if (!environment) throw new DomainError("not_found", "The workspace was not found.");
  const policy = hostExecutionPolicy(database, scope, environment.id);
  const roots = !policy ? undefined : environment.kind === "local"
    ? canonicalLocalWorkspaceRoots(policy.snapshot.roots) : policy.snapshot.roots;
  return {
    stillAdmitted(rootId: string, path: string) {
      if (!roots) return false;
      const binding = storedFileRootBinding(database, scope, workspaceId, rootId);
      return !!binding && !!workspaceRootGrant(roots, path, binding);
    },
    admit(path: string, validated?: FileRootAdmission) {
      const grant = roots && workspaceRootGrant(roots, path, validated);
      if (!grant) throw new DomainError("conflict", "The Files root changed during admission.");
      return grant;
    },
  };
}

export function storedFileRootBinding(database: Database.Database, scope: RequestScope, workspaceId: string, rootId: string) {
  const rows = prepareCached(database, `SELECT authority_root_id AS authorityRootId, authority_root_generation AS authorityRevision
    FROM workspace_file_roots WHERE tenant_id = ?1 AND owner_principal_id = ?2 AND workspace_id = ?3 AND root_id = ?4
    UNION ALL SELECT authority_root_id, authority_root_generation FROM workspace_file_link_roots
    WHERE tenant_id = ?1 AND owner_principal_id = ?2 AND workspace_id = ?3 AND root_id = ?4
    UNION ALL SELECT authority_root_id, authority_root_generation FROM workspace_file_linked_worktree_roots
    WHERE tenant_id = ?1 AND owner_principal_id = ?2 AND workspace_id = ?3 AND root_id = ?4`).all({
      1: scope.tenantId, 2: scope.principalId, 3: workspaceId, 4: rootId,
    }) as {authorityRootId: string | null; authorityRevision: number | null}[];
  const binding = rows[0];
  return rows.length === 1 && binding?.authorityRootId && binding.authorityRevision !== null
    ? {authorityRootId: binding.authorityRootId, authorityRevision: binding.authorityRevision} : undefined;
}
