import { useId, useLayoutEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { setActivityDetail } from "../../app/settings.js";
import { ConversationItemView } from "../conversation/ConversationItemView.js";
import type { ItemRenderContext } from "../conversation/types.js";
import {
  clearPendingActivityDetailExpansion,
  consumeActivityDetailExpansion,
  hasPendingActivityDetailExpansion,
  requestActivityDetailExpansion,
} from "./activity-detail-intent.js";
import {
  activitySummaryLabel,
  isSummaryActivityItem,
  summarizeActivityItems,
  type ActivityItem,
} from "./activity-groups.js";

export function ActivityGroup({
  items,
  context,
  threadId,
}: {
  readonly items: readonly ActivityItem[];
  readonly context?: ItemRenderContext;
  readonly threadId: string;
}): React.JSX.Element {
  const firstItemId = items[0]?.id;
  const summaryOnly = items.length > 0 && items.every(isSummaryActivityItem);
  const detailsAvailable =
    items.length > 0 && items.every((item) => !isSummaryActivityItem(item));
  const [open, setOpen] = useState(
    () =>
      detailsAvailable &&
      firstItemId !== undefined &&
      hasPendingActivityDetailExpansion(threadId, firstItemId),
  );
  const detailsId = useId();
  const summary = useMemo(() => summarizeActivityItems(items), [items]);
  const label = activitySummaryLabel(summary);

  useLayoutEffect(() => {
    if (
      detailsAvailable &&
      firstItemId !== undefined &&
      consumeActivityDetailExpansion(threadId, firstItemId)
    ) {
      setOpen(true);
    }
  }, [detailsAvailable, firstItemId, threadId]);

  // A mixed run can occur only during a projection replacement. Fail closed:
  // neither detail children nor mode controls mount until the fresh
  // authoritative snapshot replaces the entire run.
  const interactive = detailsAvailable || summaryOnly;

  const changeDetailMode = () => {
    if (detailsAvailable) {
      clearPendingActivityDetailExpansion();
      setOpen(false);
      setActivityDetail("summary", "inline_activity");
      return;
    }
    if (!summaryOnly || firstItemId === undefined) return;
    requestActivityDetailExpansion(threadId, firstItemId);
    setActivityDetail("full", "inline_activity");
  };

  return (
    <section
      className="activity-group"
      data-activity-detail={detailsAvailable ? "full" : "summary"}
      data-activity-first-item-id={firstItemId}
      data-activity-member-count={items.length}
      data-activity-reasoning-count={summary.reasoningSteps}
      data-activity-status={
        summary.working ? "working" : (summary.terminalStatus ?? "settled")
      }
      data-activity-tool-count={summary.toolCalls}
      data-testid="activity-group"
    >
      {interactive ? (
        <button
          aria-controls={detailsId}
          aria-expanded={open}
          className="activity-group-summary"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <ChevronRight
            aria-hidden="true"
            className="activity-group-chevron"
            size={12}
            strokeWidth={1.8}
          />
          <span>{label}</span>
        </button>
      ) : (
        <div className="activity-group-summary activity-group-summary-static">
          {label}
        </div>
      )}
      {interactive && open ? (
        <div
          className="activity-group-disclosure"
          id={detailsId}
          {...(detailsAvailable
            ? { "data-testid": "activity-group-details" }
            : {})}
        >
          <button
            className="activity-group-detail-mode-action"
            onClick={changeDetailMode}
            type="button"
          >
            {detailsAvailable ? "Disable details" : "Enable details"}
          </button>
          {detailsAvailable
            ? items.map((item) =>
                isSummaryActivityItem(item) ? null : (
                  <ConversationItemView
                    key={item.id}
                    item={item}
                    {...(context ? { context } : {})}
                  />
                ),
              )
            : null}
        </div>
      ) : null}
    </section>
  );
}
