// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRANSIENT_NOTICE_MS, useTransientNotice } from "./use-transient-notice.js";

afterEach(() => vi.useRealTimers());

describe("useTransientNotice", () => {
  it("shows a notice briefly, restarts on a new one, and clears on demand", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTransientNotice());
    expect(result.current[0]).toBe("");
    act(() => result.current[1]("Prompt saved."));
    expect(result.current[0]).toBe("Prompt saved.");
    act(() => vi.advanceTimersByTime(TRANSIENT_NOTICE_MS - 1));
    act(() => result.current[1]("Prompt order saved."));
    act(() => vi.advanceTimersByTime(TRANSIENT_NOTICE_MS - 1));
    expect(result.current[0]).toBe("Prompt order saved.");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current[0]).toBe("");
    act(() => result.current[1]("Prompt deleted."));
    act(() => result.current[2]());
    expect(result.current[0]).toBe("");
  });
});
