// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutomationResource } from "./use-automation-resource.js";
import { automationStore, definition, AUTOMATION_ID, THREAD_ID } from "./automation-test-fixture.js";

afterEach(cleanup);
const SECOND = "30000000-0000-4000-8000-000000000002";

describe("automation resource ownership", () => {
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
