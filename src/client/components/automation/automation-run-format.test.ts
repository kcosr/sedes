import { describe, expect, it } from "vitest";
import {
  durationLabel,
  runAccessibleName,
  runDayTime,
  runDetailTitle,
  runHealth,
  runPrecheckSummary,
  runTimeline,
} from "./automation-run-format.js";
import { run } from "./automation-test-fixture.js";

const NOW = new Date(2026, 9, 6, 3, 40);

function clock(date: Date, seconds = false): string {
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
}

describe("run format", () => {
  it("names the day of a run: today, yesterday, then weekday and date", () => {
    const today = new Date(2026, 9, 6, 3, 17);
    const yesterday = new Date(2026, 9, 5, 2, 0);
    const sunday = new Date(2026, 9, 4, 2, 0);
    expect(runDayTime(today.toISOString(), NOW)).toBe(`Today ${clock(today)}`);
    expect(runDayTime(yesterday.toISOString(), NOW)).toBe(`Yesterday ${clock(yesterday)}`);
    expect(runDayTime(sunday.toISOString(), NOW)).toMatch(new RegExp(`^Sun Oct 4 ${clock(sunday)}$`, "u"));
    expect(runDayTime(new Date(2025, 9, 4, 2, 0).toISOString(), NOW)).toMatch(/2025/u);
  });

  it("writes durations on a readable scale", () => {
    expect(durationLabel(150)).toBe("150 ms");
    expect(durationLabel(1_430)).toBe("1.4 s");
    expect(durationLabel(24_000)).toBe("24 s");
    expect(durationLabel(125_000)).toBe("2 min 5 s");
    expect(durationLabel(120_000)).toBe("2 min");
    expect(durationLabel(3_780_000)).toBe("1 h 3 min");
  });

  it("lays out the timeline with the time since each previous step", () => {
    const accepted = run({
      scheduledFor: "2026-10-06T02:00:00.000Z",
      claimedAt: "2026-10-06T02:00:00.150Z",
      startedAt: "2026-10-06T02:00:01.000Z",
      acceptedAt: "2026-10-06T02:00:02.400Z",
      finishedAt: "2026-10-06T02:00:02.400Z",
    });
    expect(runTimeline(accepted)).toEqual([
      { label: "Scheduled for", time: clock(new Date("2026-10-06T02:00:00.000Z"), true) },
      { label: "Claimed", time: clock(new Date("2026-10-06T02:00:00.150Z"), true), delta: "+150 ms" },
      { label: "Started", time: clock(new Date("2026-10-06T02:00:01.000Z"), true), delta: "+850 ms" },
      { label: "Accepted", time: clock(new Date("2026-10-06T02:00:02.400Z"), true), delta: "+1.4 s" },
    ]);

    const failed = run({
      state: "failed",
      acceptedAt: undefined,
      claimedAt: undefined,
      startedAt: "2026-10-06T02:00:01.000Z",
      finishedAt: "2026-10-06T02:00:25.000Z",
    });
    expect(runTimeline(failed).map(({ label, delta }) => [label, delta])).toEqual([
      ["Scheduled for", undefined],
      ["Started", "+1 s"],
      ["Failed", "+24 s"],
    ]);
  });

  it("sums up a precheck: status, exit, duration and output", () => {
    const precheck = {
      status: "passed",
      command: "test -f package-lock.json",
      timeoutSeconds: 30,
      durationMilliseconds: 150,
      stdoutBytes: 46,
      stdoutIncluded: true,
      exitCode: 0,
    } as const;
    expect(runPrecheckSummary(precheck)).toBe(
      "Passed · exit 0 · 150 ms · 46 bytes of output added to the prompt",
    );
    expect(
      runPrecheckSummary({ ...precheck, status: "skipped", exitCode: 1, stdoutBytes: 1, stdoutIncluded: false }),
    ).toBe("Skipped the run · exit 1 · 150 ms · 1 byte of output");
    expect(runPrecheckSummary({ ...precheck, status: "pending", exitCode: undefined })).toBe("Not run yet");
  });

  it("names a row by its time, state and kind", () => {
    const manual = run({ occurrence: "manual", scheduledFor: new Date(2026, 9, 6, 3, 17).toISOString() });
    expect(runAccessibleName(manual, NOW)).toBe(`Today ${clock(new Date(2026, 9, 6, 3, 17))} Delivered, Manual`);
  });

  it("groups raw states into the page's health and sheet titles", () => {
    expect(runHealth({ state: "queued" })).toBe("sending");
    expect(runHealth({ state: "completed" })).toBe("delivered");
    expect(runDetailTitle({ state: "failed" })).toBe("Failed run");
    expect(runDetailTitle({ state: "uncertain" })).toBe("Run with an unknown outcome");
    expect(runDetailTitle({ state: "dispatching" })).toBe("Run in progress");
  });
});
