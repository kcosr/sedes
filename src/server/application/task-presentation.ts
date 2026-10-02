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
  switch (record.scopeKind) {
    case "global":
      return { kind: "global" };
    case "project":
      return { kind: "project", projectId: record.projectId! };
    case "thread":
      return { kind: "thread", threadId: record.threadId! };
  }
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
    associatedProjectId: record.associatedProjectId,
  });
}
