import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { NormalizedThreadSummary } from "../../../shared/protocol/conversation.js";
import type {
  AssociatedTask,
  Task,
  TaskScope,
  TaskScopeMode,
  UpdateTaskRequest,
} from "../../../shared/protocol/tasks.js";
import type { ApplicationThreadSummaryReader } from "../../application/application-snapshot-service.js";
import type {
  OpenedWorkspaceSummary,
  WorkspaceApplicationService,
  WorkspaceEnvironmentSummary,
} from "../../application/workspace-application-service.js";
import {
  presentAssociatedTask,
  presentTask,
} from "../../application/task-presentation.js";
import type { BackendKind } from "../../backends/contracts.js";
import type { TaskRepository } from "../../db/repositories/task-repository.js";
import type { InventoryRepository } from "../../db/repositories/inventory-repository.js";
import { DomainError } from "../../domain/errors.js";
import type { TaskService } from "../../domain/task-service.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import {
  currentScopedResourceRefs,
  environmentAuthorityContinuationDigest,
  grantProjectAccessCaller,
  requireAdmittedEnvironment,
  requireAdmittedResource,
  requireAdmittedResources,
  requireExactScopeQuery,
  scopeAuthorityRefs,
  type AgentToolEnvironmentAuthorityReader,
  type TrustedEnvironmentAuthorityGrant,
} from "../environment/environment-authority.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";

export const AGENT_MANAGEMENT_DEFAULT_PAGE_SIZE = 50;
export const AGENT_MANAGEMENT_MAXIMUM_PAGE_SIZE = 100;
export const AGENT_MANAGEMENT_MAXIMUM_CURSOR_LENGTH = 2_048;

const WORKSPACE_LIST_TOOL = CANONICAL_AGENT_TOOL_MANIFEST["workspace.list"];
const THREAD_LIST_TOOL = CANONICAL_AGENT_TOOL_MANIFEST["thread.list"];
const TASK_LIST_TOOL = CANONICAL_AGENT_TOOL_MANIFEST["task.list"];

export type AgentManagementPage<T> = {
  readonly items: readonly T[];
  readonly nextCursor?: string;
};

export type AgentWorkspaceSummary = {
  readonly id: string;
  readonly label: string;
  readonly availability: "available" | "unavailable";
  readonly lastOpenedAt: string;
  readonly environment: {
    readonly id: string;
    readonly label: string;
  };
  readonly project: {
    readonly id: string;
    readonly name: string;
  };
};

export type AgentWorkspaceListScope =
  | { readonly kind: "default_environment" }
  | { readonly kind: "environment"; readonly environmentId: string }
  | { readonly kind: "all_allowed_environments" };

export type AgentThreadActivity = "idle" | "running" | "waiting_for_input";

export type AgentThreadSummary = {
  readonly id: string;
  readonly title: string;
  readonly lastActivityAt: string;
  readonly workspace: {
    readonly id: string;
    readonly label: string;
  };
  readonly environment: {
    readonly id: string;
    readonly label: string;
  };
  readonly backend: BackendKind;
  readonly lifecycle: "active" | "snoozed" | "settled" | "archived";
  readonly pinned: boolean;
  readonly activity: AgentThreadActivity;
  readonly automation: AgentThreadAutomation | null;
};

/**
 * The automation summary frozen by the `thread.list` output schema; schedule
 * detail and the prompt preview stay browser projection fields.
 */
export type AgentThreadAutomation = Omit<
  NonNullable<NormalizedThreadSummary["automation"]>,
  "schedule" | "misfirePolicy" | "promptPreview"
>;

export type AgentThreadListScope =
  | { readonly kind: "default_environment" }
  | { readonly kind: "default_workspace" }
  | { readonly kind: "workspace"; readonly workspaceId: string }
  | { readonly kind: "all_allowed_environments" };

export type AgentTaskSummary = {
  readonly id: string;
  readonly scope: TaskScope;
  readonly associatedProjectId: string | null;
  readonly title: string;
  readonly pinned: boolean;
  readonly backlog: boolean;
  readonly completedAt: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fileCount: number;
};

