// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutomationResource } from "./use-automation-resource.js";
import { automationStore, definition, AUTOMATION_ID, THREAD_ID } from "./automation-test-fixture.js";

afterEach(cleanup);
const SECOND = "30000000-0000-4000-8000-000000000002";

describe("automation resource ownership", () => {
  it.each([false, true])("recovers failed local deletion unless an authoritative deletion arrived (event: %s)", async (eventArrives) => {
    const fixture = automationStore([{ automation: definition() }]);
    const { result } = renderHook(() => useAutomationResource(fixture.store, AUTOMATION_ID));
    await waitFor(() => expect(result.current.definition?.id).toBe(AUTOMATION_ID));
    let rejectDelete!: (reason: Error) => void;
    let removing!: Promise<void>;
    act(() => {
      removing = result.current.reads.remove(() => new Promise((_resolve, reject) => { rejectDelete = reject; }));
    });
    act(() => { fixture.invalidate(); fixture.invalidateSource(THREAD_ID); result.current.reload(); });
    expect(fixture.api.getAutomation).toHaveBeenCalledOnce();
    if (eventArrives) act(() => fixture.invalidate(AUTOMATION_ID, true));
    fixture.api.getAutomation.mockResolvedValue(definition({ revision: 4 }));
    await act(async () => {
      rejectDelete(new Error("Delete was rejected"));
      await expect(removing).rejects.toThrow("Delete was rejected");
    });
    if (eventArrives) {
      expect(result.current.missing).toBe(true);
      expect(fixture.api.getAutomation).toHaveBeenCalledOnce();
    } else {
      await waitFor(() => expect(result.current.definition?.revision).toBe(4));
      expect(result.current.missing).toBe(false);
      expect(fixture.api.getAutomation).toHaveBeenCalledTimes(2);
    }
  });

  it.each(["resolve", "reject"] as const)("isolates a pending deletion's late %s from another selected identity", async (outcome) => {
    const fixture = automationStore([{ automation: definition() }]);
    const { result, rerender } = renderHook(({ id }) => useAutomationResource(fixture.store, id), { initialProps: { id: AUTOMATION_ID } });
    await waitFor(() => expect(result.current.definition?.id).toBe(AUTOMATION_ID));
    const oldReads = result.current.reads;
    let finishDelete!: () => void;
    let removing!: Promise<void>;
    act(() => {
      removing = oldReads.remove(() => new Promise<void>((resolve, reject) => {
        finishDelete = () => outcome === "resolve" ? resolve() : reject(new Error("Old deletion rejected"));
      }));
    });
    fixture.api.getAutomation.mockResolvedValue(definition({ id: SECOND, name: "Other reminder" }));
    rerender({ id: SECOND });
    await waitFor(() => expect(result.current.definition?.id).toBe(SECOND));
    expect(result.current.reads).not.toBe(oldReads);
    await act(async () => { finishDelete(); await removing.catch(() => undefined); });
    expect(result.current.missing).toBe(false);
    expect(result.current.reads.getSnapshot()).toBe("active");
    act(() => fixture.invalidate());
    await waitFor(() => expect(fixture.api.getAutomation).toHaveBeenCalledTimes(3));
    expect(result.current.definition?.name).toBe("Other reminder");
  });

  it("consumes deletion without refetching and fences an older response while retaining loaded fields", async () => {
    const original = definition();
    const fixture = automationStore([{ automation: original }]);
    const { result, rerender } = renderHook(({ id }) => useAutomationResource(fixture.store, id), { initialProps: { id: AUTOMATION_ID } });
    await waitFor(() => expect(result.current.definition).toEqual(original));
    act(() => fixture.invalidate(SECOND, true));
    expect(result.current.missing).toBe(false);
    expect(fixture.api.getAutomation).toHaveBeenCalledOnce();

    let finishRead!: (value: ReturnType<typeof definition>) => void;
    fixture.api.getAutomation.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    act(() => fixture.invalidate(AUTOMATION_ID));
    await waitFor(() => expect(fixture.api.getAutomation).toHaveBeenCalledTimes(2));
    const signal = fixture.api.getAutomation.mock.calls[1]![1] as AbortSignal;
    act(() => {
      fixture.invalidate(AUTOMATION_ID, true);
      fixture.invalidateSource(THREAD_ID);
      fixture.invalidateSource();
      fixture.invalidate();
      fixture.invalidate(AUTOMATION_ID);
      result.current.reload();
    });
    expect(signal.aborted).toBe(true);
    expect(result.current.missing).toBe(true);
    expect(result.current.error).toBe("This automation was deleted.");
    expect(result.current.definition).toEqual(original);
    await act(async () => finishRead(definition({ name: "Stale response", revision: 99 })));
    expect(result.current.definition).toEqual(original);
    expect(result.current.missing).toBe(true);
    expect(fixture.api.getAutomation).toHaveBeenCalledTimes(2);

    const other = definition({ id: SECOND, name: "Independent reminder" });
    fixture.api.getAutomation.mockResolvedValue(other);
    rerender({ id: SECOND });
    expect(result.current.definition).toBeUndefined();
    expect(result.current.missing).toBe(false);
    await waitFor(() => expect(result.current.definition).toEqual(other));
    act(() => fixture.invalidate());
    await waitFor(() => expect(fixture.api.getAutomation).toHaveBeenCalledTimes(4));
    expect(result.current.missing).toBe(false);
  });

  it("does not adopt an initial response that arrives after its deletion event", async () => {
    let finishRead!: (value: ReturnType<typeof definition>) => void;
    const getAutomation = vi.fn((_id: string, _signal?: AbortSignal) => new Promise<ReturnType<typeof definition>>((resolve) => { finishRead = resolve; }));
    const fixture = automationStore([], { getAutomation });
    const { result } = renderHook(() => useAutomationResource(fixture.store, AUTOMATION_ID));
    const signal = getAutomation.mock.calls[0]![1] as AbortSignal;
    act(() => fixture.invalidate(AUTOMATION_ID, true));
    expect(signal.aborted).toBe(true);
    await act(async () => finishRead(definition()));
    act(() => { fixture.invalidateSource(); fixture.invalidate(); });
    expect(result.current.definition).toBeUndefined();
    expect(result.current.missing).toBe(true);
    expect(getAutomation).toHaveBeenCalledOnce();
  });

  it("refreshes only the selected resource and resynchronizes after reconnect", async () => {
    const fixture = automationStore([{ automation: definition() }]);
    const { result } = renderHook(() => useAutomationResource(fixture.store, AUTOMATION_ID));
    await waitFor(() => expect(result.current.definition?.id).toBe(AUTOMATION_ID));
    act(() => fixture.invalidate(SECOND));
    expect(fixture.api.getAutomation).toHaveBeenCalledTimes(1);
    fixture.api.getAutomation.mockResolvedValue(definition({ revision: 4 }));
    act(() => fixture.invalidate(AUTOMATION_ID));
    await waitFor(() => expect(result.current.definition?.revision).toBe(4));
    act(() => fixture.invalidate());
    await waitFor(() => expect(fixture.api.getAutomation).toHaveBeenCalledTimes(3));
  });

  it("aborts an old request and never shows it on another resource with the same revision", async () => {
    let old!: (value: ReturnType<typeof definition>) => void;
    const get = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { old = resolve; })).mockResolvedValueOnce(definition({ id: SECOND, name: "Reminder" }));
    const fixture = automationStore([{ automation: definition() }], { getAutomation: get });
    const { result, rerender } = renderHook(({ id }) => useAutomationResource(fixture.store, id), { initialProps: { id: AUTOMATION_ID } });
    rerender({ id: SECOND });
    await waitFor(() => expect(result.current.definition?.name).toBe("Reminder"));
    await act(async () => old(definition()));
    expect(result.current.definition?.id).toBe(SECOND);
    expect((get.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
  });
  it("refreshes source metadata for its source changes without accepting unrelated sources", async () => {
    const fixture = automationStore([{ automation: definition() }]);
    const { result } = renderHook(() => useAutomationResource(fixture.store, AUTOMATION_ID));
    await waitFor(() => expect(result.current.definition?.id).toBe(AUTOMATION_ID));
    act(() => fixture.invalidateSource("unrelated-source"));
    expect(fixture.api.getAutomation).toHaveBeenCalledTimes(1);
    fixture.api.getAutomation.mockResolvedValue(definition({ source: { ...definition().source, title: "Renamed source", inventoryState: "snoozed" } }));
    act(() => fixture.invalidateSource(THREAD_ID));
    await waitFor(() => expect(result.current.definition?.source.title).toBe("Renamed source"));
    expect(result.current.definition?.source.inventoryState).toBe("snoozed");
  });
});
