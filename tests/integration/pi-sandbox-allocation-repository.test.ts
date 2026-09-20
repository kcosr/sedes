import { describe, expect, it } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { PiSandboxAllocationRepository } from "../../src/server/pi-sandbox/pi-sandbox-allocation-repository.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";

const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [{ id: environmentId, kind: "local", label: "Local" }],
  backends: [{
    id: "pi-primary",
    kind: "pi",
    label: "Pi",
    enabled: true,
    modelPolicy: { type: "catalog" },
  }],
  targets: [{
    id: "local-primary",
    kind: "pi_sdk",
    label: "Local Pi",
    backendInstanceId: "pi-primary",
    executionEnvironmentId: environmentId,
    enabled: true,
  }],
  defaultTargetId: "local-primary",
});

function fixture() {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(scope);
  const workspace = legacy.rememberWorkspace(scope, {
    environmentId: environment.id,
    canonicalPath: "/tmp/pi-sandbox-source",
    displayName: "Source",
    availability: "available",
    trustState: "trusted",
  }, 100);
  const thread = legacy.createThread(scope, { workspaceId: workspace.id, title: "Sandbox" }, 200);
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(database, backendNormalizedMigrations);
  return {
    database,
    scope,
    workspaceId: workspace.id,
    threadId: thread.thread.id,
    repository: new PiSandboxAllocationRepository(database),
  };
}

const allocationId = "00000000-0000-4000-8000-000000000001";
const operationOne = "00000000-0000-4000-8000-000000000002";
const operationTwo = "00000000-0000-4000-8000-000000000003";

describe("PiSandboxAllocationRepository", () => {
  it("reserves one exact principal-scoped allocation and replays the same selection", () => {
    const current = fixture();
    try {
      const input = {
        applicationThreadId: current.threadId,
        allocationId,
        executionEnvironmentId: environmentId,
        sourceWorkspaceId: current.workspaceId,
        sourceCanonicalPath: "/tmp/pi-sandbox-source",
        allocationRootPath: `/tmp/allocations/${allocationId}`,
        homePath: `/tmp/allocations/${allocationId}/home`,
        workspacePath: `/tmp/allocations/${allocationId}/home/workspace`,
        workspaceAccess: "writable_clone" as const,
        networkProfile: "isolated" as const,
        now: 400,
      };
      const reserved = current.repository.reserve(current.scope, input);
      expect(reserved).toMatchObject({
        allocationId,
        state: "reserved",
        retention: "active",
        revision: 0,
      });
      expect(current.repository.reserve(current.scope, input)).toEqual(reserved);
      expect(
        current.repository.getForThread(
          { ...current.scope, principalId: "another-principal" },
          current.threadId,
        ),
      ).toBeUndefined();
      expect(
        current.repository.getForThread(
          { ...current.scope, tenantId: "another-tenant" },
          current.threadId,
        ),
      ).toBeUndefined();
      expect(() =>
        current.repository.reserve(current.scope, {
          ...input,
          allocationId: "00000000-0000-4000-8000-000000000099",
        }),
      ).toThrow(/another sandbox allocation/i);
    } finally {
      current.database.close();
    }
  });

  it("persists materialization, retention, failed deletion, and retry transitions", () => {
    const current = fixture();
    try {
      let record = current.repository.reserve(current.scope, {
        applicationThreadId: current.threadId,
        allocationId,
        executionEnvironmentId: environmentId,
        sourceWorkspaceId: current.workspaceId,
        sourceCanonicalPath: "/tmp/pi-sandbox-source",
        allocationRootPath: `/tmp/allocations/${allocationId}`,
        homePath: `/tmp/allocations/${allocationId}/home`,
        workspacePath: `/tmp/allocations/${allocationId}/home/workspace`,
        workspaceAccess: "writable_clone",
        networkProfile: "execution_host",
        now: 400,
      });
      record = current.repository.beginMaterialization(current.scope, current.threadId, {
        expectedRevision: record.revision,
        operationId: operationOne,
        now: 410,
      });
      expect(record).toMatchObject({ state: "materializing", revision: 1 });
      record = current.repository.completeMaterialization(current.scope, current.threadId, {
        operationId: operationOne,
        sourceHeadOid: "a".repeat(40),
        sandboxBranch: "sandbox/thread",
        now: 420,
      });
      expect(record).toMatchObject({ state: "ready", revision: 2, readyAt: 420 });
      record = current.repository.markRetained(current.scope, current.threadId, {
        expectedRevision: record.revision,
        now: 430,
      });
      expect(record).toMatchObject({ retention: "retained", retainedAt: 430, revision: 3 });
      record = current.repository.beginDeletion(current.scope, current.threadId, {
        expectedRevision: record.revision,
        operationId: operationOne,
        now: 440,
      });
      record = current.repository.failDeletion(current.scope, current.threadId, {
        operationId: operationOne,
        diagnosticCode: "filesystem_busy",
        now: 450,
      });
      expect(record).toMatchObject({
        state: "delete_failed",
        retention: "delete_requested",
        diagnosticCode: "filesystem_busy",
        revision: 5,
      });
      record = current.repository.beginDeletion(current.scope, current.threadId, {
        expectedRevision: record.revision,
        operationId: operationTwo,
        now: 460,
      });
      record = current.repository.completeDeletion(current.scope, current.threadId, {
        operationId: operationTwo,
        now: 470,
      });
      expect(record).toMatchObject({
        state: "deleted",
        retention: "delete_requested",
        completedDeleteOperationId: operationTwo,
        deletedAt: 470,
        revision: 7,
      });
      expect(
        current.repository.beginDeletion(current.scope, current.threadId, {
          expectedRevision: 5,
          operationId: operationTwo,
          now: 480,
        }),
      ).toEqual(record);
      expect(current.repository.listRecoverable(current.scope)).toEqual([]);
    } finally {
      current.database.close();
    }
  });

  it("reconciles interrupted external operations to retryable failed states", () => {
    const current = fixture();
    try {
      const reserved = current.repository.reserve(current.scope, {
        applicationThreadId: current.threadId,
        allocationId,
        executionEnvironmentId: environmentId,
        sourceWorkspaceId: current.workspaceId,
        sourceCanonicalPath: "/tmp/pi-sandbox-source",
        allocationRootPath: `/tmp/allocations/${allocationId}`,
        homePath: `/tmp/allocations/${allocationId}/home`,
        workspacePath: `/tmp/allocations/${allocationId}/home/workspace`,
        workspaceAccess: "writable_clone",
        networkProfile: "isolated",
        now: 400,
      });
      current.repository.beginMaterialization(current.scope, current.threadId, {
        expectedRevision: reserved.revision,
        operationId: operationOne,
        now: 410,
      });
      expect(
        current.repository.reconcileInterruptedOperations(current.scope, {
          now: 500,
        }),
      ).toEqual([
        expect.objectContaining({
          state: "materialization_failed",
          operationId: null,
          diagnosticCode: "materialization_interrupted",
          revision: 2,
        }),
      ]);
      expect(
        current.repository.reconcileInterruptedOperations(current.scope, {
          now: 600,
        }),
      ).toEqual([]);
    } finally {
      current.database.close();
    }
  });
});
