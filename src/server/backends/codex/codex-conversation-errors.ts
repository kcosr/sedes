/**
 * Normalized BackendError construction and Codex RPC, binding, and
 * interaction error mapping for the Codex conversation handle.
 */
import type { ContextExcerpt } from "../../../shared/protocol/context-excerpts.js";
import { CodexAppServerBindingError } from "../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import {
  BackendError,
  type BackendMutationReconciliation,
  type SubmitTurnInput,
} from "../contracts.js";
import type { CodexThread } from "./codex-c1-protocol.js";
import {
  codexThreadCompactStartMethod,
  codexThreadSetNameMethod,
  codexTurnInterruptMethod,
  codexTurnStartMethod,
  codexTurnSteerMethod,
} from "./codex-c2-protocol.js";
import { codexContextExcerptFingerprint } from "./codex-context-excerpts.js";
import { CodexInteractionBridgeError } from "./codex-interaction-bridge.js";
import { codexTaskContextFingerprint } from "./codex-task-contexts.js";
import {
  CodexRpcDeliveryError,
  CodexRpcProtocolError,
  CodexRpcRemoteError,
} from "./rpc/errors.js";

export function projectionCancelled(cause: unknown): BackendError {
  return codexError(
    "unavailable",
    "Codex projection establishment was cancelled.",
    "codex_projection_cancelled",
    true,
    cause,
  );
}

export function conversationClosed(): BackendError {
  return codexError(
    "invalid_state",
    "The Codex conversation is closed.",
    "codex_conversation_closed",
  );
}

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

export function assertCodexHistoryMode(thread: CodexThread): "legacy" | "paginated" {
  switch (thread.historyMode) {
    case "legacy":
    case "paginated":
      return thread.historyMode;
    default:
      throw codexError(
        "incompatible_protocol",
        "Codex returned an unknown history mode.",
        "codex_history_mode_invalid",
      );
  }
}

export function mutationOutcomeUnknown(operation: string): BackendError {
  return codexError(
    "submission_unknown",
    "Codex may have accepted the mutation; reconcile authoritative thread state before retrying.",
    `codex_${operation}_outcome_unknown`,
    true,
    undefined,
    true,
  );
}

export function codexContextExcerptMutationFingerprint(
  contextExcerpts: readonly ContextExcerpt[],
  operation: "submit" | "steer",
): string {
  try {
    return codexContextExcerptFingerprint(contextExcerpts);
  } catch (error) {
    throw mapCodexMutationError(error, operation);
  }
}

export function codexTaskContextMutationFingerprint(
  taskContexts: SubmitTurnInput["taskContexts"],
  operation: "submit" | "steer",
): string {
  try {
    return codexTaskContextFingerprint(taskContexts);
  } catch (error) {
    throw mapCodexMutationError(error, operation);
  }
}

export function mapCodexInteractionError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof CodexInteractionBridgeError) {
    return codexError(
      error.outcomeUnknown ? "unavailable" : "rejected",
      error.outcomeUnknown
        ? "The Codex interaction response outcome cannot be determined."
        : "The Codex interaction response is invalid or no longer pending.",
      error.code,
      error.outcomeUnknown,
      error,
      error.outcomeUnknown,
      error.lateMutationReconciliation,
    );
  }
  return codexError(
    "internal",
    "Codex could not complete the interaction response safely.",
    "codex_interaction_internal",
    false,
    error,
  );
}

export function mapCodexMutationError(
  error: unknown,
  operation: string,
  dispatched = false,
): BackendError {
  if (error instanceof BackendError) return error;
  if (!dispatched && error instanceof Error && error.message === "codex_skill_unavailable") {
    return codexError(
      "rejected",
      "The selected Codex skill is no longer available in this workspace.",
      "codex_skill_unavailable",
    );
  }
  if (error instanceof CodexAppServerBindingError) {
    const expectedMethod = {
      submit: codexTurnStartMethod.method,
      steer: codexTurnSteerMethod.method,
      interrupt: codexTurnInterruptMethod.method,
      rename: codexThreadSetNameMethod.method,
      compact: codexThreadCompactStartMethod.method,
    }[operation];
    if (
      error.method === expectedMethod &&
      error.direction === "client_request_params"
    ) {
      return codexError(
        "rejected",
        "The Codex mutation input is invalid or too large.",
        "codex_mutation_input_invalid",
        false,
        error,
      );
    }
    if (
      error.method === expectedMethod &&
      error.direction === "client_request_result"
    ) {
      return codexError(
        "submission_unknown",
        "Codex returned an invalid mutation response; its outcome is unknown.",
        "codex_mutation_response_invalid",
        true,
        error,
        true,
      );
    }
    if (dispatched) return mutationOutcomeUnknown(operation);
    return codexError(
      "internal",
      "Codex could not complete the mutation safely.",
      "codex_mutation_internal",
      false,
      error,
    );
  }
  if (error instanceof CodexRpcDeliveryError) {
    if (error.delivery === "sent_outcome_unknown") {
      return mutationOutcomeUnknown(operation);
    }
    return codexError(
      "unavailable",
      "The Codex daemon was unavailable before the mutation was sent.",
      error.message,
      true,
      error,
    );
  }
  if (error instanceof CodexRpcRemoteError) {
    if (operation === "interrupt" && error.disposition !== "rejected_not_accepted") {
      return codexError("submission_unknown", "Codex did not confirm whether Stop was applied.",
        "codex_interrupt_outcome_unknown", false, error, true);
    }
    const staleSteerCode = codexStaleSteerRejectionCode(error, operation);
    if (staleSteerCode) {
      return codexSteerTargetUnavailable(
        "The active Codex turn changed before steering.",
        staleSteerCode,
        error,
      );
    }
    return codexError(
      error.code === -32001 ? "overloaded" : "rejected",
      error.code === -32001
        ? "The Codex daemon is overloaded."
        : "Codex rejected the mutation.",
      `codex_remote_${error.code}`,
      error.code === -32001,
      error,
    );
  }
  if (error instanceof CodexRpcProtocolError) {
    return codexError(
      "submission_unknown",
      "Codex returned an invalid mutation response; its outcome is unknown.",
      "codex_mutation_response_invalid",
      true,
      error,
      true,
    );
  }
  if (!dispatched && error instanceof Error && error.name === "ZodError") {
    return codexError(
      "rejected",
      "The Codex mutation input is invalid or too large.",
      "codex_mutation_input_invalid",
      false,
      error,
    );
  }
  if (dispatched) return mutationOutcomeUnknown(operation);
  return codexError(
    "internal",
    "Codex could not complete the mutation safely.",
    "codex_mutation_internal",
    false,
    error,
  );
}

function codexStaleSteerRejectionCode(
  error: CodexRpcRemoteError,
  operation: string,
): string | undefined {
  if (
    operation !== "steer" ||
    error.method !== codexTurnSteerMethod.method ||
    error.code !== -32600
  ) {
    return undefined;
  }
  return error.rejectionReason === "no_active_turn" ? "codex_steer_no_active_turn"
    : error.rejectionReason === "expected_turn_mismatch" ? "codex_steer_expected_turn_mismatch" : undefined;
}

export function codexSteerTargetUnavailable(
  safeMessage: string,
  backendCode: string,
  cause?: unknown,
): BackendError {
  return new BackendError(
    {
      category: "invalid_state",
      retryable: false,
      crossedSubmissionBoundary: false,
      safeMessage,
      backendCode,
      steerRejectionReason: "target_no_longer_active",
    },
    cause === undefined ? undefined : { cause },
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
