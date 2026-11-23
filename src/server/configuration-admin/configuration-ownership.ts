import type Database from "better-sqlite3";
import type { ConfigurationDocument } from "../../shared/protocol/configuration-admin.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";

/** A backend claims the environment namespace even if no target currently allows turns. */
export function antigravityOwners(document: ConfigurationDocument): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const backend of document.backends) {
    if (backend.kind !== "antigravity" || !backend.enabled) continue;
    const binding = document.targets.find(target => target.backendInstanceId === backend.id);
    if (!binding) continue;
    const group = owners.get(binding.executionEnvironmentId) ?? [];
    group.push(backend.id);
    owners.set(binding.executionEnvironmentId, group);
  }
  return owners;
}

export function assertSingleAntigravityOwner(document: ConfigurationDocument): void {
  for (const ids of antigravityOwners(document).values()) if (ids.length > 1) {
    throw new DomainError("conflict", "Only one Antigravity backend can own an execution environment. Disable the other Antigravity backend before enabling this one.");
  }
}

export function restoreMigratedTargets(database: Database.Database, scope: RequestScope, document: ConfigurationDocument): boolean {
  let restored = false;
  const conflicts = database.prepare(`SELECT environment_id AS environmentId, backend_id AS backendId, target_ids_json AS targets
    FROM execution_configuration_ownership_conflicts WHERE tenant_id = ? AND owner_principal_id = ?`).all(scope.tenantId, scope.principalId) as {
      environmentId: string; backendId: string; targets: string;
    }[];
  for (const conflict of conflicts) {
    if (!document.backends.some(b => b.id === conflict.backendId && b.enabled)) continue;
    const proof = database.prepare(`SELECT backend_id AS owner FROM execution_configuration_native_owners WHERE tenant_id = ?
      AND owner_principal_id = ? AND environment_id = ? AND namespace = 'antigravity'`).get(scope.tenantId, scope.principalId, conflict.environmentId) as {owner: string | null} | undefined;
    if (!proof || (proof.owner !== null && proof.owner !== conflict.backendId)) {
      throw new DomainError("conflict", "Inspect the retained Antigravity runtime or confirm its retirement before re-enabling this backend.");
    }
    const targets = new Set(JSON.parse(conflict.targets) as string[]);
    for (const target of document.targets) if (target.backendInstanceId === conflict.backendId && targets.has(target.id) && !target.enabled) {
      target.enabled = true;
      restored = true;
    }
    database.prepare(`DELETE FROM execution_configuration_ownership_conflicts WHERE tenant_id = ?
      AND owner_principal_id = ? AND environment_id = ? AND backend_id = ?`).run(scope.tenantId, scope.principalId, conflict.environmentId, conflict.backendId);
  }
  return restored;
}
