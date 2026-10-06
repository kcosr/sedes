import { describe, expect, it } from "vitest";
import { futureTimeLabel, shortRelativeTime } from "./time.js";

describe("futureTimeLabel ladder", () => {
  const now = new Date(2026, 7, 1, 9, 0, 0); // Sat Aug 1 2026, 09:00 local

  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
  const clock = (date: Date) =>
    date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  it("relative inside the hour", () => {
    expect(futureTimeLabel(at(45 * 60_000).toISOString(), now)).toBe("in 45m");
    expect(futureTimeLabel(at(30_000).toISOString(), now)).toBe("in 1m");
  });

  it("same-day clock time past the hour", () => {
    const date = at(5 * 3_600_000);
    expect(futureTimeLabel(date.toISOString(), now)).toBe(clock(date));
  });

  it("tomorrow gets the Tmrw prefix", () => {
    const date = at(24 * 3_600_000);
    expect(futureTimeLabel(date.toISOString(), now)).toBe(
      `Tmrw ${clock(date)}`,
    );
  });

  it("inside a week gets weekday + time", () => {
    const date = at(3 * 24 * 3_600_000);
    expect(futureTimeLabel(date.toISOString(), now)).toBe(
      date.toLocaleString([], {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
    expect(futureTimeLabel(date.toISOString(), now)).toMatch(/^Tue /u);
  });

  it("a week and beyond gets month + day", () => {
    const date = at(30 * 24 * 3_600_000);
    expect(futureTimeLabel(date.toISOString(), now)).toBe(
      date.toLocaleDateString([], { month: "short", day: "numeric" }),
    );
  });

  it("past-due falls back to the absolute wake label", () => {
    const date = at(-3_600_000);
    expect(futureTimeLabel(date.toISOString(), now)).not.toMatch(/^in /);
  });
});

describe("shortRelativeTime", () => {
  const now = Date.parse("2026-10-06T03:40:00.000Z");
  it("measures against the given instant", () => {
    expect(shortRelativeTime("2026-10-06T03:39:30.000Z", now)).toBe("now");
    expect(shortRelativeTime("2026-10-06T03:16:00.000Z", now)).toBe("24m");
    expect(shortRelativeTime("2026-10-05T06:40:00.000Z", now)).toBe("21h");
    expect(shortRelativeTime("2026-10-04T03:40:00.000Z", now)).toBe("2d");
  });
});
