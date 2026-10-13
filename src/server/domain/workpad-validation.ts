import type { z } from "zod";
import { DomainError } from "./errors.js";

/** A bounded, user-facing Workpad rejection, safe on every tool surface. */
export class WorkpadValidationError extends DomainError {
  constructor(message: string) { super("bad_request", message); }
}

/** Preserve actionable content limits without exposing arbitrary validator details. */
export function parseWorkpadValue<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const pending = [...result.error.issues];
  while (pending.length > 0) {
    const issue = pending.shift()!;
    if (issue.message.startsWith("Workpad content ")) throw new WorkpadValidationError(issue.message);
    if (issue.code === "invalid_union") pending.push(...issue.errors.flat());
  }
  throw new WorkpadValidationError("Invalid workpad request.");
}
