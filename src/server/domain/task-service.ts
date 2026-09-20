import type {
  CreateTaskRequest,
  MoveTaskRequest,
  Task,
  UpdateTaskRequest,
} from "../../shared/protocol/tasks.js";
import { presentTask } from "../application/task-presentation.js";
import type { TaskRepository } from "../db/repositories/task-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";

export interface TaskChangePublisher {
  publishTaskChange(scope: RequestScope, taskId: string): Promise<void>;
}

const PUBLICATION_RETRY_MILLISECONDS = 1_000;

type PendingTaskPublication = {
  readonly scope: RequestScope;
  readonly taskId: string;
  retryAt: number;
};

/**
 * Principal-scoped task lifecycle. Mutations commit through the repository's
 * receipt/CAS contract, then publish the committed row through the shared
 * application-snapshot publication boundary.
 *
 * A publication failure never fails the request of a committed mutation —
 * that would invite client retries with fresh mutation ids (duplicate
 * creates). The change is queued and retried through the durable scheduler,
 * mirroring InventoryService's pending-publication shape.
 */
export class TaskService {
  readonly #pendingPublications = new Map<string, PendingTaskPublication>();

  constructor(
    readonly repository: TaskRepository,
    readonly publications: TaskChangePublisher,
    readonly onRetryPending?: () => void,
  ) {}

  async create(
    scope: RequestScope,
    request: CreateTaskRequest,
    now = Date.now(),
  ): Promise<Task> {
    const record = this.repository.create(scope, {
      title: request.title,
      details: request.details ?? "",
      pinned: request.pinned ?? false,
      files: request.files ?? [],
      scope: request.scope,
      mutationId: request.mutationId,
      now,
    });
    // The application publication boundary synchronously admits this work to
    // its owned/drained tail. TaskService retains success/failure observation
    // so a success clears any older pending retry for the same task.
    void this.publishTaskChange(scope, record.id, now);
    return presentTask(record);
  }

  async update(
    scope: RequestScope,
    taskId: string,
    request: UpdateTaskRequest,
    now = Date.now(),
  ): Promise<Task> {
    const record = this.repository.update(scope, taskId, {
      title: request.title,
      details: request.details,
      completed: request.completed,
      pinned: request.pinned,
      files: request.files,
      scope: request.scope,
      expectedRevision: request.expectedRevision,
      mutationId: request.mutationId,
      now,
    });
    void this.publishTaskChange(scope, taskId, now);
    return presentTask(record);
  }

  async move(
    scope: RequestScope,
    taskId: string,
    request: MoveTaskRequest,
    now = Date.now(),
  ): Promise<Task> {
    const record = this.repository.move(scope, taskId, {
      scope: request.scope,
      expectedRevision: request.expectedRevision,
      mutationId: request.mutationId,
      now,
    });
    await this.publishTaskChange(scope, taskId, now);
    return presentTask(record);
  }

  async remove(
    scope: RequestScope,
    taskId: string,
    now = Date.now(),
  ): Promise<void> {
    this.repository.remove(scope, taskId);
    await this.publishTaskChange(scope, taskId, now);
  }

  /**
   * Publish a committed task change, queueing a scheduler-driven retry on
   * failure instead of throwing. Also satisfies TaskChangePublisher so other
   * committed flows (archive disposition) share the same retry safety.
   */
  async publishTaskChange(
    scope: RequestScope,
    taskId: string,
    now = Date.now(),
  ): Promise<void> {
    const key = `${scope.tenantId}\0${scope.principalId}\0${taskId}`;
    try {
      await this.publications.publishTaskChange(scope, taskId);
      this.#pendingPublications.delete(key);
    } catch {
      this.#queuePublicationRetry(scope, taskId, now);
    }
  }

  #queuePublicationRetry(
    scope: RequestScope,
    taskId: string,
    now: number,
  ): void {
    const key = `${scope.tenantId}\0${scope.principalId}\0${taskId}`;
    this.#pendingPublications.set(key, {
      scope,
      taskId,
      retryAt: now + PUBLICATION_RETRY_MILLISECONDS,
    });
    try {
      this.onRetryPending?.();
    } catch {
      // The pending entry remains authoritative if scheduling fails.
    }
  }

  /** Durable-scheduler source: earliest pending publication retry, if any. */
  getNearestDeadline(): number | null {
    let deadline: number | null = null;
    for (const { retryAt } of this.#pendingPublications.values()) {
      if (deadline === null || retryAt < deadline) deadline = retryAt;
    }
    return deadline;
  }

  /** Durable-scheduler source: retry publications that have come due. */
  async reconcileDue(now = Date.now()): Promise<void> {
    for (const entry of [...this.#pendingPublications.values()]) {
      if (entry.retryAt > now) continue;
      await this.publishTaskChange(entry.scope, entry.taskId, now);
    }
  }
}
