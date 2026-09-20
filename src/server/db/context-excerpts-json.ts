import {
  contextExcerptArraySchema,
  type ContextExcerpt,
} from "../../shared/protocol/context-excerpts.js";
import { DomainError } from "../domain/errors.js";

export function parseStoredContextExcerpts(value: string): ContextExcerpt[] {
  try {
    return contextExcerptArraySchema.parse(JSON.parse(value));
  } catch (error) {
    throw new DomainError(
      "conflict",
      "The stored context excerpts are invalid.",
      false,
      { cause: error },
    );
  }
}

export function serializeContextExcerpts(
  value: readonly ContextExcerpt[],
): string {
  return JSON.stringify(contextExcerptArraySchema.parse(value));
}

export function sameContextExcerpts(
  left: readonly ContextExcerpt[],
  right: readonly ContextExcerpt[],
): boolean {
  return serializeContextExcerpts(left) === serializeContextExcerpts(right);
}
