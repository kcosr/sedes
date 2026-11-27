import { composerInputUtf8Bytes, MAXIMUM_THREAD_INPUT_BYTES, type ContextExcerpt } from "../../shared/protocol/context-excerpts.js";
import { appendThreadReferenceText, formatInlineThreadReferenceText, hasInlineThreadReferenceBody, MAXIMUM_THREAD_REFERENCES } from "../../shared/thread-references.js";
import { DomainError } from "./errors.js";

export function restoreStashedComposerText(draft: string, stash: string): string {
  try {
    return appendThreadReferenceText(draft, stash);
  } catch (cause) {
    throw new DomainError("invalid_transition",
      `The restored draft must fit the input limit and contain at most ${MAXIMUM_THREAD_REFERENCES} thread mentions.`,
      false, { cause });
  }
}

/** Only an exact pre-upgrade look-alike needs quoting. An old, byte-full
 * draft must stay available even when its literal quotation cannot fit. */
export function escapeHistoricalComposerText(text: string, contextExcerpts: readonly ContextExcerpt[]): string {
  if (!hasInlineThreadReferenceBody(text)) return text;
  const quoted = formatInlineThreadReferenceText([text]);
  return composerInputUtf8Bytes({ text: quoted, contextExcerpts }) <= MAXIMUM_THREAD_INPUT_BYTES ? quoted : text;
}
