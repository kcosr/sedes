import type {
  ActivityDetailMode,
  ConversationItem,
  HistoryPage,
  NormalizedThreadSnapshot,
  ThreadEventEnvelope,
  ThreadHistorySeekResult,
} from "../../shared/protocol/conversation.js";
import {
  historyPageSchema,
  normalizedThreadSnapshotSchema,
  threadEventEnvelopeSchema,
  threadHistorySeekResultSchema,
} from "../../shared/protocol/conversation.js";

type DetailedActivityItem = Extract<
  ConversationItem,
  {
    readonly kind:
      | "reasoning"
      | "command"
      | "file_read"
      | "file_change"
      | "tool"
      | "mcp"
      | "web_search";
  }
>;

const activityKinds = new Set<ConversationItem["kind"]>([
  "reasoning",
  "command",
  "file_read",
  "file_change",
  "tool",
  "mcp",
  "web_search",
]);

function isDetailedActivityItem(
  item: ConversationItem,
): item is DetailedActivityItem {
  return activityKinds.has(item.kind);
}

export function projectConversationItemActivity(
  item: ConversationItem,
  detail: ActivityDetailMode,
): ConversationItem {
  if (detail === "full" || !isDetailedActivityItem(item)) return item;
  return {
    id: item.id,
    turnId: item.turnId,
    kind: "activity_summary",
    activityKind: item.kind,
    status: item.status,
    revision: item.revision,
    ...(item.kind === "reasoning" && item.summaryParts
      ? { summaryParts: item.summaryParts }
      : {}),
    ...(item.startedAt ? { startedAt: item.startedAt } : {}),
    ...(item.completedAt ? { completedAt: item.completedAt } : {}),
  };
}

function projectItems(
  items: Readonly<Record<string, ConversationItem>>,
  detail: ActivityDetailMode,
): Record<string, ConversationItem> {
  if (detail === "full") return items;
  return Object.fromEntries(
    Object.entries(items).map(([id, item]) => [
      id,
      projectConversationItemActivity(item, detail),
    ]),
  );
}

/**
 * Projects normalized server-authoritative transcript data for one browser.
 * The input remains untouched so a summary viewer can never poison the shared
 * hub, provider history, replay suffix, or a simultaneous full-detail viewer.
 */
export function projectThreadSnapshotActivity(
  snapshot: NormalizedThreadSnapshot,
  detail: ActivityDetailMode,
): NormalizedThreadSnapshot {
  if (detail === "full") return snapshot;
  return normalizedThreadSnapshotSchema.parse(
    projectThreadSnapshotActivityValue(snapshot, detail),
  );
}

function projectThreadSnapshotActivityValue(
  snapshot: NormalizedThreadSnapshot,
  detail: ActivityDetailMode,
): NormalizedThreadSnapshot {
  return {
    ...snapshot,
    itemsById: projectItems(snapshot.itemsById, detail),
  };
}

export function projectHistoryPageActivity(
  page: HistoryPage,
  detail: ActivityDetailMode,
): HistoryPage {
  if (detail === "full") return page;
  return historyPageSchema.parse(projectHistoryPageActivityValue(page, detail));
}

function projectHistoryPageActivityValue(
  page: HistoryPage,
  detail: ActivityDetailMode,
): HistoryPage {
  return {
    ...page,
    itemsById: projectItems(page.itemsById, detail),
  };
}

export function projectThreadEventEnvelopeActivity(
  envelope: ThreadEventEnvelope,
  detail: ActivityDetailMode,
): ThreadEventEnvelope {
  if (detail === "full") return envelope;
  const event = envelope.event;
  switch (event.type) {
    case "snapshot":
      return threadEventEnvelopeSchema.parse({
        ...envelope,
        event: {
          ...event,
          snapshot: projectThreadSnapshotActivityValue(event.snapshot, detail),
        },
      });
    case "history_prepend":
      return threadEventEnvelopeSchema.parse({
        ...envelope,
        event: {
          ...event,
          page: projectHistoryPageActivityValue(event.page, detail),
        },
      });
    case "item_upsert":
      return threadEventEnvelopeSchema.parse({
        ...envelope,
        event: {
          ...event,
          item: projectConversationItemActivity(event.item, detail),
        },
      });
    default:
      return envelope;
  }
}

export function projectThreadHistorySeekActivity(
  result: ThreadHistorySeekResult,
  detail: ActivityDetailMode,
): ThreadHistorySeekResult {
  if (detail === "full" || result.status !== "found") return result;
  return threadHistorySeekResultSchema.parse({
    ...result,
    page: projectHistoryPageActivityValue(result.page, detail),
  });
}
