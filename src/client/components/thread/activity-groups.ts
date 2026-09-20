import type { ConversationItem } from "../../../shared/index.js";

export const detailedActivityKinds = [
  "reasoning",
  "command",
  "file_read",
  "file_change",
  "tool",
  "mcp",
  "web_search",
] as const;

type DetailedActivityKind = (typeof detailedActivityKinds)[number];

export type DetailedActivityItem = Extract<
  ConversationItem,
  { readonly kind: DetailedActivityKind }
>;

export type ActivitySummaryItem = Extract<
  ConversationItem,
  { readonly kind: "activity_summary" }
>;

export type ActivityItem = DetailedActivityItem | ActivitySummaryItem;

export interface ActivityGroupSummary {
  readonly reasoningSteps: number;
  readonly toolCalls: number;
  readonly working: boolean;
  readonly terminalStatus?: "failed" | "interrupted";
  readonly durationMilliseconds?: number;
}

export type ConversationPresentationGroup =
  | { readonly kind: "activity"; readonly items: readonly ActivityItem[] }
  | { readonly kind: "item"; readonly item: ConversationItem };

const detailedActivityKindSet = new Set<string>(detailedActivityKinds);

export function isActivityItem(item: ConversationItem): item is ActivityItem {
  return (
    detailedActivityKindSet.has(item.kind) || item.kind === "activity_summary"
  );
}

export function isSummaryActivityItem(
  item: ActivityItem,
): item is ActivitySummaryItem {
  return item.kind === "activity_summary";
}

/** Forms maximal activity runs. Any ordinary conversation item is a boundary. */
export function groupConversationItems(
  items: readonly ConversationItem[],
): readonly ConversationPresentationGroup[] {
  const groups: ConversationPresentationGroup[] = [];
  let activity: ActivityItem[] = [];
  const flushActivity = () => {
    if (activity.length === 0) return;
    groups.push({ kind: "activity", items: activity });
    activity = [];
  };
  for (const item of items) {
    if (isActivityItem(item)) {
      activity.push(item);
      continue;
    }
    flushActivity();
    groups.push({ kind: "item", item });
  }
  flushActivity();
  return groups;
}

export function summarizeActivityItems(
  items: readonly ActivityItem[],
): ActivityGroupSummary {
  let reasoningSteps = 0;
  let toolCalls = 0;
  let earliestStart = Number.POSITIVE_INFINITY;
  let latestCompletion = Number.NEGATIVE_INFINITY;
  let hasStart = false;
  let hasCompletion = false;
  let working = false;
  let failed = false;
  let interrupted = false;

  for (const item of items) {
    const reasoning =
      item.kind === "reasoning" ||
      (isSummaryActivityItem(item) && item.activityKind === "reasoning");
    if (reasoning) reasoningSteps += 1;
    else toolCalls += 1;
    if (item.status === "streaming") working = true;
    else if (item.status === "failed") failed = true;
    else if (item.status === "interrupted") interrupted = true;

    const startedAt = parseTimestamp(item.startedAt);
    if (startedAt !== undefined) {
      earliestStart = Math.min(earliestStart, startedAt);
      hasStart = true;
    }
    const completedAt = parseTimestamp(item.completedAt);
    if (completedAt !== undefined) {
      latestCompletion = Math.max(latestCompletion, completedAt);
      hasCompletion = true;
    }
  }

  const durationMilliseconds =
    !working && hasStart && hasCompletion && latestCompletion >= earliestStart
      ? latestCompletion - earliestStart
      : undefined;
  return {
    reasoningSteps,
    toolCalls,
    working,
    ...(!working && failed
      ? { terminalStatus: "failed" as const }
      : !working && interrupted
        ? { terminalStatus: "interrupted" as const }
        : {}),
    ...(durationMilliseconds === undefined ? {} : { durationMilliseconds }),
  };
}

export function activitySummaryLabel(summary: ActivityGroupSummary): string {
  const parts = ["Activity"];
  if (summary.reasoningSteps > 0) {
    parts.push(
      `${summary.reasoningSteps} reasoning ${summary.reasoningSteps === 1 ? "step" : "steps"}`,
    );
  }
  if (summary.toolCalls > 0) {
    parts.push(
      `${summary.toolCalls} tool ${summary.toolCalls === 1 ? "call" : "calls"}`,
    );
  }
  if (summary.working) parts.push("Working…");
  else {
    if (summary.terminalStatus === "failed") parts.push("Failed");
    else if (summary.terminalStatus === "interrupted") {
      parts.push("Interrupted");
    }
    if (summary.durationMilliseconds !== undefined) {
      parts.push(formatActivityDuration(summary.durationMilliseconds));
    }
  }
  return parts.join(" · ");
}

export function formatActivityDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0
    ? `${minutes}m`
    : `${minutes}m ${remainingSeconds}s`;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
