import { DomainError } from "../domain/errors.js";

export type ImageShowFailure = "unsupported" | "invalid" | "size" | "unavailable" | "changed" | "busy" | "cancelled" | "request_conflict" | "inactive_turn" | "turn_limit" | "retention_failed";
const messages: Record<ImageShowFailure, string> = {
  unsupported: "Only PNG, JPEG, GIF, and WebP images can be shown.",
  invalid: "The image is malformed or exceeds the supported image dimensions.",
  size: "The image must be nonempty and at most 16 MiB.",
  unavailable: "The image is unavailable through this thread's Files access.",
  changed: "The source image, thread, or execution environment changed. Retry with a new request.",
  busy: "Image display is busy. Retry after the current captures finish.",
  cancelled: "Image capture was cancelled or timed out. Retry the request.",
  request_conflict: "The image request ID was already used with different input or a different thread binding.",
  inactive_turn: "Showing a new image requires the originating active conversation turn.",
  turn_limit: "This turn has reached its image display limit (1,000 images).",
  retention_failed: "The image could not be retained. Retry the request.",
};

/** These fixed messages are safe for tool clients; source paths never escape. */
export class ImageShowError extends DomainError {
  constructor(readonly reason: ImageShowFailure) {
    super(reason === "request_conflict" || reason === "changed" ? "conflict" :
      reason === "busy" || reason === "cancelled" || reason === "inactive_turn" || reason === "retention_failed" ? "runtime_unavailable" :
      reason === "unavailable" ? "not_found" : "bad_request", messages[reason], reason === "busy" || reason === "cancelled" || reason === "retention_failed");
  }
}
