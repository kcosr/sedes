const relativeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

export function relativeTime(isoDate: string): string {
  const value = new Date(isoDate).getTime() - Date.now();
  const abs = Math.abs(value);
  if (abs < 60_000) return relativeFormatter.format(Math.round(value / 1_000), "second");
  if (abs < 3_600_000) return relativeFormatter.format(Math.round(value / 60_000), "minute");
  if (abs < 86_400_000) return relativeFormatter.format(Math.round(value / 3_600_000), "hour");
  return relativeFormatter.format(Math.round(value / 86_400_000), "day");
}

/** Compact Codex-style row timestamp: "now", "24m", "3h", "2d". */
export function shortRelativeTime(
  isoDate: string,
  now: number = Date.now(),
): string {
  const elapsed = now - new Date(isoDate).getTime();
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

export function snoozeLabel(isoDate: string): string {
  const date = new Date(isoDate);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

export function localDateTimeValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

/**
 * Future-absolute time, the one format for upcoming instants (next runs,
 * wakes): "in 45m" → same-day clock time → "Tmrw 9:00 AM" → "Mon 9:00 AM" →
 * "Aug 12". A past-due stamp falls back to the absolute wake-style label;
 * sidebar rows color it warning via data-overdue.
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
  if (dayDelta < 7) {
    return date.toLocaleString([], {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
