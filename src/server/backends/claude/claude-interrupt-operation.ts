import { BackendError, type InterruptConversationInput } from "../contracts.js";

interface InterruptEntry<Result> {
  accepted: boolean;
  result?: Result;
  readonly deadlineAt: number;
}

/** Native-owner journal. Entries are never evicted while this owner can act. */
export class ClaudeInterruptOperations<Result> {
  readonly #entries = new Map<string, InterruptEntry<Result>>();

  outcome(operationId: string): "accepted" | "unknown" {
    return this.#entries.get(operationId)?.accepted ? "accepted" : "unknown";
  }

  async run(
    input: InterruptConversationInput,
    effect: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#entries.get(input.applicationOperationId);
    if (previous) {
      // A remote replay carries a newly translated remaining duration. Its
      // first owner-local deadline and outcome stay authoritative.
      if (previous.accepted) return previous.result as Result;
      throw claudeInterruptUnknown();
    }
    assertClaudeInterruptTime(input, false);
    if (this.#entries.size >= 16_384) {
      throw new BackendError({
        category: "overloaded",
        retryable: false,
        crossedSubmissionBoundary: false,
        backendCode: "claude_interrupt_capacity",
        safeMessage: "The Claude owner cannot retain another Stop operation.",
      });
    }
    const entry: InterruptEntry<Result> = {
      accepted: false,
      deadlineAt: input.deadlineAt,
    };
    this.#entries.set(input.applicationOperationId, entry);
    const controller = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    const timer = setTimeout(
      () => controller.abort(claudeInterruptUnknown()),
      Math.max(1, entry.deadlineAt - Date.now()),
    );
    timer.unref?.();
    let abort!: () => void;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(claudeInterruptUnknown());
        signal.addEventListener("abort", abort, { once: true });
      });
      const result = await Promise.race([
        Promise.resolve().then(() => {
          assertClaudeInterruptTime({ ...input, signal });
          return effect(signal);
        }),
        cancelled,
      ]);
      assertClaudeInterruptTime({ ...input, signal });
      entry.result = result;
      entry.accepted = true;
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}

export function assertClaudeInterruptTime(
  input: Pick<InterruptConversationInput, "deadlineAt" | "signal">,
  crossed = true,
): void {
  if (!Number.isSafeInteger(input.deadlineAt) ||
      input.deadlineAt <= Date.now() || input.signal?.aborted) {
    throw claudeInterruptUnknown(crossed);
  }
}

export function claudeInterruptUnknown(crossed = true): BackendError {
  return new BackendError({
    category: crossed ? "submission_unknown" : "unavailable",
    retryable: false,
    crossedSubmissionBoundary: crossed,
    backendCode: "claude_interrupt_outcome_unknown",
    safeMessage: "Claude did not confirm this Stop within its original deadline.",
  });
}
