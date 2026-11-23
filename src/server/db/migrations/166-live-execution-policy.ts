import type { ConfigurationDocument, ConfigurationRuntimeState } from "../../../shared/protocol/configuration-admin.js";
import { changedConfigurationEffects } from "../../configuration-admin/configuration-effects.js";
import { environmentFingerprints, writeExecutionPolicy } from "../../configuration-admin/configuration-execution-policy.js";
import { antigravityOwners } from "../../configuration-admin/configuration-ownership.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { DatabaseMigration } from "../migrate.js";

export const liveExecutionPolicyMigration: DatabaseMigration = {
  version: 166, name: "live_execution_policy",
  sql: `
CREATE TABLE live_execution_policies (
  tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0), snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  digest TEXT NOT NULL CHECK(length(digest) = 64), last_generation INTEGER NOT NULL CHECK(last_generation >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, environment_id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id)
) STRICT;
CREATE TABLE execution_policy_recovery_fences (
  tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, environment_id TEXT NOT NULL, incarnation TEXT NOT NULL,
  desired_revision INTEGER NOT NULL CHECK (desired_revision > 0), desired_digest TEXT NOT NULL CHECK (length(desired_digest) = 64),
  installed_revision INTEGER NOT NULL CHECK (installed_revision > 0), installed_digest TEXT NOT NULL CHECK (length(installed_digest) = 64),
  PRIMARY KEY (tenant_id, owner_principal_id, environment_id, incarnation),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id)
) STRICT;
CREATE TABLE execution_configuration_ownership_conflicts (
  tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, environment_id TEXT NOT NULL, backend_id TEXT NOT NULL,
  target_ids_json TEXT NOT NULL CHECK(json_valid(target_ids_json)),
  PRIMARY KEY(tenant_id, owner_principal_id, environment_id, backend_id),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id)
) STRICT;
CREATE TABLE execution_configuration_native_owners (
  tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL, environment_id TEXT NOT NULL, namespace TEXT NOT NULL, backend_id TEXT,
  PRIMARY KEY(tenant_id, owner_principal_id, environment_id, namespace),
  FOREIGN KEY (tenant_id, owner_principal_id) REFERENCES principals(tenant_id, id)
) STRICT;
-- Historical host confirmations cannot be reconstructed. Keep request digests, results and replay identities intact.
UPDATE execution_configuration_runtime_state SET state_json = json_set(state_json, '$.effects', json('[]'));
UPDATE execution_configuration_receipts SET result_json = json_set(result_json, '$.runtime.effects', json('[]')) WHERE operation = 'lifecycle';
UPDATE execution_configuration_receipts SET result_json = json_set(result_json, '$.runtimes', (
  SELECT json_group_array(json_set(value, '$.effects', json('[]'))) FROM json_each(result_json, '$.runtimes')
)) WHERE operation = 'save';
UPDATE host_pairing_receipts SET result_json = json_set(result_json, '$.configuration.runtimes', (
  SELECT json_group_array(json_set(value, '$.effects', json('[]'))) FROM json_each(result_json, '$.configuration.runtimes')
)) WHERE operation IN ('accept', 'revoke', 'reapprove');
`,
  convertRows(database) {
    const rows = database.prepare(`SELECT tenant_id AS tenantId, owner_principal_id AS principalId, revision, configuration_json AS configuration
      FROM principal_execution_configuration`).all() as (RequestScope & {revision: number; configuration: string})[];
    for (const row of rows) {
      const document = JSON.parse(row.configuration) as ConfigurationDocument;
      let repaired = false;
      for (const [environmentId, ids] of antigravityOwners(document)) {
        if (ids.length < 2) continue;
        // Pre-166 installations have no durable native-owner proof. Retain every runtime and reservation for exact inspection/cleanup.
        for (const id of ids) {
          const backend = document.backends.find(b => b.id === id)!;
          backend.enabled = false;
          const enabledTargets = document.targets.filter(t => t.backendInstanceId === id && t.enabled);
          database.prepare(`INSERT INTO execution_configuration_ownership_conflicts VALUES (?, ?, ?, ?, ?)`)
            .run(row.tenantId, row.principalId, environmentId, id, JSON.stringify(enabledTargets.map(t => t.id)));
          database.prepare(`UPDATE agent_backend_instances SET enabled = 0, configuration_revision = configuration_revision + 1
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ? AND enabled = 1`).run(row.tenantId, row.principalId, id);
          for (const target of enabledTargets) {
            target.enabled = false;
            if (document.defaultTargetId === target.id) document.defaultTargetId = null;
            database.prepare(`UPDATE agent_connection_profiles SET enabled = 0, configuration_revision = configuration_revision + 1
              WHERE tenant_id = ? AND owner_principal_id = ? AND template_id = ? AND enabled = 1`).run(row.tenantId, row.principalId, target.id);
          }
          const current = database.prepare(`SELECT state_json AS state FROM execution_configuration_runtime_state WHERE
            tenant_id = ? AND owner_principal_id = ? AND resource_kind = 'backend' AND resource_id = ?`).get(row.tenantId, row.principalId, id) as {state: string} | undefined;
          if (current) {
            const runtime = JSON.parse(current.state) as ConfigurationRuntimeState;
            runtime.desiredRevision = row.revision + 1;
            runtime.applyState = "pending";
            runtime.effects = [{ component: "ownership", subjectId: id, state: "failed", desiredRevision: runtime.desiredRevision,
              effectiveRevision: null, detail: "Conflicting Antigravity definitions were disabled. Inspect the retained runtime to establish ownership." }];
            database.prepare(`UPDATE execution_configuration_runtime_state SET state_json = ? WHERE tenant_id = ? AND owner_principal_id = ?
              AND resource_kind = 'backend' AND resource_id = ?`).run(JSON.stringify(runtime), row.tenantId, row.principalId, id);
          }
        }
        repaired = true;
      }
      if (repaired) database.prepare(`UPDATE principal_execution_configuration SET revision = revision + 1, configuration_json = ?
        WHERE tenant_id = ? AND owner_principal_id = ?`).run(JSON.stringify(document), row.tenantId, row.principalId);
      const liveRows = database.prepare(`SELECT state_json AS state FROM execution_configuration_runtime_state
        WHERE tenant_id = ? AND owner_principal_id = ?`).all(row.tenantId, row.principalId) as {state:string}[];
      for (const {state} of liveRows) {
        const runtime = JSON.parse(state) as ConfigurationRuntimeState;
        if (runtime.effects?.some(effect => effect.component === "ownership")) continue;
        const empty: ConfigurationDocument = {executionEnvironments:[], backends:[], targets:[], defaultTargetId:null, webSearch:null};
        runtime.effects = changedConfigurationEffects(row, empty, document, runtime.resourceKind, runtime.resourceId,
          runtime.desiredRevision, undefined) ?? [];
        // Earlier aggregate observations describe the old negotiated controller. Only a new-wire confirmation
        // can establish the current remote grant, even when the historical aggregate happened to match.
        if (runtime.effects.some(effect => effect.state === "awaiting_host")) {
          runtime.effectiveRevision = null;
          if (runtime.applyState === "applied") runtime.applyState = "pending";
        }
        database.prepare(`UPDATE execution_configuration_runtime_state SET state_json = ? WHERE tenant_id = ? AND owner_principal_id = ?
          AND resource_kind = ? AND resource_id = ?`).run(JSON.stringify(runtime), row.tenantId, row.principalId, runtime.resourceKind, runtime.resourceId);
      }
      for (const environment of document.executionEnvironments) {
        const args = [row.tenantId, row.principalId, environment.id];
        const snapshot = writeExecutionPolicy(database, row, environment.id, document);
        const { fingerprint, operationsFingerprint } = environmentFingerprints(environment, snapshot);
        database.prepare(`UPDATE execution_environments SET configuration_fingerprint = ?, operations_configuration_fingerprint = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`).run(fingerprint, operationsFingerprint, ...args);
      }
    }
  },
};
