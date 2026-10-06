// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AutomationSchedule } from "../../../shared/protocol/automation.js";
import { automationStore, THREAD_ID } from "./automation-test-fixture.js";
import { useNextOccurrences } from "./use-next-occurrences.js";

const schedule: AutomationSchedule = { kind: "cron", expression: "0 * * * *", timeZone: "UTC" };
const hour = (value: number) => `2026-10-06T${String(value).padStart(2, "0")}:00:00.000Z`;
const at = (iso: string, seconds = 0) => new Date(Date.parse(iso) + seconds * 1_000);

function render(preview: ReturnType<typeof vi.fn>, initial: { now: Date; nextRunAt?: string; schedule?: AutomationSchedule }) {
  const fixture = automationStore([{ automation: null }], { previewThreadAutomationSchedule: preview });
  return renderHook(
    ({ now, nextRunAt, schedule: current }: { now: Date; nextRunAt?: string; schedule?: AutomationSchedule }) =>
      useNextOccurrences(fixture.store, THREAD_ID, current, nextRunAt, now),
    { initialProps: { schedule, ...initial } },
  );
}

describe("useNextOccurrences", () => {
  it("drops an occurrence once it passes and asks for the next ones", async () => {
    const preview = vi
      .fn()
      .mockResolvedValueOnce({ occurrences: [hour(3), hour(4), hour(5)] })
      .mockResolvedValueOnce({ occurrences: [hour(4), hour(5), hour(6)] });
    const { result, rerender } = render(preview, { now: at(hour(2), 30), nextRunAt: hour(3) });
    await waitFor(() => expect(result.current).toEqual([hour(3), hour(4), hour(5)]));
    expect(preview).toHaveBeenCalledWith(THREAD_ID, schedule, { count: 3, signal: expect.any(AbortSignal) });

    // The minute clock passes 3:00; the summary has not moved on yet.
    rerender({ schedule, now: at(hour(3), 10), nextRunAt: hour(3) });
    expect(result.current).toEqual([hour(4), hour(5)]);
    await waitFor(() => expect(result.current).toEqual([hour(4), hour(5), hour(6)]));
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it("asks again when the next run moves on", async () => {
    const preview = vi
      .fn()
      .mockResolvedValueOnce({ occurrences: [hour(3), hour(4), hour(5)] })
      .mockResolvedValueOnce({ occurrences: [hour(4), hour(5), hour(6)] });
    const { result, rerender } = render(preview, { now: at(hour(2), 30), nextRunAt: hour(3) });
    await waitFor(() => expect(result.current).toHaveLength(3));
    rerender({ schedule, now: at(hour(2), 30), nextRunAt: hour(4) });
    await waitFor(() => expect(result.current).toEqual([hour(4), hour(5), hour(6)]));
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it("asks only once per passing, even when the server's clock lags", async () => {
    const preview = vi.fn().mockResolvedValue({ occurrences: [hour(3), hour(4), hour(5)] });
    const { result, rerender } = render(preview, { now: at(hour(2), 30), nextRunAt: hour(3) });
    await waitFor(() => expect(result.current).toHaveLength(3));
    rerender({ schedule, now: at(hour(3), 10), nextRunAt: hour(3) });
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    rerender({ schedule, now: at(hour(3), 70), nextRunAt: hour(3) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(preview).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual([hour(4), hour(5)]);
  });

  it("asks for the occurrences after a snooze's wake time, however many it skips", async () => {
    // A five-minute schedule snoozed for a day skips hundreds of occurrences.
    const wake = "2026-10-07T02:30:00.000Z";
    const afterWake = ["2026-10-07T02:35:00.000Z", "2026-10-07T02:40:00.000Z", "2026-10-07T02:45:00.000Z"];
    const preview = vi.fn().mockResolvedValue({ occurrences: afterWake });
    const fixture = automationStore([{ automation: null }], { previewThreadAutomationSchedule: preview });
    const { result } = renderHook(() =>
      useNextOccurrences(fixture.store, THREAD_ID, schedule, hour(3), at(hour(2), 30), wake),
    );
    await waitFor(() => expect(result.current).toEqual(afterWake));
    expect(preview).toHaveBeenCalledWith(THREAD_ID, schedule, {
      count: 3,
      after: wake,
      signal: expect.any(AbortSignal),
    });
  });

  it("asks nothing without a schedule", () => {
    const preview = vi.fn();
    const { result } = render(preview, { now: at(hour(2)), schedule: undefined });
    expect(result.current).toEqual([]);
    expect(preview).not.toHaveBeenCalled();
  });
});
