import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  taskDetailsSchema,
  taskFilesSchema,
  taskListProjectionSchema,
  taskQuerySchema,
  taskScopeModeSchema,
  taskTitleSchema,
  TASK_COMPLETED_UNPLACED_MESSAGE,
  type OpenTaskDisposition,
  type TaskListProjection,
  type TaskScope,
  type TaskScopeMode,
} from "../../../shared/protocol/tasks.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export type TaskScopeKind = "global" | "project" | "thread";

export type TaskRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly id: string;
  readonly scopeKind: TaskScopeKind;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly title: string;
  readonly details: string;
  readonly pinned: boolean;
  readonly backlog: boolean;
  readonly files: readonly string[];
  readonly completedAt: number | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type OpenThreadTaskSummary = Pick<
  TaskRecord,
  "id" | "title" | "threadId"
> & {
  readonly threadId: string;
};

export type OpenThreadTaskSummaryCollection = {
  readonly snapshot: string;
  readonly items: readonly OpenThreadTaskSummary[];
  readonly total: number;
  readonly omitted: number;
};

export type TaskListSummary = Pick<
  TaskRecord,
  | "id"
  | "scopeKind"
  | "projectId"
  | "threadId"
  | "title"
  | "pinned"
  | "backlog"
  | "completedAt"
  | "revision"
  | "createdAt"
  | "updatedAt"
> & {
  readonly associatedProjectId: string | null;
  readonly fileCount: number;
};

export type AssociatedTaskRecord = TaskRecord & {
  /**
   * Read-only project association: the task's project, or the current
   * project of a thread task's thread's location; null for global tasks.
   */
  readonly associatedProjectId: string | null;
  /**
   * Server-only: a thread task's thread's location, so a removed location
   * hides its thread tasks even while their project stays active. Null for
   * global and project tasks.
   */
  readonly associatedWorkspaceId: string | null;
};

export type TaskListPage =
  | {
      readonly projection: "summary";
      readonly items: readonly TaskListSummary[];
      readonly nextCursor?: string;
    }
  | {
      readonly projection: "full";
      readonly items: readonly AssociatedTaskRecord[];
      readonly nextCursor?: string;
    };

type TaskRow = Omit<TaskRecord, "pinned" | "backlog" | "files"> & {
  readonly pinned: 0 | 1;
  readonly backlog: 0 | 1;
  readonly filesJson: string;
};

type AssociatedTaskRow = TaskRow & {
  readonly associatedProjectId: string | null;
  readonly associatedWorkspaceId: string | null;
};

type TaskSummaryRow = Omit<TaskListSummary, "pinned" | "backlog"> & {
  readonly pinned: 0 | 1;
  readonly backlog: 0 | 1;
};

type TaskMutationReceipt = {
  readonly operationKind: string;
  readonly requestFingerprint: string;
  readonly resultJson: string;
};

// Leaves room beneath the canonical tool's 1 MiB result ceiling for the page
// envelope, cursor, and normalized Task presentation. A valid individual task
// is bounded below that ceiling and is always admitted so pagination advances.
const FULL_TASK_LIST_RECORD_BUDGET_BYTES = 900 * 1_024;

/**
 * Scope column tuple for one task row. A thread task deliberately stores no
 * project: its association follows its thread's location, so a draft moving
 * between locations cannot strand a stale denormalized copy.
 */
type ResolvedScopeColumns = {
  readonly scopeKind: TaskScopeKind;
  readonly projectId: string | null;
  readonly threadId: string | null;
};

function fingerprint(operation: string, parts: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify([operation, ...parts]))
    .digest("hex");
}

function scopeFingerprintParts(scope: TaskScope): readonly unknown[] {
  switch (scope.kind) {
    case "project":
      return [scope.kind, scope.projectId];
    case "thread":
      return [scope.kind, scope.threadId];
    case "global":
      return [scope.kind];
  }
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function encodeTaskCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeTaskCursor(
  cursor: string,
  expectedFingerprint: string,
): { readonly createdAt: number; readonly id: string } {
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Object.keys(decoded).length !== 3 ||
      !("fingerprint" in decoded) ||
      decoded.fingerprint !== expectedFingerprint ||
      !("createdAt" in decoded) ||
      !Number.isSafeInteger(decoded.createdAt) ||
      (decoded.createdAt as number) < 0 ||
      !("id" in decoded) ||
      typeof decoded.id !== "string" ||
      decoded.id.length === 0
    ) {
      throw new Error("task_cursor_invalid");
    }
    return { createdAt: decoded.createdAt as number, id: decoded.id };
  } catch (cause) {
    throw new DomainError(
      "cursor_invalid",
      "The task cursor is invalid.",
      false,
      {
        cause,
      },
    );
  }
}

