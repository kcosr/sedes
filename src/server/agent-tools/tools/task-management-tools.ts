import { Type } from "typebox";
import {
  createTaskRequestSchema,
  taskQuerySchema as taskQueryRequestSchema,
  updateTaskRequestSchema,
  type Task,
  type TaskScope,
} from "../../../shared/protocol/tasks.js";
import type {
  AgentManagementService,
  AgentTaskPage,
} from "../application/agent-management-service.js";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import {
  AGENT_TOOL_JSON_SCHEMA_DIALECT,
  normalizeCanonicalAgentToolSchema,
} from "../schema/canonical-json-schema.js";
import {
  cursorSchema,
  identifierSchema,
  isoDateSchema,
  nestedTaskOutputSchema,
  resolveTaskTargetScope,
  sharedAdapters,
  taskDetailsSchema,
  taskFilesSchema,
  taskOutputSchema,
  taskQuerySchema,
  taskBacklogDescription,
  taskPinnedDescription,
  taskScopeSchema,
  taskTargetScopeSchema,
  taskTitleSchema,
} from "./management-tool-schemas.js";
import { CANONICAL_AGENT_TOOL_MANIFEST } from "../registry/canonical-agent-tool-manifest.js";

const taskListManifest = CANONICAL_AGENT_TOOL_MANIFEST["task.list"];
const taskGetManifest = CANONICAL_AGENT_TOOL_MANIFEST["task.get"];
const taskCreateManifest = CANONICAL_AGENT_TOOL_MANIFEST["task.create"];
const taskUpdateManifest = CANONICAL_AGENT_TOOL_MANIFEST["task.update"];

type TargetScope = {
  readonly kind: "global" | "project" | "thread";
  readonly projectId?: string;
  readonly threadId?: string;
};
export type TaskListInput = {
  readonly scope: TargetScope;
  readonly scopeMode: "exact" | "subtree";
  readonly completed?: boolean;
  readonly pinned?: boolean;
  readonly backlog?: boolean;
  readonly query?: string;
  readonly projection?: "summary" | "full";
  readonly cursor?: string;
  readonly pageSize?: number;
};
export type TaskCreateInput = {
  readonly title: string;
  readonly details?: string;
  readonly pinned?: boolean;
  readonly backlog?: boolean;
  readonly files?: readonly string[];
  readonly scope: TargetScope;
};
export type TaskUpdateInput = {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly title?: string;
  readonly details?: string;
  readonly completed?: boolean;
  readonly pinned?: boolean;
  readonly backlog?: boolean;
  readonly files?: readonly string[];
  readonly scope?: TargetScope;
};

const taskSummarySchema = Type.Object(
  {
    id: identifierSchema,
    scope: taskScopeSchema,
    associatedProjectId: Type.Union([identifierSchema, Type.Null()], {
      description:
        "Read-only project association: the task's project, or the current project of a thread task's thread; null only for global tasks.",
    }),
    title: taskTitleSchema,
    pinned: Type.Boolean({ description: taskPinnedDescription }),
    backlog: Type.Boolean({ description: taskBacklogDescription }),
    completedAt: Type.Union([isoDateSchema, Type.Null()]),
    revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    createdAt: isoDateSchema,
    updatedAt: isoDateSchema,
    fileCount: Type.Integer({ minimum: 0, maximum: 16 }),
  },
  { additionalProperties: false, maxProperties: 11 },
);

/** Pin and backlog are the user's to set; an agent changes them on request. */
function placementInputDescription(action: string): string {
  return `${action} only when the user asks. A completed task cannot be pinned or in the backlog.`;
}

const readExecution = (concurrencyClass: string) => ({
  form: "inline" as const,
  adapterWaitCeilingMilliseconds: sharedAdapters,
  supportsCancellation: true,
  idempotency: "not_applicable" as const,
  progress: "none" as const,
  maximumInputBytes: 8_192,
  maximumOutputBytes: 1024 * 1024,
  concurrencyClass,
  uncertainExternalOutcome: false,
});
const writeExecution = (concurrencyClass: string) => ({
  ...readExecution(concurrencyClass),
  maximumInputBytes: 1024 * 1024,
  uncertainExternalOutcome: true,
});
const exposure = { adapters: ["pi_sdk", "mcp", "http", "cli"] as const };

