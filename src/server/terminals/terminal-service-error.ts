export type TerminalServiceErrorCode =
  | "not_found"
  | "conflict"
  | "invalid_transition"
  | "environment_unavailable"
  | "runtime_unavailable";

/** A browser-safe terminal administration failure; HTTP projects it centrally. */
export class TerminalServiceError extends Error {
  constructor(
    readonly code: TerminalServiceErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "TerminalServiceError";
  }
}
