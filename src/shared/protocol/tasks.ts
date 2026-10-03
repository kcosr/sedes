import { z } from "zod";
import {
  mutationIdSchema,
  projectIdSchema,
  taskIdSchema,
  threadIdSchema,
} from "./domain.js";

/** Tasks and Workpads belong to everyone, to a project, or to one thread. */
export const taskScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), projectId: projectIdSchema }),
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
  /** Priority: sorts first within its section. */
  pinned: z.boolean(),
  /** Stage: still open, but not current work. */
  backlog: z.boolean(),
  files: taskFilesSchema,
  /** Completing a task clears `pinned` and `backlog`. */
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

/**
 * A delivered Task as a conversation message shows it. The immutable snapshot
 * captured at delivery acceptance, scope included, stays on the server.
 */
export const messageTaskContextSchema = z.strictObject({
  id: taskIdSchema,
  title: taskTitleSchema,
  details: taskDetailsSchema,
  completedAt: z.iso.datetime().nullable(),
  revision: z.number().int().nonnegative(),
});
export type MessageTaskContext = z.infer<typeof messageTaskContextSchema>;

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
    associatedProjectId: projectIdSchema.nullable(),
  })
  .superRefine((task, context) => {
    if (task.scope.kind === "global") {
      if (task.associatedProjectId !== null) {
        context.addIssue({
          code: "custom",
          message: "A global task cannot have an associated project.",
          path: ["associatedProjectId"],
        });
      }
      return;
    }
    if (task.scope.kind === "project") {
      if (task.associatedProjectId !== task.scope.projectId) {
        context.addIssue({
          code: "custom",
          message: "A project task must be associated with its exact project.",
          path: ["associatedProjectId"],
        });
      }
      return;
    }
    if (task.associatedProjectId === null) {
      context.addIssue({
        code: "custom",
        message: "A thread task requires the project of its thread's location.",
        path: ["associatedProjectId"],
      });
    }
  });
export type AssociatedTask = z.infer<typeof associatedTaskSchema>;

/**
 * Why an update that would leave a task completed and pinned or in the
 * backlog is refused. The repository enforces it after receipt lookup, so a
 * request that committed before the rule existed still replays.
 */
export const TASK_COMPLETED_UNPLACED_MESSAGE =
  "A completed task can't be pinned or in the backlog. Reopen it first.";

export const createTaskRequestSchema = z.strictObject({
  mutationId: mutationIdSchema,
  title: taskTitleSchema,
  details: taskDetailsSchema.optional(),
  pinned: z.boolean().optional(),
  backlog: z.boolean().optional(),
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
    backlog: z.boolean().optional(),
    files: taskFilesSchema.optional(),
    scope: taskScopeSchema.optional(),
  })
  .refine(
    (request) =>
      request.title !== undefined ||
      request.details !== undefined ||
      request.completed !== undefined ||
      request.pinned !== undefined ||
      request.backlog !== undefined ||
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
 * can move up-scope, stay open, or complete in place by explicit choice.
 */
export const openTaskDispositionSchema = z.enum([
  "move_to_project",
  "move_to_global",
  "complete",
  "keep",
]);
export type OpenTaskDisposition = z.infer<typeof openTaskDispositionSchema>;

/** Fingerprint of the full principal-scoped open-task set reviewed by a caller. */
export const openTaskSnapshotSchema = z.string().regex(/^[a-f0-9]{64}$/);
