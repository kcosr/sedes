import type {
  BulkInventoryImpact,
  BulkInventoryMutationRequest,
  BulkInventoryMutationResult,
  InventoryTransitionRequest,
  NormalizedApplicationThreadSummary,
  ThreadArchiveImpact,
} from "../../shared/index.js";
import { ApiError } from "../api/ApiClient.js";
import { navigate, parseRoute } from "../app/router.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { getBlockingOperation, runBlockingOperation } from "./blocking-operation.js";

/**
 * Whether archiving needs the choices dialog: descendants, unfinished work
 * (open tasks, stashed prompts, unanswered questions), an isolated workspace,
 * or an unavailable plain archive. Otherwise "Archive" archives at once.
 */
export function archiveNeedsChoices(impact: ThreadArchiveImpact): boolean {
  return (
    impact.descendantCount > 0 ||
    impact.openTasks.root.total > 0 ||
    impact.pendingQuestions.root > 0 ||
    impact.stashedPrompts.root > 0 ||
    impact.executionWorkspace.kind === "isolated" ||
    !impact.archiveOnly.available
  );
}

type ArchiveRequest = Extract<InventoryTransitionRequest, { action: "archive" | "archive_family" }>;
type Archived = { choice: "only" | "all"; ids: readonly string[] };

export function leaveArchivedThread(ids: readonly string[]): boolean {
  const route = parseRoute(window.location.pathname);
  if (route.name !== "thread" || !ids.includes(route.threadId)) return false;
  navigate("/");
  return true;
}

export function archiveImpactChanged(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "conflict" || error.code === "inventory_revision_conflict");
}

function archiveRefused(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 &&
    error.status !== 408 && error.code !== "operation_outcome_uncertain";
}

interface ConfirmedStackArchive {
  readonly impact: BulkInventoryImpact;
  readonly request: Extract<BulkInventoryMutationRequest, { action: "archive" }>;
  pending?: Promise<BulkInventoryMutationResult>;
}

export interface ThreadArchiveStart {
  readonly thread: NormalizedApplicationThreadSummary;
  readonly onArchived?: (choice: "only" | "all", threadIds: readonly string[]) => void;
  readonly onPendingChange?: (pending: boolean) => void;
  readonly returnFocusRef?: { readonly current: HTMLElement | null };
}

export interface ThreadArchiveOperation extends ThreadArchiveStart {
  readonly id: number;
  readonly result?:
    | { readonly kind: "choices"; readonly impact: ThreadArchiveImpact }
    | { readonly kind: "error"; readonly message: string };
}

/** Browser-session state, scoped to one application connection and its thread ids. */
class ThreadArchiveOperations {
  #operations: readonly ThreadArchiveOperation[] = [];
  #nextId = 0;
  readonly #listeners = new Set<() => void>();
  readonly #stacks = new Map<string, ConfirmedStackArchive>();
  readonly #confirmed = new Map<string, { request: ArchiveRequest; pending?: Promise<Archived> }>();
  readonly #pending = new Map<number, Promise<void>>();

  constructor(readonly store: ApplicationClientStore) {}

  getSnapshot = (): readonly ThreadArchiveOperation[] => this.#operations;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #publish(operations: readonly ThreadArchiveOperation[]): void {
    this.#operations = operations;
    for (const listener of this.#listeners) listener();
  }

  closeResult(id: number): void {
    this.#publish(this.#operations.filter((operation) => operation.id !== id));
  }

