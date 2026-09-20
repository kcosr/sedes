import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
} from "../../src/server/db/migrate.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import type { DomainError } from "../../src/server/domain/errors.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import {
  TASK_DETAILS_MAX_CHARACTERS,
  TASK_FILES_MAX_COUNT,
  TASK_FILE_MAX_PATH_BYTES,
} from "../../src/shared/index.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";

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
      label: "Primary Local SDK",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

function fixture(latestVersion = backendNormalizedMigrations.at(-1)!.version) {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(scope);
  const firstWorkspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/tasks-first",
      displayName: "Tasks first",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const secondWorkspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/tasks-second",
      displayName: "Tasks second",
      availability: "available",
      trustState: "trusted",
    },
    110,
  );
  const firstThread = legacy.createThread(
    scope,
    { workspaceId: firstWorkspace.id, title: "First thread" },
    200,
  );
  const secondThread = legacy.createThread(
    scope,
    { workspaceId: secondWorkspace.id, title: "Second thread" },
    210,
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(
    database,
    backendNormalizedMigrations.filter(
      (migration) => migration.version <= latestVersion,
    ),
  );
  return {
    database,
    scope,
    environmentId: environment.id,
    firstWorkspaceId: firstWorkspace.id,
    secondWorkspaceId: secondWorkspace.id,
    firstThreadId: firstThread.thread.id,
    secondThreadId: secondThread.thread.id,
    tasks: new TaskRepository(database),
    bindings: new ConversationBindingRepository(database),
    inventory: new InventoryRepository(database),
  };
}

function domainError(code: DomainError["code"]) {
  return expect.objectContaining<Partial<DomainError>>({ code });
}

