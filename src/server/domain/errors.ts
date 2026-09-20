export type DomainErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "draft_revision_conflict"
  | "inventory_revision_conflict"
  | "pin_revision_conflict"
  | "bookmark_revision_conflict"
  | "group_assignment_revision_conflict"
  | "group_revision_conflict"
  | "group_name_conflict"
  | "task_revision_conflict"
  | "task_reference_unresolved"
  | "task_context_too_large"
  | "workspace_file_revision_conflict"
  | "workspace_file_download_too_large"
  | "workspace_file_write_outcome_unknown"
  | "invalid_transition"
  | "stash_limit_reached"
  | "cursor_invalid"
  | "workspace_missing"
  | "materialization_unresolved"
  | "steer_target_unavailable"
  | "archived_thread"
  | "operation_outcome_uncertain"
  | "attachment_quota_exceeded"
  | "runtime_unavailable";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DomainError";
  }
}