  #setResult(id: number, result: ThreadArchiveOperation["result"]): void {
    this.#publish(this.#operations.map((operation) =>
      operation.id === id ? { ...operation, result } : operation,
    ));
  }

  confirmed(threadId: string): ArchiveRequest | undefined {
    return this.#confirmed.get(threadId)?.request;
  }

  stack(key: string) { return this.#stacks.get(key); }

  submitStack(key: string, impact: BulkInventoryImpact, request: ConfirmedStackArchive["request"]) {
    const attempt = this.#stacks.get(key) ?? { request, impact };
    this.#stacks.set(key, attempt);
    attempt.pending ??= this.store.mutateBulkInventory(attempt.request)
      .then(result => { this.#stacks.delete(key); return result; })
      .catch((error: unknown) => {
        if (archiveRefused(error)) this.#stacks.delete(key);
        throw error;
      }).finally(() => { attempt.pending = undefined; });
    return attempt.pending;
  }

  submit(threadId: string, request: ArchiveRequest): Promise<Archived> {
    const attempt = this.#confirmed.get(threadId) ?? { request };
    this.#confirmed.set(threadId, attempt);
    attempt.pending ??= this.store.archiveThreads(threadId, attempt.request)
      .then((ids): Archived => {
        this.#confirmed.delete(threadId);
        return { choice: attempt.request.action === "archive" ? "only" : "all", ids };
      })
      .catch((error: unknown) => {
        // A lost response can follow commit. Retain the exact request until a
        // receipt or a definitive pre-commit refusal settles its outcome.
        if (archiveRefused(error)) this.#confirmed.delete(threadId);
        throw error;
      }).finally(() => { attempt.pending = undefined; });
    return attempt.pending;
  }

  async start(options: ThreadArchiveStart): Promise<void> {
    // Both the request and any remaining choices belong to the thread, not to
    // whichever header, row, or drawer happened to launch them.
    if (getBlockingOperation()) return;
    const existing = this.#operations.find(
      (operation) => operation.thread.id === options.thread.id,
    );
    if (existing) {
      const completion = this.#pending.get(existing.id);
      if (completion && !existing.result) {
        await runBlockingOperation({
          message: "Archiving thread…",
          deferProgress: true,
          run: () => completion,
        });
      }
      return;
    }

    let dismissed = false;
    let surfacePending = false;
    const setPending = (pending: boolean) => {
      if (pending === surfacePending) return;
      surfacePending = pending;
      options.onPendingChange?.(pending);
    };
    let archiveStarted = false;
    let confirmFreshImpact = false;
    let work: Promise<Archived | undefined> | undefined;
    const operation: ThreadArchiveOperation = {
      ...options,
      id: ++this.#nextId,
      onPendingChange: setPending,
      onArchived: (choice, ids) => {
        if (!dismissed) options.onArchived?.(choice, ids);
      },
    };
    let finish!: () => void;
    this.#pending.set(operation.id, new Promise<void>((resolve) => { finish = resolve; }));
    this.#publish([...this.#operations, operation]);
    setPending(true);
    try {
      await runBlockingOperation({
        message: "Archiving thread…",
        deferProgress: true,
        onDismiss: () => {
          dismissed = true;
          // Release the initiating surface's controls; the shared registry
          // still prevents another archive of this thread.
          setPending(false);
        },
        onDismissedError: (error) => this.#setResult(operation.id, {
          kind: "error",
          message: error instanceof Error ? error.message : "The thread could not be archived.",
        }),
        run: () => {
          work = (async () => {
            const id = options.thread.id;
            let request = this.confirmed(id);
            if (!request) {
              const impact = await this.store.getThreadArchiveImpact(id);
              if (confirmFreshImpact || archiveNeedsChoices(impact)) {
                this.#setResult(operation.id, { kind: "choices", impact });
                return;
              }
              request = {
                action: "archive", mutationId: crypto.randomUUID(),
                expectedRevision: options.thread.inventoryRevision,
                expectedStashedPromptCount: impact.stashedPrompts.root,
                expectedPendingQuestionCount: impact.pendingQuestions.root,
                expectedOpenTaskSnapshot: impact.openTasks.root.snapshot,
                executionWorkspaceDisposition: { kind: "keep" },
              };
            }
            archiveStarted = true;
            try {
              return await this.submit(id, request);
            } catch (error) {
              if (!archiveImpactChanged(error)) throw error;
              // A change to reviewed work requires fresh, explicit confirmation,
              // even if refreshing the impact fails and the user retries.
              archiveStarted = false;
              confirmFreshImpact = true;
              const impact = await this.store.getThreadArchiveImpact(id);
              this.#setResult(operation.id, { kind: "choices", impact });
            }
          })();
          return work;
        },
        retry: (error) => !archiveStarted || Boolean(this.confirmed(options.thread.id)) || (error instanceof ApiError && error.retryable),
        onSuccess: (archived) => {
          if (archived) operation.onArchived?.(archived.choice, archived.ids);
        },
      });
      // The runner reports errors; keep the shared guard until work settles.
      await work?.catch(() => undefined);
    } finally {
      setPending(false);
      this.#pending.delete(operation.id);
      finish();
      if (!this.#operations.find(({ id }) => id === operation.id)?.result) {
        this.closeResult(operation.id);
      }
    }
  }
}

const operationsByConnection = new WeakMap<ApplicationClientStore, ThreadArchiveOperations>();
export function getThreadArchiveOperations(store: ApplicationClientStore): ThreadArchiveOperations {
  let operations = operationsByConnection.get(store);
  if (!operations) {
    operations = new ThreadArchiveOperations(store);
    operationsByConnection.set(store, operations);
  }
  return operations;
}