const taskSummaryPageSchema = Type.Object(
  {
    projection: Type.String({ enum: ["summary"], maxLength: 7 }),
    items: Type.Array(taskSummarySchema, { maxItems: 100 }),
    nextCursor: Type.Optional(cursorSchema),
  },
  { additionalProperties: false, maxProperties: 3 },
);
const fullTaskPageSchema = Type.Object(
  {
    projection: Type.String({ enum: ["full"], maxLength: 4 }),
    items: Type.Array(nestedTaskOutputSchema, { maxItems: 100 }),
    nextCursor: Type.Optional(cursorSchema),
  },
  { additionalProperties: false, maxProperties: 3 },
);

export function createTaskListToolDefinition(
  service: AgentManagementService,
): AgentToolDefinition<TaskListInput, { readonly page: AgentTaskPage }> {
  return {
    ...taskListManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          scope: taskTargetScopeSchema,
          scopeMode: Type.String({
            enum: ["exact", "subtree"],
            maxLength: 7,
            description:
              "Select only the requested scope or include all descendant scopes. Project subtree also includes tasks on the threads of its active locations and needs access to every environment hosting one; prefer exact scope for project tasks. Global subtree spans every environment.",
          }),
          completed: Type.Optional(Type.Boolean()),
          pinned: Type.Optional(Type.Boolean()),
          backlog: Type.Optional(
            Type.Boolean({
              description:
                "Only backlog tasks (true) or only tasks outside the backlog (false). Omit to include both.",
            }),
          ),
          query: Type.Optional(taskQuerySchema),
          projection: Type.Optional(
            Type.String({
              enum: ["summary", "full"],
              maxLength: 7,
              description:
                "Select summary metadata or complete task documents; defaults to summary.",
            }),
          ),
          cursor: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 2_048,
              description:
                "Opaque next-page cursor. Continue with the same scope, scopeMode, filters, projection, and pageSize.",
            }),
          ),
          pageSize: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 100,
              description:
                "Maximum item count. Full-document pages may contain fewer items to remain below the 1 MiB output limit.",
            }),
          ),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 9,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          page: Type.Union([taskSummaryPageSchema, fullTaskPageSchema], {
            description:
              "A homogeneous page whose projection identifies whether items are summaries or complete tasks.",
          }),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 1,
        },
      ),
    ),
    requiredCapabilities: [],
    execution: readExecution("task_list_read"),
    exposure,
    adapters: {
      pi: {
        name: "sedes_task_list",
        label: "Sedes task list",
        promptSnippet:
          "Filter task summaries or complete task documents in one scope or its descendants.",
      },
      mcp: { name: "sedes_task_list" },
      http: { invocation: "inline" },
      cli: { command: taskListManifest.id },
    },
    async execute(input, context) {
      const scope = resolveTaskTargetScope(input.scope, context);
      return {
        page: service.listTasks(
          { tenantId: context.tenantId, principalId: context.principalId },
          scope,
          context.environmentAuthority,
          {
            scopeMode: input.scopeMode,
            ...(input.completed === undefined
              ? {}
              : { completed: input.completed }),
            ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
            ...(input.backlog === undefined
              ? {}
              : { backlog: input.backlog }),
            ...(input.query === undefined
              ? {}
              : { query: taskQueryRequestSchema.parse(input.query) }),
            projection: input.projection ?? "summary",
            ...(input.cursor ? { cursor: input.cursor } : {}),
            pageSize: input.pageSize ?? 50,
          },
        ),
      };
    },
  };
}

export function createTaskGetToolDefinition(
  service: AgentManagementService,
): AgentToolDefinition<{ readonly taskId: string }, Task> {
  return {
    ...taskGetManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        { taskId: identifierSchema },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 1,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(taskOutputSchema),
    requiredCapabilities: [],
    execution: readExecution("task_get_read"),
    exposure,
    adapters: {
      pi: {
        name: "sedes_task_get",
        label: "Get Sedes task",
        promptSnippet: "Read a complete Sedes task.",
      },
      mcp: { name: "sedes_task_get" },
      http: { invocation: "inline" },
      cli: { command: taskGetManifest.id },
    },
    async execute(input, context) {
      return service.getTask(
        { tenantId: context.tenantId, principalId: context.principalId },
        input.taskId,
        context.environmentAuthority,
      );
    },
  };
}

