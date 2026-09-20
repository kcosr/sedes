import { parseResolvedBackendConfiguration } from "./resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
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
  if (latestVersion >= 93) {
    importLegacyDatabaseConfigurationFixture(database, {
      configuration, localWorkspaceRoots: ["/tmp"], sourceLabel: "saved-agent-fixture",
    }, 100);
    new InventoryRepository(database).updateEnvironmentAvailability(scope, configuration.executionEnvironments[0]!.id, { available: true, now: 100 });
  }
  return { database, scope };
}
