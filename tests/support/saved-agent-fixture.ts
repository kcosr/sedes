import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { parseResolvedBackendConfiguration } from "./resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { SingleUserIdentityProvider, type RequestScope } from "../../src/server/identity/identity-provider.js";
import { convertLegacyConfiguration } from "../../src/server/config/legacy-configuration-import.js";
import { importLegacyDatabaseConfigurationFixture } from "./database-configuration-fixture.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";

const latestBackendNormalizedVersion =
  backendNormalizedMigrations[backendNormalizedMigrations.length - 1]!.version;

const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [
    {
      id: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      kind: "local",
      label: "Local",
    },
  ],
  backends: [
    {
      id: "pi-primary",
      kind: "pi",
      label: "Primary Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "local-primary",
      kind: "pi_sdk",
      label: "Local Pi",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

export function savedAgentDatabase(
  latestVersion = latestBackendNormalizedVersion,
) {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 100,
  });
  applyDatabaseMigrations(
    database,
    backendNormalizedMigrations.filter(
      (migration) => migration.version <= latestVersion,
    ),
  );
  if (latestVersion === latestBackendNormalizedVersion) {
    importLegacyDatabaseConfigurationFixture(database, {
      configuration, localWorkspaceRoots: ["/tmp"], sourceLabel: "saved-agent-fixture",
    }, 100);
  } else if (latestVersion >= 93) {
    // This fixture contains a single local Pi backend. Its historical desired document already existed
    // alongside the normalized rows, before the live-policy and workspace-grant projections were introduced.
    const {document} = convertLegacyConfiguration({configuration, localWorkspaceRoots:["/tmp"], sourceLabel:"saved-agent-fixture"});
    database.prepare("INSERT INTO principal_execution_configuration (tenant_id,owner_principal_id,revision,configuration_json,updated_at) VALUES (?,?,0,?,100)")
      .run(scope.tenantId,scope.principalId,JSON.stringify(document));
    database.prepare("UPDATE agent_backend_instances SET owner_principal_id = ? WHERE tenant_id = ? AND owner_principal_id IS NULL")
      .run(scope.principalId, scope.tenantId);
  }
  if (latestVersion >= 93) {
    new InventoryRepository(database).updateEnvironmentAvailability(scope, configuration.executionEnvironments[0]!.id, { available: true, now: 100 });
  }
  return { database, scope };
}

type HistoricalWorkspace = {
  readonly id?: string;
  readonly environmentId: string;
  readonly canonicalPath: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly trustState: "trusted" | "untrusted";
  readonly environmentConfigurationRevision: number;
  readonly now: number;
};

/** Schemas 126–166 persisted project membership and an environment counter for each workspace. */
export function insertPreRootGrantWorkspace(database: Database.Database, scope: RequestScope,
  input: HistoricalWorkspace & {readonly project: {readonly kind: "new"; readonly name: string}}) {
  const id = input.id ?? randomUUID();
  const projectId = randomUUID();
  return database.transaction(() => {
    database.prepare(`INSERT INTO projects(tenant_id, owner_principal_id, id, name, revision, membership_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?)`).run(scope.tenantId, scope.principalId, projectId, input.project.name, input.now, input.now);
    database.prepare(`INSERT INTO workspaces(tenant_id, owner_principal_id, environment_id, id, project_id, canonical_path,
      display_name, availability, trust_state, revision, environment_configuration_revision, last_opened_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`).run(scope.tenantId, scope.principalId, input.environmentId, id, projectId,
      input.canonicalPath, input.displayName, input.available ? "available" : "unavailable", input.trustState,
      input.environmentConfigurationRevision, input.now, input.now, input.now);
    return {id, projectId, environmentId: input.environmentId, canonicalPath: input.canonicalPath};
  })();
}

/**
 * Seeds a workspace into a database built before migration 126, when a
 * workspace had no project. Current schemas admit workspaces through
 * InventoryRepository.upsertWorkspace instead.
 */
export function insertPreProjectWorkspace(
  database: Database.Database,
  scope: RequestScope,
  input: HistoricalWorkspace,
): { readonly id: string; readonly environmentId: string; readonly canonicalPath: string } {
  const id = input.id ?? randomUUID();
  database.prepare(`
    INSERT INTO workspaces(
      tenant_id, owner_principal_id, environment_id, id, canonical_path,
      display_name, availability, trust_state, revision,
      environment_configuration_revision, last_opened_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(
    scope.tenantId, scope.principalId, input.environmentId, id,
    input.canonicalPath, input.displayName,
    input.available ? "available" : "unavailable", input.trustState,
    input.environmentConfigurationRevision, input.now, input.now, input.now,
  );
  return { id, environmentId: input.environmentId, canonicalPath: input.canonicalPath };
}
