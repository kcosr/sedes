/** A positively received provider refusal; transport uncertainty is never a rejection. */
export class BackendRuntimeControlRejectedError extends Error {
  constructor(readonly reason: "confirmation_stale" | "blocked" | "cleanup_unproven", options?: ErrorOptions) {
    super(`backend_runtime_control_rejected:${reason}`, options);
    this.name = "BackendRuntimeControlRejectedError";
  }
}