const columns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  id,
  scope_kind AS scopeKind,
  project_id AS projectId,
  thread_id AS threadId,
  title,
  details,
  pinned,
  backlog,
  files_json AS filesJson,
  completed_at AS completedAt,
  revision,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const threadLocationColumn = (column: string) => `(
  SELECT task_location.${column}
  FROM application_threads AS task_thread
  JOIN workspaces AS task_location
    ON task_location.tenant_id = task_thread.tenant_id
    AND task_location.owner_principal_id = task_thread.owner_principal_id
    AND task_location.id = task_thread.workspace_id
  WHERE task_thread.tenant_id = tasks.tenant_id
    AND task_thread.owner_principal_id = tasks.owner_principal_id
    AND task_thread.id = tasks.thread_id
)`;

const associatedProjectColumn = `
  CASE
    WHEN scope_kind = 'thread' THEN ${threadLocationColumn("project_id")}
    ELSE project_id
  END AS associatedProjectId
`;

const associatedColumns = `
  ${columns},
  ${associatedProjectColumn},
  CASE
    WHEN scope_kind = 'thread' THEN ${threadLocationColumn("id")}
    ELSE NULL
  END AS associatedWorkspaceId
`;

/**
 * The global subtree an agent can reach through every environment: removed
 * projects and removed locations hide their own tasks, and a project without
 * an active location is outside every environment, so only its own project
 * query reaches its tasks.
 */
const globalSubtreeClause = `(
  scope_kind = 'global'
  OR (scope_kind = 'project' AND EXISTS (
    SELECT 1 FROM workspaces AS project_location
    WHERE project_location.tenant_id = tasks.tenant_id
      AND project_location.owner_principal_id = tasks.owner_principal_id
      AND project_location.project_id = tasks.project_id
      AND project_location.removed_at IS NULL
  ))
  OR (scope_kind = 'thread' AND EXISTS (
    SELECT 1
    FROM application_threads AS task_thread
    JOIN workspaces AS task_location
      ON task_location.tenant_id = task_thread.tenant_id
      AND task_location.owner_principal_id = task_thread.owner_principal_id
      AND task_location.id = task_thread.workspace_id
    WHERE task_thread.tenant_id = tasks.tenant_id
      AND task_thread.owner_principal_id = tasks.owner_principal_id
      AND task_thread.id = tasks.thread_id
      AND task_location.removed_at IS NULL
  ))
)`;

export class TaskRepository {
  constructor(readonly database: Database.Database) {}

  list(scope: RequestScope): readonly TaskRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ?
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(scope.tenantId, scope.principalId) as TaskRow[];
    return rows.map((row) => this.#presentRow(row));
  }

  listAssociated(scope: RequestScope): readonly AssociatedTaskRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT ${associatedColumns}
          FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ?
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(scope.tenantId, scope.principalId) as AssociatedTaskRow[];
    return rows.map((row) => this.#presentAssociatedRow(row));
  }

  listAssociatedByThread(
    scope: RequestScope,
    threadId: string,
  ): readonly AssociatedTaskRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT ${associatedColumns}
          FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND scope_kind = 'thread' AND thread_id = ?
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(scope.tenantId, scope.principalId, threadId) as AssociatedTaskRow[];
    return rows.map((row) => this.#presentAssociatedRow(row));
  }

