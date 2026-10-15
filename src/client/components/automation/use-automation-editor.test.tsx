// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutomationEditor } from "./use-automation-editor.js";
import { AUTOMATION_ID, THREAD_ID, automationStore, definition } from "./automation-test-fixture.js";

afterEach(cleanup);

function editHook(fixture: ReturnType<typeof automationStore>, saved = definition(), canCloneOnRun = true) {
  return renderHook(({ live }) => useAutomationEditor(fixture.store, { id: THREAD_ID, automation: live }, { canCloneOnRun, automationId: saved.id }), { initialProps: { live: saved } });
}

describe("independent automation editor", () => {
  it("creates a named enabled sibling atomically, even when this source already has one", async () => {
    const saved = definition({ name: "Daily update" });
    const fixture = automationStore([{ automation: definition() }], { createAutomation: vi.fn().mockResolvedValue(saved) });
    const { result } = renderHook(() => useAutomationEditor(fixture.store, { id: THREAD_ID, automation: null }, { canCloneOnRun: true }));
    act(() => result.current.update({ name: "Daily update", prompt: "Send an update" }));
    await waitFor(() => expect(result.current.validation.valid).toBe(true));
    await act(async () => { expect(await result.current.save({ enable: true })).toEqual(saved); });
    expect(fixture.api.createAutomation).toHaveBeenCalledWith(THREAD_ID, expect.objectContaining({ name: "Daily update", prompt: "Send an update", initialState: "enabled", mutationId: expect.any(String) }));
    expect(fixture.api.setAutomationState).not.toHaveBeenCalled();
  });

  it("requires a name and creates a paused one-shot with no missed-occurrence policy", async () => {
    const fixture = automationStore([{ automation: null }], { createAutomation: vi.fn().mockResolvedValue(definition()) });
    const { result } = renderHook(() => useAutomationEditor(fixture.store, { id: THREAD_ID, automation: null }, { canCloneOnRun: true }));
    act(() => result.current.update({ prompt: "Remember to call", scheduleKind: "date_time" }));
    await waitFor(() => expect(result.current.preview.checking).toBe(false));
    expect(result.current.validation.valid).toBe(false);
    act(() => result.current.update({ name: "Call dentist" }));
    await waitFor(() => expect(result.current.validation.valid).toBe(true));
    await act(async () => { await result.current.save(); });
    expect(fixture.api.createAutomation).toHaveBeenCalledWith(THREAD_ID, expect.objectContaining({ name: "Call dentist", initialState: "paused", misfirePolicy: null }));
  });

  it("edits by automation ID and fences concurrent edits with that definition revision", async () => {
    const fixture = automationStore([{ automation: definition() }], { updateAutomation: vi.fn().mockResolvedValue(definition({ revision: 4 })) });
    const { result, rerender } = editHook(fixture);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.update({ name: "Renamed schedule" }));
    rerender({ live: definition({ revision: 4 }) });
    expect(result.current.stale).toBe(true);
    await act(async () => { expect(await result.current.save()).toBeUndefined(); });
    expect(fixture.api.updateAutomation).not.toHaveBeenCalled();
    fixture.api.getAutomation.mockResolvedValue(definition({ revision: 4 }));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.stale).toBe(false));
    act(() => result.current.update({ name: "Renamed schedule" }));
    await waitFor(() => expect(result.current.validation.valid).toBe(true));
    await act(async () => { await result.current.save(); });
    expect(fixture.api.updateAutomation).toHaveBeenCalledWith(AUTOMATION_ID, expect.objectContaining({ expectedRevision: 4, name: "Renamed schedule" }));
  });

  it("retains the same create receipt on retry and never adopts a sibling after a conflict", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("conflict")).mockResolvedValueOnce(definition());
    const fixture = automationStore([{ automation: definition() }], { createAutomation: create });
    const { result } = renderHook(() => useAutomationEditor(fixture.store, { id: THREAD_ID, automation: null }, { canCloneOnRun: true }));
    act(() => result.current.update({ name: "Reminder", prompt: "Remind me" }));
    await waitFor(() => expect(result.current.validation.valid).toBe(true));
    await act(async () => { await result.current.save(); });
    expect(result.current.form.name).toBe("Reminder");
    expect(fixture.api.getAutomation).not.toHaveBeenCalled();
    await act(async () => { await result.current.save(); });
    expect(create.mock.calls[0]![1].mutationId).toBe(create.mock.calls[1]![1].mutationId);
  });

  it("deletes only the selected definition", async () => {
    const fixture = automationStore([{ automation: definition() }]);
    const { result } = editHook(fixture);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => { await result.current.remove(); });
    expect(fixture.api.deleteAutomation).toHaveBeenCalledWith(AUTOMATION_ID, 3, expect.any(String));
  });
  it("allows name and prompt edits that retain an existing Fork when the source cannot fork now", async () => {
    const saved = definition({ runMode: "clone" });
    const update = vi.fn().mockResolvedValue({ ...saved, name: "Changed name" });
    const fixture = automationStore([{ automation: saved }], { updateAutomation: update });
    const { result } = editHook(fixture, saved, false);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.update({ name: "Changed name", prompt: "An updated prompt" }));
    await waitFor(() => expect(result.current.validation.valid).toBe(true));
    await act(async () => { await result.current.save(); });
    expect(update).toHaveBeenCalledWith(AUTOMATION_ID, expect.objectContaining({ name: "Changed name", prompt: "An updated prompt", runMode: "clone" }));
  });

  it("rejects changing an existing This thread automation to Fork while the source cannot fork", async () => {
    const fixture = automationStore([{ automation: definition() }]);
    const { result } = editHook(fixture, definition(), false);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.update({ runMode: "clone" }));
    await waitFor(() => expect(result.current.preview.checking).toBe(false));
    expect(result.current.validation.cloneUnavailable).toBe(true);
    expect(result.current.validation.valid).toBe(false);
    await act(async () => { await result.current.save(); });
    expect(fixture.api.updateAutomation).not.toHaveBeenCalled();
  });

  it("enforces the shared 160-character name boundary", async () => {
    const fixture = automationStore([{ automation: null }]);
    const { result } = renderHook(() => useAutomationEditor(fixture.store, { id: THREAD_ID, automation: null }, { canCloneOnRun: true }));
    act(() => result.current.update({ name: "a".repeat(161), prompt: "Reminder" }));
    await waitFor(() => expect(result.current.preview.checking).toBe(false));
    expect(result.current.validation.valid).toBe(false);
    act(() => result.current.update({ name: "a".repeat(160) }));
    expect(result.current.validation.valid).toBe(true);
  });

});
