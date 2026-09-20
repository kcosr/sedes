import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import type { DomainError } from "../../src/server/domain/errors.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";

const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [{ id: "019196f7-a0a8-7bc4-a89b-8cf013978405", kind: "local", label: "Local" }],
  backends: [{ id: "pi-primary", kind: "pi", label: "Pi", enabled: true, modelPolicy: { type: "catalog" } }],
  targets: [{ id: "local-primary", kind: "pi_sdk", label: "Local", backendInstanceId: "pi-primary", executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405", enabled: true }],
  defaultTargetId: "local-primary",
});

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describe("task create fingerprint migration", () => {
  it("rewrites escaped legacy creates, preserves other receipts, and restores strict replay", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      applyBackendNormalizationMigration(database, {
        configuration,
        quiescentCutoverConfirmed: true,
        appliedAt: 100,
      });
      applyDatabaseMigrations(
        database,
        backendNormalizedMigrations.filter(({ version }) => version <= 43),
      );
      const id = "10000000-0000-4000-8000-000000000001";
      const mutationId = "10000000-0000-4000-8000-000000000002";
      const record = {
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        id,
        scopeKind: "global" as const,
        environmentId: null,
        workspaceId: null,
        threadId: null,
        title: "Quote \" and slash \\",
        details: "Line one\nline two\t雪",
        pinned: true,
        files: ["/tmp/quote-\".md", "/tmp/雪.txt"],
        completedAt: null,
        revision: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
      };
      database.prepare(`
        INSERT INTO tasks(
          tenant_id, owner_principal_id, id, scope_kind, environment_id,
          workspace_id, thread_id, title, details, pinned, files_json,
          completed_at, revision, created_at, updated_at
        ) VALUES (?, ?, ?, 'global', NULL, NULL, NULL, ?, ?, 1, ?, NULL, 0, ?, ?)
      `).run(scope.tenantId, scope.principalId, id, record.title, record.details, JSON.stringify(record.files), record.createdAt, record.updatedAt);
      const legacyFingerprint = hash(["create_task", record.title, "global"]);
      database.prepare(`
        INSERT INTO task_mutation_receipts(
          tenant_id, principal_id, mutation_id, operation_kind,
          request_fingerprint, result_json, created_at
        ) VALUES (?, ?, ?, 'create_task', ?, ?, ?)
      `).run(scope.tenantId, scope.principalId, mutationId, legacyFingerprint, JSON.stringify({ version: 1, record }), 1_000);
      const otherMutationId = "10000000-0000-4000-8000-000000000003";
      const otherFingerprint = "a".repeat(64);
      database.prepare(`
        INSERT INTO task_mutation_receipts(
          tenant_id, principal_id, mutation_id, operation_kind,
          request_fingerprint, result_json, created_at
        ) VALUES (?, ?, ?, 'update_task', ?, ?, ?)
      `).run(scope.tenantId, scope.principalId, otherMutationId, otherFingerprint, JSON.stringify({ version: 1, record }), 1_100);
      const moveMutationId = "10000000-0000-4000-8000-000000000004";
      const moveFingerprint = "b".repeat(64);
      database.prepare(`
        INSERT INTO task_mutation_receipts(
          tenant_id, principal_id, mutation_id, operation_kind,
          request_fingerprint, result_json, created_at
        ) VALUES (?, ?, ?, 'move_task', ?, ?, ?)
      `).run(scope.tenantId, scope.principalId, moveMutationId, moveFingerprint, JSON.stringify({ version: 1, record }), 1_200);

      applyDatabaseMigrations(database, backendNormalizedMigrations);

      const receipt = database.prepare(`
        SELECT request_fingerprint AS fingerprint FROM task_mutation_receipts
        WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
      `).get(scope.tenantId, scope.principalId, mutationId) as { fingerprint: string };
      expect(receipt.fingerprint).toBe(
        hash(["create_task", record.title, record.details, true, record.files, "global"]),
      );
      expect(
        database.prepare(`SELECT request_fingerprint AS fingerprint FROM task_mutation_receipts WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?`).get(scope.tenantId, scope.principalId, otherMutationId),
      ).toEqual({ fingerprint: otherFingerprint });
      expect(
        database.prepare(`SELECT request_fingerprint AS fingerprint FROM task_mutation_receipts WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?`).get(scope.tenantId, scope.principalId, moveMutationId),
      ).toEqual({ fingerprint: moveFingerprint });

      const tasks = new TaskRepository(database);
      expect(tasks.create(scope, {
        title: record.title,
        details: record.details,
        pinned: true,
        files: record.files,
        scope: { kind: "global" },
        mutationId,
        now: 2_000,
      })).toEqual(record);
      expect(() => tasks.create(scope, {
        title: record.title,
        details: `${record.details}!`,
        pinned: true,
        files: record.files,
        scope: { kind: "global" },
        mutationId,
        now: 3_000,
      })).toThrow(expect.objectContaining<Partial<DomainError>>({ code: "conflict" }));
    } finally {
      database.close();
    }
  });

  it("hashes a legacy lone surrogate exactly while new inputs reject it", () => {
    const database = openOverlayDatabase(":memory:");
    try {
      const scope = new SingleUserIdentityProvider(database).getScope();
      applyBackendNormalizationMigration(database, {
        configuration,
        quiescentCutoverConfirmed: true,
        appliedAt: 100,
      });
      applyDatabaseMigrations(
        database,
        backendNormalizedMigrations.filter(({ version }) => version <= 43),
      );
      const mutationId = "10000000-0000-4000-8000-000000000010";
      const legacyFingerprint = hash(["create_task", "bad\ud800title", "global"]);
      const record = {
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        id: "10000000-0000-4000-8000-000000000011",
        scopeKind: "global",
        environmentId: null,
        workspaceId: null,
        threadId: null,
        title: "bad\ud800title",
        details: "",
        pinned: false,
        files: [],
        completedAt: null,
        revision: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
      };
      database.prepare(`
        INSERT INTO task_mutation_receipts(
          tenant_id, principal_id, mutation_id, operation_kind,
          request_fingerprint, result_json, created_at
        ) VALUES (?, ?, ?, 'create_task', ?, ?, ?)
      `).run(
        scope.tenantId,
        scope.principalId,
        mutationId,
        legacyFingerprint,
        JSON.stringify({ version: 1, record }),
        1_000,
      );

      applyDatabaseMigrations(database, backendNormalizedMigrations);
      expect(
        database.prepare(
          "SELECT request_fingerprint AS fingerprint FROM task_mutation_receipts WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?",
        ).get(scope.tenantId, scope.principalId, mutationId),
      ).toEqual({
        fingerprint: hash([
          "create_task",
          record.title,
          record.details,
          record.pinned,
          record.files,
          "global",
        ]),
      });
      expect(
        database.prepare(
          "SELECT 1 FROM schema_migrations WHERE version = 44",
        ).get(),
      ).toEqual({ 1: 1 });
      expect(() =>
        new TaskRepository(database).create(scope, {
          title: record.title,
          scope: { kind: "global" },
          mutationId,
          now: 2_000,
        }),
      ).toThrow(/well-formed UTF-16/);
    } finally {
      database.close();
    }
  });
});
