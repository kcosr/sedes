import type {
  NormalizedApplicationThreadSummary,
  ThreadArchiveImpact,
} from "../../shared/index.js";
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
    let work: Promise<boolean> | undefined;
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
            const impact = await this.store.getThreadArchiveImpact(options.thread.id);
            if (archiveNeedsChoices(impact)) {
              this.#setResult(operation.id, { kind: "choices", impact });
              return false;
            }
            archiveStarted = true;
            await this.store.mutateInventory(options.thread, "archive", {
              expectedStashedPromptCount: impact.stashedPrompts.root,
            });
            return true;
          })();
          return work;
        },
        retry: () => !archiveStarted,
        onSuccess: (archived) => {
          if (archived) operation.onArchived?.("only", [options.thread.id]);
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
