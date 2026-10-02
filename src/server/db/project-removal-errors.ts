import { DomainError } from "../domain/errors.js";

// Translate the fixed diagnostics raised by migrations 99, 126 and 127 without
// changing their checksum-locked SQL. Migration 127 uses the saved-work messages
// for both removed projects and threads in removed locations.
// Never expose arbitrary database diagnostics through the application or
// agent-tool API.
const admissionMessages = new Map([
  ["The project was removed. Restore it before starting new work.",
    "This location was removed. Restore it before starting new work."],
  ["The project was removed. Restore it before moving a thread.",
    "This location was removed. Restore it before moving a thread."],
  ["The project was removed. Restore it before adding saved work.",
    "This project or location was removed. Restore it before adding saved work."],
  ["The project was removed. Restore it before moving saved work into it.",
    "This project or location was removed. Restore it before moving saved work into it."],
  ["The project was removed. Restore it before enabling scheduled work.",
    "This location was removed. Restore it before enabling scheduled work."],
  ["The project was removed. Restore it before adding or restoring its locations.",
    "The project was removed. Restore it before adding or restoring its locations."],
  ["The project still has active locations. Remove them before removing the project.",
    "The project still has active locations. Remove them before removing the project."],
]);

export function projectRemovalAdmissionError(error: unknown): DomainError | undefined {
  if (!(error instanceof Error) || !("code" in error) ||
    error.code !== "SQLITE_CONSTRAINT_TRIGGER") {
    return undefined;
  }
  const message = admissionMessages.get(error.message);
  return message === undefined ? undefined : new DomainError("invalid_transition", message, false, { cause: error });
}
