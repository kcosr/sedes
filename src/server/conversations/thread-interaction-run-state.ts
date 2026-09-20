import type {
  BackendInteraction,
  ThreadRunState,
} from "../../shared/protocol/conversation.js";

/** Pending gates refine active work, never mask disconnect or terminal state. */
export function interactionRunState(
  actorState: ThreadRunState,
  interactions: readonly BackendInteraction[],
): ThreadRunState {
  if (actorState !== "starting" && actorState !== "running") return actorState;
  if (
    interactions.some(
      ({ kind }) =>
        kind === "confirmation" || kind === "choice" || kind === "decision",
    )
  )
    return "waiting_for_approval";
  if (
    interactions.some(
      ({ kind }) =>
        kind === "text_input" ||
        kind === "editor" ||
        kind === "questionnaire" ||
        kind === "form",
    )
  )
    return "waiting_for_input";
  return actorState;
}
