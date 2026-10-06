// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { automationStore, THREAD_ID, type FixtureThread } from "./automation-test-fixture.js";
import { useAutomationCapability } from "./use-automation-details.js";
import { useAutomationThread } from "./use-automation-thread.js";

const busy = { available: true, canAttach: false, canRunNow: false, canCloneOnRun: true };
const settled = { available: true, canAttach: true, canRunNow: false, canCloneOnRun: true };

function thread(overrides: Partial<FixtureThread> = {}): FixtureThread {
  return { automation: null, ...overrides };
}

describe("useAutomationCapability", () => {
  it("reads the capability again when the thread enters or leaves a run, not on every run step", async () => {
    const getThreadAutomationCapability = vi.fn().mockResolvedValueOnce(busy).mockResolvedValueOnce(settled);
    const fixture = automationStore([thread({ runState: "running" })], { getThreadAutomationCapability });
    const { result } = renderHook(() => {
      const current = useAutomationThread(fixture.store, THREAD_ID);
      return useAutomationCapability(fixture.store, THREAD_ID, current);
    });
    await waitFor(() => expect(result.current.capability).toEqual(busy));

    // Still in flight: what the server answers has not changed.
    act(() => fixture.publish([thread({ runState: "stopping" })]));
    act(() => fixture.publish([thread({ runState: "waiting_for_input" })]));
    expect(getThreadAutomationCapability).toHaveBeenCalledOnce();

    act(() => fixture.publish([thread({ runState: "idle" })]));
    await waitFor(() => expect(result.current.capability).toEqual(settled));
    expect(getThreadAutomationCapability).toHaveBeenCalledTimes(2);

    // A failed turn settles the thread as idle does.
    act(() => fixture.publish([thread({ runState: "failed" })]));
    expect(getThreadAutomationCapability).toHaveBeenCalledTimes(2);
  });

  it("reads it again when the thread is bound to its backend", async () => {
    const getThreadAutomationCapability = vi.fn().mockResolvedValue(settled);
    const fixture = automationStore([thread({ backingState: "unbound" })], { getThreadAutomationCapability });
    renderHook(() => {
      const current = useAutomationThread(fixture.store, THREAD_ID);
      return useAutomationCapability(fixture.store, THREAD_ID, current);
    });
    await waitFor(() => expect(getThreadAutomationCapability).toHaveBeenCalledOnce());
    act(() => fixture.publish([thread({ backingState: "bound" })]));
    await waitFor(() => expect(getThreadAutomationCapability).toHaveBeenCalledTimes(2));
  });
});