export function createTaskCreateToolDefinition(
  service: AgentManagementService,
): AgentToolDefinition<TaskCreateInput, Task> {
  return {
    ...taskCreateManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          title: taskTitleSchema,
          details: Type.Optional(taskDetailsSchema),
          pinned: Type.Optional(
            Type.Boolean({ description: placementInputDescription("Pin") }),
          ),
          backlog: Type.Optional(
            Type.Boolean({
              description: placementInputDescription("Put in the backlog"),
            }),
          ),
          files: Type.Optional(taskFilesSchema),
          scope: taskTargetScopeSchema,
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          maxProperties: 6,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(taskOutputSchema),
    requiredCapabilities: [],
    execution: writeExecution("task_create_write"),
    exposure,
    adapters: {
      pi: {
        name: "sedes_task_create",
        label: "Create Sedes task",
        promptSnippet: "Create a principal-owned Sedes task.",
      },
      mcp: { name: "sedes_task_create" },
      http: { invocation: "inline" },
      cli: { command: taskCreateManifest.id },
    },
    async execute(input, context) {
      const scope = resolveTaskTargetScope(input.scope, context);
      const request = createTaskRequestSchema.parse({
        mutationId: context.mutationId,
        title: input.title,
        ...(input.details === undefined ? {} : { details: input.details }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
        ...(input.backlog === undefined ? {} : { backlog: input.backlog }),
        ...(input.files === undefined ? {} : { files: input.files }),
        scope,
      });
      return service.createTask(
        { tenantId: context.tenantId, principalId: context.principalId },
        context.mutationId,
        context.environmentAuthority,
        {
          title: request.title,
          ...(request.details === undefined
            ? {}
            : { details: request.details }),
          ...(request.pinned === undefined ? {} : { pinned: request.pinned }),
          ...(request.backlog === undefined
            ? {}
            : { backlog: request.backlog }),
          ...(request.files === undefined ? {} : { files: request.files }),
          taskScope: request.scope,
        },
      );
    },
  };
}

export function createTaskUpdateToolDefinition(
  service: AgentManagementService,
): AgentToolDefinition<TaskUpdateInput, Task> {
  return {
    ...taskUpdateManifest,
    inputSchema: normalizeCanonicalAgentToolSchema(
      Type.Object(
        {
          taskId: identifierSchema,
          expectedRevision: Type.Integer({
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
          }),
          title: Type.Optional(taskTitleSchema),
          details: Type.Optional(taskDetailsSchema),
          completed: Type.Optional(Type.Boolean()),
          pinned: Type.Optional(
            Type.Boolean({ description: placementInputDescription("Pin") }),
          ),
          backlog: Type.Optional(
            Type.Boolean({
              description: placementInputDescription("Put in the backlog"),
            }),
          ),
          files: Type.Optional(taskFilesSchema),
          scope: Type.Optional(taskTargetScopeSchema),
        },
        {
          $schema: AGENT_TOOL_JSON_SCHEMA_DIALECT,
          additionalProperties: false,
          minProperties: 3,
          maxProperties: 9,
        },
      ),
    ),
    outputSchema: normalizeCanonicalAgentToolSchema(taskOutputSchema),
    requiredCapabilities: [],
    execution: writeExecution("task_update_write"),
    exposure,
    adapters: {
      pi: {
        name: "sedes_task_update",
        label: "Update Sedes task",
        promptSnippet: "Update a Sedes task using its current revision.",
      },
      mcp: { name: "sedes_task_update" },
      http: { invocation: "inline" },
      cli: { command: taskUpdateManifest.id },
    },
    async execute(input, context) {
      const scope: TaskScope | undefined = input.scope
        ? resolveTaskTargetScope(input.scope, context)
        : undefined;
      const request = updateTaskRequestSchema.parse({
        mutationId: context.mutationId,
        expectedRevision: input.expectedRevision,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.details === undefined ? {} : { details: input.details }),
        ...(input.completed === undefined
          ? {}
          : { completed: input.completed }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
        ...(input.backlog === undefined ? {} : { backlog: input.backlog }),
        ...(input.files === undefined ? {} : { files: input.files }),
        ...(scope === undefined ? {} : { scope }),
      });
      const { mutationId: _mutationId, ...domainRequest } = request;
      return service.updateTask(
        { tenantId: context.tenantId, principalId: context.principalId },
        context.mutationId,
        input.taskId,
        context.environmentAuthority,
        domainRequest,
      );
    },
  };
}
