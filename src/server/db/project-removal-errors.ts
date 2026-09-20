import { DomainError } from "../domain/errors.js";

// These are the fixed public diagnostics raised by migration 99. Never expose
// arbitrary database diagnostics through the application or agent-tool API.
const admissionMessages = new Set([
  "The project was removed. Restore it before starting new work.",
  "The project was removed. Restore it before moving a thread.",
  "The project was removed. Restore it before adding saved work.",
  "The project was removed. Restore it before moving saved work into it.",
  "The project was removed. Restore it before enabling scheduled work.",
]);

export function projectRemovalAdmissionError(error: unknown): DomainError | undefined {
  if (!(error instanceof Error) || !("code" in error) ||
    error.code !== "SQLITE_CONSTRAINT_TRIGGER" || !admissionMessages.has(error.message)) {
    return undefined;
  }
  return new DomainError("invalid_transition", error.message, false, { cause: error });
}
