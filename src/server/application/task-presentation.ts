import {
  associatedTaskSchema,
  taskSchema,
  type AssociatedTask,
  type Task,
  type TaskScope,
} from "../../shared/protocol/tasks.js";
import type {
  AssociatedTaskRecord,
  TaskRecord,
} from "../db/repositories/task-repository.js";

function taskScope(record: TaskRecord): TaskScope {
  if (record.scopeKind === "workspace") {
    return { kind: "workspace", workspaceId: record.workspaceId! };
  }
  if (record.scopeKind === "thread") {
    return { kind: "thread", threadId: record.threadId! };
  }
  return { kind: "global" };
}

export function presentTask(record: TaskRecord): Task {
  return taskSchema.parse({
    id: record.id,
    scope: taskScope(record),
    title: record.title,
    details: record.details,
    pinned: record.pinned,
    files: record.files,
    completedAt:
      record.completedAt === null
        ? null
        : new Date(record.completedAt).toISOString(),
    revision: record.revision,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  });
}

export function presentAssociatedTask(
  record: AssociatedTaskRecord,
): AssociatedTask {
  return associatedTaskSchema.parse({
    ...presentTask(record),
    associatedWorkspaceId: record.associatedWorkspaceId,
  });
}
