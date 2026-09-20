import { z } from "zod";
import {
  mutationIdSchema,
  taskIdSchema,
  threadIdSchema,
  workspaceIdSchema,
} from "./domain.js";

export const taskScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({
    kind: z.literal("workspace"),
    workspaceId: workspaceIdSchema,
  }),
  z.strictObject({ kind: z.literal("thread"), threadId: threadIdSchema }),
]);
export type TaskScope = z.infer<typeof taskScopeSchema>;

export const TASK_DETAILS_MAX_CHARACTERS = 65_536;
export const TASK_QUERY_MAX_CHARACTERS = 240;
export const TASK_FILES_MAX_COUNT = 16;
export const TASK_FILE_MAX_PATH_BYTES = 4_096;
function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const wellFormedTaskTextSchema = z.string().refine(hasWellFormedUtf16, {
  message: "Task text must contain well-formed UTF-16.",
});

export const taskTitleSchema = wellFormedTaskTextSchema.min(1).max(240);
export const taskDetailsSchema = wellFormedTaskTextSchema.max(
  TASK_DETAILS_MAX_CHARACTERS,
);
export const taskQuerySchema = wellFormedTaskTextSchema
  .max(TASK_QUERY_MAX_CHARACTERS)
  .refine((value) => value.trim().length > 0, {
    message: "A task query must contain non-whitespace text.",
  });
export const taskListProjectionSchema = z.enum(["summary", "full"]);
export type TaskListProjection = z.infer<typeof taskListProjectionSchema>;
export const taskScopeModeSchema = z.enum(["exact", "subtree"]);
export type TaskScopeMode = z.infer<typeof taskScopeModeSchema>;
export const taskFilePathSchema = z
  .string()
  .refine(hasWellFormedUtf16, {
    message: "Task file paths must contain well-formed UTF-16.",
  })
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.includes("\0") &&
      new TextEncoder().encode(value).byteLength <= TASK_FILE_MAX_PATH_BYTES,
    {
      message: `Task file paths must be absolute POSIX paths of at most ${TASK_FILE_MAX_PATH_BYTES} bytes.`,
    },
  );
export const taskFilesSchema = z
  .array(taskFilePathSchema)
  .max(TASK_FILES_MAX_COUNT)
  .refine((files) => new Set(files).size === files.length, {
    message: "Task file paths must be unique.",
  });

export const taskSchema = z.strictObject({
  id: taskIdSchema,
  scope: taskScopeSchema,
  title: taskTitleSchema,
  details: taskDetailsSchema,
  pinned: z.boolean(),
  files: taskFilesSchema,
  completedAt: z.iso.datetime().nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Task = z.infer<typeof taskSchema>;

export const MAXIMUM_COMPOSER_TASK_REFERENCES = 8;

/** Live task identity retained by a draft or stash until delivery. */
export const composerTaskReferenceSchema = z.strictObject({
  taskId: taskIdSchema,
  titleSnapshot: taskTitleSchema,
});
export type ComposerTaskReference = z.infer<typeof composerTaskReferenceSchema>;

export const composerTaskReferencesSchema = z
  .array(composerTaskReferenceSchema)
  .max(MAXIMUM_COMPOSER_TASK_REFERENCES)
  .superRefine((references, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < references.length; index += 1) {
      const taskId = references[index]!.taskId;
      if (seen.has(taskId)) {
        context.addIssue({
          code: "custom",
          message: "Composer task reference identifiers must be unique.",
          path: [index, "taskId"],
        });
      }
      seen.add(taskId);
    }
  });

export const composerTaskReferenceIdsSchema = z
  .array(taskIdSchema)
  .max(MAXIMUM_COMPOSER_TASK_REFERENCES)
  .refine((taskIds) => new Set(taskIds).size === taskIds.length, {
    message: "Composer task reference identifiers must be unique.",
  });

/** Immutable Task state captured at durable delivery acceptance. */
export const materializedTaskContextSchema = taskSchema;
export type MaterializedTaskContext = Task;

export const materializedTaskContextsSchema = z
  .array(materializedTaskContextSchema)
  .max(MAXIMUM_COMPOSER_TASK_REFERENCES)
  .superRefine((tasks, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < tasks.length; index += 1) {
      const taskId = tasks[index]!.id;
      if (seen.has(taskId)) {
        context.addIssue({
          code: "custom",
          message: "Materialized task context identifiers must be unique.",
          path: [index, "id"],
        });
      }
      seen.add(taskId);
    }
  });

