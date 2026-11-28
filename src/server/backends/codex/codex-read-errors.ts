import { BackendError, type BackendMutationReconciliation } from "../contracts.js";
import { CodexAppServerBindingError } from "../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import { CodexRpcDeliveryError, CodexRpcProtocolError, CodexRpcRemoteError } from "./rpc/errors.js";

export function bindingMismatch(): BackendError {
  return codexError(
    "permission_denied",
    "The Codex thread does not match this conversation binding.",
    "codex_thread_binding_mismatch",
  );
}

export function mapCodexReadError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof CodexRpcDeliveryError) {
    return codexError(
      "unavailable",
      "The Codex daemon is unavailable.",
      error.message,
      true,
      error,
    );
  }
  if (error instanceof CodexRpcRemoteError) {
    if (error.code === -32001) {
      return codexError(
        "overloaded",
        "The Codex daemon is overloaded.",
        "codex_remote_overloaded",
        true,
        error,
      );
    }
    if (error.code === -32601 || error.code === -32602) {
      return codexError(
        "incompatible_protocol",
        "The Codex daemon rejected a required released operation.",
        `codex_remote_${error.code}`,
        false,
        error,
      );
    }
    return codexError(
      "unavailable",
      "Codex could not read the thread.",
      `codex_remote_${error.code}`,
      false,
      error,
    );
  }
  if (error instanceof CodexRpcProtocolError) {
    return codexError(
      "incompatible_protocol",
      "Codex returned an invalid protocol response.",
      error.message,
      false,
      error,
    );
  }
  if (
    (error instanceof CodexAppServerBindingError &&
      error.direction === "client_request_result") ||
    (error instanceof Error && error.name === "ZodError")
  ) {
    return codexError(
      "incompatible_protocol",
      "Codex returned an invalid protocol response.",
      "codex_c1_protocol_invalid",
      false,
      error,
    );
  }
  return codexError(
    "internal",
    "Codex could not complete the read safely.",
    "codex_read_internal",
    false,
    error,
  );
}

export function codexError(
  category: BackendError["category"],
  safeMessage: string,
  backendCode: string,
  retryable = false,
  cause?: unknown,
  crossedSubmissionBoundary = false,
  lateMutationReconciliation?: Promise<BackendMutationReconciliation>,
): BackendError {
  return new BackendError(
    {
      category,
      retryable,
      crossedSubmissionBoundary,
      safeMessage,
      backendCode,
    },
    cause === undefined && lateMutationReconciliation === undefined
      ? undefined
      : { cause, lateMutationReconciliation },
  );
}
