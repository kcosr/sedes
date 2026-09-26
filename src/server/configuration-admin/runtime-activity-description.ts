import type { BackgroundActivity } from "../../shared/protocol/background-activity.js";
import type { BackendRuntimeActivity } from "../backends/module.js";

function counted(count: number, singular: string, plural: string): string | undefined {
  return count > 0 ? `${count} ${count === 1 ? singular : plural}` : undefined;
}

/** Background work a loaded conversation reports, for interruption previews. */
export function describeBackgroundActivity(activity: BackgroundActivity | undefined): string | undefined {
  if (!activity) return undefined;
  if (activity.state === "unknown") return "background work unknown";
  const parts = [
    counted(activity.agents, "background agent", "background agents"),
    counted(activity.commands, "background command", "background commands"),
    counted(activity.other, "other background task", "other background tasks"),
  ].filter((part): part is string => part !== undefined);
  return parts.length ? parts.join(", ") : undefined;
}

/** Work a provider runtime reports across all of its conversations, loaded or not. */
export function describeRuntimeActivity(activity: BackendRuntimeActivity | undefined): string | undefined {
  if (!activity) return undefined;
  const parts = [
    counted(activity.runningTurns, "running turn", "running turns"),
    counted(activity.background.agents, "background agent", "background agents"),
    counted(activity.background.commands, "background command", "background commands"),
    counted(activity.background.other, "other background task", "other background tasks"),
    counted(activity.background.unknownConversations, "conversation with unknown background work", "conversations with unknown background work"),
    counted(activity.pendingInteractions, "pending approval", "pending approvals"),
    counted(activity.unacknowledgedConversations, "conversation with undelivered output", "conversations with undelivered output"),
  ].filter((part): part is string => part !== undefined);
  return parts.length ? parts.join(", ") : undefined;
}
