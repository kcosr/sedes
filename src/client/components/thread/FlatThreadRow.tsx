import {
  AlarmClock,
  ArchiveRestore,
  Bookmark,
  MessageCircleQuestion,
  Check,
  CircleHelp,
  CircleX,
  Box,
  Folder,
  ListPlus,
  ListTodo,
  Moon,
  PencilLine,
  Repeat,
  Server,
  Split,
  TriangleAlert,
  Terminal as TerminalIcon,
} from "lucide-react";
import type { NormalizedApplicationThreadSummary } from "../../../shared/index.js";
import { BackendBrandIcon } from "../brand-icons.js";
import type { SidebarDensity } from "../../app/sidebar-view-model.js";
import { sidebarEffectiveTimestamp } from "../../app/sidebar-view-model.js";
import {
  shortAutomationTime,
  shortRelativeTime,
  snoozeLabel,
} from "../../lib/time.js";
import "./flat-thread-row.css";

/**
 * Presentational row for the flat (time / state / none) sidebar views.
 * Purely prop-driven, with no store or router imports.
 */

/** Fork context for the quiet ⑂ affordance; families flatten in these views. */
export interface FlatThreadRowForkInfo {
  /** Descendant count when this thread is a family root. */
  readonly descendantCount?: number;
  /** Resolved source title when this thread is a fork child. */
  readonly sourceTitle?: string;
  readonly isChild: boolean;
}

/**
 * Normalized task counts for this exact thread scope. The caller owns task
 * projection so this presentational row never has to infer scope or status
 * from application task records.
 */
export interface FlatThreadRowTaskSummary {
  readonly openCount: number;
}

/**
 * Glyph priority ladder — one glyph, one truth; states never repeat as
 * badges. Moon (snoozed) and Repeat (automation) deliberately split the
 * shared Clock of the legacy shelves: the two interleave in Upcoming.
 */
export type FlatRowGlyphKind =
  | "failed"
  | "waiting"
  | "running"
  | "draft"
  | "snoozed"
  | "automation"
  | "settled"
  | "disconnected"
  | "idle";

export function flatRowGlyphKind(
  thread: NormalizedApplicationThreadSummary,
): FlatRowGlyphKind {
  if (
    thread.runState === "failed" ||
    thread.backingState === "creation_unknown"
  ) {
    return "failed";
  }
  if (
    thread.runState === "waiting_for_input" ||
    thread.runState === "waiting_for_approval"
  ) {
    return "waiting";
  }
  if (
    thread.runState === "running" ||
    thread.runState === "starting" ||
    thread.runState === "stopping" ||
    thread.runState === "reconciling" ||
    thread.backingState === "creating"
  ) {
    return "running";
  }
  if (thread.backingState === "unbound") return "draft";
  if (thread.inventoryState === "snoozed") return "snoozed";
  if (thread.automation) return "automation";
  if (thread.inventoryState === "settled") return "settled";
  if (thread.runState === "disconnected") return "disconnected";
  return "idle";
}

/** Icon node for a glyph kind; shared with the peek panel's state row. */
export function flatRowGlyphIcon(kind: FlatRowGlyphKind): React.ReactNode {
  switch (kind) {
    case "failed":
      return <CircleX size={14} strokeWidth={2.2} />;
    case "waiting":
      return <CircleHelp size={14} strokeWidth={2.2} />;
    case "running":
      return <span className="comet-spinner flat-row-spin" />;
    case "draft":
      return <PencilLine size={14} strokeWidth={2} />;
    case "snoozed":
      return <Moon size={14} strokeWidth={2} />;
    case "automation":
      return <Repeat size={14} strokeWidth={2} />;
    case "settled":
      return <Check size={14} strokeWidth={2.2} />;
    case "disconnected":
      return <span className="flat-row-idle-dot flat-row-idle-dot-hollow" />;
    case "idle":
      return <span className="flat-row-idle-dot" />;
  }
}

/**
 * Future-absolute trailing time for future-times groups (Upcoming /
 * Scheduled / Snoozed): "in 45m" → same-day clock time → "Tmrw 9:00 AM" →
 * "Mon 9:00 AM" → "Aug 12". A past-due stamp falls back to the absolute
 * wake-style label; the row colors it warning via data-overdue.
 */
