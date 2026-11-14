import { X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { BackendAccountUsage, NormalizedApplicationSnapshot } from "../../../shared/index.js";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover.js";
import { eyebrowClass } from "../ui/floating.js";
import { cn } from "../../lib/utils.js";

const MAXIMUM_AGE_MS = 10 * 60_000;
const HOVER_DELAY_MS = 500;
const CLOSE_DELAY_MS = 140;
const POPOVER_WIDTH = 272;

/** Reads only the target's scoped application snapshot; opening never fetches. */
export function accountUsageForTarget(
  application: NormalizedApplicationSnapshot | undefined,
  targetId: string,
): BackendAccountUsage | undefined {
  const target = application?.executionTargets.find(({ id }) => id === targetId);
  if (!target?.available) return undefined;
  return application?.accountUsages.find((entry) =>
    entry.backendInstanceId === target.backendInstanceId &&
    entry.executionEnvironmentId === target.environmentId,
  );
}

export function AccountUsageLine({ usage, backendLabel, visible = true }: {
  readonly usage?: BackendAccountUsage;
  readonly backendLabel: string;
  readonly visible?: boolean;
}): React.JSX.Element | null {
  const [, expire] = useState(0);
  const expiresAt = usage ? Math.min(
    usage.capturedAt + MAXIMUM_AGE_MS,
    ...usage.windows.flatMap(({ resetsAt }) => resetsAt === null ? [] : [resetsAt]),
  ) : 0;
  useEffect(() => {
    if (!visible || !expiresAt || expiresAt <= Date.now()) return;
    const timer = window.setTimeout(() => expire((value) => value + 1), expiresAt - Date.now());
    return () => window.clearTimeout(timer);
  }, [expiresAt, visible]);
  if (!visible || !usage?.windows.length || expiresAt <= Date.now()) return null;
  return <AvailableAccountUsageLine key={usage.accountId ?? "unknown"} usage={usage} backendLabel={backendLabel} />;
}

function AvailableAccountUsageLine({ usage, backendLabel }: {
  readonly usage: BackendAccountUsage;
  readonly backendLabel: string;
}): React.JSX.Element {
  const [mode, setMode] = useState<"closed" | "preview" | "pinned">("closed");
  const modeRef = useRef(mode);
  const [anchorFraction, setAnchorFraction] = useState(0.5);
  const [geometryRevision, setGeometryRevision] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const hovered = useRef(false);
  const dismissed = useRef(false);
  const pointerDown = useRef(false);
  const restoreFocus = useRef(false);
  const contentId = useId();
  const open = mode !== "closed";
  const remaining = Math.min(...usage.windows.map(({ remainingPercent }) => remainingPercent));
  const level = remaining < 5 ? "critical" : remaining < 15 ? "low" : "normal";
  const bounds = () => {
    const rect = trigger.current?.closest(".composer")?.getBoundingClientRect();
    const left = Math.max(8, rect?.width ? rect.left : 8);
    const right = Math.min(window.innerWidth - 8, rect?.width ? rect.right : window.innerWidth - 8);
    return { left, right, width: Math.min(POPOVER_WIDTH, right - left) };
  };
  const virtualAnchor = useMemo(() => ({ current: {
    getBoundingClientRect: () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return new DOMRect();
      const { left, right, width } = bounds();
      const x = Math.max(left + width / 2, Math.min(right - width / 2, rect.left + rect.width * anchorFraction));
      return new DOMRect(x, rect.top + 6, 0, 0);
    },
    get contextElement() { return trigger.current ?? undefined; },
  } }), [anchorFraction, geometryRevision]);
  useEffect(() => {
    if (!open) return;
    const observer = new ResizeObserver(() => setGeometryRevision((value) => value + 1));
    const composer = trigger.current?.closest(".composer");
    if (composer) observer.observe(composer);
    const resize = () => setGeometryRevision((value) => value + 1);
    window.addEventListener("resize", resize);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, [open]);
  useEffect(() => () => { window.clearTimeout(openTimer.current); window.clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    const cancelPending = () => {
      if (openTimer.current === undefined) return;
      window.clearTimeout(openTimer.current);
      openTimer.current = undefined;
      dismissed.current = true;
    };
    const keyDown = (event: KeyboardEvent) => { if (event.key === "Escape") cancelPending(); };
    const pointerDownOutside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node)) cancelPending();
    };
    document.addEventListener("keydown", keyDown);
    document.addEventListener("pointerdown", pointerDownOutside);
    return () => {
      document.removeEventListener("keydown", keyDown);
      document.removeEventListener("pointerdown", pointerDownOutside);
    };
  }, []);
  const change = (next: typeof mode) => { modeRef.current = next; setMode(next); };
  const cancelOpen = () => { window.clearTimeout(openTimer.current); openTimer.current = undefined; };
  const cancelClose = () => { window.clearTimeout(closeTimer.current); closeTimer.current = undefined; };
  const dismiss = () => { cancelOpen(); cancelClose(); dismissed.current = true; change("closed"); };
  const pointAt = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (modeRef.current === "pinned") return;
    const rect = event.currentTarget.getBoundingClientRect();
    setAnchorFraction(rect.width ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0.5);
  };
  const scheduleClose = () => {
    cancelOpen(); cancelClose();
    closeTimer.current = window.setTimeout(() => {
      const focused = trigger.current?.contains(document.activeElement) || content.current?.contains(document.activeElement);
      if (!hovered.current && !focused && modeRef.current === "preview") change("closed");
    }, CLOSE_DELAY_MS);
  };
  return <Popover open={open} onOpenChange={(next) => { if (!next) dismiss(); }}>
    <PopoverAnchor virtualRef={virtualAnchor} />
    <button ref={trigger} type="button" className="account-usage-line" data-level={level}
      aria-label={`${backendLabel} included usage: ${formatPercent(remaining)} remaining. Show usage details.`}
      aria-expanded={open} aria-controls={open ? contentId : undefined} aria-haspopup="dialog"
      style={{ "--account-usage-remaining": `${remaining}%` } as CSSProperties}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        hovered.current = true; dismissed.current = false; pointAt(event); cancelClose(); cancelOpen();
        if (modeRef.current === "closed") openTimer.current = window.setTimeout(() => {
          openTimer.current = undefined;
          if (hovered.current && !dismissed.current) change("preview");
        }, HOVER_DELAY_MS);
      }}
      onPointerMove={(event) => { if (event.pointerType === "mouse") pointAt(event); }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        hovered.current = false; scheduleClose();
      }}
      onPointerDown={(event) => { pointerDown.current = true; pointAt(event); }}
      onPointerUp={() => { pointerDown.current = false; }}
      onPointerCancel={() => { pointerDown.current = false; }}
      onFocus={() => {
        if (pointerDown.current || dismissed.current) return;
        cancelOpen(); cancelClose(); setAnchorFraction(0.5);
        if (modeRef.current === "closed") change("preview");
      }}
      onBlur={() => { pointerDown.current = false; dismissed.current = false; scheduleClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); dismiss(); } }}
      onClick={() => {
        pointerDown.current = false; cancelOpen(); cancelClose();
        if (modeRef.current === "pinned") dismiss();
        else { dismissed.current = false; change("pinned"); }
      }}>
      <span className="account-usage-track" aria-hidden="true"><span className="account-usage-fill" /></span>
    </button>
    <PopoverContent ref={content} id={contentId} side="top" align="center" sideOffset={8}
      aria-label={`${backendLabel} included usage`} className="account-usage-popover gap-3 p-3"
      style={{ width: bounds().width }}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => { event.preventDefault(); if (restoreFocus.current) trigger.current?.focus({ preventScroll: true }); restoreFocus.current = false; }}
      onEscapeKeyDown={() => { restoreFocus.current = Boolean(content.current?.contains(document.activeElement)); dismiss(); }}
      onInteractOutside={(event) => { if (trigger.current?.contains(event.target as Node)) event.preventDefault(); }}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") { hovered.current = true; cancelClose(); } }}
      onPointerLeave={(event) => { if (event.pointerType === "mouse") { hovered.current = false; scheduleClose(); } }}
      onFocusCapture={cancelClose} onBlurCapture={scheduleClose}>
      <div className="account-usage-heading">
        <div><p className={cn(eyebrowClass, "m-0")}>Included usage</p>
          <p className="account-usage-provider">{backendLabel}{usage.plan ? ` · ${usage.plan}` : ""}</p></div>
        <button type="button" className="account-usage-close" aria-label="Close usage details"
          onClick={() => { restoreFocus.current = true; dismiss(); }}><X size={14} aria-hidden="true" /></button>
      </div>
      <div className="account-usage-windows">
        {usage.windows.map((window, index) => <div className="account-usage-window" key={index}>
          <div className="account-usage-window-heading"><span>{windowLabel(window.durationMinutes, index, usage.windows.length)}</span><strong>{formatPercent(window.remainingPercent)} left</strong></div>
          {window.resetsAt !== null && <p className="account-usage-reset">Resets <time dateTime={new Date(window.resetsAt).toISOString()}>{formatTime(window.resetsAt)}</time></p>}
        </div>)}
      </div>
      {usage.includedUsageAllowed === false && <p className="account-usage-note">Included usage is currently unavailable.</p>}
      <p className="account-usage-checked">Checked <time dateTime={new Date(usage.capturedAt).toISOString()}>{formatTime(usage.capturedAt)}</time></p>
      {usage.accountId && <details className="account-usage-account"><summary>Account identifier</summary><code>{usage.accountId}</code></details>}
    </PopoverContent>
  </Popover>;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}
function windowLabel(minutes: number | null, index: number, count: number): string {
  if (minutes === null) return count === 1 ? "Usage window" : `Usage window ${index + 1}`;
  if (minutes === 10_080) return "Weekly";
  if (minutes === 1_440) return "Daily";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
