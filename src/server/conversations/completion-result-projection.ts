import type { ClassifiedAssistantResult } from "../../shared/protocol/completion-result.js";
import type { BackendItem } from "../../shared/protocol/backend.js";
import type { BoundedText } from "../../shared/protocol/payload.js";
import { boundText } from "./payload-policy.js";
import type { ProjectedConversationTimeline } from "./conversation-projector.js";

/**
 * Projects the immutable, backend-neutral text carried by an authoritative
 * completion observation. Only ordinary assistant messages are callback
 * output; reasoning, plans, tools, and later tool-only enrichment remain
 * transcript evidence rather than model-visible callback content.
 */
export function projectAuthoritativeCompletionResult(input: {
  readonly backendTurnId: string;
  readonly timeline: ProjectedConversationTimeline;
  readonly matchesApplicationTurnId: (
    backendTurnId: string,
    applicationTurnId: string,
  ) => boolean;
}): {
  readonly applicationTurnId: string;
  readonly result: BoundedText;
} {
  const matchingTurnIds = input.timeline.orderedTurnIds.filter(
    (applicationTurnId) =>
      input.matchesApplicationTurnId(
        input.backendTurnId,
        applicationTurnId,
      ),
  );
  if (matchingTurnIds.length !== 1) {
    throw new Error("authoritative_completion_turn_unresolved");
  }
  const applicationTurnId = matchingTurnIds[0]!;
  const turn = input.timeline.turnsById[applicationTurnId];
  if (!turn) {
    throw new Error("authoritative_completion_turn_unresolved");
  }
  const assistantText = turn.orderedItemIds
    .map((itemId) => input.timeline.itemsById[itemId])
    .filter(
      (item) => item !== undefined && item.kind === "assistant_message",
    )
    .map((item) => item.markdown.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
  return {
    applicationTurnId,
    result: boundText(assistantText),
  };
}

/** Partition before bounding so progress cannot consume the final answer budget. */
export function projectClassifiedAssistantResult(
  items: readonly Extract<BackendItem, { semanticKind: "assistant_message" }>[],
): ClassifiedAssistantResult {
  const result: ClassifiedAssistantResult = {
    provisional: null,
    final: null,
    unclassified: null,
  };
  let remaining = 16_384;
  for (const phase of ["final", "provisional", "unclassified"] as const) {
    const messages = items.filter(
      (item) => (item.responsePhase ?? "unclassified") === phase,
    );
    if (messages.length === 0) continue;
    const text = messages
      .map((item) => item.markdown.text)
      .filter(Boolean)
      .join("\n\n");
    const bounded = text === "" ? { text: "" } : boundText(text, remaining);
    result[phase] = bounded;
    remaining -= Buffer.byteLength(bounded.text, "utf8");
  }
  return result;
}
