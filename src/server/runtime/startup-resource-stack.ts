export type StartupResourceCleanup = () => void | Promise<void>;

type CleanupEntry = {
  readonly label: string;
  readonly cleanup: StartupResourceCleanup;
} & (
  | {
      readonly mode: "bounded";
      readonly deadlineMilliseconds: number;
      readonly onDeadline: () => void;
    }
  | { readonly mode: "ownership_critical" }
);

export type StartupResourceCleanupPolicy =
  | {
      readonly mode?: "bounded";
      readonly deadlineMilliseconds?: number;
      /** Ownership-safe local fallback; it must not claim remote cleanup. */
      readonly onDeadline?: () => void;
    }
  | {
      /** Dependencies must remain alive until this cleanup actually settles. */
      readonly mode: "ownership_critical";
    };

const DEFAULT_CLEANUP_DEADLINE_MILLISECONDS = 10_000;

/**
 * Small explicit async ownership stack for production startup.
 *
 * Resources are registered immediately after acquisition and unwound in exact
 * reverse order. Cleanup continues after individual failures. A startup
 * failure remains the primary error; otherwise the first cleanup error is
 * reported after every registered cleanup has been attempted.
 */
export class StartupResourceStack {
  readonly #entries: CleanupEntry[] = [];
  #disposePromise: Promise<void> | undefined;

  defer(
    label: string,
    cleanup: StartupResourceCleanup,
    policy: StartupResourceCleanupPolicy = {},
  ): void {
    if (this.#disposePromise) {
      throw new Error("startup_resource_stack_already_disposed");
    }
    if (!label) {
      throw new Error("startup_resource_label_required");
    }
    if (policy.mode === "ownership_critical") {
      this.#entries.push({ label, cleanup, mode: "ownership_critical" });
    } else {
      const deadlineMilliseconds =
        policy.deadlineMilliseconds ?? DEFAULT_CLEANUP_DEADLINE_MILLISECONDS;
      if (
        !Number.isSafeInteger(deadlineMilliseconds) ||
        deadlineMilliseconds <= 0
      ) {
        throw new Error("startup_resource_cleanup_deadline_invalid");
      }
      this.#entries.push({
        label,
        cleanup,
        mode: "bounded",
        deadlineMilliseconds,
        onDeadline: policy.onDeadline ?? (() => undefined),
      });
    }
  }

  dispose(primaryError?: unknown): Promise<void> {
    this.#disposePromise ??= this.#unwind(primaryError);
    return this.#disposePromise;
  }

  async #unwind(primaryError?: unknown): Promise<void> {
    let firstError = primaryError;
    while (this.#entries.length > 0) {
      const entry = this.#entries.pop()!;
      try {
        await cleanupBeforeDeadline(entry);
      } catch (error) {
        firstError ??= new Error(
          `Startup resource "${entry.label}" failed to close.`,
          { cause: error },
        );
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}

async function cleanupBeforeDeadline(entry: CleanupEntry): Promise<void> {
  if (entry.mode === "ownership_critical") {
    await entry.cleanup();
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  const cleanup = Promise.resolve().then(entry.cleanup);
  // A timed-out cleanup continues observing its own ownership proof. Retain a
  // rejection handler because the stack deliberately proceeds to later
  // safety gates after the local fallback runs.
  void cleanup.catch(() => undefined);
  const outcome = await Promise.race([
    cleanup.then(() => "closed" as const),
    new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), entry.deadlineMilliseconds);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome === "closed") return;
  entry.onDeadline();
  throw new Error(
    `Startup resource "${entry.label}" exceeded its cleanup deadline.`,
  );
}
