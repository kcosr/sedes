import type Database from "better-sqlite3";
import {
  composerTaskReferencesSchema,
  materializedTaskContextsSchema,
  type ComposerTaskReference,
  type MaterializedTaskContext,
} from "../../shared/protocol/tasks.js";
import { presentTask } from "../application/task-presentation.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { TaskRepository } from "./repositories/task-repository.js";
import type { ContextExcerpt } from "../../shared/protocol/context-excerpts.js";
import {
  composerInputUtf8Bytes,
  MAXIMUM_COMPOSER_INPUT_BYTES,
} from "../../shared/protocol/context-excerpts.js";

export function parseStoredTaskReferences(
  value: string,
): ComposerTaskReference[] {
  try {
    return composerTaskReferencesSchema.parse(JSON.parse(value));
  } catch (error) {
    throw new DomainError(
      "conflict",
      "The stored task references are invalid.",
      false,
      {
        cause: error,
      },
    );
  }
}

export function serializeTaskReferences(
  value: readonly ComposerTaskReference[],
): string {
  return JSON.stringify(composerTaskReferencesSchema.parse(value));
}

export function sameTaskReferences(
  left: readonly ComposerTaskReference[],
  right: readonly ComposerTaskReference[],
): boolean {
  return serializeTaskReferences(left) === serializeTaskReferences(right);
}

export function parseStoredTaskContexts(
  value: string,
): MaterializedTaskContext[] {
  try {
    return materializedTaskContextsSchema.parse(JSON.parse(value));
  } catch (error) {
    throw new DomainError(
      "conflict",
      "The stored task contexts are invalid.",
      false,
      {
        cause: error,
      },
    );
  }
}

export function serializeTaskContexts(
  value: readonly MaterializedTaskContext[],
): string {
  return JSON.stringify(materializedTaskContextsSchema.parse(value));
}

export function sameTaskContexts(
  left: readonly MaterializedTaskContext[],
  right: readonly MaterializedTaskContext[],
): boolean {
  return serializeTaskContexts(left) === serializeTaskContexts(right);
}

/** Resolve exact principal-owned task rows while the caller's write transaction is held. */
export function materializeTaskReferences(
  database: Database.Database,
  scope: RequestScope,
  references: readonly ComposerTaskReference[],
): MaterializedTaskContext[] {
  const repository = new TaskRepository(database);
  const contexts: MaterializedTaskContext[] = [];
  for (const reference of composerTaskReferencesSchema.parse(references)) {
    const task = repository.find(scope, reference.taskId);
    if (!task) {
      throw new DomainError(
        "task_reference_unresolved",
        "An attached task no longer exists. Remove the missing task before sending.",
      );
    }
    contexts.push(presentTask(task));
  }
  return materializedTaskContextsSchema.parse(contexts);
}

/** Preserve fallback labels for retained refs; resolve labels only for newly attached IDs. */
export function resolveDraftTaskReferences(
  database: Database.Database,
  scope: RequestScope,
  current: readonly ComposerTaskReference[],
  requestedIds: readonly string[],
): ComposerTaskReference[] {
  const retained = new Map(
    current.map((reference) => [reference.taskId, reference]),
  );
  const repository = new TaskRepository(database);
  return composerTaskReferencesSchema.parse(
    requestedIds.map((taskId) => {
      const existing = retained.get(taskId);
      if (existing) return existing;
      const task = repository.find(scope, taskId);
      if (!task) {
        throw new DomainError(
          "task_reference_unresolved",
          "The task could not be attached because it no longer exists.",
        );
      }
      return { taskId: task.id, titleSnapshot: task.title };
    }),
  );
}

export function taskReferencesFromContexts(
  contexts: readonly MaterializedTaskContext[],
): ComposerTaskReference[] {
  return composerTaskReferencesSchema.parse(
    contexts.map((task) => ({ taskId: task.id, titleSnapshot: task.title })),
  );
}

export function assertMaterializedComposerBytes(input: {
  readonly text: string;
  readonly contextExcerpts: readonly ContextExcerpt[];
  readonly taskContexts: readonly MaterializedTaskContext[];
}): void {
  const bytes = composerInputUtf8Bytes(input);
  if (bytes > MAXIMUM_COMPOSER_INPUT_BYTES) {
    throw new DomainError(
      "task_context_too_large",
      "The attached task content is too large to send. Remove a task or shorten its details.",
    );
  }
}
