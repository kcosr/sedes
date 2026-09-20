import type Database from "better-sqlite3";
import type { ConfigurationDocument } from "../../shared/protocol/configuration-admin.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { DomainError } from "../domain/errors.js";

/** Pairing is reserved by enrollment, never manufactured by a whole-document save. */
export function assertOutboundPairingReferences(database: Database.Database, scope: RequestScope,
  document: ConfigurationDocument, previous?: ConfigurationDocument): void {
  for (const environment of document.executionEnvironments) {
    if (environment.kind !== "outbound") continue;
    const pairing = database.prepare(`SELECT environment_id AS environmentId, platform, state FROM host_pairings
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
      .get(scope.tenantId, scope.principalId, environment.pairingId) as { environmentId: string; platform: string; state: string } | undefined;
    if (!pairing || pairing.environmentId !== environment.id || pairing.platform !== environment.platform) {
      throw new DomainError("conflict", "The outbound environment requires its exact approved pairing and platform.");
    }
    if (previous && pairing.state === "revoked" && !previous.executionEnvironments.some(item => item.id === environment.id)) {
      throw new DomainError("conflict", "A removed revoked environment cannot be restored through configuration save.");
    }
  }
  for (const environment of previous?.executionEnvironments ?? []) {
    if (environment.kind !== "outbound" || document.executionEnvironments.some(item => item.id === environment.id)) continue;
    const pairing = database.prepare(`SELECT state FROM host_pairings WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
      .get(scope.tenantId, scope.principalId, environment.pairingId) as { state: string } | undefined;
    if (pairing?.state !== "revoked") throw new DomainError("conflict", "Revoke the host pairing before removing its environment.");
  }
}
