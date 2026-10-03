import { z } from "zod";
import {
  projectIdSchema,
  taskIdSchema,
  threadIdSchema,
  workspaceIdSchema,
} from "../../shared/protocol/domain.js";
import {
  MAXIMUM_COMPOSER_TASK_REFERENCES,
  type MessageTaskContext,
  type Task,
} from "../../shared/protocol/tasks.js";

/*
 * Task attachment format v1: the immutable Task state captured when a message
 * with attached Tasks is accepted for delivery. Copies live in stored delivery
 * evidence (delivery input snapshots, queued inputs, conversation creation
 * attempts, conversation mutation receipts) and in signed provider history
 * (Pi markers, and Codex and Claude carriers written by earlier builds), and
 * none of them can be rewritten.
 *
 * The format is frozen. It is written out here field by field, with its own
 * limits, and does not follow the live Task schema, so changing a Task field
 * never changes how a stored copy parses. Key order is part of the format:
 * carrier HMACs, Codex byte equality, and Pi fingerprints are computed over
 * re-serialized copies, and parsing emits keys in this order. A different
 * attachment shape is a new version, written from then on, while v1 copies
 * stay readable.
 */

const V1_TITLE_MAX_CHARACTERS = 240;
const V1_DETAILS_MAX_CHARACTERS = 65_536;
const V1_FILES_MAX_COUNT = 16;
const V1_FILE_MAX_PATH_BYTES = 4_096;

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

const v1TextSchema = z.string().refine(hasWellFormedUtf16, {
  message: "Task text must contain well-formed UTF-16.",
});

const v1FilePathSchema = z
  .string()
  .refine(hasWellFormedUtf16, {
    message: "Task file paths must contain well-formed UTF-16.",
  })
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.includes("\0") &&
      new TextEncoder().encode(value).byteLength <= V1_FILE_MAX_PATH_BYTES,
    {
      message: `Task file paths must be absolute POSIX paths of at most ${V1_FILE_MAX_PATH_BYTES} bytes.`,
    },
  );

/**
 * Scope in a v1 copy. Copies signed before projects existed hold the former
 * `{kind: "workspace", workspaceId}` scope. The server never writes that form
 * any more, and it never reaches a browser: message parts carry
 * `MessageTaskContext`.
 */
const v1ScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), projectId: projectIdSchema }),
  z.strictObject({ kind: z.literal("thread"), threadId: threadIdSchema }),
  z.strictObject({
    kind: z.literal("workspace"),
    workspaceId: workspaceIdSchema,
  }),
]);

/** Server-only immutable Task state in attachment format v1. */
export const materializedTaskContextSchema = z.strictObject({
  id: taskIdSchema,
  scope: v1ScopeSchema,
  title: v1TextSchema.min(1).max(V1_TITLE_MAX_CHARACTERS),
  details: v1TextSchema.max(V1_DETAILS_MAX_CHARACTERS),
  pinned: z.boolean(),
  files: z
    .array(v1FilePathSchema)
    .max(V1_FILES_MAX_COUNT)
    .refine((files) => new Set(files).size === files.length, {
      message: "Task file paths must be unique.",
    }),
  completedAt: z.iso.datetime().nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type MaterializedTaskContext = z.infer<
  typeof materializedTaskContextSchema
>;

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

/**
 * Capture a live Task in attachment format v1. Only v1's fields are taken, so
 * fields the Task gains later never reach an attachment.
 */
export function materializeTaskContext(task: Task): MaterializedTaskContext {
  return materializedTaskContextSchema.parse({
    id: task.id,
    scope: task.scope,
    title: task.title,
    details: task.details,
    pinned: task.pinned,
    files: task.files,
    completedAt: task.completedAt,
    revision: task.revision,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
}

/** What a conversation message shows of a delivered Task snapshot. */
export function presentMessageTaskContext(
  task: MaterializedTaskContext,
): MessageTaskContext {
  return {
    id: task.id,
    title: task.title,
    details: task.details,
    completedAt: task.completedAt,
    revision: task.revision,
  };
}
