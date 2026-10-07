import { describe, expect, it } from "vitest";
import {
  durationLabel,
  runAccessibleName,
  runDetailTitle,
  runHealth,
  runPrecheckSummary,
  runTimeline,
  runTurnSummary,
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

    // The run's own ending, never its turn's: an unknown run that later
    // learned its turn finished still ended unknown.
    const learned = run({
      state: "uncertain",
      acceptedAt: undefined,
      finishedAt: "2026-10-06T02:00:25.000Z",
      turn: { id: "turn-1", outcome: "completed", settledAt: "2026-10-06T02:05:00.000Z" },
    });
    expect(runTimeline(learned).at(-1)?.label).toBe("Outcome unknown");
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

  it("names a row by its turn's outcome and duration, or how long it has been running", () => {
    const time = `Today ${clock(new Date(2026, 9, 6, 3, 17))}`;
    const scheduledFor = new Date(2026, 9, 6, 3, 17).toISOString();
    const settled = (outcome: "completed" | "failed" | "interrupted", seconds?: number) =>
      run({
        scheduledFor,
        turn: {
          id: "turn-1",
          outcome,
          settledAt: "2026-10-06T02:10:00.000Z",
          ...(seconds === undefined
            ? {}
            : { startedAt: "2026-10-06T02:00:00.000Z", endedAt: new Date(Date.parse("2026-10-06T02:00:00.000Z") + seconds * 1_000).toISOString() }),
        },
      });
    expect(runAccessibleName(settled("completed", 134), NOW)).toBe(`${time} Finished in 2m 14s, Scheduled`);
    expect(runAccessibleName(settled("failed", 40), NOW)).toBe(`${time} Failed after 40s, Scheduled`);
    expect(runAccessibleName(settled("interrupted", 300), NOW)).toBe(`${time} Interrupted after 5m, Scheduled`);
    expect(runAccessibleName(settled("interrupted"), NOW)).toBe(`${time} Interrupted, Scheduled`);

    const delivered = run({ scheduledFor, acceptedAt: new Date(2026, 9, 6, 3, 36).toISOString() });
    expect(runAccessibleName(delivered, NOW, true)).toBe(`${time} Running for 4m, Scheduled`);
    expect(
      runAccessibleName({ ...delivered, acceptedAt: new Date(2026, 9, 6, 3, 39, 30).toISOString() }, NOW, true),
    ).toBe(`${time} Running, Scheduled`);
  });

  it("groups raw states into the page's health and sheet titles", () => {
    expect(runHealth({ state: "queued" })).toBe("sending");
    expect(runHealth({ state: "completed" })).toBe("delivered");
    expect(runDetailTitle({ state: "failed" })).toBe("Failed run");
    expect(runDetailTitle({ state: "uncertain" })).toBe("Run with an unknown outcome");
    expect(runDetailTitle({ state: "dispatching" })).toBe("Run in progress");
  });

  it("lets a settled turn decide a delivered run's health, and running mark one without", () => {
    const turn = (outcome: "completed" | "failed" | "interrupted") => ({
      id: "turn-1",
      outcome,
      settledAt: "2026-10-06T02:10:00.000Z",
    });
    expect(runHealth({ state: "completed", turn: turn("completed") })).toBe("finished");
    expect(runHealth({ state: "completed", turn: turn("failed") })).toBe("failed");
    expect(runHealth({ state: "completed", turn: turn("interrupted") })).toBe("interrupted");
    expect(runHealth({ state: "completed", turn: turn("completed") }, true)).toBe("finished");
    expect(runHealth({ state: "completed" }, true)).toBe("running");
    expect(runHealth({ state: "queued" }, true)).toBe("sending");
    expect(runDetailTitle({ state: "completed", turn: turn("completed") })).toBe("Finished run");
    expect(runDetailTitle({ state: "completed", turn: turn("failed") })).toBe("Failed run");
    expect(runDetailTitle({ state: "completed", turn: turn("interrupted") })).toBe("Interrupted run");
    expect(runDetailTitle({ state: "completed" }, true)).toBe("Run in progress");
  });

  it("sums up a settled turn: its ending, duration and times", () => {
    const turn = {
      id: "turn-1",
      outcome: "completed",
      settledAt: "2026-10-06T02:02:20.000Z",
      startedAt: "2026-10-06T02:00:03.000Z",
      endedAt: "2026-10-06T02:02:17.000Z",
    } as const;
    const started = clock(new Date(turn.startedAt), true);
    const ended = clock(new Date(turn.endedAt), true);
    expect(runTurnSummary(turn)).toEqual({
      outcome: "Finished · 2m 14s",
      times: `Started ${started} · ended ${ended}`,
    });
    expect(runTurnSummary({ ...turn, outcome: "failed", startedAt: undefined })).toEqual({
      outcome: "Failed",
      times: `Ended ${ended}`,
    });
    expect(runTurnSummary({ ...turn, outcome: "interrupted", startedAt: undefined, endedAt: undefined })).toEqual({
      outcome: "Interrupted",
    });
  });
});
