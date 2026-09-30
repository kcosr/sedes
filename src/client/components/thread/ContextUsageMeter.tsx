import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { UsageSnapshot } from "../../../shared/index.js";
import { eyebrowClass } from "@client/components/ui/floating";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@client/components/ui/popover";
import { cn } from "@client/lib/utils";

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
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
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        role="tooltip"
        className="w-max max-w-[calc(100vw-16px)] gap-1 p-3 whitespace-nowrap"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={openFromHover}
        onPointerLeave={closeFromHover}
      >
        <p className={cn(eyebrowClass, "m-0")}>Context window</p>
        <p className="m-0 leading-5">{summary}</p>
        <p className="m-0 text-(length:--text-meta) leading-4 text-muted-foreground">
          {detail}
        </p>
      </PopoverContent>
    </Popover>
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
