import { useId } from "react";
import type { CSSProperties, ReactNode } from "react";
import { cx, toneClass } from "../lib/cx";
import type { Tone } from "../lib/cx";
import { Button, IconButton } from "./Button";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

export interface EmptyStateProps {
  icon?: IconName | undefined;
  title: ReactNode;
  children?: ReactNode;
  /** Buttons ("Clear filters", "Create grant"). */
  actions?: ReactNode;
  /** Less vertical padding (drawers, cards). */
  compact?: boolean | undefined;
  tone?: Tone | undefined;
  className?: string | undefined;
}

/** Nothing to show: icon tile, title, one line of help, actions. */
export function EmptyState({
  icon = "inbox",
  title,
  children,
  actions,
  compact,
  tone,
  className,
}: EmptyStateProps) {
  return (
    <div className={cx("wb-empty", compact && "wb-empty--compact", className)}>
      <span className={cx("wb-empty-icon", toneClass(tone))}>
        <Icon name={icon} />
      </span>
      <h3 className="wb-empty-title">{title}</h3>
      {children ? <p className="wb-empty-text">{children}</p> : null}
      {actions ? <div className="wb-empty-actions">{actions}</div> : null}
    </div>
  );
}

export interface ErrorStateProps {
  error: unknown;
  title?: ReactNode;
  onRetry?: (() => void) | undefined;
  retrying?: boolean | undefined;
  compact?: boolean | undefined;
  className?: string | undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/** A load failed: message plus Retry. */
export function ErrorState({
  error,
  title = "Couldn’t load this view",
  onRetry,
  retrying,
  compact,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={cx("wb-empty", compact && "wb-empty--compact", className)}
      role="alert"
    >
      <span className="wb-empty-icon wb-tone-danger">
        <Icon name="alert" />
      </span>
      <h3 className="wb-empty-title">{title}</h3>
      <p className="wb-empty-text">{errorMessage(error)}</p>
      {onRetry ? (
        <div className="wb-empty-actions">
          <Button icon="refresh" onClick={onRetry} pending={retrying}>
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** One shimmer bar/block. Width/height accept px numbers or CSS lengths. */
export function Skeleton({
  width,
  height,
  className,
}: {
  width?: number | string | undefined;
  height?: number | string | undefined;
  className?: string | undefined;
}) {
  const style: CSSProperties = {};
  if (width !== undefined) style.width = width;
  if (height !== undefined) style.height = height;
  return (
    <span
      className={cx("wb-skel", className)}
      style={style}
      aria-hidden="true"
    />
  );
}

/** List placeholder in the dense row shape (inside a List). */
export function SkeletonRows({
  rows = 6,
  compact = false,
  header = true,
  label = "Loading",
}: {
  rows?: number | undefined;
  compact?: boolean | undefined;
  header?: boolean | undefined;
  label?: string | undefined;
}) {
  return (
    <div
      className="wb-skel-rows"
      aria-busy="true"
      aria-label={label}
      role="status"
    >
      {header ? (
        <div className="wb-group-h">
          <Skeleton />
          <span className="wb-group-rule" />
        </div>
      ) : null}
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className={cx("wb-skel-row", compact && "wb-skel-row--compact")}
        >
          <Skeleton width={16} height={16} />
          <div>
            <Skeleton width={`${55 - (i % 3) * 8}%`} height={14} />
            {compact ? null : <Skeleton width="32%" />}
            {compact ? null : <Skeleton width="85%" />}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Paragraph-ish placeholder (drawer sections, cards). */
export function SkeletonBlock({
  lines = 4,
  label = "Loading",
}: {
  lines?: number | undefined;
  label?: string | undefined;
}) {
  return (
    <div
      className="wb-skel-block"
      aria-busy="true"
      aria-label={label}
      role="status"
    >
      {Array.from({ length: lines }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}

/** Sidebar placeholder. */
export function SkeletonSidebar({ lines = 8 }: { lines?: number | undefined }) {
  return (
    <div
      className="wb-skel-side"
      aria-busy="true"
      aria-label="Loading"
      role="status"
    >
      {Array.from({ length: lines }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}

/** Thin indeterminate bar pinned to the top of a scroll region while refetching. */
export function ProgressBar({ active }: { active: boolean }) {
  return (
    <div
      className={cx("wb-progress", active && "is-active")}
      aria-hidden="true"
    >
      <i />
    </div>
  );
}

export interface MeterProps {
  value: number;
  max?: number | undefined;
  /** Visible label above the bar (also the accessible name). */
  label?: ReactNode;
  /** Accessible name when there is no visible label. */
  "aria-label"?: string | undefined;
  /** Text on the right ("42 / 100", "42%"); default percent. */
  valueText?: string | undefined;
  /** Hide the value text. */
  hideValue?: boolean | undefined;
  tone?: Tone | undefined;
  className?: string | undefined;
}

/** Determinate bar (quota used, sync progress). */
export function Meter({
  value,
  max = 100,
  label,
  valueText,
  hideValue = false,
  tone,
  className,
  "aria-label": ariaLabel,
}: MeterProps) {
  const labelId = `wb-meter-${useId()}`;
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const text = valueText ?? `${Math.round(ratio * 100)}%`;
  return (
    <div className={cx("wb-meter", toneClass(tone), className)}>
      {label || !hideValue ? (
        <div className="wb-meter-head">
          <span id={labelId}>{label}</span>
          {hideValue ? null : (
            // Announced through aria-valuetext on the meter.
            <span className="wb-meter-value" aria-hidden="true">
              {text}
            </span>
          )}
        </div>
      ) : null}
      <div
        className="wb-meter-track"
        role="meter"
        aria-label={ariaLabel}
        aria-labelledby={!ariaLabel && label ? labelId : undefined}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={text}
      >
        <span className="wb-meter-bar" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

const TONE_ICON: Record<Tone, IconName> = {
  info: "info",
  success: "circle-check",
  warning: "alert",
  danger: "alert-circle",
  neutral: "info",
  muted: "info",
};

export interface BannerProps {
  tone?: Tone | undefined;
  title?: ReactNode;
  children?: ReactNode;
  icon?: IconName | undefined;
  /** Buttons on the right. */
  actions?: ReactNode;
  onDismiss?: (() => void) | undefined;
  dismissLabel?: string | undefined;
  /** One-line layout (attention items above a list). */
  slim?: boolean | undefined;
  /** Announce when it appears (role=status, or role=alert for danger). */
  live?: boolean | undefined;
  className?: string | undefined;
}

/** Inline notice. */
export function Banner({
  tone = "info",
  title,
  children,
  icon,
  actions,
  onDismiss,
  dismissLabel = "Dismiss",
  slim = false,
  live = false,
  className,
}: BannerProps) {
  return (
    <div
      className={cx(
        "wb-banner",
        slim && "wb-banner--slim",
        toneClass(tone),
        className,
      )}
      role={live ? (tone === "danger" ? "alert" : "status") : undefined}
    >
      <Icon name={icon ?? TONE_ICON[tone]} />
      <div className="wb-banner-body">
        {title ? <div className="wb-banner-title">{title}</div> : null}
        {children ? <div className="wb-banner-text">{children}</div> : null}
      </div>
      {actions ? <div className="wb-banner-actions">{actions}</div> : null}
      {onDismiss ? (
        <IconButton
          icon="x"
          label={dismissLabel}
          size="sm"
          className="wb-banner-dismiss"
          onClick={onDismiss}
        />
      ) : null}
    </div>
  );
}

/** Staged-changes bar for a Main footer: "3 uncommitted changes · Validate · Save · Discard". */
export function DraftBar({
  children,
  actions,
  className,
}: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div
      className={cx("wb-draftbar", className)}
      role="region"
      aria-label="Unsaved changes"
    >
      <Icon name="pencil" />
      <div className="wb-draftbar-text">{children}</div>
      {actions ? <div className="wb-draftbar-actions">{actions}</div> : null}
    </div>
  );
}
