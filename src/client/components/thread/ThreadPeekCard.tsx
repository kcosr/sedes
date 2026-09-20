import {
  AlarmClock,
  Box,
  Folder,
  Repeat,
  Server,
  Split,
  TriangleAlert,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
} from "react";
import type { NormalizedApplicationThreadSummary } from "../../../shared/index.js";
import { automationTimeLabel, shortRelativeTime } from "../../lib/time.js";
import {
  flatRowGlyphIcon,
  flatRowGlyphKind,
  flatRowTime,
  futureTimeLabel,
  type FlatThreadRowForkInfo,
} from "./FlatThreadRow.js";
import "./flat-thread-row.css";

/**
 * Hover peek pop-out for sidebar rows: a read-only panel beside the sidebar
 * with the details the rows deliberately leave out. Non-interactive
 * (pointer-events: none), so a hand-rolled positioned div suffices — no
 * popover machinery.
 */

export const THREAD_PEEK_WIDTH = 236;
const PEEK_GAP = 10;
const VIEWPORT_INSET = 8;
const DEFAULT_PEEK_DELAY_MS = 180;

export interface ThreadPeekPosition {
  readonly top: number;
  readonly left: number;
}

export interface ThreadPeekBindings {
  readonly onPointerEnter: (event: React.PointerEvent<HTMLElement>) => void;
  readonly onPointerLeave: () => void;
  readonly onFocus: (event: React.FocusEvent<HTMLElement>) => void;
  readonly onBlur: () => void;
  readonly onDragEnter?: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onDragLeave?: (event: ReactDragEvent<HTMLElement>) => void;
}

export interface ThreadPeekState {
  /** Thread id currently peeked, or null while closed. */
  readonly peekId: string | null;
  readonly position: ThreadPeekPosition | null;
  /** Attach to the rendered panel so its height can be clamped to the viewport. */
  readonly panelRef: React.RefCallback<HTMLDivElement>;
  /** Spread onto each row's container (hover + keyboard focus triggers). */
  readonly bind: (id: string) => ThreadPeekBindings;
  readonly hide: () => void;
}

/**
 * Peek open/position state. Shows after a short hover (or focus) delay,
 * positions the panel beside the hovered row clamped to the viewport (flips
 * to the left edge when the sidebar hugs the right), and hides on list
 * scroll, pointer leave, and blur. The hook watches nothing beyond those
 * triggers: suppression is the parent's job via `enabled` — pass `false`
 * while the view options popover is open or the mode has peek off, and any
 * open panel closes. Touch and pen reserve long-press for the row context
 * menu, so peek remains a mouse-hover and keyboard-focus affordance.
 */
