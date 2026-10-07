// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMinuteClock } from "./use-minute-clock.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Probe() {
  return <span data-testid="now">{useMinuteClock()}</span>;
}

it("advances just after each minute boundary and stops when unmounted", () => {
  const start = Date.parse("2026-10-06T03:40:30.000Z");
  vi.useFakeTimers({ now: start });
  const view = render(<Probe />);
  const now = () => Number(screen.getByTestId("now").textContent);
  expect(now()).toBe(start);
  act(() => vi.advanceTimersByTime(29_000));
  expect(now()).toBe(start);
  act(() => vi.advanceTimersByTime(1_010));
  expect(now()).toBe(Date.parse("2026-10-06T03:41:00.010Z"));
  act(() => vi.advanceTimersByTime(60_000));
  expect(now()).toBe(Date.parse("2026-10-06T03:42:00.010Z"));
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
