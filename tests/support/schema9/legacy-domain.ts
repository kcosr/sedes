/**
 * Schema-9-only values used to construct migration fixtures. These types are
 * intentionally isolated from the normalized production protocol.
 */
export type AttemptPhase =
  | "prepared"
  | "submitting"
  | "accepted_unpersisted"
  | "aborted_unpersisted";

export type BackingState =
  | "draft"
  | "materializing"
  | "native"
  | "materialization_failed";

export type InventoryState =
  | "active"
  | "snoozed"
  | "settled"
  | "archived";

export type ThreadAvailability =
  | "available"
  | "missing"
  | "quarantined"
  | "environment_unavailable";

export type ToolMode = "read_only" | "full";

export type WakeReason =
  | "manual"
  | "deadline"
  | "completion"
  | "failure"
  | "needs-input"
  | "activity";
