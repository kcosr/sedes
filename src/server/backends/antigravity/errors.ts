import { BackendError } from "../contracts.js";
import { AntigravityError, type AntigravityFailure } from "./port.js";

export function antigravityFailureError(failure: AntigravityFailure): BackendError {
  return new BackendError({ category: failure.delivery === "sent_outcome_unknown" ? "submission_unknown" : "rejected",
    retryable: failure.delivery === "not_sent", crossedSubmissionBoundary: failure.delivery === "sent_outcome_unknown",
    safeMessage: failure.delivery === "sent_outcome_unknown"
      ? "The Antigravity operation outcome is unknown. It has not been resent."
      : "Antigravity could not accept the requested operation.", backendCode: failure.code });
}

export function antigravityTransportError(error: unknown): unknown {
  return error instanceof AntigravityError ? antigravityFailureError(error) : error;
}

/** Read/attachment failures never authorize a new submission or expose native
 * paths, parser diagnostics, or transport details through an Error message. */
export function antigravityReadError(error: unknown, signal?: AbortSignal): BackendError {
  signal?.throwIfAborted();
  if (error instanceof BackendError) return error;
  return new BackendError({ category: "unavailable", retryable: true, crossedSubmissionBoundary: false,
    safeMessage: "Antigravity could not read or attach this native session. Verify its runtime and native history on the execution host.",
    ...(error instanceof AntigravityError ? { backendCode: error.code } : {}) });
}