export function futureTimeLabel(isoDate: string, now = new Date()): string {
  const date = new Date(isoDate);
  const difference = date.getTime() - now.getTime();
  if (difference <= 0) return snoozeLabel(isoDate);
  if (difference < 3_600_000) {
    return `in ${Math.max(1, Math.round(difference / 60_000))}m`;
  }
  const clock = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const dayDelta = Math.round(
    (startOfDay(date) - startOfDay(now)) / 86_400_000,
  );
  if (dayDelta === 0) return clock;
  if (dayDelta === 1) return `Tmrw ${clock}`;
  if (dayDelta < 7) return shortAutomationTime(isoDate);
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export interface FlatRowTime {
  readonly label: string;
  /** Rendered future-absolute (the row sits in a future-times group). */
  readonly future: boolean;
  /** A future-times stamp that is already due; colored warning. */
  readonly overdue: boolean;
}

export function flatRowTime(
  thread: NormalizedApplicationThreadSummary,
  futureTimes: boolean,
  now = new Date(),
): FlatRowTime {
  if (futureTimes) {
    const at = thread.snoozedUntil ?? thread.automation?.nextRunAt;
    if (at !== undefined) {
      return {
        label: futureTimeLabel(at, now),
        future: true,
        overdue: new Date(at).getTime() <= now.getTime(),
      };
    }
  }
  // Missing wake in a future group (or any past bucket): past-relative on the
  // effective timestamp so inventory transitions do not strand the stamp.
  const effective = new Date(sidebarEffectiveTimestamp(thread)).toISOString();
  return { label: shortRelativeTime(effective), future: false, overdue: false };
}

export interface FlatRowContext {
  readonly label: string;
  readonly tone: "failure" | "neutral";
}

/** Card line-2 context slot; one string, priority failure > paused > schedule. */
export function flatRowContext(
  thread: NormalizedApplicationThreadSummary,
): FlatRowContext | undefined {
  const automation = thread.automation ?? undefined;
  if (
    thread.attention.automationContext === "failed" ||
    automation?.lastRun?.state === "failed"
  ) {
    return { label: "run failed", tone: "failure" };
  }
  if (automation?.status === "paused")
    return { label: "paused", tone: "neutral" };
  if (automation?.nextRunAt !== undefined) {
    return {
      label: `next ${futureTimeLabel(automation.nextRunAt)}`,
      tone: "neutral",
    };
  }
  if (
    thread.inventoryState === "snoozed" &&
    thread.snoozedUntil !== undefined
  ) {
    return {
      label: `wakes ${futureTimeLabel(thread.snoozedUntil)}`,
      tone: "neutral",
    };
  }
  if (thread.backingState === "unbound")
    return { label: "draft", tone: "neutral" };
  return undefined;
}

interface RowBadge {
  readonly key: string;
  readonly chip: string;
  readonly label: string;
  readonly icon: React.ReactNode;
}

function buildBadges(
  thread: NormalizedApplicationThreadSummary,
  settled: boolean,
): RowBadge[] {
  const badges: RowBadge[] = [];
  // Settled recession: additive status badges are suppressed. Durable fork,
  // task, and stash presence render separately in the row indicator group,
  // and the wake indicator lives there too, surviving settled until it is
  // acknowledged.
  if (!settled) {
    if (
      thread.attention.queueFailure ||
      thread.attention.automationContext === "failed"
    ) {
      const label = thread.attention.queueFailure
        ? thread.attention.automationContext === "failed"
          ? "Queued input and automation failed"
          : "Queued input failed"
        : "Automation failed";
      badges.push({
        key: "alert",
        chip: "alert",
        label,
        icon: <TriangleAlert size={14} strokeWidth={2} />,
      });
    }
    if (thread.queuedInputCount > 0) {
      badges.push({
        key: "queued",
        chip: "queued",
        label: `${thread.queuedInputCount} queued`,
        icon: <ListPlus size={14} strokeWidth={2} />,
      });
    }
  }
  return badges;
}

export function FlatThreadRow({
  thread,
  density,
  showBackendBrand,
  futureTimes = false,
  selected = false,
  workspaceLabel,
  environmentLabel,
  targetLabel,
  showProjectLabel = true,
  showEnvironmentLabel = false,
  showTargetLabel = false,
  fork,
  taskSummary,
  groupLabel,
  showCompactGroupLabel = false,
  onGroupSelect,
  showCompactProjectLabel = false,
  onProjectSelect,
  onEnvironmentSelect,
  clickNamesToFilter = false,
  quickSwitchHint,
  actions,
  onSelect,
  onOpenQuestions,
  selectAriaLabel,
  selectAriaCurrent,
  selectAriaHasPopup,
  selectAriaExpanded,
  selectAriaControls,
}: {
  readonly thread: NormalizedApplicationThreadSummary;
  readonly density: SidebarDensity;
  /** Render the thread's backend brand mark beside the state glyph. */
  readonly showBackendBrand: boolean;
  /** The row sits in a future-times group; trailing time renders absolute. */
  readonly futureTimes?: boolean;
  readonly selected?: boolean;
  /** Workspace label for the chip; the chip renders only when provided. */
  readonly workspaceLabel?: string;
  /** Execution-environment presentation, already collision-qualified. */
  readonly environmentLabel?: string;
  /** Exact Target presentation, already collision-qualified. */
  readonly targetLabel?: string;
  /** Hide the label where the group header already carries project context. */
  readonly showProjectLabel?: boolean;
  readonly showEnvironmentLabel?: boolean;
  readonly showTargetLabel?: boolean;
  readonly fork?: FlatThreadRowForkInfo;
  /** Counts for tasks directly scoped to this thread. */
  readonly taskSummary?: FlatThreadRowTaskSummary;
  /** Persistent group label; compact rendering is reserved for stack faces. */
  readonly groupLabel?: string;
  /** Stack faces may identify their group without changing ordinary compact rows. */
  readonly showCompactGroupLabel?: boolean;
  readonly onGroupSelect?: () => void;
  /** Project-stack faces identify and may scope to their workspace. */
  readonly showCompactProjectLabel?: boolean;
  readonly onProjectSelect?: () => void;
  readonly onEnvironmentSelect?: () => void;
  readonly clickNamesToFilter?: boolean;
  /** Temporary primary-modifier hint replacing the trailing timestamp. */
  readonly quickSwitchHint?: {
    readonly ariaKey: string;
    readonly confirmation: boolean;
    readonly label: string;
  };
  /** Hover/keyboard-visible-focus action cluster; swaps with the trailing time like ThreadRow. */
  readonly actions?: React.ReactNode;
  readonly onSelect?: React.MouseEventHandler<HTMLButtonElement>;
  readonly onOpenQuestions?: React.MouseEventHandler<HTMLButtonElement>;
  /** Accessible activation semantics may be overridden for stack faces. */
  readonly selectAriaLabel?: string;
  readonly selectAriaCurrent?: "page" | false;
  readonly selectAriaHasPopup?: "dialog" | "menu";
  readonly selectAriaExpanded?: boolean;
  readonly selectAriaControls?: string;
}): React.JSX.Element {
  const settled = thread.inventoryState === "settled";
  const unseen = thread.attention.unseenCompletion;
  const title = thread.title.text || "Untitled thread";
  const glyphKind = flatRowGlyphKind(thread);
  const glyphVisible = unseen || glyphKind !== "idle";
  const glyphLabel =
    glyphKind === "waiting"
      ? thread.runState === "waiting_for_approval"
        ? "Waiting for approval"
        : "Waiting for input"
      : glyphKind.charAt(0).toUpperCase() + glyphKind.slice(1);
  const renderedGlyphLabel =
    unseen && glyphKind === "idle"
      ? "Finished while you were away"
      : glyphLabel;
  const time = flatRowTime(thread, futureTimes);
  const context = density === "card" ? flatRowContext(thread) : undefined;

  const badges = buildBadges(thread, settled);

  const rootClass = [
    "flat-row",
    density === "card" ? "flat-row-card" : "flat-row-compact",
    selected ? "flat-row-selected" : "",
    settled ? "flat-row-settled" : "",
    unseen ? "flat-row-unseen" : "",
    density === "card" && groupLabel ? "flat-row-card-has-group" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const glyph = (
    <span
      className="flat-row-glyph"
      data-glyph={
        glyphVisible
          ? unseen && glyphKind === "idle"
            ? "unseen"
            : glyphKind
          : undefined
      }
      role={glyphVisible ? "img" : undefined}
      aria-hidden={glyphVisible ? undefined : "true"}
      aria-label={glyphVisible ? renderedGlyphLabel : undefined}
      title={glyphVisible ? renderedGlyphLabel : undefined}
    >
      {unseen && glyphKind === "idle" ? (
        <span
          className="flat-row-unseen-dot"
          data-testid="flat-row-unseen-dot"
        />
      ) : glyphVisible ? (
        flatRowGlyphIcon(glyphKind)
      ) : null}
    </span>
  );

  const brandMark = showBackendBrand ? (
    <span
      className="flat-row-brand"
      data-testid="flat-row-brand"
      role="img"
      aria-label={thread.backend.label.text}
      title={thread.backend.label.text}
    >
      <BackendBrandIcon brand={thread.backend.brand} size={14} />
    </span>
  ) : null;

  const badgeCluster =
    badges.length > 0 ? (
      <span className="flat-row-badges">
        {badges.map((badge) => (
          <span
            key={badge.key}
            className="flat-row-chip"
            data-chip={badge.chip}
            role="img"
            aria-label={badge.label}
            title={badge.label}
          >
            {badge.icon}
          </span>
        ))}
      </span>
    ) : undefined;

  const openTaskCount = taskSummary?.openCount ?? 0;
  const taskLabel = `${openTaskCount} open task${openTaskCount === 1 ? "" : "s"}`;
  const taskIndicator =
    openTaskCount > 0 ? (
      <span
        className="flat-row-indicator flat-row-task-indicator"
        data-indicator="task"
        data-testid="flat-row-task-indicator"
        role="img"
        aria-label={taskLabel}
        title={taskLabel}
      >
        <ListTodo size={14} strokeWidth={1.9} aria-hidden="true" />
      </span>
    ) : undefined;

  const questionLabel = `${thread.pendingQuestionCount} unanswered question${thread.pendingQuestionCount === 1 ? "" : "s"}`;
  const QuestionIndicator = onOpenQuestions ? "button" : "span";
  const questionIndicator = thread.pendingQuestionCount > 0 ? (
    <QuestionIndicator
      type={onOpenQuestions ? "button" : undefined}
      role={onOpenQuestions ? undefined : "img"}
      className="flat-row-indicator flat-row-question-indicator"
      data-indicator="question"
      data-testid="flat-row-question-indicator"
      aria-label={questionLabel}
      title={questionLabel}
      onClick={onOpenQuestions}
    >
      <MessageCircleQuestion size={14} strokeWidth={1.9} aria-hidden="true" />
    </QuestionIndicator>
  ) : undefined;

  const stashLabel = `${thread.stashedPromptCount} stashed prompt${thread.stashedPromptCount === 1 ? "" : "s"}`;
  const stashIndicator =
    thread.stashedPromptCount > 0 ? (
      <span
        className="flat-row-indicator flat-row-stash-indicator"
        data-indicator="stash"
        data-testid="flat-row-stash-indicator"
        role="img"
        aria-label={stashLabel}
        title={stashLabel}
      >
        <ArchiveRestore size={14} strokeWidth={1.9} aria-hidden="true" />
      </span>
    ) : undefined;

  const bookmarkLabel = `${thread.turnBookmarkCount} bookmarked turn${thread.turnBookmarkCount === 1 ? "" : "s"}`;
  const bookmarkIndicator =
    thread.turnBookmarkCount > 0 ? (
      <span
        className="flat-row-indicator flat-row-bookmark-indicator"
        data-indicator="bookmark"
        data-testid="flat-row-bookmark-indicator"
        role="img"
        aria-label={bookmarkLabel}
        title={bookmarkLabel}
      >
        <Bookmark size={14} strokeWidth={1.9} aria-hidden="true" />
      </span>
    ) : undefined;

  const terminalLabel = `${thread.terminalSummary.runningCount} running terminal${thread.terminalSummary.runningCount === 1 ? "" : "s"}, ${thread.terminalSummary.retainedCount} retained`;
  const terminalIndicator =
    thread.terminalSummary.retainedCount > 0 ? (
      <span
        className="flat-row-indicator flat-row-terminal-indicator"
        data-indicator="terminal"
        data-testid="flat-row-terminal-indicator"
        role="img"
        aria-label={terminalLabel}
        title={terminalLabel}
      >
        <TerminalIcon size={14} strokeWidth={1.9} aria-hidden="true" />
      </span>
    ) : undefined;

  // Pending wake attention is a row indicator, not a status badge: it packs
  // into the trailing icon list like fork/task/stash and stays visible while
  // the thread is settled until the wake is acknowledged.
  const wakeIndicator = thread.attention.wake ? (
    <span
      className="flat-row-indicator flat-row-wake-indicator"
      data-indicator="wake"
      data-testid="flat-row-wake-indicator"
      role="img"
      aria-label="Woke"
      title="Woke"
    >
      <AlarmClock size={14} strokeWidth={2} aria-hidden="true" />
    </span>
  ) : undefined;

  const forkCount = fork?.isChild ? undefined : fork?.descendantCount;
  const forkLabel = fork?.isChild
    ? fork.sourceTitle
      ? `Fork of ${fork.sourceTitle}`
      : "Forked thread"
    : forkCount && forkCount > 0
      ? `${forkCount} fork${forkCount === 1 ? "" : "s"}`
      : undefined;
  const forkIndicator = forkLabel ? (
    <span
      className="flat-row-indicator flat-row-fork-indicator"
      data-indicator="fork"
      data-testid="flat-row-fork-indicator"
      role="img"
      aria-label={forkLabel}
      title={forkLabel}
    >
      <Split size={14} strokeWidth={1.8} aria-hidden="true" />
      {forkCount !== undefined && (
        <span className="flat-row-indicator-count" aria-hidden="true">
          {forkCount}
        </span>
      )}
    </span>
  ) : undefined;

  const indicatorGroup =
    wakeIndicator ||
    forkIndicator ||
    taskIndicator ||
    stashIndicator ||
    bookmarkIndicator ||
    terminalIndicator ? (
      <span className="flat-row-indicators" data-testid="flat-row-indicators">
        {wakeIndicator}
        {forkIndicator}
        {taskIndicator}
        {stashIndicator}
        {bookmarkIndicator}
        {terminalIndicator}
      </span>
    ) : undefined;

  // Compact rows skip the project label — it is rarely needed when most
  // installs use one project. Card density shows it on line 2 with the same
  // folder icon and muted styling as the thread header's project row.
  const projectIsInteractive = clickNamesToFilter && onProjectSelect !== undefined;
  const ProjectLabel = projectIsInteractive ? "button" : "span";
  const projectMeta =
    density === "card" && showProjectLabel && workspaceLabel !== undefined ? (
      <ProjectLabel
        type={projectIsInteractive ? "button" : undefined}
        onClick={projectIsInteractive ? onProjectSelect : undefined}
        aria-label={
          projectIsInteractive
            ? `Filter threads by project ${workspaceLabel}`
            : undefined
        }
        className={`thread-project flat-row-project${projectIsInteractive ? " flat-row-location-filter" : ""}`}
        data-testid="flat-row-project"
        title={
          projectIsInteractive ? `Filter by ${workspaceLabel}` : workspaceLabel
        }
      >
        <Folder size={13} strokeWidth={1.8} aria-hidden="true" />
        <span className="thread-project-name flat-row-filter-name">{workspaceLabel}</span>
      </ProjectLabel>
    ) : undefined;
  const environmentIsInteractive = clickNamesToFilter && onEnvironmentSelect !== undefined;
  const EnvironmentLabel = environmentIsInteractive ? "button" : "span";
  const environmentMeta =
    density === "card" &&
    showEnvironmentLabel &&
    environmentLabel !== undefined ? (
      <EnvironmentLabel
        type={environmentIsInteractive ? "button" : undefined}
        onClick={environmentIsInteractive ? onEnvironmentSelect : undefined}
        aria-label={
          environmentIsInteractive
            ? `Filter threads by environment ${environmentLabel}`
            : undefined
        }
        className={`flat-row-location-part flat-row-environment${environmentIsInteractive ? " flat-row-location-filter" : ""}`}
        data-testid="flat-row-environment"
        title={
          environmentIsInteractive ? `Filter by ${environmentLabel}` : environmentLabel
        }
      >
        <Server size={12} strokeWidth={1.8} aria-hidden="true" />
        <span className="flat-row-filter-name">{environmentLabel}</span>
      </EnvironmentLabel>
    ) : undefined;
  const targetMeta =
    showTargetLabel && targetLabel !== undefined ? (
      <span
        className="flat-row-location-part flat-row-target"
        data-testid="flat-row-target"
        title={targetLabel}
      >
        <Box size={12} strokeWidth={1.8} aria-hidden="true" />
        <span>{targetLabel}</span>
      </span>
    ) : undefined;
  const locationMeta =
    projectMeta || environmentMeta || targetMeta ? (
      <span className="flat-row-location" data-testid="flat-row-location">
        {projectMeta}
        {environmentMeta}
        {targetMeta}
      </span>
    ) : undefined;

  // Wake/fork/task/stash indicators belong with the trailing metadata rather
  // than the flexible title/status content. This lets the icons pack against
  // the timestamp with no empty per-indicator slots in either density.
  const trailing = (
    <>
      {questionIndicator}
      <div className="flat-row-trailing">
        <div className="flat-row-default-trailing">
          {indicatorGroup}
          <span
            className="flat-row-time"
            data-testid="flat-row-time"
            data-shortcut={
              quickSwitchHint === undefined
                ? undefined
                : quickSwitchHint.confirmation
                  ? "confirmation"
                  : "true"
            }
            data-future={time.future ? "true" : undefined}
            data-overdue={time.overdue ? "true" : undefined}
            title={
              quickSwitchHint === undefined
                ? time.label
                : `Switch to ${title} with ${quickSwitchHint.label}`
            }
          >
            {quickSwitchHint?.label ?? time.label}
          </span>
        </div>
        {actions !== undefined && (
          <div className="flat-row-actions">{actions}</div>
        )}
      </div>
    </>
  );

  if (density === "compact") {
    return (
      <div
        className={rootClass}
        data-testid="flat-thread-row"
        data-density="compact"
        data-selected={selected ? "true" : "false"}
      >
        <button
          type="button"
          className="flat-row-link"
          data-testid="thread-row-link"
          aria-label={selectAriaLabel}
          aria-current={
            selectAriaCurrent === false
              ? undefined
              : (selectAriaCurrent ?? (selected ? "page" : undefined))
          }
          aria-haspopup={selectAriaHasPopup}
          aria-expanded={selectAriaExpanded}
          aria-controls={selectAriaControls}
          aria-keyshortcuts={quickSwitchHint?.ariaKey}
          onClick={onSelect}
        >
          {glyph}
          {brandMark}
          <span className="flat-row-title">{title}</span>
          {badgeCluster}
          {targetMeta}
        </button>
        {groupLabel && showCompactGroupLabel && (
          <button
            type="button"
            className="flat-row-group"
            title={`Filter by ${groupLabel}`}
            aria-label={`Filter threads by group ${groupLabel}`}
            onClick={onGroupSelect}
          >
            {groupLabel}
          </button>
        )}
        {workspaceLabel && showCompactProjectLabel && (
          <button
            type="button"
            className="flat-row-group"
            title={`Filter by ${workspaceLabel}`}
            aria-label={`Filter threads by project ${workspaceLabel}`}
            onClick={onProjectSelect}
          >
            {workspaceLabel}
          </button>
        )}
        {trailing}
      </div>
    );
  }

  const separateLocationControls =
    (projectIsInteractive && projectMeta !== undefined) ||
    (environmentIsInteractive && environmentMeta !== undefined);
  const cardMetadata = (
    <span className="flat-row-line2">
      {locationMeta}
      {badgeCluster}
      {context && (
        <span
          className="flat-row-context"
          data-testid="flat-row-context"
          data-tone={context.tone}
        >
          {context.label}
        </span>
      )}
    </span>
  );
  const cardButton = (
    <button
      type="button"
      className="flat-row-link"
      data-testid="thread-row-link"
      aria-label={selectAriaLabel}
      aria-current={
        selectAriaCurrent === false
          ? undefined
          : (selectAriaCurrent ?? (selected ? "page" : undefined))
      }
      aria-haspopup={selectAriaHasPopup}
      aria-expanded={selectAriaExpanded}
      aria-controls={selectAriaControls}
      aria-keyshortcuts={quickSwitchHint?.ariaKey}
      onClick={onSelect}
    >
      <span className="flat-row-line1">
        {glyph}
        {brandMark}
        <span className="flat-row-title">{title}</span>
      </span>
      {!separateLocationControls && cardMetadata}
    </button>
  );

  return (
    <div
      className={rootClass}
      data-testid="flat-thread-row"
      data-density="card"
      data-selected={selected ? "true" : "false"}
    >
      {separateLocationControls ? (
        <div className="flat-row-card-content">
          {cardButton}
          {cardMetadata}
        </div>
      ) : (
        cardButton
      )}
      {groupLabel && (
        <button
          type="button"
          className="flat-row-group"
          title={`Filter by ${groupLabel}`}
          aria-label={`Filter threads by group ${groupLabel}`}
          onClick={onGroupSelect}
        >
          {groupLabel}
        </button>
      )}
      {trailing}
    </div>
  );
}
