import { DomainError } from "./errors.js";

/** A definitive refusal before provider submission; safe to re-admit later. */
export class AutomationDeferredError extends DomainError {
  constructor(
    readonly reason: "source_busy" | "source_materializing" | "source_recovery" | "queue_capacity",
    message: string,
    readonly eligibleAt: number | null = null,
  ) {
    super("conflict", message, true);
    this.name = "AutomationDeferredError";
  }
}
