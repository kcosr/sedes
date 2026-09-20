import type { SedesToolErrorCode } from "../contracts/agent-tool-contracts.js";

export class CanonicalAgentToolRequestError extends Error {
  constructor(
    readonly code: SedesToolErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CanonicalAgentToolRequestError";
  }
}

