import { BackendError, type BackendMutationReconciliation, type InterruptConversationInput } from "./contracts.js";

/** One immutable admission budget, including native carrier work and its acknowledgement. */
export interface ConversationInterruptBudget {
  readonly signal: AbortSignal;
  remainingMilliseconds(): number;
  /** Call immediately before the first native effect. */
  dispatch(): void;
  wait<T>(work: Promise<T>): Promise<T>;
}

interface Entry {
  readonly deadlineAt: number;
  outcome: "pending" | "accepted" | "unknown" | "not_applied";
}

function failure(code: string, crossed = false): BackendError {
  return new BackendError({
    category: crossed ? "submission_unknown" : "unavailable",
    safeMessage: crossed ? "Conversation Stop could not be confirmed." : "Conversation Stop is unavailable.",
    backendCode: code, retryable: false, crossedSubmissionBoundary: crossed,
  });
}

/** Bounded evidence for one native control generation. Missing evidence never proves acceptance. */
export class ConversationInterruptLedger {
  readonly #entries = new Map<string, Entry>();
  constructor(readonly maximumEntries = 16_384) {}

  #prior(input: InterruptConversationInput): Entry | undefined {
    if (!input.applicationOperationId || input.applicationOperationId.length > 160 ||
        !Number.isSafeInteger(input.deadlineAt)) throw failure("interrupt_input_invalid");
    const prior = this.#entries.get(input.applicationOperationId);
    if (prior && prior.deadlineAt !== input.deadlineAt) throw failure("interrupt_replay_mismatch");
    return prior;
  }

  reconcile(input: InterruptConversationInput): BackendMutationReconciliation {
    const prior = this.#prior(input);
    return { outcome: prior?.outcome === "accepted" ? "accepted" : prior?.outcome === "not_applied" ? "not_applied" : "unknown" };
  }

  async execute(input: InterruptConversationInput, lifetime: AbortSignal,
    effect: (budget: ConversationInterruptBudget) => Promise<void>): Promise<void> {
    const prior = this.#prior(input);
    if (prior) {
      if (prior.outcome === "accepted") return;
      throw failure("interrupt_replay_unconfirmed", prior.outcome !== "not_applied");
    }
    if (input.deadlineAt <= Date.now() || input.signal?.aborted || lifetime.aborted) {
      throw failure("interrupt_budget_expired");
    }
    // Keep tombstones for the generation: a replay cannot acquire a fresh deadline.
    if (this.#entries.size >= this.maximumEntries) throw failure("interrupt_ledger_full");
    const entry: Entry = { deadlineAt: input.deadlineAt, outcome: "pending" };
    this.#entries.set(input.applicationOperationId, entry);
    const timerController = new AbortController();
    const signal = AbortSignal.any([lifetime, timerController.signal, ...(input.signal ? [input.signal] : [])]);
    const timer = setTimeout(() => timerController.abort(), Math.max(1, input.deadlineAt - Date.now()));
    timer.unref?.();
    let dispatched = false;
    const remainingMilliseconds = () => {
      const remaining = input.deadlineAt - Date.now();
      if (remaining <= 0 || signal.aborted) throw failure("interrupt_budget_expired", dispatched);
      return remaining;
    };
    const budget: ConversationInterruptBudget = {
      signal, remainingMilliseconds,
      dispatch: () => { remainingMilliseconds(); dispatched = true; },
      wait: async <T>(work: Promise<T>): Promise<T> => {
        // Install both handlers even if the budget already elapsed: late failures stay observed.
        return await new Promise<T>((resolve, reject) => {
          const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(failure("interrupt_budget_expired", dispatched)); };
          signal.addEventListener("abort", onAbort, { once: true });
          void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
          try { remainingMilliseconds(); } catch (cause) { signal.removeEventListener("abort", onAbort); reject(cause); }
        });
      },
    };
    try {
      await budget.wait(effect(budget));
      remainingMilliseconds();
      entry.outcome = "accepted";
    } catch (cause) {
      // Dispatch alone is not acceptance. An explicit provider proof that the
      // native request was rejected is stronger than a transport write, while
      // deadlines, unclassified failures and late replies remain uncertain.
      const provedNotApplied = cause instanceof BackendError && !cause.crossedSubmissionBoundary &&
        !signal.aborted && Date.now() < input.deadlineAt;
      entry.outcome = !dispatched || provedNotApplied ? "not_applied" : "unknown";
      throw cause;
    } finally { clearTimeout(timer); }
  }
}
