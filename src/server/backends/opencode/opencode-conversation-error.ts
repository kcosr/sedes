import { BackendError } from "../contracts.js";
import { DomainError } from "../../domain/errors.js";
import { OpenCodeHistoryError } from "./opencode-history-reader.js";
import { OpenCodeNativeProtocolError, OpenCodeNativeReadLimitError } from "./opencode-native-api.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";

const retryable = new Set([
  "opencode_request_failed", "opencode_request_aborted", "opencode_response_read_failed",
  "opencode_event_ready_timeout", "opencode_event_aborted", "opencode_event_disconnected",
  "opencode_event_stream_failed", "opencode_event_closed", "opencode_event_overflow",
  "opencode_runtime_unavailable", "opencode_runtime_start_failed", "opencode_runtime_stopping",
  "opencode_startup_timeout", "opencode_startup_exited", "opencode_owned_start_failed",
  "opencode_authentication_probe_failed", "opencode_version_probe_failed",
]);

/** Read/control-admission boundary only: this does not classify mutation acceptance. */
export function mapOpenCodeConversationError(error: unknown): BackendError {
  if (error instanceof BackendError) return error;
  if (error instanceof DomainError && (error.code === "invalid_transition" || error.code === "conflict")) {
    return failure("opencode_settings_unavailable", "invalid_state", error.retryable, error.message);
  }
  if (error instanceof OpenCodeNativeReadLimitError) {
    return new OpenCodeHistoryError(error.limit === "response_bytes" ? "response_bytes" : "records");
  }
  if (error instanceof OpenCodeNativeProtocolError) return new OpenCodeHistoryError("invalid");
  if (error instanceof OpenCodeRuntimeError) {
    if (error.code === "opencode_response_too_large") return new OpenCodeHistoryError("response_bytes");
    if (error.code === "opencode_native_not_found") return failure(error.code, "not_found", false,
      "The OpenCode conversation or requested history record no longer exists.");
    if (["opencode_native_cursor_invalid", "opencode_native_read_input_invalid", "opencode_session_location_changed"].includes(error.code)) {
      return failure(error.code, "invalid_state", false, "The OpenCode conversation changed or the requested view is invalid.");
    }
    if (error.code === "opencode_runtime_identity_changed") return failure(error.code, "invalid_state", false,
      "The OpenCode native runtime identity changed; reopen the conversation.");
    if (["opencode_request_authority_mismatch", "opencode_redirect_rejected"].includes(error.code)) {
      return failure(error.code, "permission_denied", false, "The OpenCode request does not match its admitted authority.");
    }
    if (["opencode_release_incompatible", "opencode_event_malformed", "opencode_startup_frame_invalid", "opencode_startup_frame_too_large"].includes(error.code)) {
      return failure(error.code, "incompatible_protocol", false, "The OpenCode response or release is incompatible.");
    }
    return failure(error.code, "unavailable", retryable.has(error.code), "The OpenCode native runtime is unavailable.");
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return failure("opencode_request_aborted", "unavailable", true, "The OpenCode request was cancelled or timed out.");
  }
  return failure("opencode_conversation_failed", "internal", false, "The OpenCode conversation could not be read.");
}

function failure(backendCode: string, category: BackendError["category"], retryable: boolean, safeMessage: string): BackendError {
  return new BackendError({ backendCode, category, retryable, safeMessage, crossedSubmissionBoundary: false });
}
