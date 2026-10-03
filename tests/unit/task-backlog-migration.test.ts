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
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";

const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [{ id: "019196f7-a0a8-7bc4-a89b-8cf013978405", kind: "local", label: "Local" }],
  backends: [{ id: "pi-primary", kind: "pi", label: "Pi", enabled: true, modelPolicy: { type: "catalog" } }],
  targets: [{ id: "local-primary", kind: "pi_sdk", label: "Local", backendInstanceId: "pi-primary", executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405", enabled: true }],
  defaultTargetId: "local-primary",
});

const OPEN_PINNED = "10000000-0000-4000-8000-000000000001";
const COMPLETED_PINNED = "10000000-0000-4000-8000-000000000002";
const COMPLETED = "10000000-0000-4000-8000-000000000003";
const CREATE_MUTATION = "20000000-0000-4000-8000-000000000001";

function fingerprint(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function migratedTo127() {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 100,
  });
  applyDatabaseMigrations(
    database,
    backendNormalizedMigrations.filter(({ version }) => version <= 127),
  );
  const insert = database.prepare(`
    INSERT INTO tasks(
      tenant_id, owner_principal_id, id, scope_kind, project_id, thread_id,
      title, details, pinned, files_json, completed_at, revision, created_at,
      updated_at
    ) VALUES (?, ?, ?, 'global', NULL, NULL, ?, '', ?, '[]', ?, ?, 1000, 2000)
  `);
  insert.run(scope.tenantId, scope.principalId, OPEN_PINNED, "Open pinned", 1, null, 3);
  insert.run(scope.tenantId, scope.principalId, COMPLETED_PINNED, "Completed pinned", 1, 1500, 4);
  insert.run(scope.tenantId, scope.principalId, COMPLETED, "Completed", 0, 1500, 5);
  const record = {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    id: OPEN_PINNED,
    scopeKind: "global",
    projectId: null,
    threadId: null,
    title: "Open pinned",
    details: "",
    pinned: true,
    files: [],
    completedAt: null,
    revision: 0,
    createdAt: 1000,
    updatedAt: 1000,
  };
  const receipt = database.prepare(`
    INSERT INTO task_mutation_receipts(
      tenant_id, principal_id, mutation_id, operation_kind,
      request_fingerprint, result_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1000)
  `);
  receipt.run(
    scope.tenantId,
    scope.principalId,
    CREATE_MUTATION,
    "create_task",
    fingerprint(["create_task", "Open pinned", "", true, [], "global"]),
    JSON.stringify({ version: 1, record }),
  );
  for (const [index, kind] of ["update_task", "move_task"].entries()) {
    receipt.run(
      scope.tenantId,
      scope.principalId,
      `20000000-0000-4000-8000-00000000001${index}`,
      kind,
      "a".repeat(64),
      JSON.stringify({ version: 1, record: { ...record, pinned: false } }),
    );
  }
  return { database, scope };
}

describe("task backlog migration", () => {
  it("adds backlog, unpins completed tasks, and keeps receipts replaying", () => {
    const { database, scope } = migratedTo127();
    try {
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      const rows = database
        .prepare(
          `SELECT id, pinned, backlog, revision, updated_at AS updatedAt
           FROM tasks ORDER BY id`,
        )
        .all();
      expect(rows).toEqual([
        { id: OPEN_PINNED, pinned: 1, backlog: 0, revision: 3, updatedAt: 2000 },
        // The pin comes off at a new revision; the update time stays.
        { id: COMPLETED_PINNED, pinned: 0, backlog: 0, revision: 5, updatedAt: 2000 },
        { id: COMPLETED, pinned: 0, backlog: 0, revision: 5, updatedAt: 2000 },
      ]);

      const receipts = database
        .prepare(
          `SELECT operation_kind AS kind, result_json AS resultJson
           FROM task_mutation_receipts ORDER BY mutation_id`,
        )
        .all() as Array<{ kind: string; resultJson: string }>;
      expect(receipts.map(({ kind }) => kind)).toEqual([
        "create_task",
        "update_task",
        "move_task",
      ]);
      for (const { resultJson } of receipts) {
        expect(JSON.parse(resultJson).record.backlog).toBe(false);
      }

      // A pre-upgrade create request without backlog still replays its receipt.
      const replayed = new TaskRepository(database).create(scope, {
        title: "Open pinned",
        details: "",
        pinned: true,
        files: [],
        scope: { kind: "global" },
        mutationId: CREATE_MUTATION,
        now: 9_000,
      });
      expect(replayed).toMatchObject({ id: OPEN_PINNED, pinned: true, backlog: false });
    } finally {
      database.close();
    }
  });

  it("keeps a completed task unpinned and out of the backlog", () => {
    const { database, scope } = migratedTo127();
    try {
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      for (const assignment of ["pinned = 1", "backlog = 1"]) {
        expect(() =>
          database
            .prepare(`UPDATE tasks SET ${assignment} WHERE id = ?`)
            .run(COMPLETED),
        ).toThrow("A completed task cannot be pinned or in the backlog.");
      }
      expect(() =>
        database
          .prepare(`UPDATE tasks SET completed_at = 1600 WHERE id = ?`)
          .run(OPEN_PINNED),
      ).toThrow("A completed task cannot be pinned or in the backlog.");
      expect(() =>
        database
          .prepare(`
            INSERT INTO tasks(
              tenant_id, owner_principal_id, id, scope_kind, title, backlog,
              completed_at, created_at, updated_at
            ) VALUES (?, ?, ?, 'global', 'Done', 1, 1000, 1000, 1000)
          `)
          .run(scope.tenantId, scope.principalId, "10000000-0000-4000-8000-000000000009"),
      ).toThrow("A completed task cannot be pinned or in the backlog.");
      database
        .prepare(`UPDATE tasks SET pinned = 0, completed_at = 1600 WHERE id = ?`)
        .run(OPEN_PINNED);
      database
        .prepare(`UPDATE tasks SET completed_at = NULL, backlog = 1 WHERE id = ?`)
        .run(COMPLETED);
    } finally {
      database.close();
    }
  });
});