export type AgentTaskPage =
  | (AgentManagementPage<AgentTaskSummary> & {
      readonly projection: "summary";
    })
  | (AgentManagementPage<AssociatedTask> & { readonly projection: "full" });

type Cursor = { readonly sort: number; readonly id: string };

function queryFingerprint(kind: string, values: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, ...values]))
    .digest("hex");
}

function encodeCursor(fingerprint: string, cursor: Cursor): string {
  return Buffer.from(
    JSON.stringify({ fingerprint, ...cursor }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string, fingerprint: string): Cursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.keys(parsed).length !== 3 ||
      !("fingerprint" in parsed) ||
      parsed.fingerprint !== fingerprint ||
      !("sort" in parsed) ||
      !Number.isSafeInteger(parsed.sort) ||
      (parsed.sort as number) < 0 ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    ) {
      throw new Error("agent_management_cursor_invalid");
    }
    return { sort: parsed.sort as number, id: parsed.id };
  } catch (cause) {
    throw new DomainError(
      "cursor_invalid",
      "The management-list cursor is invalid.",
      false,
      { cause },
    );
  }
}

function activity(runState: string): AgentThreadActivity {
  if (runState === "waiting_for_input" || runState === "waiting_for_approval") {
    return "waiting_for_input";
  }
  if (
    runState === "idle" ||
    runState === "failed" ||
    runState === "disconnected"
  ) {
    return "idle";
  }
  return "running";
}

