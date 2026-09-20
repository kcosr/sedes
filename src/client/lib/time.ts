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
export function shortRelativeTime(isoDate: string): string {
  const elapsed = Date.now() - new Date(isoDate).getTime();
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

/** Compact automation next-run label for list rows: "Fri 9:00 PM". */
export function shortAutomationTime(isoDate: string): string {
  return new Date(isoDate).toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function automationTimeLabel(isoDate: string): string {
  return new Date(isoDate).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
