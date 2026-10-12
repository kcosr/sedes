import { cx } from "../lib/cx";
import {
  formatDate,
  formatDateTime,
  formatRelative,
  formatTime,
  toDate,
  useNow,
} from "../lib/time";
import type { DateLike } from "../lib/time";

export interface TimeProps {
  value: DateLike | null | undefined;
  /** relative ("5m ago", default), date ("Sep 27"), time ("7:45 PM"), datetime. */
  format?: "relative" | "date" | "time" | "datetime" | undefined;
  /** Shown for missing/invalid values (default "—"). */
  fallback?: string | undefined;
  className?: string | undefined;
}

/**
 * The one date renderer: short text, the absolute date and time (with
 * seconds) in `title`, machine-readable `dateTime`. Relative text refreshes
 * every 30 s.
 */
export function Time({
  value,
  format = "relative",
  fallback = "—",
  className,
}: TimeProps) {
  const now = useNow();
  const d = toDate(value);
  if (!d) return <span className={cx("wb-muted", className)}>{fallback}</span>;
  const text =
    format === "relative"
      ? formatRelative(d, now)
      : format === "date"
        ? formatDate(d, now)
        : format === "time"
          ? formatTime(d)
          : formatDateTime(d);
  return (
    <time
      className={className}
      dateTime={d.toISOString()}
      title={formatDateTime(d, { seconds: true })}
    >
      {text}
    </time>
  );
}
