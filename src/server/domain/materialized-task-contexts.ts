import { z } from "zod";
import { workspaceIdSchema } from "../../shared/protocol/domain.js";
import {
  MAXIMUM_COMPOSER_TASK_REFERENCES,
  taskSchema,
  taskScopeSchema,
  type MessageTaskContext,
} from "../../shared/protocol/tasks.js";

/**
 * Task scope in a delivered snapshot. Snapshots signed before projects held
 * the former `{kind: "workspace", workspaceId}` scope. Provider transcripts
 * and stored delivery evidence keep those exact bytes, so their carriers must
 * still parse and verify. The server never writes this form any more, and it
 * never reaches a browser: message parts carry `MessageTaskContext`.
 */
const materializedTaskContextScopeSchema = z.discriminatedUnion("kind", [
  ...taskScopeSchema.options,
  z.strictObject({
    kind: z.literal("workspace"),
    workspaceId: workspaceIdSchema,
  }),
]);

/**
 * Server-only immutable Task state captured at durable delivery acceptance.
 * Extending keeps every key in its original position and nothing is
 * transformed, so re-serializing a parsed snapshot reproduces the bytes that
 * carrier HMACs, Codex byte equality, and Pi fingerprints were computed over.
 */
export const materializedTaskContextSchema = taskSchema.extend({
  scope: materializedTaskContextScopeSchema,
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