export function requireUniqueTaskContextContentParts(
  parts: readonly {
    readonly kind: string;
    readonly task?: { readonly id: string };
  }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  let count = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part.kind !== "task_context" || !part.task) continue;
    count += 1;
    if (seen.has(part.task.id)) {
      context.addIssue({
        code: "custom",
        message: "Message task context identifiers must be unique.",
        path: ["content", index, "task", "id"],
      });
    }
    seen.add(part.task.id);
  }
  if (count > MAXIMUM_COMPOSER_TASK_REFERENCES) {
    context.addIssue({
      code: "custom",
      message: "User message contains too many task contexts.",
      path: ["content"],
    });
  }
}
export const associatedTaskSchema = taskSchema
  .extend({
    associatedWorkspaceId: workspaceIdSchema.nullable(),
  })
  .superRefine((task, context) => {
    if (task.scope.kind === "global") {
      if (task.associatedWorkspaceId !== null) {
        context.addIssue({
          code: "custom",
          message: "A global task cannot have an associated workspace.",
          path: ["associatedWorkspaceId"],
        });
      }
      return;
    }
    if (task.scope.kind === "workspace") {
      if (task.associatedWorkspaceId !== task.scope.workspaceId) {
        context.addIssue({
          code: "custom",
          message:
            "A workspace task must be associated with its exact workspace.",
          path: ["associatedWorkspaceId"],
        });
      }
      return;
    }
    if (task.associatedWorkspaceId === null) {
      context.addIssue({
        code: "custom",
        message: "A thread task requires an associated workspace.",
        path: ["associatedWorkspaceId"],
      });
    }
  });
export type AssociatedTask = z.infer<typeof associatedTaskSchema>;

export const createTaskRequestSchema = z.strictObject({
  mutationId: mutationIdSchema,
  title: taskTitleSchema,
  details: taskDetailsSchema.optional(),
  pinned: z.boolean().optional(),
  files: taskFilesSchema.optional(),
  scope: taskScopeSchema,
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const updateTaskRequestSchema = z
  .strictObject({
    mutationId: mutationIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    title: taskTitleSchema.optional(),
    details: taskDetailsSchema.optional(),
    completed: z.boolean().optional(),
    pinned: z.boolean().optional(),
    files: taskFilesSchema.optional(),
    scope: taskScopeSchema.optional(),
  })
  .refine(
    (request) =>
      request.title !== undefined ||
      request.details !== undefined ||
      request.completed !== undefined ||
      request.pinned !== undefined ||
      request.files !== undefined ||
      request.scope !== undefined,
    { message: "A task update must change at least one field." },
  );
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

export const moveTaskRequestSchema = z.strictObject({
  mutationId: mutationIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  scope: taskScopeSchema,
});
export type MoveTaskRequest = z.infer<typeof moveTaskRequestSchema>;

export const taskMutationResultSchema = z.strictObject({
  task: taskSchema,
});
export type TaskMutationResult = z.infer<typeof taskMutationResultSchema>;

export const taskRouteParametersSchema = z.strictObject({
  taskId: taskIdSchema,
});

/**
 * Lifecycle handling of a thread's open tasks when settling or archiving.
 * Completed tasks always stay with the thread as its record; open tasks
 * either move up-scope or stay by explicit choice.
 */
export const openTaskDispositionSchema = z.enum([
  "move_to_workspace",
  "move_to_global",
  "keep",
]);
export type OpenTaskDisposition = z.infer<typeof openTaskDispositionSchema>;
