import { describe, expect, it } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { randomUUID } from "node:crypto";
import { importLegacyDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import { convertLegacyConfiguration } from "../../src/server/config/legacy-configuration-import.js";

const localEnvironmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";

function configuration(modelPolicy: unknown) {
  return parseResolvedBackendConfiguration({
    schemaVersion: 10,
    executionEnvironments: [
      { id: localEnvironmentId, kind: "local", label: "Local" },
    ],
    backends: [
      {
        id: "pi-primary",
        kind: "pi",
        label: "Pi",
        enabled: true,
        modelPolicy,
      },
    ],
    targets: [
      {
        id: "pi-local",
        kind: "pi_sdk",
        label: "Pi local",
        backendInstanceId: "pi-primary",
        executionEnvironmentId: localEnvironmentId,
        enabled: true,
      },
    ],
    defaultTargetId: "pi-local",
  });
}

describe("backend model-policy reconciliation", () => {
  it("revisions a backend with absent module configuration after a policy-only edit", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      applyBackendNormalizationMigration(database, {
        configuration: configuration({ type: "catalog" }),
        quiescentCutoverConfirmed: true,
        appliedAt: 50,
      });
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      const repository = new BackendConfigurationRepository(database);
      const fixture = importLegacyDatabaseConfigurationFixture(database, {
        configuration: configuration({ type: "catalog" }), localWorkspaceRoots: ["/tmp"], sourceLabel: "backend-model-policy",
      }, 100);
      const before = repository.getBackend(scope, "pi-primary");

      const { document } = convertLegacyConfiguration({
        configuration: configuration({
          type: "allowlist",
          allowed: [{ providerIds: ["xai"], modelIds: ["grok-4.5"] }],
        }),
        localWorkspaceRoots: ["/tmp"], sourceLabel: "backend-model-policy-edit",
      });
      fixture.repository.save(scope, { mutationId: randomUUID(), expectedRevision: 0, configuration: document }, next => fixture.projection.project(scope, next));
      const after = repository.getBackend(scope, "pi-primary");

      expect(after.configurationRevision).toBe(
        before.configurationRevision + 1,
      );
      expect(after.configurationFingerprint).not.toBe(
        before.configurationFingerprint,
      );
    } finally {
      database.close();
    }
  });
});
