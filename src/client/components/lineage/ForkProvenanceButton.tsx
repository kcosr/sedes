import { Split } from "lucide-react";
import { Tooltip } from "radix-ui";
import type { NormalizedThreadForkOrigin } from "../../../shared/index.js";
import {
  openThreadRoute,
  pointerPanelPresentation,
} from "../../workspace-panels/thread-panel-navigation.js";

export function ForkProvenanceButton({
  origin,
  sourceTitle,
  onNavigate,
  className = "",
}: {
  readonly origin: NormalizedThreadForkOrigin;
  readonly sourceTitle?: string;
  readonly onNavigate?: () => void;
  readonly className?: string;
}): React.JSX.Element {
  const sourceAvailable = origin.sourceThreadId !== null;
  const source = sourceTitle ? `“${sourceTitle}”` : "the source thread";
  const completedAt = origin.sourceTurnCompletedAt
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(origin.sourceTurnCompletedAt))
    : undefined;
  const attribution =
    origin.originKind === "agent_fork"
      ? " Initiated by another Sedes thread."
      : origin.originKind === "principal_client_fork"
        ? " Initiated by a principal tool client."
        : origin.originKind === "automation_fork"
          ? " Initiated by an automation."
          : "";
  const context = `${
    sourceAvailable
      ? origin.sourceTurnId
        ? `Forked from ${source} at ${completedAt ?? "the selected completed turn"}. Open the fork point.`
        : `Forked from ${source}. The exact fork point is unavailable; open the source thread.`
      : "Fork source unavailable. This thread still retains fork provenance."
  }${attribution}`;

  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className={`fork-provenance-button ${className}`.trim()}
            aria-label={context}
            aria-disabled={!sourceAvailable}
            onClick={(event) => {
              event.stopPropagation();
              if (!origin.sourceThreadId) return;
              onNavigate?.();
              openThreadRoute(
                origin.sourceThreadId,
                pointerPanelPresentation(event),
                origin.sourceTurnId ?? undefined,
              );
            }}
          >
            <Split
              className="fork-split-icon"
              size={14}
              strokeWidth={1.8}
              aria-hidden="true"
            />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="lineage-tooltip" sideOffset={6}>
            {context}
            <Tooltip.Arrow className="lineage-tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
