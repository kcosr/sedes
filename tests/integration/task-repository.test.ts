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
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
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
  const projectOf = (workspaceId: string) =>
    latestVersion >= 126
      ? (
          database
            .prepare("SELECT project_id AS projectId FROM workspaces WHERE id = ?")
            .get(workspaceId) as { readonly projectId: string }
        ).projectId
      : "";
  return {
    database,
    scope,
    environmentId: environment.id,
    firstWorkspaceId: firstWorkspace.id,
    secondWorkspaceId: secondWorkspace.id,
    // Differently named locations became separate projects in migration 126.
    firstProjectId: projectOf(firstWorkspace.id),
    secondProjectId: projectOf(secondWorkspace.id),
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
      const projectTask = current.tasks.create(current.scope, {
        title: "Project authority",
        scope: { kind: "project", projectId: current.firstProjectId },
        mutationId: "project-authority",
        now: 1_001,
      });
      const threadTask = current.tasks.create(current.scope, {
        title: "Thread authority",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "thread-authority",
        now: 1_002,
      });
      // A project task carries no environment of its own: agents reach it
      // through the project's member environments.
      const reader = new DatabaseAgentToolSourceAuthority(
        current.database,
        new Uint8Array(32).fill(3),
      );
      expect(reader.resolveTask(current.scope, globalTask.id)).toEqual({
        id: globalTask.id,
        revision: 0,
        scopeKind: "global",
        label: "Global authority",
      });
      expect(reader.resolveTask(current.scope, projectTask.id)).toEqual({
        id: projectTask.id,
        revision: 0,
        scopeKind: "project",
        projectId: current.firstProjectId,
        label: "Project authority",
      });
      expect(reader.resolveTask(current.scope, threadTask.id)).toEqual({
        id: threadTask.id,
        revision: 0,
        scopeKind: "thread",
        environmentId: current.environmentId,
        threadId: current.firstThreadId,
        label: "Thread authority",
      });
      expect(reader.resolveProject(current.scope, current.firstProjectId)).toEqual({
        id: current.firstProjectId,
        label: "Tasks first",
        membershipRevision: expect.any(Number),
        memberEnvironmentIds: [current.environmentId],
      });
      expect(
        reader.resolveTask({ ...current.scope, principalId: "other" }, projectTask.id),
      ).toBeUndefined();
    } finally {
      current.database.close();
    }
  });

  it("binds authorized task reads to the admitted revision", () => {
    const current = fixture();
    try {
      const task = current.tasks.create(current.scope, {
        title: "Authority-bound",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "authority-bound-create",
        now: 1_000,
      });
      expect(
        current.tasks.getAtRevision(current.scope, task.id, 0),
      ).toMatchObject({ id: task.id, title: "Authority-bound" });
      current.tasks.move(current.scope, task.id, {
        scope: { kind: "project", projectId: current.firstProjectId },
        expectedRevision: 0,
        mutationId: "authority-bound-move",
        now: 2_000,
      });
      // A scope change advances the revision, so stale authority cannot read it.
      expect(() =>
        current.tasks.getAtRevision(current.scope, task.id, 0),
      ).toThrow(domainError("conflict"));
      expect(() =>
        current.tasks.getAtRevision(
          { ...current.scope, principalId: "other" },
          task.id,
          1,
        ),
      ).toThrow(domainError("not_found"));
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
        projectId: null,
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
        projectId: null,
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
        projectId: null,
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
        projectId: null,
        threadId: current.firstThreadId,
      });

      const workspaceTask = current.tasks.create(current.scope, {
        title: "Workspace task",
        scope: { kind: "project", projectId: current.firstProjectId },
        mutationId: "create-workspace",
        now: 3_000,
      });
      expect(workspaceTask).toMatchObject({
        scopeKind: "project",
        projectId: current.firstProjectId,
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
        scope: { kind: "project", projectId: current.firstProjectId },
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
          scope: { kind: "project", projectId: current.firstProjectId },
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
          scope: { kind: "project", projectId: current.firstProjectId },
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
        scope: { kind: "project", projectId: current.firstProjectId },
        mutationId: "page-first",
        now: 1_000,
      });
      const second = current.tasks.create(current.scope, {
        title: "Second",
        scope: { kind: "project", projectId: current.firstProjectId },
        mutationId: "page-second",
        now: 2_000,
      });
      current.tasks.create(current.scope, {
        title: "Other workspace",
        scope: { kind: "project", projectId: current.secondProjectId },
        mutationId: "page-other",
        now: 3_000,
      });
      const pageOne = current.tasks.listPage(current.scope, {
        scopeMode: "exact",
        taskScope: { kind: "project", projectId: current.firstProjectId },
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
              kind: "project",
              projectId: current.firstProjectId,
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
            kind: "project",
            projectId: current.secondProjectId,
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
        scope: { kind: "project", projectId: current.firstProjectId },
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
        scope: { kind: "project", projectId: current.secondProjectId },
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
              kind: "project",
              projectId: current.firstProjectId,
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
        associatedProjectId: current.firstProjectId,
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
        associatedProjectId: current.secondProjectId,
      });
      expect(
        current.tasks
          .listPage(current.scope, {
            scopeMode: "subtree",
            taskScope: {
              kind: "project",
              projectId: current.firstProjectId,
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
              kind: "project",
              projectId: current.secondProjectId,
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
              kind: "project",
              projectId: current.secondProjectId,
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
            kind: "project",
            projectId: current.firstProjectId,
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

  it("spans a project's active locations and hides removed projects and locations", () => {
    const current = fixture();
    try {
      const list = (
        taskScope: Parameters<TaskRepository["listPage"]>[1]["taskScope"],
        scopeMode: "exact" | "subtree",
      ) =>
        current.tasks
          .listPage(current.scope, {
            taskScope,
            scopeMode,
            projection: "summary",
            pageSize: 50,
          })
          .items.map(({ id }) => id);
      const profile = current.database
        .prepare("SELECT id FROM agent_connection_profiles LIMIT 1")
        .get() as { readonly id: string };
      const location = (canonicalPath: string, projectId: string) =>
        current.inventory.upsertWorkspace(current.scope, {
          environmentId: current.environmentId,
          canonicalPath,
          displayName: canonicalPath.split("/").at(-1)!,
          project: { kind: "existing", projectId },
          available: true,
          trustState: "trusted",
          environmentConfigurationRevision: 0,
          now: 900,
        });
      const remove = (workspaceId: string) =>
        current.inventory.removeWorkspace(current.scope, workspaceId, {
          expectedRevision: current.inventory.getWorkspace(
            current.scope,
            workspaceId,
          ).revision,
          expectedThreadIds: current.inventory.listThreadIdsForWorkspace(
            current.scope,
            workspaceId,
          ),
          now: 950,
        });
      // A second location of the first project, with its own thread.
      const copy = location("/tmp/tasks-first-copy", current.firstProjectId);
      const copyThread = current.bindings.createUnboundThread(current.scope, {
        workspaceId: copy.id,
        connectionProfileId: profile.id,
        title: "Copy thread",
        now: 910,
      });
      const projectTask = current.tasks.create(current.scope, {
        title: "Shared project task",
        scope: { kind: "project", projectId: current.firstProjectId },
        mutationId: "spans-project",
        now: 1_000,
      });
      const copyTask = current.tasks.create(current.scope, {
        title: "Copy thread task",
        scope: { kind: "thread", threadId: copyThread.id },
        mutationId: "spans-copy-thread",
        now: 1_100,
      });
      const firstThreadTask = current.tasks.create(current.scope, {
        title: "First thread task",
        scope: { kind: "thread", threadId: current.firstThreadId },
        mutationId: "spans-first-thread",
        now: 1_200,
      });
      expect(
        list({ kind: "project", projectId: current.firstProjectId }, "subtree"),
      ).toEqual([projectTask.id, copyTask.id, firstThreadTask.id]);
      expect(
        current.tasks.getAssociated(current.scope, copyTask.id),
      ).toMatchObject({
        associatedProjectId: current.firstProjectId,
        associatedWorkspaceId: copy.id,
      });

      // A removed location hides its thread tasks; its project stays active.
      remove(copy.id);
      expect(
        list({ kind: "project", projectId: current.firstProjectId }, "subtree"),
      ).toEqual([projectTask.id, firstThreadTask.id]);
      expect(list({ kind: "global" }, "subtree")).toEqual([
        projectTask.id,
        firstThreadTask.id,
      ]);

      // A project without an active location is reached only by its own query.
      remove(current.firstWorkspaceId);
      expect(
        list({ kind: "project", projectId: current.firstProjectId }, "exact"),
      ).toEqual([projectTask.id]);
      expect(list({ kind: "global" }, "subtree")).toEqual([]);

      // A removed project is neither listed nor a destination.
      const project = current.inventory.getProject(
        current.scope,
        current.firstProjectId,
      );
      const inspection = current.inventory.inspectProjectRemoval(
        current.scope,
        current.firstProjectId,
        {
          expectedRevision: project.revision,
          expectedMembershipRevision: project.membershipRevision,
        },
      );
      current.inventory.removeProject(current.scope, current.firstProjectId, {
        expectedRevision: project.revision,
        expectedMembershipRevision: project.membershipRevision,
        expectedLocations: inspection.locations,
        now: 1_300,
      });
      expect(() =>
        list({ kind: "project", projectId: current.firstProjectId }, "exact"),
      ).toThrow(domainError("not_found"));
      expect(() =>
        current.tasks.create(current.scope, {
          title: "Into a removed project",
          scope: { kind: "project", projectId: current.firstProjectId },
          mutationId: "spans-removed-create",
          now: 1_400,
        }),
      ).toThrow(domainError("not_found"));
      const global = current.tasks.create(current.scope, {
        title: "Global",
        scope: { kind: "global" },
        mutationId: "spans-global",
        now: 1_500,
      });
      expect(() =>
        current.tasks.move(current.scope, global.id, {
          scope: { kind: "project", projectId: current.firstProjectId },
          expectedRevision: 0,
          mutationId: "spans-removed-move",
          now: 1_600,
        }),
      ).toThrow(domainError("not_found"));
      // The commit-time guard also refuses a write that skipped the check.
      expect(() =>
        current.database
          .prepare(
            "UPDATE tasks SET scope_kind = 'project', project_id = ? WHERE id = ?",
          )
          .run(current.firstProjectId, global.id),
      ).toThrow(
        "The project was removed. Restore it before moving saved work into it.",
      );
      expect(current.tasks.get(current.scope, projectTask.id).title).toBe(
        "Shared project task",
      );
    } finally {
      current.database.close();
    }
  });

  it("replays pre-upgrade create receipts in project form and fails closed for scoped updates", () => {
    const current = fixture(126);
    try {
      const taskId = randomUUID();
      const record = {
        tenantId: current.scope.tenantId,
        ownerPrincipalId: current.scope.principalId,
        id: taskId,
        scopeKind: "workspace",
        environmentId: current.environmentId,
        workspaceId: current.firstWorkspaceId,
        threadId: null,
        title: "Before projects",
        details: "Old",
        pinned: true,
        files: ["/tmp/a.md"],
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
              workspace_id, thread_id, title, details, pinned, files_json,
              completed_at, revision, created_at, updated_at
            ) VALUES (?, ?, ?, 'workspace', ?, ?, NULL, ?, ?, 1, ?, NULL, 0, ?, ?)
          `,
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          taskId,
          current.environmentId,
          current.firstWorkspaceId,
          record.title,
          record.details,
          JSON.stringify(record.files),
          1_000,
          1_000,
        );
      const receipt = current.database.prepare(
        `
          INSERT INTO task_mutation_receipts(
            tenant_id, principal_id, mutation_id, operation_kind,
            request_fingerprint, result_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      );
      const fingerprint = (parts: readonly unknown[]) =>
        createHash("sha256").update(JSON.stringify(parts)).digest("hex");
      receipt.run(
        current.scope.tenantId,
        current.scope.principalId,
        "create-before-projects",
        "create_task",
        fingerprint([
          "create_task",
          record.title,
          record.details,
          true,
          record.files,
          "workspace",
          current.firstWorkspaceId,
        ]),
        JSON.stringify({ version: 1, record }),
        1_000,
      );
      const moved = { ...record, revision: 1, updatedAt: 1_500 };
      receipt.run(
        current.scope.tenantId,
        current.scope.principalId,
        "update-scope-before-projects",
        "update_task",
        fingerprint([
          "update_task",
          taskId,
          null,
          null,
          null,
          0,
          null,
          null,
          ["workspace", current.firstWorkspaceId],
        ]),
        JSON.stringify({ version: 1, record: moved }),
        1_500,
      );

      applyDatabaseMigrations(current.database, backendNormalizedMigrations);
      const projectId = current.inventory.getWorkspace(
        current.scope,
        current.firstWorkspaceId,
      ).projectId;
      const { environmentId: _environment, workspaceId: _workspace, ...rest } =
        record;
      expect(
        current.tasks.create(current.scope, {
          title: record.title,
          details: record.details,
          pinned: true,
          files: record.files,
          scope: { kind: "project", projectId },
          mutationId: "create-before-projects",
          now: 2_000,
        }),
      ).toEqual({ ...rest, scopeKind: "project", projectId });
      // The update fingerprint covered the former scope and an unstored
      // expected revision, so its replay fails closed.
      expect(() =>
        current.tasks.update(current.scope, taskId, {
          scope: { kind: "project", projectId },
          expectedRevision: 0,
          mutationId: "update-scope-before-projects",
          now: 2_500,
        }),
      ).toThrow(domainError("conflict"));
      expect(current.tasks.get(current.scope, taskId)).toMatchObject({
        scopeKind: "project",
        projectId,
        revision: 0,
      });
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
        scope: { kind: "project", projectId: current.firstProjectId },
        mutationId: "audit-matching",
        now: 1_000,
      });
      const completed = current.tasks.create(current.scope, {
        title: "Release follow-up",
        pinned: true,
        scope: { kind: "project", projectId: current.firstProjectId },
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
        scope: { kind: "project", projectId: current.firstProjectId },
        mutationId: "audit-unpinned",
        now: 3_000,
      });
      const unicode = current.tasks.create(current.scope, {
        title: "Ärger review",
        scope: { kind: "project", projectId: current.firstProjectId },
        mutationId: "audit-unicode",
        now: 4_000,
      });

      const page = current.tasks.listPage(current.scope, {
        scopeMode: "exact",
        taskScope: { kind: "project", projectId: current.firstProjectId },
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
            associatedProjectId: current.firstProjectId,
            associatedWorkspaceId: null,
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
              kind: "project",
              projectId: current.firstProjectId,
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
            kind: "project",
            projectId: current.firstProjectId,
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
            kind: "project",
            projectId: current.firstProjectId,
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
        scope: { kind: "project", projectId: current.firstProjectId },
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
        scopeKind: "project",
        projectId: current.firstProjectId,
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
          scope: { kind: "project", projectId: current.firstProjectId },
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
        scope: { kind: "project", projectId: current.secondProjectId },
        expectedRevision: 0,
        mutationId: "move-workspace",
        now: 2_000,
      });
      expect(toWorkspace).toMatchObject({
        scopeKind: "project",
        projectId: current.secondProjectId,
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
        projectId: null,
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
        projectId: null,
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
          scope: { kind: "project", projectId: randomUUID() },
          expectedRevision: 3,
          mutationId: "move-missing-project",
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
              kind: "project",
              projectId: current.firstProjectId,
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
        ).toEqual({ snapshot: expect.any(String), items: [], total: 0, omitted: 0 });
        expect(
          current.tasks.applyOpenThreadTaskDisposition(
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
        scope: { kind: "project", projectId: current.firstProjectId },
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
        snapshot: expect.any(String),
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
        snapshot: expect.any(String),
      });
      expect(
        current.tasks.listOpenThreadTaskSummaries(current.scope, [], 100),
      ).toEqual({ snapshot: expect.any(String), items: [], total: 0, omitted: 0 });
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

      const moved = current.tasks.applyOpenThreadTaskDisposition(
        current.scope,
        [current.firstThreadId],
        "move_to_global",
        2_000,
      );
      expect(moved).toEqual([open.id]);
      expect(current.tasks.get(current.scope, open.id)).toMatchObject({
        scopeKind: "global",
        projectId: null,
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

      const moved = current.tasks.applyOpenThreadTaskDisposition(
        current.scope,
        [current.firstThreadId, current.secondThreadId],
        "move_to_project",
        3_000,
      );
      expect([...moved].sort()).toEqual([firstOpen.id, secondOpen.id].sort());
      expect(current.tasks.get(current.scope, firstOpen.id)).toMatchObject({
        scopeKind: "project",
        projectId: current.firstProjectId,
        threadId: null,
        revision: 1,
      });
      expect(current.tasks.get(current.scope, secondOpen.id)).toMatchObject({
        scopeKind: "project",
        projectId: current.secondProjectId,
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

  it("rejects direct inserts with contradictory scope columns", () => {
    const current = fixture();
    try {
      const insert = current.database.prepare(
        `
          INSERT INTO tasks(
            tenant_id, owner_principal_id, id, scope_kind, project_id,
            thread_id, title, details, completed_at, revision,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, '', NULL, 0, ?, ?)
        `,
      );
      for (const [scopeKind, projectId, threadId] of [
        ["global", null, current.firstThreadId],
        ["project", null, null],
        ["project", current.firstProjectId, current.firstThreadId],
        ["thread", current.firstProjectId, current.firstThreadId],
        ["workspace", current.firstProjectId, null],
      ] as const) {
        expect(() =>
          insert.run(
            current.scope.tenantId,
            current.scope.principalId,
            randomUUID(),
            scopeKind,
            projectId,
            threadId,
            "Contradictory",
            1_000,
            1_000,
          ),
        ).toThrow(/CHECK constraint failed/);
      }
      expect(() =>
        insert.run(
          current.scope.tenantId,
          current.scope.principalId,
          randomUUID(),
          "project",
          randomUUID(),
          null,
          "Unknown project",
          1_000,
          1_000,
        ),
      ).toThrow(/FOREIGN KEY constraint failed/);
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
          openTaskDisposition: "move_to_project",
          applyOpenTasks: () => {
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

      const applyOpenTasks = vi.fn((archivedThreadIds: readonly string[]) =>
        current.tasks.applyOpenThreadTaskDisposition(
          current.scope,
          archivedThreadIds,
          "move_to_project",
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
        openTaskDisposition: "move_to_project",
        applyOpenTasks,
      } as const;
      const result = current.inventory.archiveThreads(
        current.scope,
        current.firstThreadId,
        input,
      );
      expect(result.replayed).toBe(false);
      expect(result.movedTaskIds).toEqual([open.id]);
      expect(applyOpenTasks).toHaveBeenCalledExactlyOnceWith([
        current.firstThreadId,
      ]);
      expect(
        current.inventory.getInventory(current.scope, current.firstThreadId),
      ).toMatchObject({ inventoryState: "archived", inventoryRevision: 1 });
      const movedOpen = current.tasks.get(current.scope, open.id);
      expect(movedOpen).toMatchObject({
        scopeKind: "project",
        projectId: current.firstProjectId,
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
      expect(applyOpenTasks).toHaveBeenCalledTimes(1);
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