describe("task repository", () => {
  it("resolves bounded environment authority for every task scope", () => {
    const current = fixture();
    try {
      const remoteEnvironmentId = "019196f7-a0a8-7bc4-a89b-8cf013978499";
      current.database
        .prepare(
          `
            INSERT INTO execution_environments(
              tenant_id, owner_principal_id, id, kind, label, availability,
              diagnostic_code, revision, configuration_revision,
              configuration_fingerprint, created_at, updated_at
            )
            SELECT tenant_id, owner_principal_id, ?, 'ssh', 'Remote',
              availability, diagnostic_code, revision,
              configuration_revision, configuration_fingerprint,
              created_at, updated_at
            FROM execution_environments
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .run(
          remoteEnvironmentId,
          current.scope.tenantId,
          current.scope.principalId,
          current.environmentId,
        );

      expect(
        current.tasks.resolveScopeEnvironmentIds(
          current.scope,
          { kind: "global" },
          "exact",
        ),
      ).toEqual([]);
      expect(
        current.tasks.resolveScopeEnvironmentIds(
          current.scope,
          { kind: "global" },
          "subtree",
        ),
      ).toEqual([current.environmentId, remoteEnvironmentId].sort());
      expect(
        current.tasks.resolveScopeEnvironmentIds(
          current.scope,
          { kind: "workspace", workspaceId: current.firstWorkspaceId },
          "subtree",
        ),
      ).toEqual([current.environmentId]);
      expect(
        current.tasks.resolveScopeEnvironmentIds(
          current.scope,
          { kind: "thread", threadId: current.firstThreadId },
          "exact",
        ),
      ).toEqual([current.environmentId]);

      const globalTask = current.tasks.create(current.scope, {
        title: "Global authority",
        scope: { kind: "global" },
        mutationId: "global-authority",
        now: 1_000,
      });
      const workspaceTask = current.tasks.create(current.scope, {
        title: "Workspace authority",
        scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
        mutationId: "workspace-authority",
        now: 1_001,
      });
      const threadTask = current.tasks.create(current.scope, {
        title: "Thread authority",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "thread-authority",
        now: 1_002,
      });
      expect(
        current.tasks.resolveTaskEnvironmentAuthority(
          current.scope,
          globalTask.id,
        ),
      ).toMatchObject({
        scopeKind: "global",
        environmentId: null,
        revision: 0,
      });
      expect(
        current.tasks.resolveTaskEnvironmentAuthority(
          current.scope,
          workspaceTask.id,
        ),
      ).toMatchObject({
        scopeKind: "workspace",
        environmentId: current.environmentId,
      });
      expect(threadTask.environmentId).toBeNull();
      expect(
        current.tasks.resolveTaskEnvironmentAuthority(
          current.scope,
          threadTask.id,
        ),
      ).toMatchObject({
        scopeKind: "thread",
        environmentId: current.environmentId,
      });
    } finally {
      current.database.close();
    }
  });

  it("binds authorized task reads and lists to fresh authority facts", () => {
    const current = fixture();
    try {
      const task = current.tasks.create(current.scope, {
        title: "Authority-bound",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "authority-bound-create",
        now: 1_000,
      });
      const authority = current.tasks.resolveTaskEnvironmentAuthority(
        current.scope,
        task.id,
      );
      expect(
        current.tasks.getWithEnvironmentAuthority(current.scope, authority),
      ).toMatchObject({ id: task.id, title: "Authority-bound" });
      expect(
        current.tasks.listPageWithEnvironmentAuthority(current.scope, {
          taskScope: { kind: "global" },
          scopeMode: "subtree",
          targetEnvironmentIds: [current.environmentId],
          sourceEnvironmentId: current.environmentId,
          policyRevision: 1,
          continuationAuthorityDigest: "a".repeat(64),
          projection: "summary",
          pageSize: 50,
        }).items,
      ).toHaveLength(1);
      expect(() =>
        current.tasks.listPageWithEnvironmentAuthority(current.scope, {
          taskScope: { kind: "global" },
          scopeMode: "subtree",
          targetEnvironmentIds: [],
          sourceEnvironmentId: current.environmentId,
          policyRevision: 1,
          continuationAuthorityDigest: "a".repeat(64),
          projection: "summary",
          pageSize: 50,
        }),
      ).toThrow(domainError("not_found"));

      const globalTask = current.tasks.create(current.scope, {
        title: "Principal-wide authority",
        scope: { kind: "global" },
        mutationId: "global-authority-create",
        now: 1_500,
      });
      expect(
        current.tasks.listPageWithEnvironmentAuthority(current.scope, {
          taskScope: { kind: "global" },
          scopeMode: "exact",
          targetEnvironmentIds: [],
          sourceEnvironmentId: current.environmentId,
          policyRevision: 1,
          continuationAuthorityDigest: "b".repeat(64),
          projection: "summary",
          pageSize: 50,
        }).items,
      ).toEqual([
        expect.objectContaining({
          id: globalTask.id,
          scopeKind: "global",
          associatedWorkspaceId: null,
        }),
      ]);
      expect(() =>
        current.tasks.listPageWithEnvironmentAuthority(current.scope, {
          taskScope: { kind: "global" },
          scopeMode: "exact",
          targetEnvironmentIds: [current.environmentId],
          sourceEnvironmentId: current.environmentId,
          policyRevision: 1,
          continuationAuthorityDigest: "b".repeat(64),
          projection: "summary",
          pageSize: 50,
        }),
      ).toThrow(domainError("not_found"));

      current.tasks.update(current.scope, task.id, {
        title: "Changed after admission",
        expectedRevision: 0,
        mutationId: "authority-bound-update",
        now: 2_000,
      });
      expect(() =>
        current.tasks.getWithEnvironmentAuthority(current.scope, authority),
      ).toThrow(domainError("conflict"));
    } finally {
      current.database.close();
    }
  });

  it("rejects ill-formed UTF-16 before persistence or fingerprinting", () => {
    const current = fixture();
    try {
      for (const input of [
        { title: "bad\ud800title" },
        { title: "Valid", details: "bad\udc00details" },
        { title: "Valid", files: ["/tmp/bad\ud800.txt"] },
      ]) {
        expect(() =>
          current.tasks.create(current.scope, {
            ...input,
            scope: { kind: "global" },
            mutationId: randomUUID(),
            now: 1_000,
          }),
        ).toThrow();
      }
      expect(current.tasks.list(current.scope)).toEqual([]);
    } finally {
      current.database.close();
    }
  });

  it("migrates existing task rows and mutation receipts with default files and pin state", () => {
    const current = fixture(29);
    try {
      const taskId = randomUUID();
      const mutationId = "create-before-task-files-pins";
      const record = {
        tenantId: current.scope.tenantId,
        ownerPrincipalId: current.scope.principalId,
        id: taskId,
        scopeKind: "global",
        environmentId: null,
        workspaceId: null,
        threadId: null,
        title: "Existing task",
        details: "Existing details",
        completedAt: null,
        revision: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
      };
      current.database
        .prepare(
          `
            INSERT INTO tasks(
              tenant_id, owner_principal_id, id, scope_kind, environment_id,
              workspace_id, thread_id, title, details, completed_at, revision,
              created_at, updated_at
            ) VALUES (?, ?, ?, 'global', NULL, NULL, NULL, ?, ?, NULL, 0, ?, ?)
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          taskId,
          record.title,
          record.details,
          record.createdAt,
          record.updatedAt,
        );
      const requestFingerprint = createHash("sha256")
        .update(JSON.stringify(["create_task", record.title, "global"]))
        .digest("hex");
      current.database
        .prepare(
          `
            INSERT INTO task_mutation_receipts(
              tenant_id, principal_id, mutation_id, operation_kind,
              request_fingerprint, result_json, created_at
            ) VALUES (?, ?, ?, 'create_task', ?, ?, ?)
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          mutationId,
          requestFingerprint,
          JSON.stringify({ version: 1, record }),
          1_000,
        );
      const legacyUpdateMutationId = "update-before-task-files-pins";
      const legacyUpdatedRecord = {
        ...record,
        title: "Updated existing task",
        revision: 1,
        updatedAt: 1_500,
      };
      current.database
        .prepare(
          `
            INSERT INTO task_mutation_receipts(
              tenant_id, principal_id, mutation_id, operation_kind,
              request_fingerprint, result_json, created_at
            ) VALUES (?, ?, ?, 'update_task', ?, ?, ?)
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          legacyUpdateMutationId,
          createHash("sha256")
            .update(
              JSON.stringify([
                "update_task",
                taskId,
                legacyUpdatedRecord.title,
                null,
                null,
                0,
              ]),
            )
            .digest("hex"),
          JSON.stringify({ version: 1, record: legacyUpdatedRecord }),
          1_500,
        );

      applyDatabaseMigrations(current.database, backendNormalizedMigrations);

      expect(current.tasks.get(current.scope, taskId)).toMatchObject({
        pinned: false,
        files: [],
      });
      expect(
        current.tasks.create(current.scope, {
          title: record.title,
          details: record.details,
          pinned: false,
          files: [],
          scope: { kind: "global" },
          mutationId,
          now: 2_000,
        }),
      ).toEqual({ ...record, pinned: false, files: [] });
      expect(
        current.tasks.update(current.scope, taskId, {
          title: legacyUpdatedRecord.title,
          expectedRevision: 0,
          mutationId: legacyUpdateMutationId,
          now: 2_500,
        }),
      ).toEqual({ ...legacyUpdatedRecord, pinned: false, files: [] });
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      current.database.close();
    }
  });

  it("migrates existing tasks and receipts before storing and replaying large details", () => {
    const current = fixture(24);
    try {
      const taskId = randomUUID();
      const mutationId = "create-before-large-details-migration";
      const legacyRecord = {
        tenantId: current.scope.tenantId,
        ownerPrincipalId: current.scope.principalId,
        id: taskId,
        scopeKind: "global",
        environmentId: null,
        workspaceId: null,
        threadId: null,
        title: "Large document",
        details: "",
        completedAt: null,
        revision: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
      };
      current.database
        .prepare(
          `
            INSERT INTO tasks(
              tenant_id, owner_principal_id, id, scope_kind, title, details,
              revision, created_at, updated_at
            ) VALUES (?, ?, ?, 'global', ?, '', 0, ?, ?)
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          taskId,
          legacyRecord.title,
          legacyRecord.createdAt,
          legacyRecord.updatedAt,
        );
      current.database
        .prepare(
          `
            INSERT INTO task_mutation_receipts(
              tenant_id, principal_id, mutation_id, operation_kind,
              request_fingerprint, result_json, created_at
            ) VALUES (?, ?, ?, 'create_task', ?, ?, ?)
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          mutationId,
          createHash("sha256")
            .update(JSON.stringify(["create_task", "Large document", "global"]))
            .digest("hex"),
          JSON.stringify({ version: 1, record: legacyRecord }),
          1_000,
        );

      applyDatabaseMigrations(current.database, backendNormalizedMigrations);
      const created = current.tasks.get(current.scope, taskId);

      expect(
        current.tasks.create(current.scope, {
          title: "Large document",
          scope: { kind: "global" },
          mutationId,
          now: 2_000,
        }),
      ).toEqual(created);

      const details = "x".repeat(TASK_DETAILS_MAX_CHARACTERS);
      const updated = current.tasks.update(current.scope, created.id, {
        details,
        expectedRevision: 0,
        mutationId: "update-with-large-details",
        now: 3_000,
      });
      expect(updated.details).toHaveLength(TASK_DETAILS_MAX_CHARACTERS);
      expect(
        current.tasks.update(current.scope, created.id, {
          details,
          expectedRevision: 0,
          mutationId: "update-with-large-details",
          now: 4_000,
        }),
      ).toEqual(updated);

      expect(() =>
        current.database
          .prepare("UPDATE tasks SET details = ? WHERE id = ?")
          .run(`${details}x`, created.id),
      ).toThrow(/CHECK constraint failed/);
      expect(current.database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      current.database.close();
    }
  });

  it("creates tasks in each scope and lists them by creation time with an id tiebreak", () => {
    const current = fixture();
    try {
      const globalTask = current.tasks.create(current.scope, {
        title: "Global task",
        scope: { kind: "global" },
        mutationId: "create-global",
        now: 1_000,
      });
      expect(globalTask).toMatchObject({
        tenantId: current.scope.tenantId,
        ownerPrincipalId: current.scope.principalId,
        scopeKind: "global",
        environmentId: null,
        workspaceId: null,
        threadId: null,
        title: "Global task",
        details: "",
        pinned: false,
        files: [],
        completedAt: null,
        revision: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
      });

      const threadTask = current.tasks.create(current.scope, {
        title: "Thread task",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "create-thread",
        now: 2_000,
      });
      expect(threadTask).toMatchObject({
        scopeKind: "thread",
        environmentId: null,
        workspaceId: null,
        threadId: current.firstThreadId,
      });

      const workspaceTask = current.tasks.create(current.scope, {
        title: "Workspace task",
        scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
        mutationId: "create-workspace",
        now: 3_000,
      });
      expect(workspaceTask).toMatchObject({
        scopeKind: "workspace",
        environmentId: current.environmentId,
        workspaceId: current.firstWorkspaceId,
        threadId: null,
      });

      const tieOne = current.tasks.create(current.scope, {
        title: "Tie one",
        scope: { kind: "global" },
        mutationId: "create-tie-one",
        now: 4_000,
      });
      const tieTwo = current.tasks.create(current.scope, {
        title: "Tie two",
        scope: { kind: "global" },
        mutationId: "create-tie-two",
        now: 4_000,
      });
      expect(current.tasks.list(current.scope).map(({ id }) => id)).toEqual([
        globalTask.id,
        threadTask.id,
        workspaceTask.id,
        ...[tieOne.id, tieTwo.id].sort(),
      ]);
    } finally {
      current.database.close();
    }
  });

  it("replays creation for the same mutation and rejects reuse with different input", () => {
    const current = fixture();
    try {
      const first = current.tasks.create(current.scope, {
        title: "Buy milk",
        scope: { kind: "global" },
        mutationId: "create-replay",
        now: 1_000,
      });
      const replayed = current.tasks.create(current.scope, {
        title: "Buy milk",
        scope: { kind: "global" },
        mutationId: "create-replay",
        now: 2_000,
      });
      expect(replayed).toEqual(first);
      expect(
        current.database.prepare("SELECT COUNT(*) AS count FROM tasks").get(),
      ).toEqual({ count: 1 });

      expect(() =>
        current.tasks.create(current.scope, {
          title: "Different title",
          scope: { kind: "global" },
          mutationId: "create-replay",
          now: 3_000,
        }),
      ).toThrow(domainError("conflict"));
      expect(() =>
        current.tasks.create(current.scope, {
          title: "Buy milk",
          scope: { kind: "thread", threadId: current.firstThreadId },
          mutationId: "create-replay",
          now: 3_000,
        }),
      ).toThrow(domainError("conflict"));
      expect(current.tasks.list(current.scope)).toEqual([first]);
    } finally {
      current.database.close();
    }
  });

  it("creates all useful initial fields atomically and fingerprints them", () => {
    const current = fixture();
    try {
      const created = current.tasks.create(current.scope, {
        title: "Ship it",
        details: "Review both artifacts",
        pinned: true,
        files: ["/tmp/spec.md", "/tmp/report.txt"],
        scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
        mutationId: "create-complete-record",
        now: 1_000,
      });
      expect(created).toMatchObject({
        title: "Ship it",
        details: "Review both artifacts",
        pinned: true,
        files: ["/tmp/spec.md", "/tmp/report.txt"],
        completedAt: null,
        revision: 0,
      });
      expect(
        current.tasks.create(current.scope, {
          title: "Ship it",
          details: "Review both artifacts",
          pinned: true,
          files: ["/tmp/spec.md", "/tmp/report.txt"],
          scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
          mutationId: "create-complete-record",
          now: 2_000,
        }),
      ).toEqual(created);
      expect(() =>
        current.tasks.create(current.scope, {
          title: "Ship it",
          details: "Changed",
          pinned: true,
          files: ["/tmp/spec.md", "/tmp/report.txt"],
          scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
          mutationId: "create-complete-record",
          now: 3_000,
        }),
      ).toThrow(domainError("conflict"));
    } finally {
      current.database.close();
    }
  });

  it("pages scoped task summaries without returning document bodies", () => {
    const current = fixture();
    try {
      const first = current.tasks.create(current.scope, {
        title: "First",
        details: "secret first body",
        files: ["/tmp/one", "/tmp/two"],
        scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
        mutationId: "page-first",
        now: 1_000,
      });
      const second = current.tasks.create(current.scope, {
        title: "Second",
        scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
        mutationId: "page-second",
        now: 2_000,
      });
      current.tasks.create(current.scope, {
        title: "Other workspace",
        scope: { kind: "workspace", workspaceId: current.secondWorkspaceId },
        mutationId: "page-other",
        now: 3_000,
      });
      const pageOne = current.tasks.listPage(current.scope, {
        scopeMode: "exact",
        taskScope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
        projection: "summary",
        pageSize: 1,
      });
      expect(pageOne.items).toEqual([
        expect.objectContaining({ id: first.id, fileCount: 2 }),
      ]);
      expect(pageOne.items[0]).not.toHaveProperty("details");
      expect(pageOne.items[0]).not.toHaveProperty("files");
      expect(pageOne.nextCursor).toBeTruthy();
      expect(
        current.tasks
          .listPage(current.scope, {
            scopeMode: "exact",
            taskScope: {
              kind: "workspace",
              workspaceId: current.firstWorkspaceId,
            },
            projection: "summary",
            pageSize: 1,
            cursor: pageOne.nextCursor,
          })
          .items.map(({ id }) => id),
      ).toEqual([second.id]);
      expect(() =>
        current.tasks.listPage(current.scope, {
          scopeMode: "exact",
          taskScope: {
            kind: "workspace",
            workspaceId: current.secondWorkspaceId,
          },
          projection: "summary",
          pageSize: 1,
          cursor: pageOne.nextCursor,
        }),
      ).toThrow(domainError("cursor_invalid"));
    } finally {
      current.database.close();
    }
  });

  it("uses the ID tie-breaker and isolates task cursors by page size and projection", () => {
    const current = fixture();
    try {
      const firstCreated = current.tasks.create(current.scope, {
        title: "Same-time first create",
        scope: { kind: "global" },
        mutationId: "same-time-first",
        now: 1_000,
      });
      const secondCreated = current.tasks.create(current.scope, {
        title: "Same-time second create",
        scope: { kind: "global" },
        mutationId: "same-time-second",
        now: 1_000,
      });
      const orderedIds = [firstCreated.id, secondCreated.id].sort(
        (left, right) => left.localeCompare(right),
      );

      const pageOne = current.tasks.listPage(current.scope, {
        scopeMode: "exact",
        taskScope: { kind: "global" },
        projection: "summary",
        pageSize: 1,
      });
      expect(pageOne.items.map(({ id }) => id)).toEqual([orderedIds[0]]);
      expect(pageOne.nextCursor).toBeTruthy();

      expect(() =>
        current.tasks.listPage(current.scope, {
          taskScope: { kind: "global" },
          scopeMode: "subtree",
          projection: "summary",
          pageSize: 1,
          cursor: pageOne.nextCursor,
        }),
      ).toThrow(domainError("cursor_invalid"));
      expect(() =>
        current.tasks.listPage(current.scope, {
          scopeMode: "exact",
          taskScope: { kind: "global" },
          projection: "summary",
          pageSize: 2,
          cursor: pageOne.nextCursor,
        }),
      ).toThrow(domainError("cursor_invalid"));
      expect(() =>
        current.tasks.listPage(current.scope, {
          scopeMode: "exact",
          taskScope: { kind: "global" },
          projection: "full",
          pageSize: 1,
          cursor: pageOne.nextCursor,
        }),
      ).toThrow(domainError("cursor_invalid"));

      const pageTwo = current.tasks.listPage(current.scope, {
        scopeMode: "exact",
        taskScope: { kind: "global" },
        projection: "summary",
        pageSize: 1,
        cursor: pageOne.nextCursor,
      });
      expect(pageTwo.items.map(({ id }) => id)).toEqual([orderedIds[1]]);
      expect(pageTwo.nextCursor).toBeUndefined();
    } finally {
      current.database.close();
    }
  });

  it("lists global and thread pages with create defaults and denies foreign scope", () => {
    const current = fixture();
    try {
      const global = current.tasks.create(current.scope, {
        title: "Global default fields",
        scope: { kind: "global" },
        mutationId: "page-global-defaults",
        now: 1_000,
      });
      const thread = current.tasks.create(current.scope, {
        title: "Thread task",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "page-thread",
        now: 2_000,
      });
      expect(global).toMatchObject({ details: "", pinned: false, files: [] });
      expect(
        current.tasks
          .listPage(current.scope, {
            scopeMode: "exact",
            taskScope: { kind: "global" },
            projection: "summary",
            pageSize: 50,
          })
          .items.map(({ id }) => id),
      ).toEqual([global.id]);
      expect(
        current.tasks
          .listPage(current.scope, {
            scopeMode: "exact",
            taskScope: { kind: "thread", threadId: current.firstThreadId },
            projection: "summary",
            pageSize: 50,
          })
          .items.map(({ id }) => id),
      ).toEqual([thread.id]);

      const foreign = {
        tenantId: current.scope.tenantId,
        principalId: "foreign-principal",
      };
      expect(
        current.tasks.listPage(foreign, {
          scopeMode: "exact",
          taskScope: { kind: "global" },
          projection: "summary",
          pageSize: 50,
        }),
      ).toEqual({ projection: "summary", items: [] });
      expect(() =>
        current.tasks.listPage(foreign, {
          scopeMode: "exact",
          taskScope: { kind: "thread", threadId: current.firstThreadId },
          projection: "summary",
          pageSize: 50,
        }),
      ).toThrow(domainError("not_found"));
    } finally {
      current.database.close();
    }
  });

  it("traverses descendant task scopes without changing exact-scope defaults", () => {
    const current = fixture();
    try {
      const global = current.tasks.create(current.scope, {
        title: "Global task",
        scope: { kind: "global" },
        mutationId: "subtree-global",
        now: 1_000,
      });
      const firstWorkspace = current.tasks.create(current.scope, {
        title: "First workspace task",
        scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
        mutationId: "subtree-first-workspace",
        now: 2_000,
      });
      const firstThread = current.tasks.create(current.scope, {
        title: "First thread task",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "subtree-first-thread",
        now: 3_000,
      });
      const secondWorkspace = current.tasks.create(current.scope, {
        title: "Second workspace task",
        scope: { kind: "workspace", workspaceId: current.secondWorkspaceId },
        mutationId: "subtree-second-workspace",
        now: 4_000,
      });
      const secondThread = current.tasks.create(current.scope, {
        title: "Second thread task",
        scope: { kind: "thread", threadId: current.secondThreadId },
        mutationId: "subtree-second-thread",
        now: 5_000,
      });

      expect(
        current.tasks
          .listPage(current.scope, {
            scopeMode: "exact",
            taskScope: { kind: "global" },
            projection: "summary",
            pageSize: 50,
          })
          .items.map(({ id }) => id),
      ).toEqual([global.id]);
      expect(
        current.tasks
          .listPage(current.scope, {
            taskScope: { kind: "global" },
            scopeMode: "subtree",
            projection: "summary",
            pageSize: 50,
          })
          .items.map(({ id }) => id),
      ).toEqual([
        global.id,
        firstWorkspace.id,
        firstThread.id,
        secondWorkspace.id,
        secondThread.id,
      ]);
      expect(
        current.tasks
          .listPage(current.scope, {
            taskScope: {
              kind: "workspace",
              workspaceId: current.firstWorkspaceId,
            },
            scopeMode: "subtree",
            projection: "summary",
            pageSize: 50,
          })
          .items.map(({ id }) => id),
      ).toEqual([firstWorkspace.id, firstThread.id]);
      expect(
        current.tasks.getAssociated(current.scope, firstThread.id),
      ).toMatchObject({
        associatedWorkspaceId: current.firstWorkspaceId,
      });
      expect(
        current.tasks
          .listAssociatedByThread(current.scope, current.firstThreadId)
          .map(({ id }) => id),
      ).toEqual([firstThread.id]);

      current.bindings.moveUnboundThreadWorkspace(
        current.scope,
        current.firstThreadId,
        {
          workspaceId: current.secondWorkspaceId,
          expectedThreadRevision: 0,
          mutationId: "move-subtree-thread",
          now: 6_000,
        },
      );
      expect(
        current.tasks.getAssociated(current.scope, firstThread.id),
      ).toMatchObject({
        associatedWorkspaceId: current.secondWorkspaceId,
      });
      expect(
        current.tasks
          .listPage(current.scope, {
            scopeMode: "subtree",
            taskScope: {
              kind: "workspace",
              workspaceId: current.firstWorkspaceId,
            },
            projection: "summary",
            pageSize: 50,
          })
          .items.map(({ id }) => id),
      ).toEqual([firstWorkspace.id]);
      expect(
        current.tasks
          .listPage(current.scope, {
            scopeMode: "subtree",
            taskScope: {
              kind: "workspace",
              workspaceId: current.secondWorkspaceId,
            },
            projection: "summary",
            pageSize: 50,
          })
          .items.map(({ id }) => id),
      ).toEqual([firstThread.id, secondWorkspace.id, secondThread.id]);

      current.database
        .prepare(
          `
            UPDATE thread_principal_state
            SET inventory_state = 'archived', inventory_revision = inventory_revision + 1
            WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          current.firstThreadId,
        );
      expect(
        current.tasks
          .listPage(current.scope, {
            scopeMode: "subtree",
            taskScope: {
              kind: "workspace",
              workspaceId: current.secondWorkspaceId,
            },
            projection: "summary",
            pageSize: 50,
          })
          .items.map(({ id }) => id),
      ).toContain(firstThread.id);
      expect(
        current.tasks
          .listPage(current.scope, {
            taskScope: { kind: "thread", threadId: current.firstThreadId },
            scopeMode: "subtree",
            projection: "summary",
            pageSize: 50,
          })
          .items.map(({ id }) => id),
      ).toEqual([firstThread.id]);

      const foreignScope = {
        tenantId: current.scope.tenantId,
        principalId: "foreign-principal",
      };
      expect(
        current.tasks.listPage(foreignScope, {
          taskScope: { kind: "global" },
          scopeMode: "subtree",
          projection: "summary",
          pageSize: 50,
        }),
      ).toEqual({ projection: "summary", items: [] });
      expect(
        current.tasks.listAssociatedByThread(
          foreignScope,
          current.firstThreadId,
        ),
      ).toEqual([]);
      expect(() =>
        current.tasks.listPage(foreignScope, {
          taskScope: {
            kind: "workspace",
            workspaceId: current.firstWorkspaceId,
          },
          scopeMode: "subtree",
          projection: "summary",
          pageSize: 50,
        }),
      ).toThrow(domainError("not_found"));
    } finally {
      current.database.close();
    }
  });

  it("filters task pages and returns complete documents for one-call audits", () => {
    const current = fixture();
    try {
      const matching = current.tasks.create(current.scope, {
        title: "Review RELEASE plan",
        details: "Check the rollout notes",
        pinned: true,
        files: ["/tmp/release.md"],
        scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
        mutationId: "audit-matching",
        now: 1_000,
      });
      const completed = current.tasks.create(current.scope, {
        title: "Release follow-up",
        pinned: true,
        scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
        mutationId: "audit-completed",
        now: 2_000,
      });
      current.tasks.update(current.scope, completed.id, {
        completed: true,
        expectedRevision: 0,
        mutationId: "audit-complete",
        now: 2_500,
      });
      current.tasks.create(current.scope, {
        title: "Unpinned release task",
        scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
        mutationId: "audit-unpinned",
        now: 3_000,
      });
      const unicode = current.tasks.create(current.scope, {
        title: "Ärger review",
        scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
        mutationId: "audit-unicode",
        now: 4_000,
      });

      const page = current.tasks.listPage(current.scope, {
        scopeMode: "exact",
        taskScope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
        completed: false,
        pinned: true,
        query: "  release  ",
        projection: "full",
        pageSize: 50,
      });

      expect(page).toEqual({
        projection: "full",
        items: [
          {
            ...matching,
            associatedWorkspaceId: current.firstWorkspaceId,
          },
        ],
      });
      expect(page.items[0]).toMatchObject({
        details: "Check the rollout notes",
        files: ["/tmp/release.md"],
      });
      expect(
        current.tasks
          .listPage(current.scope, {
            scopeMode: "exact",
            taskScope: {
              kind: "workspace",
              workspaceId: current.firstWorkspaceId,
            },
            query: "ÄRGER",
            projection: "summary",
            pageSize: 50,
          })
          .items.map(({ id }) => id),
      ).toEqual([unicode.id]);
      expect(
        current.tasks.listPage(current.scope, {
          scopeMode: "exact",
          taskScope: {
            kind: "workspace",
            workspaceId: current.firstWorkspaceId,
          },
          query: "ärger",
          projection: "summary",
          pageSize: 50,
        }).items,
      ).toEqual([]);
      expect(() =>
        current.tasks.listPage(current.scope, {
          scopeMode: "exact",
          taskScope: {
            kind: "workspace",
            workspaceId: current.firstWorkspaceId,
          },
          query: "   ",
          projection: "summary",
          pageSize: 50,
        }),
      ).toThrow();
    } finally {
      current.database.close();
    }
  });

  it("fingerprints task filters and byte-bounds complete-document pages", () => {
    const current = fixture();
    try {
      const details = "\u0001".repeat(TASK_DETAILS_MAX_CHARACTERS);
      const files = Array.from({ length: TASK_FILES_MAX_COUNT }, (_, index) => {
        const suffix = `-${index}`;
        return `/${"\u0001".repeat(
          TASK_FILE_MAX_PATH_BYTES - 1 - suffix.length,
        )}${suffix}`;
      });
      const first = current.tasks.create(current.scope, {
        title: "Large first",
        details,
        files,
        scope: { kind: "global" },
        mutationId: "large-page-first",
        now: 1_000,
      });
      const second = current.tasks.create(current.scope, {
        title: "Large second",
        details,
        files,
        scope: { kind: "global" },
        mutationId: "large-page-second",
        now: 2_000,
      });

      const pageOne = current.tasks.listPage(current.scope, {
        scopeMode: "exact",
        taskScope: { kind: "global" },
        completed: false,
        projection: "full",
        pageSize: 50,
      });
      expect(pageOne.items.map(({ id }) => id)).toEqual([first.id]);
      expect(pageOne.nextCursor).toBeTruthy();
      expect(
        Buffer.byteLength(JSON.stringify({ page: pageOne }), "utf8"),
      ).toBeLessThan(1_024 * 1_024);
      expect(
        current.tasks
          .listPage(current.scope, {
            scopeMode: "exact",
            taskScope: { kind: "global" },
            completed: false,
            projection: "full",
            pageSize: 50,
            cursor: pageOne.nextCursor,
          })
          .items.map(({ id }) => id),
      ).toEqual([second.id]);
      expect(() =>
        current.tasks.listPage(current.scope, {
          scopeMode: "exact",
          taskScope: { kind: "global" },
          completed: true,
          projection: "full",
          pageSize: 50,
          cursor: pageOne.nextCursor,
        }),
      ).toThrow(domainError("cursor_invalid"));
    } finally {
      current.database.close();
    }
  });

  it("updates fields under revision CAS, clears completion, and replays without double-applying", () => {
    const current = fixture();
    try {
      const created = current.tasks.create(current.scope, {
        title: "Original title",
        scope: { kind: "global" },
        mutationId: "create-update-target",
        now: 1_000,
      });

      const completed = current.tasks.update(current.scope, created.id, {
        title: "Renamed task",
        details: "Now with details",
        completed: true,
        expectedRevision: 0,
        mutationId: "update-complete",
        now: 2_000,
      });
      expect(completed).toMatchObject({
        title: "Renamed task",
        details: "Now with details",
        completedAt: 2_000,
        revision: 1,
        createdAt: 1_000,
        updatedAt: 2_000,
      });

      const fullyEdited = current.tasks.update(current.scope, created.id, {
        title: "Pinned release task",
        details: "Open both files",
        completed: false,
        pinned: true,
        files: ["/tmp/spec.md", "/tmp/release.zip"],
        scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
        expectedRevision: 1,
        mutationId: "update-all-fields",
        now: 2_500,
      });
      expect(fullyEdited).toMatchObject({
        title: "Pinned release task",
        details: "Open both files",
        completedAt: null,
        pinned: true,
        files: ["/tmp/spec.md", "/tmp/release.zip"],
        scopeKind: "workspace",
        environmentId: current.environmentId,
        workspaceId: current.firstWorkspaceId,
        threadId: null,
        revision: 2,
        updatedAt: 2_500,
      });
      expect(
        current.tasks.update(current.scope, created.id, {
          title: "Pinned release task",
          details: "Open both files",
          completed: false,
          pinned: true,
          files: ["/tmp/spec.md", "/tmp/release.zip"],
          scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
          expectedRevision: 1,
          mutationId: "update-all-fields",
          now: 2_750,
        }),
      ).toEqual(fullyEdited);

      const reopenInput = {
        completed: false,
        expectedRevision: 2,
        mutationId: "update-reopen",
        now: 3_000,
      };
      const reopened = current.tasks.update(
        current.scope,
        created.id,
        reopenInput,
      );
      expect(reopened).toMatchObject({
        title: "Pinned release task",
        completedAt: null,
        pinned: true,
        files: ["/tmp/spec.md", "/tmp/release.zip"],
        revision: 3,
        updatedAt: 3_000,
      });

      expect(() =>
        current.tasks.update(current.scope, created.id, {
          title: "Stale write",
          expectedRevision: 0,
          mutationId: "update-stale",
          now: 4_000,
        }),
      ).toThrow(domainError("task_revision_conflict"));

      const replayed = current.tasks.update(current.scope, created.id, {
        ...reopenInput,
        now: 5_000,
      });
      expect(replayed).toEqual(reopened);
    } finally {
      current.database.close();
    }
  });

  it("receipts and replays updates at the task notes and files bounds", () => {
    const current = fixture();
    try {
      const created = current.tasks.create(current.scope, {
        title: "Bounded task metadata",
        scope: { kind: "global" },
        mutationId: "create-bounded-task-metadata",
        now: 1_000,
      });
      const details = "\u0001".repeat(TASK_DETAILS_MAX_CHARACTERS);
      const files = Array.from({ length: TASK_FILES_MAX_COUNT }, (_, index) => {
        const suffix = `-${index}`;
        return `/${"\u0001".repeat(
          TASK_FILE_MAX_PATH_BYTES - 1 - suffix.length,
        )}${suffix}`;
      });
      const input = {
        details,
        files,
        expectedRevision: 0,
        mutationId: "update-bounded-task-metadata",
        now: 2_000,
      } as const;

      const updated = current.tasks.update(current.scope, created.id, input);
      expect(updated.details).toHaveLength(TASK_DETAILS_MAX_CHARACTERS);
      expect(updated.files).toEqual(files);
      const receipt = current.database
        .prepare(
          `
            SELECT length(CAST(result_json AS BLOB)) AS bytes
            FROM task_mutation_receipts
            WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
          `,
        )
        .get(
          current.scope.tenantId,
          current.scope.principalId,
          input.mutationId,
        ) as { readonly bytes: number };
      expect(receipt.bytes).toBeGreaterThan(524_288);
      expect(
        current.tasks.update(current.scope, created.id, {
          ...input,
          now: 3_000,
        }),
      ).toEqual(updated);
    } finally {
      current.database.close();
    }
  });

  it("moves tasks across scopes with destination validation, no-op short-circuit, and replay", () => {
    const current = fixture();
    try {
      const task = current.tasks.create(current.scope, {
        title: "Traveling task",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "create-move-target",
        now: 1_000,
      });

      const toWorkspace = current.tasks.move(current.scope, task.id, {
        scope: { kind: "workspace", workspaceId: current.secondWorkspaceId },
        expectedRevision: 0,
        mutationId: "move-workspace",
        now: 2_000,
      });
      expect(toWorkspace).toMatchObject({
        scopeKind: "workspace",
        environmentId: current.environmentId,
        workspaceId: current.secondWorkspaceId,
        threadId: null,
        revision: 1,
        updatedAt: 2_000,
      });

      const toGlobal = current.tasks.move(current.scope, task.id, {
        scope: { kind: "global" },
        expectedRevision: 1,
        mutationId: "move-global",
        now: 3_000,
      });
      expect(toGlobal).toMatchObject({
        scopeKind: "global",
        environmentId: null,
        workspaceId: null,
        threadId: null,
        revision: 2,
      });

      const toThreadInput = {
        scope: { kind: "thread", threadId: current.firstThreadId },
        expectedRevision: 2,
        mutationId: "move-thread",
        now: 4_000,
      } as const;
      const toThread = current.tasks.move(
        current.scope,
        task.id,
        toThreadInput,
      );
      expect(toThread).toMatchObject({
        scopeKind: "thread",
        environmentId: null,
        workspaceId: null,
        threadId: current.firstThreadId,
        revision: 3,
        updatedAt: 4_000,
      });

      const noOp = current.tasks.move(current.scope, task.id, {
        scope: { kind: "thread", threadId: current.firstThreadId },
        expectedRevision: 3,
        mutationId: "move-no-op",
        now: 5_000,
      });
      expect(noOp).toMatchObject({ revision: 3, updatedAt: 4_000 });

      expect(() =>
        current.tasks.move(current.scope, task.id, {
          scope: { kind: "thread", threadId: current.firstThreadId },
          expectedRevision: 0,
          mutationId: "move-no-op-stale",
          now: 6_000,
        }),
      ).toThrow(domainError("task_revision_conflict"));

      expect(() =>
        current.tasks.move(current.scope, task.id, {
          scope: { kind: "workspace", workspaceId: randomUUID() },
          expectedRevision: 3,
          mutationId: "move-missing-workspace",
          now: 6_000,
        }),
      ).toThrow(domainError("not_found"));
      expect(() =>
        current.tasks.move(current.scope, task.id, {
          scope: { kind: "thread", threadId: randomUUID() },
          expectedRevision: 3,
          mutationId: "move-missing-thread",
          now: 6_000,
        }),
      ).toThrow(domainError("not_found"));

      const replayed = current.tasks.move(current.scope, task.id, {
        ...toThreadInput,
        now: 7_000,
      });
      expect(replayed).toEqual(toThread);
    } finally {
      current.database.close();
    }
  });

  it("removes tasks idempotently", () => {
    const current = fixture();
    try {
      const created = current.tasks.create(current.scope, {
        title: "Disposable task",
        scope: { kind: "global" },
        mutationId: "create-remove-target",
        now: 1_000,
      });
      expect(current.tasks.remove(current.scope, created.id)).toBe(true);
      expect(current.tasks.find(current.scope, created.id)).toBeUndefined();
      expect(current.tasks.remove(current.scope, created.id)).toBe(false);
    } finally {
      current.database.close();
    }
  });

  it("denies wrong-scope reads, mutations, moves, and deletes of another principal's tasks", () => {
    const current = fixture();
    try {
      const owned = current.tasks.create(current.scope, {
        title: "Owner task",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "create-owned",
        now: 1_000,
      });
      const foreignScopes: readonly RequestScope[] = [
        { tenantId: current.scope.tenantId, principalId: "foreign-principal" },
        { tenantId: "foreign-tenant", principalId: current.scope.principalId },
      ];
      for (const foreign of foreignScopes) {
        expect(current.tasks.list(foreign)).toEqual([]);
        expect(
          current.tasks.listPage(foreign, {
            scopeMode: "exact",
            taskScope: { kind: "global" },
            projection: "summary",
            pageSize: 50,
          }),
        ).toEqual({ projection: "summary", items: [] });
        expect(() =>
          current.tasks.listPage(foreign, {
            scopeMode: "exact",
            taskScope: {
              kind: "workspace",
              workspaceId: current.firstWorkspaceId,
            },
            projection: "summary",
            pageSize: 50,
          }),
        ).toThrow(domainError("not_found"));
        expect(() =>
          current.tasks.listPage(foreign, {
            scopeMode: "exact",
            taskScope: {
              kind: "thread",
              threadId: current.firstThreadId,
            },
            projection: "summary",
            pageSize: 50,
          }),
        ).toThrow(domainError("not_found"));
        expect(current.tasks.find(foreign, owned.id)).toBeUndefined();
        expect(() => current.tasks.get(foreign, owned.id)).toThrow(
          domainError("not_found"),
        );
        expect(() =>
          current.tasks.update(foreign, owned.id, {
            title: "Hijacked",
            expectedRevision: 0,
            mutationId: "foreign-update",
            now: 2_000,
          }),
        ).toThrow(domainError("not_found"));
        expect(() =>
          current.tasks.move(foreign, owned.id, {
            scope: { kind: "global" },
            expectedRevision: 0,
            mutationId: "foreign-move",
            now: 2_000,
          }),
        ).toThrow(domainError("not_found"));
        expect(current.tasks.remove(foreign, owned.id)).toBe(false);
        expect(
          current.tasks.listOpenThreadTaskSummaries(
            foreign,
            [current.firstThreadId],
            100,
          ),
        ).toEqual({ items: [], total: 0, omitted: 0 });
        expect(
          current.tasks.moveOpenThreadTasks(
            foreign,
            [current.firstThreadId],
            "move_to_global",
            2_000,
          ),
        ).toEqual([]);
      }
      expect(current.tasks.get(current.scope, owned.id)).toEqual(owned);
    } finally {
      current.database.close();
    }
  });

  it("lists bounded open thread-task summaries with truthful totals", () => {
    const current = fixture();
    try {
      const first = current.tasks.create(current.scope, {
        title: "Duplicate title",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "count-open-one",
        now: 1_000,
      });
      const second = current.tasks.create(current.scope, {
        title: "Duplicate title",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "count-open-two",
        now: 1_100,
      });
      const done = current.tasks.create(current.scope, {
        title: "Already done",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "count-done",
        now: 1_200,
      });
      current.tasks.update(current.scope, done.id, {
        completed: true,
        expectedRevision: 0,
        mutationId: "count-done-complete",
        now: 1_300,
      });
      const other = current.tasks.create(current.scope, {
        title: "Other thread open",
        scope: { kind: "thread", threadId: current.secondThreadId },
        mutationId: "count-other-open",
        now: 1_400,
      });
      current.tasks.create(current.scope, {
        title: "Workspace task excluded",
        scope: { kind: "workspace", workspaceId: current.firstWorkspaceId },
        mutationId: "count-workspace-excluded",
        now: 1_500,
      });
      current.tasks.create(current.scope, {
        title: "Global task excluded",
        scope: { kind: "global" },
        mutationId: "count-global-excluded",
        now: 1_600,
      });

      expect(
        current.tasks.listOpenThreadTaskSummaries(
          current.scope,
          [current.firstThreadId, current.secondThreadId],
          2,
        ),
      ).toEqual({
        items: [
          { id: first.id, title: first.title, threadId: current.firstThreadId },
          {
            id: second.id,
            title: second.title,
            threadId: current.firstThreadId,
          },
        ],
        total: 3,
        omitted: 1,
      });
      expect(
        current.tasks.listOpenThreadTaskSummaries(
          current.scope,
          [current.secondThreadId],
          100,
        ),
      ).toEqual({
        items: [
          {
            id: other.id,
            title: other.title,
            threadId: current.secondThreadId,
          },
        ],
        total: 1,
        omitted: 0,
      });
      expect(
        current.tasks.listOpenThreadTaskSummaries(current.scope, [], 100),
      ).toEqual({ items: [], total: 0, omitted: 0 });
    } finally {
      current.database.close();
    }
  });

  it("moves open thread tasks to global while completed tasks stay in place", () => {
    const current = fixture();
    try {
      const open = current.tasks.create(current.scope, {
        title: "Open task",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "disposition-open",
        now: 1_000,
      });
      const done = current.tasks.create(current.scope, {
        title: "Completed task",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "disposition-done",
        now: 1_100,
      });
      current.tasks.update(current.scope, done.id, {
        completed: true,
        expectedRevision: 0,
        mutationId: "disposition-done-complete",
        now: 1_200,
      });

      const moved = current.tasks.moveOpenThreadTasks(
        current.scope,
        [current.firstThreadId],
        "move_to_global",
        2_000,
      );
      expect(moved).toEqual([open.id]);
      expect(current.tasks.get(current.scope, open.id)).toMatchObject({
        scopeKind: "global",
        environmentId: null,
        workspaceId: null,
        threadId: null,
        revision: 1,
        updatedAt: 2_000,
      });
      expect(current.tasks.get(current.scope, done.id)).toMatchObject({
        scopeKind: "thread",
        threadId: current.firstThreadId,
        completedAt: 1_200,
        revision: 1,
      });
    } finally {
      current.database.close();
    }
  });

  it("moves open thread tasks to each task's own thread workspace", () => {
    const current = fixture();
    try {
      const firstOpen = current.tasks.create(current.scope, {
        title: "First workspace bound",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "workspace-disposition-first",
        now: 1_000,
      });
      const secondOpen = current.tasks.create(current.scope, {
        title: "Second workspace bound",
        scope: { kind: "thread", threadId: current.secondThreadId },
        mutationId: "workspace-disposition-second",
        now: 1_100,
      });
      const done = current.tasks.create(current.scope, {
        title: "Completed stays",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "workspace-disposition-done",
        now: 1_200,
      });
      current.tasks.update(current.scope, done.id, {
        completed: true,
        expectedRevision: 0,
        mutationId: "workspace-disposition-done-complete",
        now: 1_300,
      });

      const moved = current.tasks.moveOpenThreadTasks(
        current.scope,
        [current.firstThreadId, current.secondThreadId],
        "move_to_workspace",
        3_000,
      );
      expect([...moved].sort()).toEqual([firstOpen.id, secondOpen.id].sort());
      expect(current.tasks.get(current.scope, firstOpen.id)).toMatchObject({
        scopeKind: "workspace",
        environmentId: current.environmentId,
        workspaceId: current.firstWorkspaceId,
        threadId: null,
        revision: 1,
      });
      expect(current.tasks.get(current.scope, secondOpen.id)).toMatchObject({
        scopeKind: "workspace",
        environmentId: current.environmentId,
        workspaceId: current.secondWorkspaceId,
        threadId: null,
        revision: 1,
      });
      expect(current.tasks.get(current.scope, done.id)).toMatchObject({
        scopeKind: "thread",
        threadId: current.firstThreadId,
      });
    } finally {
      current.database.close();
    }
  });

  it("promotes open and completed thread tasks to the workspace", () => {
    const current = fixture();
    try {
      const open = current.tasks.create(current.scope, {
        title: "Open promotable",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "promote-open",
        now: 1_000,
      });
      const done = current.tasks.create(current.scope, {
        title: "Completed promotable",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "promote-done",
        now: 1_100,
      });
      current.tasks.update(current.scope, done.id, {
        completed: true,
        expectedRevision: 0,
        mutationId: "promote-done-complete",
        now: 1_200,
      });
      const untouched = current.tasks.create(current.scope, {
        title: "Other thread task",
        scope: { kind: "thread", threadId: current.secondThreadId },
        mutationId: "promote-untouched",
        now: 1_300,
      });

      const moved = current.tasks.promoteThreadTasksToWorkspace(
        current.scope,
        current.firstThreadId,
        2_000,
      );
      expect([...moved].sort()).toEqual([open.id, done.id].sort());
      expect(current.tasks.get(current.scope, open.id)).toMatchObject({
        scopeKind: "workspace",
        environmentId: current.environmentId,
        workspaceId: current.firstWorkspaceId,
        threadId: null,
        revision: 1,
      });
      expect(current.tasks.get(current.scope, done.id)).toMatchObject({
        scopeKind: "workspace",
        environmentId: current.environmentId,
        workspaceId: current.firstWorkspaceId,
        threadId: null,
        completedAt: 1_200,
        revision: 2,
      });
      expect(current.tasks.get(current.scope, untouched.id)).toMatchObject({
        scopeKind: "thread",
        threadId: current.secondThreadId,
        revision: 0,
      });
    } finally {
      current.database.close();
    }
  });

  it("rejects direct inserts with contradictory scope columns", () => {
    const current = fixture();
    try {
      const insert = current.database.prepare(
        `
          INSERT INTO tasks(
            tenant_id, owner_principal_id, id, scope_kind, environment_id,
            workspace_id, thread_id, title, details, completed_at, revision,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', NULL, 0, ?, ?)
        `,
      );
      expect(() =>
        insert.run(
          current.scope.tenantId,
          current.scope.principalId,
          randomUUID(),
          "global",
          null,
          null,
          current.firstThreadId,
          "Global with thread",
          1_000,
          1_000,
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        insert.run(
          current.scope.tenantId,
          current.scope.principalId,
          randomUUID(),
          "workspace",
          null,
          current.firstWorkspaceId,
          null,
          "Workspace without environment",
          1_000,
          1_000,
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(current.tasks.list(current.scope)).toEqual([]);
    } finally {
      current.database.close();
    }
  });

  it("archives a thread and moves its open tasks in one transaction, replaying without re-moving", () => {
    const current = fixture();
    try {
      const open = current.tasks.create(current.scope, {
        title: "Open at archive time",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "archive-open",
        now: 1_000,
      });
      const done = current.tasks.create(current.scope, {
        title: "Done at archive time",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "archive-done",
        now: 1_100,
      });
      current.tasks.update(current.scope, done.id, {
        completed: true,
        expectedRevision: 0,
        mutationId: "archive-done-complete",
        now: 1_200,
      });

      expect(() =>
        current.inventory.archiveThreads(current.scope, current.firstThreadId, {
          expectedRevision: 0,
          mutationId: "archive-move-fails",
          includeDescendants: false,
          expectedThreadIds: [current.firstThreadId],
          blockedThreadIds: new Set(),
          executionWorkspaceDisposition: { kind: "keep" },
          now: 2_000,
          openTaskDisposition: "move_to_workspace",
          moveOpenTasks: () => {
            throw new Error("disposition_failed");
          },
        }),
      ).toThrow("disposition_failed");
      expect(
        current.inventory.getInventory(current.scope, current.firstThreadId),
      ).toMatchObject({ inventoryState: "active", inventoryRevision: 0 });
      expect(current.tasks.get(current.scope, open.id)).toMatchObject({
        scopeKind: "thread",
        threadId: current.firstThreadId,
        revision: 0,
      });

      const moveOpenTasks = vi.fn((archivedThreadIds: readonly string[]) =>
        current.tasks.moveOpenThreadTasks(
          current.scope,
          archivedThreadIds,
          "move_to_workspace",
          3_000,
        ),
      );
      const input = {
        expectedRevision: 0,
        mutationId: "archive-with-disposition",
        includeDescendants: false,
        expectedThreadIds: [current.firstThreadId],
        blockedThreadIds: new Set<string>(),
        executionWorkspaceDisposition: { kind: "keep" },
        now: 3_000,
        openTaskDisposition: "move_to_workspace",
        moveOpenTasks,
      } as const;
      const result = current.inventory.archiveThreads(
        current.scope,
        current.firstThreadId,
        input,
      );
      expect(result.replayed).toBe(false);
      expect(result.movedTaskIds).toEqual([open.id]);
      expect(moveOpenTasks).toHaveBeenCalledExactlyOnceWith([
        current.firstThreadId,
      ]);
      expect(
        current.inventory.getInventory(current.scope, current.firstThreadId),
      ).toMatchObject({ inventoryState: "archived", inventoryRevision: 1 });
      const movedOpen = current.tasks.get(current.scope, open.id);
      expect(movedOpen).toMatchObject({
        scopeKind: "workspace",
        environmentId: current.environmentId,
        workspaceId: current.firstWorkspaceId,
        threadId: null,
        revision: 1,
        updatedAt: 3_000,
      });
      expect(current.tasks.get(current.scope, done.id)).toMatchObject({
        scopeKind: "thread",
        threadId: current.firstThreadId,
        completedAt: 1_200,
      });

      const replay = current.inventory.archiveThreads(
        current.scope,
        current.firstThreadId,
        input,
      );
      expect(replay.replayed).toBe(true);
      // The receipt retains the moved ids so a retry can re-publish task
      // events the original request failed to emit after commit.
      expect(replay.movedTaskIds).toEqual([open.id]);
      expect(moveOpenTasks).toHaveBeenCalledTimes(1);
      expect(current.tasks.get(current.scope, open.id)).toEqual(movedOpen);
      expect(
        current.inventory.getInventory(current.scope, current.firstThreadId),
      ).toMatchObject({ inventoryState: "archived", inventoryRevision: 1 });
    } finally {
      current.database.close();
    }
  });

  it("replays the receipted result even after later mutations or deletion", () => {
    const current = fixture();
    try {
      const created = current.tasks.create(current.scope, {
        title: "Original title",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "stable-create",
        now: 1_000,
      });
      current.tasks.update(current.scope, created.id, {
        title: "Renamed later",
        expectedRevision: 0,
        mutationId: "later-rename",
        now: 2_000,
      });

      const replayAfterUpdate = current.tasks.create(current.scope, {
        title: "Original title",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "stable-create",
        now: 9_000,
      });
      expect(replayAfterUpdate).toMatchObject({
        id: created.id,
        title: "Original title",
        revision: 0,
        updatedAt: 1_000,
      });

      const renameReplayBefore = current.tasks.update(
        current.scope,
        created.id,
        {
          title: "Renamed later",
          expectedRevision: 0,
          mutationId: "later-rename",
          now: 9_100,
        },
      );
      expect(renameReplayBefore).toMatchObject({
        title: "Renamed later",
        revision: 1,
        updatedAt: 2_000,
      });

      expect(current.tasks.remove(current.scope, created.id)).toBe(true);
      const replayAfterDelete = current.tasks.create(current.scope, {
        title: "Original title",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "stable-create",
        now: 9_200,
      });
      expect(replayAfterDelete).toMatchObject({
        id: created.id,
        title: "Original title",
        revision: 0,
      });
      expect(current.tasks.find(current.scope, created.id)).toBeUndefined();
    } finally {
      current.database.close();
    }
  });

  it("parses a pre-schema-23 version-1 archive receipt with no moved tasks", () => {
    const current = fixture();
    try {
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify(["archive_threads", current.firstThreadId, 0, false]),
        )
        .digest("hex");
      current.database
        .prepare(
          `
            INSERT INTO mutation_receipts(
              tenant_id, principal_id, thread_id, mutation_id, operation_kind,
              request_fingerprint, result_code, result_json, replayable,
              created_at
            )
            VALUES (?, ?, ?, 'legacy-archive', 'archive_threads', ?,
              'completed', ?, 1, 500)
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          current.firstThreadId,
          fingerprint,
          JSON.stringify({
            version: 1,
            threadIds: [current.firstThreadId],
          }),
        );
      const replay = current.inventory.findArchiveThreadsReplay(
        current.scope,
        current.firstThreadId,
        {
          expectedRevision: 0,
          mutationId: "legacy-archive",
          includeDescendants: false,
        },
      );
      expect(replay).toBeDefined();
      expect(replay!.threadIds).toEqual([current.firstThreadId]);
      expect(replay!.movedTaskIds).toEqual([]);
    } finally {
      current.database.close();
    }
  });
});