export function useThreadPeek(options?: {
  readonly enabled?: boolean;
  readonly delayMs?: number;
}): ThreadPeekState {
  const enabled = options?.enabled ?? true;
  const delayMs = options?.delayMs ?? DEFAULT_PEEK_DELAY_MS;
  const [peek, setPeek] = useState<{
    id: string;
    top: number;
    left: number;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const panel = useRef<HTMLDivElement | null>(null);
  const peekId = peek?.id ?? null;

  const cancelPending = useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  const hide = useCallback(() => {
    cancelPending();
    setPeek(null);
  }, [cancelPending]);

  const show = useCallback((id: string, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const preferred = rect.right + PEEK_GAP;
    const left =
      preferred + THREAD_PEEK_WIDTH + VIEWPORT_INSET > window.innerWidth
        ? Math.max(VIEWPORT_INSET, rect.left - THREAD_PEEK_WIDTH - PEEK_GAP)
        : preferred;
    const top = Math.max(VIEWPORT_INSET, rect.top);
    setPeek({ id, top, left });
  }, []);

  const schedule = useCallback(
    (id: string, anchor: HTMLElement) => {
      cancelPending();
      timer.current = setTimeout(() => {
        timer.current = undefined;
        show(id, anchor);
      }, delayMs);
    },
    [cancelPending, delayMs, show],
  );

  const panelRef = useCallback((node: HTMLDivElement | null) => {
    panel.current = node;
  }, []);

  // Second pass once the panel has real height: keep it inside the viewport.
  useEffect(() => {
    if (peekId === null) return;
    const node = panel.current;
    if (!node) return;
    const height = node.getBoundingClientRect().height;
    setPeek((current) => {
      if (!current) return current;
      const maxTop = Math.max(
        VIEWPORT_INSET,
        window.innerHeight - VIEWPORT_INSET - height,
      );
      return current.top > maxTop ? { ...current, top: maxTop } : current;
    });
  }, [peekId]);

  // Any scroll (the sidebar list scrolls a nested container, so listen in
  // capture) detaches the panel from its anchor — hide instead of drifting.
  useEffect(() => {
    if (peekId === null) return;
    const handleScroll = () => hide();
    window.addEventListener("scroll", handleScroll, {
      capture: true,
      passive: true,
    });
    return () =>
      window.removeEventListener("scroll", handleScroll, { capture: true });
  }, [hide, peekId]);

  useEffect(() => {
    if (!enabled) hide();
  }, [enabled, hide]);

  useEffect(
    () => () => {
      cancelPending();
    },
    [cancelPending],
  );

  const bind = useCallback(
    (id: string): ThreadPeekBindings => ({
      onPointerEnter: (event) => {
        if (!enabled || event.pointerType !== "mouse") return;
        schedule(id, event.currentTarget);
      },
      onPointerLeave: () => {
        hide();
      },
      onFocus: (event) => {
        if (
          !enabled ||
          !(event.target instanceof HTMLElement) ||
          !event.target.matches(":focus-visible")
        ) {
          return;
        }
        schedule(id, event.currentTarget);
      },
      onBlur: hide,
    }),
    [cancelPending, enabled, hide, schedule],
  );

  return { peekId, position: peek, panelRef, bind, hide };
}

/** The thread's state as one human sentence fragment for the peek panel. */
export function threadStateInWords(
  thread: NormalizedApplicationThreadSummary,
): string {
  if (thread.runState === "failed") return "Failed";
  if (thread.backingState === "creation_unknown") return "Start failed";
  if (thread.runState === "waiting_for_input") return "Waiting for your input";
  if (thread.runState === "waiting_for_approval") {
    return "Waiting for your approval";
  }
  if (
    thread.runState === "running" ||
    thread.runState === "starting" ||
    thread.runState === "stopping" ||
    thread.runState === "reconciling" ||
    thread.backingState === "creating"
  ) {
    const base =
      thread.runState === "stopping"
        ? "Stopping"
        : thread.runState === "reconciling"
          ? "Reconciling"
          : thread.runState === "starting" || thread.backingState === "creating"
            ? "Starting"
            : "Running";
    return thread.queuedInputCount > 0
      ? `${base} · ${thread.queuedInputCount} queued`
      : base;
  }
  if (thread.inventoryState === "snoozed") {
    return thread.snoozedUntil !== undefined
      ? `Snoozed · wakes ${futureTimeLabel(thread.snoozedUntil)}`
      : "Snoozed";
  }
  if (thread.inventoryState === "settled") {
    const relative = shortRelativeTime(thread.stateChangedAt);
    return relative === "now" ? "Settled just now" : `Settled ${relative} ago`;
  }
  if (thread.backingState === "unbound") return "Draft";
  if (thread.runState === "disconnected") return "Disconnected";
  return thread.queuedInputCount > 0
    ? `Idle · ${thread.queuedInputCount} queued`
    : "Idle";
}

export function ThreadPeekCard({
  thread,
  workspaceLabel,
  workspacePath,
  workspaceAvailable,
  environmentLabel,
  environmentAvailable,
  showEnvironment = false,
  targetLabel,
  targetAvailable,
  futureTimes = false,
  fork,
  forkNeedsInputCount,
  position,
  panelRef,
}: {
  readonly thread: NormalizedApplicationThreadSummary;
  readonly workspaceLabel: string;
  readonly workspacePath?: string;
  readonly workspaceAvailable?: boolean;
  readonly environmentLabel?: string;
  readonly environmentAvailable?: boolean;
  readonly showEnvironment?: boolean;
  readonly targetLabel?: string;
  readonly targetAvailable?: boolean;
  /** Match the hovered row's group so header times agree. */
  readonly futureTimes?: boolean;
  readonly fork?: FlatThreadRowForkInfo;
  /** Loaded descendants waiting on input, for "N forks · M need input". */
  readonly forkNeedsInputCount?: number;
  readonly position: ThreadPeekPosition;
  readonly panelRef?: React.Ref<HTMLDivElement>;
}): React.JSX.Element {
  const title = thread.title.text || "Untitled thread";
  const time = flatRowTime(thread, futureTimes);
  const glyphKind = flatRowGlyphKind(thread);
  const automation = thread.automation ?? undefined;
  const automationFailed =
    thread.attention.automationContext === "failed" ||
    automation?.lastRun?.state === "failed";
  const forkCount = fork?.descendantCount ?? 0;
  const lineage = fork
    ? fork.isChild
      ? `Fork of ${fork.sourceTitle ?? "another thread"}`
      : forkCount > 0
        ? `${forkCount} fork${forkCount === 1 ? "" : "s"}${
            forkNeedsInputCount ? ` · ${forkNeedsInputCount} need input` : ""
          }`
        : undefined
    : undefined;

  return (
    <div
      ref={panelRef}
      className="thread-peek"
      style={{ top: position.top, left: position.left }}
      role="tooltip"
      data-testid="thread-peek"
    >
      <div className="thread-peek-header">
        <span className="thread-peek-title">{title}</span>
        <span
          className="thread-peek-time"
          data-overdue={time.overdue ? "true" : undefined}
        >
          {time.label}
        </span>
      </div>
      <div className="thread-peek-rows">
        <div className="thread-peek-row" data-row="workspace">
          <span className="thread-peek-row-icon">
            <Folder size={13} strokeWidth={1.8} aria-hidden="true" />
          </span>
          <span className="thread-peek-row-text">
            {workspaceLabel}
            {workspaceAvailable === false ? " · Unavailable" : ""}
            {workspacePath !== undefined && (
              <span className="thread-peek-path">{workspacePath}</span>
            )}
          </span>
        </div>
        {showEnvironment && environmentLabel && (
          <div className="thread-peek-row" data-row="environment">
            <span className="thread-peek-row-icon">
              <Server size={13} strokeWidth={1.8} aria-hidden="true" />
            </span>
            <span className="thread-peek-row-text">
              {environmentLabel}
              {environmentAvailable === false ? " · Unavailable" : ""}
            </span>
          </div>
        )}
        {targetLabel && (
          <div className="thread-peek-row" data-row="target">
            <span className="thread-peek-row-icon">
              <Box size={13} strokeWidth={1.8} aria-hidden="true" />
            </span>
            <span className="thread-peek-row-text">
              {targetLabel}
              {targetAvailable === false ? " · Unavailable" : ""}
            </span>
          </div>
        )}
        <div className="thread-peek-row" data-row="state">
          <span className="thread-peek-row-icon" data-glyph={glyphKind}>
            {flatRowGlyphIcon(glyphKind)}
          </span>
          <span className="thread-peek-row-text">
            {threadStateInWords(thread)}
          </span>
        </div>
        {automation && (
          <div className="thread-peek-row" data-row="automation">
            <span className="thread-peek-row-icon">
              <Repeat size={13} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="thread-peek-row-text">
              {automation.status === "paused"
                ? "Automation · paused"
                : automation.nextRunAt !== undefined
                  ? `Automation · next ${automationTimeLabel(automation.nextRunAt)}`
                  : "Automation"}
            </span>
          </div>
        )}
        {automationFailed && (
          <div
            className="thread-peek-row thread-peek-row-failure"
            data-row="automation-failed"
          >
            <span className="thread-peek-row-icon">
              <TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="thread-peek-row-text">Last run failed</span>
          </div>
        )}
        {lineage !== undefined && (
          <div className="thread-peek-row" data-row="lineage">
            <span className="thread-peek-row-icon">
              <Split size={13} strokeWidth={1.8} aria-hidden="true" />
            </span>
            <span className="thread-peek-row-text">{lineage}</span>
          </div>
        )}
        {thread.attention.unseenCompletion && (
          <div className="thread-peek-row" data-row="unseen">
            <span className="thread-peek-row-icon">
              <span className="thread-peek-dot" />
            </span>
            <span className="thread-peek-row-text">
              Finished while you were away
            </span>
          </div>
        )}
        {thread.attention.wake && (
          <div className="thread-peek-row" data-row="woke">
            <span className="thread-peek-row-icon">
              <AlarmClock size={13} strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="thread-peek-row-text">Woke</span>
          </div>
        )}
      </div>
    </div>
  );
}
