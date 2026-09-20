import { useContext } from "react";
import type { NormalizedThreadSnapshot } from "../../../shared/index.js";
import { ChatViewVisibilityContext } from "./chat-view-visibility.js";

/** Live work is independent of the main turn and never changes Send/Stop. */
export function BackgroundActivityStatus({
  snapshot,
  current,
  livePresentation,
  interactionTakeover,
}: {
  readonly snapshot: NormalizedThreadSnapshot;
  readonly current: boolean;
  readonly livePresentation: boolean;
  readonly interactionTakeover: boolean;
}): React.JSX.Element | null {
  const chatVisible = useContext(ChatViewVisibilityContext);
  const activity = snapshot.backgroundActivity;
  if (!chatVisible || !livePresentation || interactionTakeover || !activity) {
    return null;
  }

  const uncertain =
    !current ||
    activity.state === "unknown" ||
    snapshot.runState === "disconnected" ||
    snapshot.runState === "reconciling";
  const total = activity.agents + activity.commands + activity.other;
  if (!uncertain && total === 0) return null;

  let label: string;
  if (uncertain) {
    label =
      !current || snapshot.runState === "reconciling"
        ? "Checking background work…"
        : "Background work status unavailable";
  } else if (activity.agents === 1 && total === 1) {
    label = "Waiting for subagent";
  } else if (activity.commands === 1 && total === 1) {
    label = "Background command running";
  } else {
    const counts = [
      activity.agents > 0 &&
        `${activity.agents} subagent${activity.agents === 1 ? "" : "s"}`,
      activity.commands > 0 &&
        `${activity.commands} command${activity.commands === 1 ? "" : "s"}`,
      activity.other > 0 &&
        `${activity.other} other task${activity.other === 1 ? "" : "s"}`,
    ].filter(Boolean);
    label = `Background work · ${counts.join(", ")}`;
  }
  const description =
    !uncertain && total === 1
      ? activity.description?.text.replace(/\s+/g, " ").trim()
      : undefined;
  if (description) label += ` · ${description}`;

  return (
    <div
      className="background-activity-status-slot"
      data-testid="background-activity-status"
      data-state={uncertain ? "unknown" : "known"}
    >
      <div
        className="background-activity-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span aria-hidden="true" className="reasoning-summary-status-dot" />
        <span className="background-activity-status-text" title={label}>
          {label}
        </span>
      </div>
    </div>
  );
}