  /**
   * Resolve the environment roots spanned by a global or thread task query.
   * Global-exact is environment-neutral, while global-subtree intentionally
   * spans every configured principal environment, including environments
   * with no tasks. Project queries are reached through the agent-tool
   * project access rule instead.
   */
  resolveScopeEnvironmentIds(
    scope: RequestScope,
    taskScope: Exclude<TaskScope, { kind: "project" }>,
    scopeMode: TaskScopeMode,
  ): readonly string[] {
    const mode = taskScopeModeSchema.parse(scopeMode);
    if (taskScope.kind === "global") {
      if (mode === "exact") return [];
      const rows = this.database
        .prepare(
          `
            SELECT id
            FROM execution_environments
            WHERE tenant_id = ? AND owner_principal_id = ?
            ORDER BY id ASC
          `,
        )
        .all(scope.tenantId, scope.principalId) as Array<{
        readonly id: string;
      }>;
      return rows.map(({ id }) => id);
    }
    const resolved = this.#resolveScope(scope, taskScope);
    const row = this.database
      .prepare(
        `
          SELECT environment_id AS environmentId
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, resolved.threadId) as
      { readonly environmentId: string } | undefined;
    if (!row) {
      throw new DomainError("not_found", "The task scope was not found.");
    }
    return [row.environmentId];
  }

  listPage(
    scope: RequestScope,
    input: {
      readonly taskScope: TaskScope;
      readonly scopeMode: TaskScopeMode;
      readonly completed?: boolean;
      readonly pinned?: boolean;
      readonly backlog?: boolean;
      readonly query?: string;
      readonly projection: TaskListProjection;
      readonly cursor?: string;
      readonly pageSize: number;
      /** Trusted authority binding for agent-tool cursors. */
      readonly authorityBinding?: {
        readonly sourceEnvironmentId: string;
        readonly targetEnvironmentIds: readonly string[];
        readonly policyRevision: number;
        readonly continuationAuthorityDigest: string;
      };
    },
  ): TaskListPage {
    if (
      !Number.isInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > 100
    ) {
      throw new Error("task_page_size_invalid");
    }
    const projection = taskListProjectionSchema.parse(input.projection);
    const scopeMode = taskScopeModeSchema.parse(input.scopeMode);
    const query =
      input.query === undefined
        ? undefined
        : asciiLowercase(taskQuerySchema.parse(input.query).trim());
    const resolved = this.#resolveScope(scope, input.taskScope);
    const queryFingerprint = fingerprint("task.list@5", [
      scope.tenantId,
      scope.principalId,
      ...scopeFingerprintParts(input.taskScope),
      scopeMode,
      input.completed ?? null,
      input.pinned ?? null,
      input.backlog ?? null,
      query ?? null,
      projection,
      input.pageSize,
      input.authorityBinding ?? null,
    ]);
    const after = input.cursor
      ? decodeTaskCursor(input.cursor, queryFingerprint)
      : undefined;
    const scopeSelection =
      scopeMode === "subtree" && resolved.scopeKind === "global"
        ? { clause: globalSubtreeClause, values: [] }
        : scopeMode === "subtree" && resolved.scopeKind === "project"
          ? {
              // A project's subtree spans its tasks and the thread tasks of
              // threads in its active locations.
              clause: `(
                (scope_kind = 'project' AND project_id = ?)
                OR (
                  scope_kind = 'thread'
                  AND EXISTS (
                    SELECT 1
                    FROM application_threads AS scoped_thread
                    JOIN workspaces AS scoped_location
                      ON scoped_location.tenant_id = scoped_thread.tenant_id
                      AND scoped_location.owner_principal_id = scoped_thread.owner_principal_id
                      AND scoped_location.id = scoped_thread.workspace_id
                    WHERE scoped_thread.tenant_id = tasks.tenant_id
                      AND scoped_thread.owner_principal_id = tasks.owner_principal_id
                      AND scoped_thread.id = tasks.thread_id
                      AND scoped_location.project_id = ?
                      AND scoped_location.removed_at IS NULL
                  )
                )
              )`,
              values: [resolved.projectId, resolved.projectId],
            }
          : resolved.scopeKind === "global"
            ? { clause: "scope_kind = 'global'", values: [] }
            : resolved.scopeKind === "project"
              ? {
                  clause: "scope_kind = 'project' AND project_id = ?",
                  values: [resolved.projectId],
                }
              : {
                  clause: "scope_kind = 'thread' AND thread_id = ?",
                  values: [resolved.threadId],
                };
    const filters = [
      input.completed === undefined
        ? undefined
        : input.completed
          ? "completed_at IS NOT NULL"
          : "completed_at IS NULL",
      input.pinned === undefined ? undefined : "pinned = ?",
      input.backlog === undefined ? undefined : "backlog = ?",
      query === undefined
        ? undefined
        : "(instr(lower(title), ?) > 0 OR instr(lower(details), ?) > 0)",
    ].filter((filter): filter is string => filter !== undefined);
    const rows = this.database
      .prepare(
        `
          SELECT id, scope_kind AS scopeKind, project_id AS projectId,
            thread_id AS threadId,
            ${associatedProjectColumn},
            title, pinned, backlog, completed_at AS completedAt,
            revision, created_at AS createdAt, updated_at AS updatedAt,
            json_array_length(files_json) AS fileCount
          FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ? AND ${scopeSelection.clause}
            ${filters.map((filter) => `AND ${filter}`).join("\n            ")}
            ${after ? "AND (created_at > ? OR (created_at = ? AND id > ?))" : ""}
          ORDER BY created_at ASC, id ASC
          LIMIT ?
        `,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        ...scopeSelection.values,
        ...(input.pinned === undefined ? [] : [input.pinned ? 1 : 0]),
        ...(input.backlog === undefined ? [] : [input.backlog ? 1 : 0]),
        ...(query === undefined ? [] : [query, query]),
        ...(after ? [after.createdAt, after.createdAt, after.id] : []),
        input.pageSize + 1,
      ) as TaskSummaryRow[];
    if (projection === "full") {
      const items: AssociatedTaskRecord[] = [];
      let serializedBytes = 0;
      for (const row of rows.slice(0, input.pageSize)) {
        const record = this.getAssociated(scope, row.id);
        const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
        if (
          items.length > 0 &&
          serializedBytes + recordBytes > FULL_TASK_LIST_RECORD_BUDGET_BYTES
        ) {
          break;
        }
        items.push(record);
        serializedBytes += recordBytes;
      }
      const last = items.at(-1);
      return {
        projection,
        items,
        ...(last &&
        (items.length < Math.min(rows.length, input.pageSize) ||
          rows.length > input.pageSize)
          ? {
              nextCursor: encodeTaskCursor({
                fingerprint: queryFingerprint,
                createdAt: last.createdAt,
                id: last.id,
              }),
            }
          : {}),
      };
    }
    const items = rows.slice(0, input.pageSize).map((row) => ({
      ...row,
      pinned: row.pinned === 1,
      backlog: row.backlog === 1,
    }));
    const last = items.at(-1);
    return {
      projection,
      items,
      ...(rows.length > input.pageSize && last
        ? {
            nextCursor: encodeTaskCursor({
              fingerprint: queryFingerprint,
              createdAt: last.createdAt,
              id: last.id,
            }),
          }
        : {}),
    };
  }

  find(scope: RequestScope, taskId: string): TaskRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${columns}
          FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, taskId) as TaskRow | undefined;
    return row ? this.#presentRow(row) : undefined;
  }

  get(scope: RequestScope, taskId: string): TaskRecord {
    const record = this.find(scope, taskId);
    if (!record) {
      throw new DomainError("not_found", "The task was not found.");
    }
    return record;
  }

  findAssociated(
    scope: RequestScope,
    taskId: string,
  ): AssociatedTaskRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${associatedColumns}
          FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, taskId) as
      AssociatedTaskRow | undefined;
    return row ? this.#presentAssociatedRow(row) : undefined;
  }

  getAssociated(scope: RequestScope, taskId: string): AssociatedTaskRecord {
    const record = this.findAssociated(scope, taskId);
    if (!record) {
      throw new DomainError("not_found", "The task was not found.");
    }
    return record;
  }

  /**
   * Read a task body only at the revision whose authority was admitted.
   * Every scope change increments the same CAS revision, so this also closes
   * scope-change races between admission and the read.
   */
  getAtRevision(
    scope: RequestScope,
    taskId: string,
    expectedRevision: number,
  ): TaskRecord {
    const record = this.get(scope, taskId);
    if (record.revision !== expectedRevision) {
      throw new DomainError(
        "conflict",
        "The task authority changed before it could be read.",
      );
    }
    return record;
  }

  create(
    scope: RequestScope,
    input: {
      readonly title: string;
      readonly details?: string;
      readonly pinned?: boolean;
      readonly backlog?: boolean;
      readonly files?: readonly string[];
      readonly scope: TaskScope;
      readonly mutationId: string;
      readonly now: number;
    },
  ): TaskRecord {
    taskTitleSchema.parse(input.title);
    const details = input.details ?? "";
    taskDetailsSchema.parse(details);
    const pinned = input.pinned ?? false;
    const backlog = input.backlog ?? false;
    const files = input.files ?? [];
    taskFilesSchema.parse(files);
    // A request that leaves a task out of the backlog fingerprints as it did
    // before Backlog existed, so a retry across the upgrade still replays.
    const requestFingerprint = fingerprint("create_task", [
      input.title,
      details,
      pinned,
      files,
      ...scopeFingerprintParts(input.scope),
      ...(backlog ? [{ backlog }] : []),
    ]);
    return this.database.transaction(() => {
      const replayed = this.#replayedTask(
        scope,
        input.mutationId,
        "create_task",
        requestFingerprint,
      );
      if (replayed) return replayed;
      const resolved = this.#resolveScope(scope, input.scope);
      const id = randomUUID();
      this.database
        .prepare(
          `
            INSERT INTO tasks(
              tenant_id, owner_principal_id, id, scope_kind, project_id,
              thread_id, title, details, pinned, backlog, files_json,
              completed_at, revision, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          id,
          resolved.scopeKind,
          resolved.projectId,
          resolved.threadId,
          input.title,
          details,
          pinned ? 1 : 0,
          backlog ? 1 : 0,
          JSON.stringify(files),
          input.now,
          input.now,
        );
      const record = this.get(scope, id);
      this.#insertReceipt(
        scope,
        input.mutationId,
        "create_task",
        requestFingerprint,
        record,
        input.now,
      );
      return record;
    })();
  }

  update(
    scope: RequestScope,
    taskId: string,
    input: {
      readonly title?: string;
      readonly details?: string;
      readonly completed?: boolean;
      readonly pinned?: boolean;
      readonly backlog?: boolean;
      readonly files?: readonly string[];
      readonly scope?: TaskScope;
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): TaskRecord {
    if (input.title !== undefined) taskTitleSchema.parse(input.title);
    if (input.details !== undefined) taskDetailsSchema.parse(input.details);
    if (input.files !== undefined) taskFilesSchema.parse(input.files);
    const legacyFingerprintParts = [
      taskId,
      input.title ?? null,
      input.details ?? null,
      input.completed ?? null,
      input.expectedRevision,
    ] as const;
    // Each later field extends the fingerprint only when a request sets it,
    // so earlier request shapes keep their fingerprints.
    const extendedFingerprintParts = [
      ...legacyFingerprintParts,
      input.pinned ?? null,
      input.files ?? null,
      input.scope === undefined ? null : scopeFingerprintParts(input.scope),
    ] as const;
    const requestFingerprint = fingerprint(
      "update_task",
      input.backlog !== undefined
        ? [...extendedFingerprintParts, input.backlog]
        : input.pinned === undefined &&
            input.files === undefined &&
            input.scope === undefined
          ? legacyFingerprintParts
          : extendedFingerprintParts,
    );
    return this.database.transaction(() => {
      const replayed = this.#replayedTask(
        scope,
        input.mutationId,
        "update_task",
        requestFingerprint,
      );
      if (replayed) return replayed;
      const current = this.get(scope, taskId);
      if (current.revision !== input.expectedRevision) {
        throw new DomainError(
          "task_revision_conflict",
          "The task changed in another client.",
        );
      }
      const completed = input.completed ?? current.completedAt !== null;
      if (completed && (input.pinned === true || input.backlog === true)) {
        throw new DomainError("bad_request", TASK_COMPLETED_UNPLACED_MESSAGE);
      }
      const resolvedScope =
        input.scope === undefined
          ? undefined
          : this.#resolveScope(scope, input.scope, current);
      const assignments = ["revision = revision + 1", "updated_at = ?"];
      const values: unknown[] = [input.now];
      if (input.title !== undefined) {
        assignments.push("title = ?");
        values.push(input.title);
      }
      if (input.details !== undefined) {
        assignments.push("details = ?");
        values.push(input.details);
      }
      if (input.completed !== undefined) {
        assignments.push("completed_at = ?");
        values.push(input.completed ? input.now : null);
      }
      // Completing a task takes it out of the backlog and unpins it.
      if (input.completed === true) {
        assignments.push("pinned = 0", "backlog = 0");
      } else {
        if (input.pinned !== undefined) {
          assignments.push("pinned = ?");
          values.push(input.pinned ? 1 : 0);
        }
        if (input.backlog !== undefined) {
          assignments.push("backlog = ?");
          values.push(input.backlog ? 1 : 0);
        }
      }
      if (input.files !== undefined) {
        assignments.push("files_json = ?");
        values.push(JSON.stringify(input.files));
      }
      if (resolvedScope !== undefined) {
        assignments.push("scope_kind = ?", "project_id = ?", "thread_id = ?");
        values.push(
          resolvedScope.scopeKind,
          resolvedScope.projectId,
          resolvedScope.threadId,
        );
      }
      const changed = this.database
        .prepare(
          `
            UPDATE tasks
            SET ${assignments.join(", ")}
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND revision = ?
          `,
        )
        .run(
          ...values,
          scope.tenantId,
          scope.principalId,
          taskId,
          input.expectedRevision,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "task_revision_conflict",
          "The task changed in another client.",
        );
      }
      const record = this.get(scope, taskId);
      this.#insertReceipt(
        scope,
        input.mutationId,
        "update_task",
        requestFingerprint,
        record,
        input.now,
      );
      return record;
    })();
  }

  move(
    scope: RequestScope,
    taskId: string,
    input: {
      readonly scope: TaskScope;
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): TaskRecord {
    const requestFingerprint = fingerprint("move_task", [
      taskId,
      ...scopeFingerprintParts(input.scope),
      input.expectedRevision,
    ]);
    return this.database.transaction(() => {
      const replayed = this.#replayedTask(
        scope,
        input.mutationId,
        "move_task",
        requestFingerprint,
      );
      if (replayed) return replayed;
      const current = this.get(scope, taskId);
      const resolved = this.#resolveScope(scope, input.scope, current);
      if (
        current.scopeKind === resolved.scopeKind &&
        current.projectId === resolved.projectId &&
        current.threadId === resolved.threadId
      ) {
        if (current.revision !== input.expectedRevision) {
          throw new DomainError(
            "task_revision_conflict",
            "The task changed in another client.",
          );
        }
      } else {
        const changed = this.database
          .prepare(
            `
              UPDATE tasks
              SET scope_kind = ?, project_id = ?, thread_id = ?,
                revision = revision + 1, updated_at = ?
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
                AND revision = ?
            `,
          )
          .run(
            resolved.scopeKind,
            resolved.projectId,
            resolved.threadId,
            input.now,
            scope.tenantId,
            scope.principalId,
            taskId,
            input.expectedRevision,
          );
        if (changed.changes !== 1) {
          throw new DomainError(
            "task_revision_conflict",
            "The task changed in another client.",
          );
        }
      }
      const record = this.get(scope, taskId);
      this.#insertReceipt(
        scope,
        input.mutationId,
        "move_task",
        requestFingerprint,
        record,
        input.now,
      );
      return record;
    })();
  }

  removeCompleted(
    scope: RequestScope,
    taskId: string,
    expectedRevision: number,
  ): void {
    this.database.transaction(() => {
      const current = this.get(scope, taskId);
      if (current.revision !== expectedRevision) {
        throw new DomainError(
          "task_revision_conflict",
          "The task changed in another client.",
        );
      }
      if (current.completedAt === null) {
        throw new DomainError(
          "bad_request",
          "Only completed tasks can be deleted.",
        );
      }
      const retainedByReset = this.database
        .prepare(
          `
            SELECT 1 FROM thread_force_reset_promoted_tasks
            WHERE tenant_id = ? AND principal_id = ? AND task_id = ?
            LIMIT 1
          `,
        )
        .get(scope.tenantId, scope.principalId, taskId);
      if (retainedByReset) {
        throw new DomainError(
          "conflict",
          "The task is still referenced by a thread reset.",
        );
      }
      const changed = this.database
        .prepare(
          `
            DELETE FROM tasks
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND revision = ? AND completed_at IS NOT NULL
          `,
        )
        .run(scope.tenantId, scope.principalId, taskId, expectedRevision);
      if (changed.changes !== 1) {
        throw new DomainError(
          "task_revision_conflict",
          "The task changed in another client.",
        );
      }
    })();
  }

  /** Idempotent, receipt-less delete following the stash-delete convention. */
  remove(scope: RequestScope, taskId: string): boolean {
    return (
      this.database
        .prepare(
          `
            DELETE FROM tasks
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId, taskId).changes === 1
    );
  }

  /**
   * Bounded open thread-task summaries for an authoritative archive set.
   * Membership and ownership are both supplied by the server; callers never
   * use a browser task snapshot to select archive-impact rows.
   */
  listOpenThreadTaskSummaries(
    scope: RequestScope,
    threadIds: readonly string[],
    limit: number,
  ): OpenThreadTaskSummaryCollection {
    return this.database.transaction(() => {
      if (!Number.isInteger(limit) || limit < 0) {
        throw new Error("open_thread_task_summary_limit_invalid");
      }
      if (threadIds.length === 0) {
        return {
          items: [],
          total: 0,
          omitted: 0,
          snapshot: this.openThreadTaskSnapshot(scope, threadIds),
        };
      }
      const placeholders = threadIds.map(() => "?").join(", ");
      const countRow = this.database
        .prepare(
          `
            SELECT COUNT(*) AS total
            FROM tasks
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND scope_kind = 'thread'
              AND thread_id IN (${placeholders})
              AND completed_at IS NULL
          `,
        )
        .get(scope.tenantId, scope.principalId, ...threadIds) as {
        readonly total: number;
      };
      const items = this.database
        .prepare(
          `
            SELECT id, title, thread_id AS threadId
            FROM tasks
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND scope_kind = 'thread'
              AND thread_id IN (${placeholders})
              AND completed_at IS NULL
            ORDER BY created_at ASC, id ASC
            LIMIT ?
          `,
        )
        .all(
          scope.tenantId,
          scope.principalId,
          ...threadIds,
          limit,
        ) as OpenThreadTaskSummary[];
      return {
        items,
        total: countRow.total,
        omitted: countRow.total - items.length,
        snapshot: this.openThreadTaskSnapshot(scope, threadIds),
      };
    })();
  }

  /** Keep displayed titles and both confirmation choices in one read snapshot. */
  listOpenThreadTaskFamilySummaries(
    scope: RequestScope,
    threadIds: readonly string[],
    limit: number,
  ) {
    return this.database.transaction(() => ({
      root: this.listOpenThreadTaskSummaries(scope, threadIds.slice(0, 1), limit),
      descendants: this.listOpenThreadTaskSummaries(
        scope,
        threadIds.slice(1),
        limit,
      ),
      familySnapshot: this.openThreadTaskSnapshot(scope, threadIds),
    }))();
  }

  /** Hash every open task revision, including rows beyond the visible summary limit. */
  openThreadTaskSnapshot(
    scope: RequestScope,
    threadIds: readonly string[],
  ): string {
    const canonicalThreadIds = [...new Set(threadIds)].sort();
    const hash = createHash("sha256").update(
      JSON.stringify([scope.tenantId, scope.principalId, canonicalThreadIds]),
    );
    if (canonicalThreadIds.length > 0) {
      const placeholders = canonicalThreadIds.map(() => "?").join(", ");
      const rows = this.database
        .prepare(`
          SELECT id, revision FROM tasks
          WHERE tenant_id = ? AND owner_principal_id = ? AND scope_kind = 'thread'
            AND thread_id IN (${placeholders}) AND completed_at IS NULL
          ORDER BY id ASC
        `)
        .iterate(scope.tenantId, scope.principalId, ...canonicalThreadIds);
      for (const row of rows) hash.update(JSON.stringify(row));
    }
    return hash.digest("hex");
  }

  /** Called inside the inventory transaction, before any inventory/task writes. */
  assertOpenThreadTaskSnapshot(
    scope: RequestScope,
    threadIds: readonly string[],
    disposition: OpenTaskDisposition,
    expectedSnapshot: string | undefined,
  ): void {
    if (disposition === "complete" && expectedSnapshot === undefined) {
      throw new DomainError(
        "bad_request",
        "Completing tasks requires a reviewed open-task snapshot.",
      );
    }
    if (
      expectedSnapshot !== undefined &&
      expectedSnapshot !== this.openThreadTaskSnapshot(scope, threadIds)
    ) {
      throw new DomainError(
        "conflict",
        "Open tasks changed while this action was being confirmed. Review the updated impact and try again.",
      );
    }
  }

  /**
   * Archive-time disposition of the archive set's open thread tasks. Runs
   * inside the caller's archive transaction (better-sqlite3 nests as a
   * savepoint); the enclosing inventory mutation receipt covers it, so no
   * task receipt is written here. Completion keeps ownership intact. Returns
   * changed task ids for post-commit publication.
   */
  applyOpenThreadTaskDisposition(
    scope: RequestScope,
    threadIds: readonly string[],
    disposition: Exclude<OpenTaskDisposition, "keep">,
    now: number,
  ): readonly string[] {
    if (threadIds.length === 0) return [];
    const placeholders = threadIds.map(() => "?").join(", ");
    const dispositionSql =
      disposition === "complete"
        ? `
          UPDATE tasks
          SET completed_at = ?, pinned = 0, backlog = 0,
            revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND scope_kind = 'thread' AND thread_id IN (${placeholders})
            AND completed_at IS NULL
          RETURNING id
        `
        : disposition === "move_to_global"
          ? `
          UPDATE tasks
          SET scope_kind = 'global', project_id = NULL, thread_id = NULL,
            revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND thread_id IN (${placeholders})
            AND completed_at IS NULL
          RETURNING id
        `
          : `
          UPDATE tasks
          SET scope_kind = 'project',
            project_id = ${threadLocationColumn("project_id")},
            thread_id = NULL,
            revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND thread_id IN (${placeholders})
            AND completed_at IS NULL
          RETURNING id
        `;
    return this.database.transaction(() => {
      const changed = this.database
        .prepare(dispositionSql)
        .all(
          ...(disposition === "complete" ? [now] : []),
          now,
          scope.tenantId,
          scope.principalId,
          ...threadIds,
        ) as readonly {
        readonly id: string;
      }[];
      return changed.map(({ id }) => id);
    })();
  }

  /**
   * A removed project is not a destination; naming the project a task is
   * already in stays an in-place edit, as the commit-time guard allows.
   */
  #resolveScope(
    scope: RequestScope,
    target: TaskScope,
    current?: Pick<TaskRecord, "scopeKind" | "projectId">,
  ): ResolvedScopeColumns {
    switch (target.kind) {
      case "global":
        return { scopeKind: "global", projectId: null, threadId: null };
      case "project": {
        const project = this.database
          .prepare(
            `
              SELECT removed_at AS removedAt
              FROM projects
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .get(scope.tenantId, scope.principalId, target.projectId) as
          { readonly removedAt: number | null } | undefined;
        const unchanged =
          current?.scopeKind === "project" &&
          current.projectId === target.projectId;
        if (!project || (project.removedAt !== null && !unchanged)) {
          throw new DomainError(
            "not_found",
            "The destination project was not found.",
          );
        }
        return {
          scopeKind: "project",
          projectId: target.projectId,
          threadId: null,
        };
      }
      case "thread": {
        const thread = this.database
          .prepare(
            `
              SELECT 1
              FROM application_threads
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .get(scope.tenantId, scope.principalId, target.threadId);
        if (!thread) {
          throw new DomainError(
            "not_found",
            "The destination thread was not found.",
          );
        }
        return {
          scopeKind: "thread",
          projectId: null,
          threadId: target.threadId,
        };
      }
    }
  }

  #presentRow(row: TaskRow): TaskRecord {
    const { pinned, backlog, filesJson, ...record } = row;
    return {
      ...record,
      pinned: pinned === 1,
      backlog: backlog === 1,
      files: taskFilesSchema.parse(JSON.parse(filesJson)),
    };
  }

  #presentAssociatedRow(row: AssociatedTaskRow): AssociatedTaskRecord {
    const { associatedProjectId, associatedWorkspaceId, ...taskRow } = row;
    return {
      ...this.#presentRow(taskRow),
      associatedProjectId,
      associatedWorkspaceId,
    };
  }

  /**
   * A replayed mutation returns the receipted result — the committed row as
   * of the original mutation — not the live row, so retries stay stable when
   * later mutations changed or deleted the task.
   */
  #replayedTask(
    scope: RequestScope,
    mutationId: string,
    operationKind: string,
    requestFingerprint: string,
  ): TaskRecord | undefined {
    const receipt = this.database
      .prepare(
        `
          SELECT operation_kind AS operationKind,
            request_fingerprint AS requestFingerprint,
            result_json AS resultJson
          FROM task_mutation_receipts
          WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      TaskMutationReceipt | undefined;
    if (!receipt) return undefined;
    if (
      receipt.operationKind !== operationKind ||
      receipt.requestFingerprint !== requestFingerprint
    ) {
      throw new DomainError(
        "conflict",
        "The mutation ID was reused for a different operation.",
      );
    }
    const { record } = JSON.parse(receipt.resultJson) as {
      readonly record: TaskRecord;
    };
    return record;
  }

  #insertReceipt(
    scope: RequestScope,
    mutationId: string,
    operationKind: string,
    requestFingerprint: string,
    record: TaskRecord,
    now: number,
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO task_mutation_receipts(
            tenant_id, principal_id, mutation_id, operation_kind,
            request_fingerprint, result_json, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        mutationId,
        operationKind,
        requestFingerprint,
        JSON.stringify({ version: 1, record }),
        now,
      );
  }
}
