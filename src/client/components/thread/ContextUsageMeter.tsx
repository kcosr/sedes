import * as Popover from "@radix-ui/react-popover";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { UsageSnapshot } from "../../../shared/index.js";

type ContextUsage = NonNullable<UsageSnapshot["context"]>;

export function ContextUsageMeter({
  usage,
}: {
  usage?: ContextUsage;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  if (!usage) return null;

  const percent =
    usage.percent ??
    (usage.usedTokens === undefined
      ? undefined
      : (usage.usedTokens / usage.windowTokens) * 100);
  const level =
    typeof percent === "number" && percent >= 90
      ? "danger"
      : typeof percent === "number" && percent >= 70
        ? "warning"
        : "normal";
  const meterValue = Math.max(0, Math.min(percent ?? 0, 100));
  const usedPercent =
    percent === undefined ? undefined : Math.max(0, percent);
  const leftPercent =
    usedPercent === undefined ? undefined : Math.max(0, 100 - usedPercent);
  const summary =
    usedPercent === undefined
      ? "Usage unknown"
      : `${formatPercent(usedPercent)} used (${formatPercent(leftPercent ?? 0)} left)`;
  const detail =
    usage.usedTokens === undefined
      ? `${formatCompactNumber(usage.windowTokens)} token window`
      : `${formatCompactNumber(usage.usedTokens)} / ${formatCompactNumber(
          usage.windowTokens,
        )} tokens used`;
  const label = `Context window: ${summary}, ${detail}`;
  const meterStyle = {
    "--context-usage": `${meterValue.toFixed(2)}%`,
  } as CSSProperties;

  const cancelClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  };
  const openFromHover = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    setOpen(true);
  };
  const closeFromHover = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="context-usage-meter"
          data-level={level}
          aria-label={label}
          style={meterStyle}
          onPointerEnter={openFromHover}
          onPointerLeave={closeFromHover}
        >
          <span className="context-usage-meter-ring" aria-hidden="true" />
          <span className="context-usage-meter-dot" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="context-usage-popover"
          side="top"
          align="end"
          sideOffset={10}
          collisionPadding={12}
          role="tooltip"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={openFromHover}
          onPointerLeave={closeFromHover}
        >
          <strong>Context window</strong>
          <span>{summary}</span>
          <span>{detail}</span>
          <Popover.Arrow className="popover-arrow" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function formatPercent(value: number): string {
  return value >= 10 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${trimTrailingZero(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimTrailingZero(value / 1_000)}k`;
  return String(Math.round(value));
}

function trimTrailingZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