function summaryTaskScope(record: {
  readonly scopeKind: "global" | "project" | "thread";
  readonly projectId: string | null;
  readonly threadId: string | null;
}): TaskScope {
  switch (record.scopeKind) {
    case "global":
      return { kind: "global" };
    case "project":
      return { kind: "project", projectId: record.projectId! };
    case "thread":
      return { kind: "thread", threadId: record.threadId! };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("operation_aborted");
}

export class AgentManagementService {
  constructor(
    readonly input: {
      readonly database: Database.Database;
      readonly inventory: InventoryRepository;
      readonly threadSummaries: ApplicationThreadSummaryReader;
      readonly runtimes: {
        captureLoadedState(
          scope: RequestScope,
          threadId: string,
        ): Promise<{ readonly runState: string } | undefined>;
      };
      readonly workspaces: Pick<
        WorkspaceApplicationService,
        "listEnvironments" | "openWorkspaceForAgent"
      >;
      readonly taskRepository: TaskRepository;
      readonly tasks: Pick<TaskService, "create" | "update" | "removeCompleted">;
      /** Live authority facts, read through the same reader as admission. */
      readonly authorityReader: AgentToolEnvironmentAuthorityReader;
    },
  ) {}

  listEnvironments(
    scope: RequestScope,
  ): readonly WorkspaceEnvironmentSummary[] {
    return this.input.workspaces.listEnvironments(scope);
  }

  openWorkspaceForAgent(
    scope: RequestScope,
    request: {
      readonly environmentId: string;
      readonly path: string;
      readonly projectId?: string;
    },
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
    signal?: AbortSignal,
  ): Promise<OpenedWorkspaceSummary> {
    return this.input.workspaces.openWorkspaceForAgent(
      scope,
      request,
      environmentAuthority,
      signal,
    );
  }

  listWorkspaces(
    scope: RequestScope,
    request: {
      readonly scope: AgentWorkspaceListScope;
      readonly cursor?: string;
      readonly pageSize: number;
    },
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
  ): AgentManagementPage<AgentWorkspaceSummary> {
    const environmentIds =
      request.scope.kind === "default_environment"
        ? [environmentAuthority.defaults.environmentId]
        : request.scope.kind === "environment"
          ? [
              this.input.inventory.getEnvironment(
                scope,
                request.scope.environmentId,
              ).id,
            ]
          : [...environmentAuthority.targetEnvironmentIds];
    for (const environmentId of environmentIds) {
      requireAdmittedEnvironment(environmentAuthority, environmentId);
    }
    const fingerprint = queryFingerprint("workspace.list@5", [
      scope.tenantId,
      scope.principalId,
      request.scope.kind,
      request.scope.kind === "environment" ? request.scope.environmentId : null,
      environmentAuthority.defaults.environmentId,
      environmentAuthority.targetEnvironmentIds,
      environmentAuthority.policyIdentity.revision,
      environmentAuthorityContinuationDigest(
        environmentAuthority,
        WORKSPACE_LIST_TOOL,
      ),
      request.pageSize,
    ]);
    const after = request.cursor
      ? decodeCursor(request.cursor, fingerprint)
      : undefined;
    const rows = this.input.database
      .prepare(
        `
          SELECT workspace.id, workspace.display_name AS label,
            workspace.availability, workspace.environment_id AS environmentId,
            environment.label AS environmentLabel,
            project.id AS projectId, project.name AS projectName,
            workspace.last_opened_at AS sort
          FROM workspaces AS workspace
          INNER JOIN execution_environments AS environment
            ON environment.tenant_id = workspace.tenant_id
            AND environment.owner_principal_id = workspace.owner_principal_id
            AND environment.id = workspace.environment_id
          INNER JOIN projects AS project
            ON project.tenant_id = workspace.tenant_id
            AND project.owner_principal_id = workspace.owner_principal_id
            AND project.id = workspace.project_id
          WHERE workspace.tenant_id = ? AND workspace.owner_principal_id = ?
            AND workspace.removed_at IS NULL
            AND workspace.environment_id IN (${environmentIds.map(() => "?").join(", ")})
            ${after ? "AND (workspace.last_opened_at < ? OR (workspace.last_opened_at = ? AND workspace.id > ?))" : ""}
          ORDER BY workspace.last_opened_at DESC, workspace.id ASC
          LIMIT ?
        `,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        ...environmentIds,
        ...(after ? [after.sort, after.sort, after.id] : []),
        request.pageSize + 1,
      ) as Array<{
      readonly id: string;
      readonly label: string;
      readonly availability: string;
      readonly environmentId: string;
      readonly environmentLabel: string;
      readonly projectId: string;
      readonly projectName: string;
      readonly sort: number;
    }>;
    const retained = rows.slice(0, request.pageSize);
    const items = retained.map((row) => ({
      id: row.id,
      label: row.label,
      availability:
        row.availability === "available" ? "available" : "unavailable",
      lastOpenedAt: new Date(row.sort).toISOString(),
      environment: { id: row.environmentId, label: row.environmentLabel },
      project: { id: row.projectId, name: row.projectName },
    })) as AgentWorkspaceSummary[];
    const last = retained.at(-1);
    return {
      items,
      ...(rows.length > request.pageSize && last
        ? {
            nextCursor: encodeCursor(fingerprint, {
              sort: last.sort,
              id: last.id,
            }),
          }
        : {}),
    };
  }

  async listThreads(
    scope: RequestScope,
    sourceWorkspaceId: string | undefined,
    request: {
      readonly scope?: AgentThreadListScope;
      readonly query?: string;
      readonly lifecycle?: AgentThreadSummary["lifecycle"];
      readonly lastActivityAfter?: string;
      readonly hasAutomation?: boolean;
      readonly cursor?: string;
      readonly pageSize: number;
    },
    environmentAuthority: TrustedEnvironmentAuthorityGrant,
    signal = new AbortController().signal,
  ): Promise<AgentManagementPage<AgentThreadSummary>> {
    throwIfAborted(signal);
    const requestedScope = request.scope ?? {
      kind: "default_environment" as const,
    };
    if (
      requestedScope.kind === "default_workspace" &&
      sourceWorkspaceId === undefined
    ) {
      throw new Error("agent_source_workspace_unavailable");
    }
    const resolvedWorkspace =
      requestedScope.kind === "default_workspace"
        ? this.input.inventory.getWorkspace(scope, sourceWorkspaceId!)
        : requestedScope.kind === "workspace"
          ? this.input.inventory.getWorkspace(scope, requestedScope.workspaceId)
          : undefined;
    if (resolvedWorkspace) {
      requireAdmittedResource(environmentAuthority, {
        kind: "workspace",
        id: resolvedWorkspace.id,
        environmentId: resolvedWorkspace.environmentId,
      });
    }
    const environmentIds = resolvedWorkspace
      ? [resolvedWorkspace.environmentId]
      : requestedScope.kind === "default_environment"
        ? [environmentAuthority.defaults.environmentId]
        : [...environmentAuthority.targetEnvironmentIds];
    for (const environmentId of environmentIds) {
      requireAdmittedEnvironment(environmentAuthority, environmentId);
    }
    const lastActivityAfter =
      request.lastActivityAfter === undefined
        ? undefined
        : Date.parse(request.lastActivityAfter);
    if (
      lastActivityAfter !== undefined &&
      !Number.isFinite(lastActivityAfter)
    ) {
      throw new Error("agent_thread_last_activity_after_invalid");
    }
    const fingerprint = queryFingerprint("thread.list@6", [
      scope.tenantId,
      scope.principalId,
      requestedScope.kind,
      resolvedWorkspace?.id ?? null,
      environmentAuthority.defaults.environmentId,
      environmentAuthority.targetEnvironmentIds,
      environmentAuthority.policyIdentity.revision,
      environmentAuthorityContinuationDigest(
        environmentAuthority,
        THREAD_LIST_TOOL,
      ),
      request.query ?? null,
      request.lifecycle ?? null,
      request.lastActivityAfter ?? null,
      request.hasAutomation ?? null,
      request.pageSize,
    ]);
    const after = request.cursor
      ? decodeCursor(request.cursor, fingerprint)
      : undefined;
    const conditions = [
      "thread.tenant_id = ?",
      "thread.owner_principal_id = ?",
    ];
    const parameters: unknown[] = [scope.tenantId, scope.principalId];
    if (resolvedWorkspace) {
      conditions.push("thread.workspace_id = ?");
      parameters.push(resolvedWorkspace.id);
    } else {
      conditions.push(
        `thread.environment_id IN (${environmentIds.map(() => "?").join(", ")})`,
      );
      parameters.push(...environmentIds);
    }
    if (request.query !== undefined) {
      conditions.push("instr(lower(thread.title), lower(?)) > 0");
      parameters.push(request.query);
    }
    if (request.lifecycle !== undefined) {
      conditions.push("principal.inventory_state = ?");
      parameters.push(request.lifecycle);
    }
    if (request.hasAutomation !== undefined) {
      conditions.push(
        request.hasAutomation
          ? "definition.id IS NOT NULL"
          : "definition.id IS NULL",
      );
    }
    if (lastActivityAfter !== undefined) {
      conditions.push("thread.last_activity_at > ?");
      parameters.push(lastActivityAfter);
    }
    if (after) {
      conditions.push(
        "(thread.last_activity_at < ? OR (thread.last_activity_at = ? AND thread.id > ?))",
      );
      parameters.push(after.sort, after.sort, after.id);
    }
    const rows = this.input.database
      .prepare(
        `
          SELECT thread.id, thread.last_activity_at AS sort, principal.pinned,
            thread.workspace_id AS workspaceId,
            thread.environment_id AS environmentId,
            backend.kind AS backend, workspace.display_name AS workspaceLabel,
            environment.label AS environmentLabel
          FROM application_threads AS thread
          INNER JOIN thread_principal_state AS principal
            ON principal.tenant_id = thread.tenant_id
            AND principal.principal_id = thread.owner_principal_id
            AND principal.thread_id = thread.id
          INNER JOIN agent_backend_instances AS backend
            ON backend.tenant_id = thread.tenant_id
            AND backend.id = thread.backend_instance_id
          INNER JOIN workspaces AS workspace
            ON workspace.tenant_id = thread.tenant_id
            AND workspace.owner_principal_id = thread.owner_principal_id
            AND workspace.id = thread.workspace_id
          INNER JOIN execution_environments AS environment
            ON environment.tenant_id = thread.tenant_id
            AND environment.owner_principal_id = thread.owner_principal_id
            AND environment.id = thread.environment_id
          LEFT JOIN automation_definitions AS definition
            ON definition.tenant_id = thread.tenant_id
            AND definition.owner_principal_id = thread.owner_principal_id
            AND definition.anchor_thread_id = thread.id
            AND definition.deleted_at IS NULL
          WHERE ${conditions.join(" AND ")}
          ORDER BY thread.last_activity_at DESC, thread.id ASC
          LIMIT ?
        `,
      )
      .all(...parameters, request.pageSize + 1) as Array<{
      readonly id: string;
      readonly sort: number;
      readonly pinned: number;
      readonly backend: BackendKind;
      readonly workspaceId: string;
      readonly environmentId: string;
      readonly workspaceLabel: string;
      readonly environmentLabel: string;
    }>;
    const retained = rows.slice(0, request.pageSize);
    const summaries = new Map(
      this.input.threadSummaries
        .listByIds(
          scope,
          retained.map(({ id }) => id),
        )
        .map((summary) => [summary.id, summary]),
    );
    const items = await Promise.all(
      retained.map(async (row) => {
        const summary = summaries.get(row.id);
        if (!summary) throw new Error("agent_thread_summary_missing");
        const loaded = await this.input.runtimes.captureLoadedState(
          scope,
          row.id,
        );
        throwIfAborted(signal);
        const runState =
          summary.backingState === "creating"
            ? "starting"
            : summary.backingState === "creation_unknown"
              ? "failed"
              : summary.backingState === "unbound"
                ? "idle"
                : !summary.available
                  ? "disconnected"
                  : (loaded?.runState ?? "idle");
        return {
          id: summary.id,
          title: summary.title.text,
          lastActivityAt: new Date(row.sort).toISOString(),
          workspace: { id: row.workspaceId, label: row.workspaceLabel },
          environment: {
            id: row.environmentId,
            label: row.environmentLabel,
          },
          backend: row.backend,
          lifecycle: summary.inventoryState,
          pinned: row.pinned === 1,
          activity: activity(runState),
          automation: agentThreadAutomation(summary.automation),
        };
      }),
    );
    const last = retained.at(-1);
    return {
      items,
      ...(rows.length > request.pageSize && last
        ? {
            nextCursor: encodeCursor(fingerprint, {
              sort: last.sort,
              id: last.id,
            }),
          }
        : {}),
    };
  }

  listTasks(
    scope: RequestScope,
    taskScope: TaskScope,
    authority: TrustedEnvironmentAuthorityGrant,
    request: {
      readonly scopeMode: TaskScopeMode;
      readonly completed?: boolean;
      readonly pinned?: boolean;
      readonly backlog?: boolean;
      readonly query?: string;
      readonly projection: "summary" | "full";
      readonly cursor?: string;
      readonly pageSize: number;
    },
  ): AgentTaskPage {
    requireExactScopeQuery(
      authority,
      scopeAuthorityRefs(
        this.input.authorityReader,
        scope,
        taskScope,
        grantProjectAccessCaller(authority),
        request.scopeMode,
      ),
    );
    const page = this.input.taskRepository.listPage(scope, {
      taskScope,
      scopeMode: request.scopeMode,
      ...(request.completed === undefined
        ? {}
        : { completed: request.completed }),
      ...(request.pinned === undefined ? {} : { pinned: request.pinned }),
      ...(request.backlog === undefined ? {} : { backlog: request.backlog }),
      ...(request.query === undefined ? {} : { query: request.query }),
      projection: request.projection,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      pageSize: request.pageSize,
      authorityBinding: {
        sourceEnvironmentId: authority.defaults.environmentId,
        targetEnvironmentIds: authority.targetEnvironmentIds,
        policyRevision: authority.policyIdentity.revision,
        continuationAuthorityDigest: environmentAuthorityContinuationDigest(
          authority,
          TASK_LIST_TOOL,
        ),
      },
    });
    if (page.projection === "full") {
      return {
        projection: page.projection,
        items: page.items.map(presentAssociatedTask),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    }
    return {
      projection: page.projection,
      items: page.items.map((item) => ({
        id: item.id,
        scope: summaryTaskScope(item),
        associatedProjectId: item.associatedProjectId,
        title: item.title,
        pinned: item.pinned,
        backlog: item.backlog,
        completedAt:
          item.completedAt === null
            ? null
            : new Date(item.completedAt).toISOString(),
        revision: item.revision,
        createdAt: new Date(item.createdAt).toISOString(),
        updatedAt: new Date(item.updatedAt).toISOString(),
        fileCount: item.fileCount,
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  getTask(
    scope: RequestScope,
    taskId: string,
    authority: TrustedEnvironmentAuthorityGrant,
  ): Task {
    return presentTask(
      this.input.taskRepository.getAtRevision(
        scope,
        taskId,
        this.#requireAdmittedTask(scope, taskId, authority),
      ),
    );
  }

  createTask(
    scope: RequestScope,
    mutationId: string,
    authority: TrustedEnvironmentAuthorityGrant,
    request: {
      readonly title: string;
      readonly details?: string;
      readonly pinned?: boolean;
      readonly backlog?: boolean;
      readonly files?: readonly string[];
      readonly taskScope: TaskScope;
    },
  ): Promise<Task> {
    this.#requireAdmittedDestination(scope, request.taskScope, authority);
    return this.input.tasks.create(scope, {
      mutationId,
      title: request.title,
      ...(request.details === undefined ? {} : { details: request.details }),
      ...(request.pinned === undefined ? {} : { pinned: request.pinned }),
      ...(request.backlog === undefined ? {} : { backlog: request.backlog }),
      ...(request.files === undefined ? {} : { files: [...request.files] }),
      scope: request.taskScope,
    });
  }

  updateTask(
    scope: RequestScope,
    mutationId: string,
    taskId: string,
    authority: TrustedEnvironmentAuthorityGrant,
    request: Omit<UpdateTaskRequest, "mutationId">,
  ): Promise<Task> {
    const revision = this.#requireAdmittedTask(scope, taskId, authority);
    if (revision !== request.expectedRevision) {
      throw new DomainError(
        "task_revision_conflict",
        "The task changed in another client.",
      );
    }
    if (request.scope !== undefined) {
      this.#requireAdmittedDestination(scope, request.scope, authority);
    }
    return this.input.tasks.update(scope, taskId, {
      mutationId,
      ...request,
    });
  }

  async deleteTask(
    scope: RequestScope,
    taskId: string,
    authority: TrustedEnvironmentAuthorityGrant,
    expectedRevision: number,
  ): Promise<{ readonly taskId: string; readonly deleted: true }> {
    const revision = this.#requireAdmittedTask(scope, taskId, authority);
    if (revision !== expectedRevision) {
      throw new DomainError(
        "task_revision_conflict",
        "The task changed in another client.",
      );
    }
    await this.input.tasks.removeCompleted(scope, taskId, expectedRevision);
    return { taskId, deleted: true };
  }

  /** Rechecks the task's current scope; returns the admitted revision. */
  #requireAdmittedTask(
    scope: RequestScope,
    taskId: string,
    authority: TrustedEnvironmentAuthorityGrant,
  ): number {
    const refs = currentScopedResourceRefs(
      this.input.authorityReader,
      scope,
      "task",
      taskId,
      grantProjectAccessCaller(authority),
    );
    requireAdmittedResources(authority, refs);
    return refs.find(({ kind }) => kind === "task")!.revision!;
  }

  /** A destination scope must have been admitted exactly as it is now. */
  #requireAdmittedDestination(
    scope: RequestScope,
    destination: TaskScope,
    authority: TrustedEnvironmentAuthorityGrant,
  ): void {
    requireAdmittedResources(
      authority,
      scopeAuthorityRefs(
        this.input.authorityReader,
        scope,
        destination,
        grantProjectAccessCaller(authority),
        "exact",
      ),
    );
  }
}

function agentThreadAutomation(
  automation: NormalizedThreadSummary["automation"],
): AgentThreadAutomation | null {
  if (!automation) return null;
  const {
    schedule: _schedule,
    misfirePolicy: _misfirePolicy,
    promptPreview: _promptPreview,
    ...summary
  } = automation;
  return summary;
}
