import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { cx, toneClass } from "../lib/cx";
import type { Tone } from "../lib/cx";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

export interface ChipToggleProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange"
> {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  icon?: IconName | undefined;
  count?: number | string | undefined;
}

/** Pill-shaped on/off filter (aria-pressed). */
export function ChipToggle({
  pressed,
  onPressedChange,
  icon,
  count,
  children,
  className,
  onClick,
  ...rest
}: ChipToggleProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx("wb-chip-toggle", className)}
      aria-pressed={pressed}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) onPressedChange(!pressed);
      }}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
      {count !== undefined ? (
        <>
          {" "}
          <span className="wb-chip-toggle-count">{count}</span>
        </>
      ) : null}
    </button>
  );
}

export interface ChipProps {
  children: ReactNode;
  icon?: IconName | undefined;
  /** Shows an × button. */
  onRemove?: (() => void) | undefined;
  /** Accessible name of the × button (default "Remove <text>"). */
  removeLabel?: string | undefined;
  /** Dashed, non-removable value set elsewhere (e.g. by server config). */
  readOnly?: boolean | undefined;
  title?: string | undefined;
  className?: string | undefined;
}

/** A value token, optionally removable. */
export function Chip({
  children,
  icon,
  onRemove,
  removeLabel,
  readOnly,
  title,
  className,
}: ChipProps) {
  const name =
    removeLabel ??
    (typeof children === "string" ? `Remove ${children}` : "Remove");
  return (
    <span
      className={cx(
        "wb-chip",
        onRemove && "wb-chip--removable",
        readOnly && "wb-chip--readonly",
        className,
      )}
      title={title}
    >
      {icon ? <Icon name={icon} /> : null}
      <span className="wb-chip-label">{children}</span>
      {onRemove ? (
        <button
          type="button"
          className="wb-chip-remove"
          aria-label={name}
          onClick={onRemove}
        >
          <Icon name="x" />
        </button>
      ) : null}
    </span>
  );
}

export interface BadgeProps {
  children: ReactNode;
  tone?: Tone | undefined;
  /** soft (tinted, default), outline (neutral border), dot (coloured dot + text). */
  variant?: "soft" | "outline" | "dot" | undefined;
  icon?: IconName | undefined;
  title?: string | undefined;
  className?: string | undefined;
}

/** Small status/label pill. */
export function Badge({
  children,
  tone,
  variant = "soft",
  icon,
  title,
  className,
}: BadgeProps) {
  return (
    <span
      className={cx(
        "wb-badge",
        variant !== "soft" && `wb-badge--${variant}`,
        toneClass(tone),
        className,
      )}
      title={title}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </span>
  );
}

/** Solid state pill with white text (drawer headers: "Active", "Revoked"). */
export function StatePill({
  children,
  tone = "neutral",
  icon,
  title,
  className,
}: {
  children: ReactNode;
  tone?: Tone | undefined;
  icon?: IconName | undefined;
  title?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      className={cx("wb-state-pill", toneClass(tone), className)}
      title={title}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </span>
  );
}

/** 7px status dot. Give it a `label` when nothing next to it says the status. */
export function StatusDot({
  tone = "muted",
  label,
  pulse = false,
  className,
}: {
  tone?: Tone | undefined;
  label?: string | undefined;
  /** Gentle pulse for "live" states (off under reduced motion). */
  pulse?: boolean | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      className={cx(
        "wb-status-dot",
        pulse && "wb-status-dot--pulse",
        toneClass(tone),
        className,
      )}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
    />
  );
}

/**
 * A state in a table cell. The normal state ("Active") is `quiet`: just a
 * dot, its label for screen readers and as a tooltip, so exceptions stand
 * out. Other states show the dot and the label. Tone from the tone tokens.
 */
export function StateCell({
  label,
  tone = "neutral",
  quiet = false,
  title,
  className,
}: {
  /** The state's name ("Active", "Disabled"): visible, or announced when quiet. */
  label: string;
  tone?: Tone | undefined;
  /** Dot only (the default/normal state). */
  quiet?: boolean | undefined;
  /** Tooltip (default: the label). */
  title?: string | undefined;
  className?: string | undefined;
}) {
  return (
    <span
      className={cx(
        "wb-state-cell",
        quiet && "wb-state-cell--quiet",
        toneClass(tone),
        className,
      )}
      title={title ?? (quiet ? label : undefined)}
    >
      <span className="wb-state-cell-dot" aria-hidden="true" />
      <span className={quiet ? "wb-sr-only" : "wb-state-cell-label"}>
        {label}
      </span>
    </span>
  );
}

/** Keyboard key. */
export function Kbd({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return <kbd className={cx("wb-kbd", className)}>{children}</kbd>;
}

const AVATAR_COLORS = [
  "#6e7781",
  "#8c6d3f",
  "#5b7f95",
  "#7a6a9c",
  "#5f8a6b",
  "#9a6060",
  "#4f7f7f",
  "#8a7550",
  "#6b6f9a",
] as const;

function avatarColor(seed: string): string {
  let h = 7;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
}

/** Letter avatar with a stable colour per name (no image requests). */
export function Avatar({
  name,
  size = "sm",
  highlight = false,
  title,
  className,
}: {
  name: string;
  size?: "sm" | "md" | "lg" | "xl" | undefined;
  /** Accent colour (e.g. the signed-in user). */
  highlight?: boolean | undefined;
  title?: string | undefined;
  className?: string | undefined;
}) {
  const style = {
    "--wb-avatar-bg": highlight
      ? "var(--wb-accent)"
      : avatarColor(name.toLowerCase()),
  } as CSSProperties;
  return (
    <span
      className={cx(
        "wb-avatar",
        size !== "sm" && `wb-avatar--${size}`,
        className,
      )}
      style={style}
      title={title ?? name}
      aria-hidden="true"
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}
