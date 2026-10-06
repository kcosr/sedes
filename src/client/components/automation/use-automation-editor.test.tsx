// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/ApiClient.js";
import {
  automationStore,
  automationSummary,
  definition,
  THREAD_ID,
} from "./automation-test-fixture.js";
import { AUTOMATION_PREVIEW_COUNT, useAutomationEditor } from "./use-automation-editor.js";
import { useAutomationThread } from "./use-automation-thread.js";

const options = { canCloneOnRun: true };

/** The fixture thread's editor, fed as the page feeds it: from its live summary. */
function useEditor(fixture: ReturnType<typeof automationStore>, editorOptions: { readonly canCloneOnRun: boolean }) {
  const thread = useAutomationThread(fixture.store, THREAD_ID);
  return useAutomationEditor(fixture.store, thread ?? { id: THREAD_ID, automation: null }, editorOptions);
}

function render(fixture: ReturnType<typeof automationStore>, canCloneOnRun = true) {
  return renderHook(() => useEditor(fixture, { canCloneOnRun }));
}

describe("useAutomationEditor", () => {
  it("creates: defaults, dirty tracking, preview-gated validity, then save and enable", async () => {
    const created = definition({ status: "paused", revision: 1 });
    const enabled = definition({ status: "enabled", revision: 2 });
    const fixture = automationStore([{ automation: null }], {
      createThreadAutomation: vi.fn().mockResolvedValue(created),
      setThreadAutomationState: vi.fn().mockResolvedValue(enabled),
    });
    const { result } = render(fixture);
    expect(result.current.mode).toBe("create");
    expect(result.current.status).toBe("ready");
    expect(result.current.form).toMatchObject({ scheduleKind: "interval", intervalAmount: 1, intervalUnit: "days" });
    expect(result.current.dirty).toBe(false);
    expect(result.current.validation.valid).toBe(false);

    act(() => result.current.update({ prompt: "  Check dependencies  " }));
    expect(result.current.dirty).toBe(true);
    expect(result.current.preview.checking).toBe(true);
    await waitFor(() => expect(result.current.validation.valid).toBe(true));
    expect(fixture.api.previewThreadAutomationSchedule).toHaveBeenCalledWith(
      THREAD_ID,
      result.current.schedule,
      AUTOMATION_PREVIEW_COUNT,
      expect.any(AbortSignal),
    );
    expect(result.current.preview.occurrences).toHaveLength(3);

    const schedule = result.current.schedule;
    expect(schedule).toMatchObject({ kind: "interval", everySeconds: 86_400 });
    let saved = false;
    await act(async () => {
      saved = await result.current.save({ enable: true });
    });
    expect(saved).toBe(true);
    expect(fixture.api.createThreadAutomation).toHaveBeenCalledWith(THREAD_ID, {
      prompt: "Check dependencies",
      runMode: "same_thread",
      schedule,
      misfirePolicy: "coalesce",
      precheck: null,
      mutationId: expect.any(String),
    });
    expect(fixture.api.setThreadAutomationState).toHaveBeenCalledWith(THREAD_ID, "enable", 1, expect.any(String));
    expect(result.current.definition).toEqual(enabled);
    expect(result.current.mode).toBe("edit");
    expect(result.current.dirty).toBe(false);
  });

  it("saves a new automation paused when asked", async () => {
    const fixture = automationStore([{ automation: null }], {
      createThreadAutomation: vi.fn().mockResolvedValue(definition({ status: "paused" })),
    });
    const { result } = render(fixture);
    act(() => result.current.update({ prompt: "Check" }));
    await waitFor(() => expect(result.current.validation.valid).toBe(true));
    await act(async () => {
      await result.current.save();
    });
    expect(fixture.api.createThreadAutomation).toHaveBeenCalledOnce();
    expect(fixture.api.setThreadAutomationState).not.toHaveBeenCalled();
  });

  it("keeps a new automation that could not be enabled, and says so", async () => {
    const fixture = automationStore([{ automation: null }], {
      createThreadAutomation: vi.fn().mockResolvedValue(definition({ status: "paused", revision: 1 })),
      setThreadAutomationState: vi.fn().mockRejectedValue(new Error("Choose an allowed model.")),
    });
    const { result } = render(fixture);
    act(() => result.current.update({ prompt: "Check" }));
    await waitFor(() => expect(result.current.validation.valid).toBe(true));
    let saved = true;
    await act(async () => {
      saved = await result.current.save({ enable: true });
    });
    expect(saved).toBe(false);
    expect(result.current.error).toBe("Saved as paused. It could not be enabled: Choose an allowed model.");
    expect(result.current.mode).toBe("edit");
  });

  it("edits: loads the saved definition clean, then updates against its revision", async () => {
    const saved = definition({ prompt: "Old prompt" });
    const updated = definition({ prompt: "New prompt", revision: 4 });
    const fixture = automationStore([{ automation: automationSummary() }], {
      getThreadAutomation: vi.fn().mockResolvedValue(saved),
      updateThreadAutomation: vi.fn().mockResolvedValue(updated),
    });
    const { result } = render(fixture);
    expect(result.current.mode).toBe("edit");
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.form).toMatchObject({ prompt: "Old prompt", scheduleKind: "cron", cronExpression: "0 2 * * *" });
    expect(result.current.dirty).toBe(false);

    act(() => result.current.update({ prompt: "New prompt" }));
    expect(result.current.dirty).toBe(true);
    await waitFor(() => expect(result.current.validation.valid).toBe(true));
    act(() => result.current.reset());
    expect(result.current.form.prompt).toBe("Old prompt");

    act(() => result.current.update({ prompt: "New prompt" }));
    await waitFor(() => expect(result.current.validation.valid).toBe(true));
    await act(async () => {
      await result.current.save();
    });
    expect(fixture.api.updateThreadAutomation).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ prompt: "New prompt", expectedRevision: 3 }),
    );
    expect(result.current.definition).toEqual(updated);
    expect(result.current.dirty).toBe(false);
  });

  it("reloads a clean form when the automation changes elsewhere, and marks an edited one stale", async () => {
    const getThreadAutomation = vi
      .fn()
      .mockResolvedValueOnce(definition({ prompt: "First", revision: 3 }))
      .mockResolvedValueOnce(definition({ prompt: "Second", revision: 4 }))
      .mockResolvedValueOnce(definition({ prompt: "Third", revision: 5 }));
    const fixture = automationStore([{ automation: automationSummary({ revision: 3 }) }], { getThreadAutomation });
    const { result } = render(fixture);
    await waitFor(() => expect(result.current.form.prompt).toBe("First"));

    act(() => fixture.publish([{ automation: automationSummary({ revision: 4 }) }]));
    await waitFor(() => expect(result.current.form.prompt).toBe("Second"));
    expect(result.current.stale).toBe(false);

    act(() => result.current.update({ prompt: "Mine" }));
    act(() => fixture.publish([{ automation: automationSummary({ revision: 5 }) }]));
    expect(result.current.stale).toBe(true);
    expect(result.current.form.prompt).toBe("Mine");
    let saved = true;
    await act(async () => {
      saved = await result.current.save();
    });
    expect(saved).toBe(false);
    expect(getThreadAutomation).toHaveBeenCalledTimes(2);

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.form.prompt).toBe("Third"));
    expect(result.current.stale).toBe(false);
    expect(result.current.dirty).toBe(false);
  });

  it("ignores edits while a save is in flight, so the saved response cannot drop them", async () => {
    let finishSave!: (value: ReturnType<typeof definition>) => void;
    const fixture = automationStore([{ automation: automationSummary() }], {
      updateThreadAutomation: vi.fn(
        () =>
          new Promise<ReturnType<typeof definition>>((resolve) => {
            finishSave = resolve;
          }),
      ),
    });
    const { result } = render(fixture);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.update({ prompt: "Saved prompt" }));
    await waitFor(() => expect(result.current.validation.valid).toBe(true));
    let saving!: Promise<boolean>;
    act(() => {
      saving = result.current.save();
    });
    expect(result.current.pending).toBe("save");
    act(() => result.current.update({ prompt: "Typed during the save" }));
    expect(result.current.form.prompt).toBe("Saved prompt");
    await act(async () => {
      finishSave(definition({ prompt: "Saved prompt", revision: 4 }));
      await saving;
    });
    expect(result.current.dirty).toBe(false);
    act(() => result.current.update({ prompt: "Typed after the save" }));
    expect(result.current.form.prompt).toBe("Typed after the save");
  });

  it("shows the existing automation when another client created one first", async () => {
    const existing = definition({ prompt: "Theirs" });
    const fixture = automationStore([{ automation: null }], {
      createThreadAutomation: vi
        .fn()
        .mockRejectedValue(new ApiError(409, "conflict", "This thread already has an automation.", false)),
      getThreadAutomation: vi.fn().mockResolvedValue(existing),
    });
    const { result } = render(fixture);
    act(() => result.current.update({ prompt: "Mine" }));
    await waitFor(() => expect(result.current.validation.valid).toBe(true));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.form.prompt).toBe("Theirs");
    expect(result.current.mode).toBe("edit");
    expect(result.current.notice).toMatch(/already has an automation/u);
    expect(result.current.error).toBeUndefined();
  });

  it("keeps the form when the automation is deleted elsewhere, to save it anew", async () => {
    const fixture = automationStore([{ automation: automationSummary() }]);
    const { result } = render(fixture);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => fixture.publish([{ automation: null }]));
    expect(result.current.deletedElsewhere).toBe(true);
    expect(result.current.mode).toBe("create");
    expect(result.current.form.prompt).toBe(definition().prompt);
  });

  it("refuses to save while the last run's outcome is unknown or a fork cannot be made", async () => {
    const fixture = automationStore([
      {
        automation: automationSummary({
          lastRun: { id: "run-1", state: "uncertain", occurrence: "scheduled", scheduledFor: "2026-10-06T00:00:00.000Z" },
        }),
      },
    ]);
    const { result } = render(fixture, false);
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.uncertain).toBe(true);
    act(() => result.current.update({ prompt: "Changed", runMode: "clone" }));
    expect(result.current.validation.cloneUnavailable).toBe(true);
    expect(result.current.validation.valid).toBe(false);
    let saved = true;
    await act(async () => {
      saved = await result.current.save();
    });
    expect(saved).toBe(false);
    expect(fixture.api.updateThreadAutomation).not.toHaveBeenCalled();
  });

  it("reports limits on the prompt, command and timeout", async () => {
    const fixture = automationStore([{ automation: null }]);
    const { result } = renderHook(() => useEditor(fixture, options));
    act(() =>
      result.current.update({
        prompt: "x".repeat(65_537),
        precheckEnabled: true,
        precheckCommand: "y".repeat(4_097),
        precheckTimeout: 0,
      }),
    );
    expect(result.current.validation.promptError).toMatch(/65,536/u);
    expect(result.current.validation.commandError).toMatch(/4,096/u);
    expect(result.current.validation.timeoutError).toMatch(/1 to 60/u);
    expect(result.current.validation.valid).toBe(false);
  });

  it("tests the precheck and forgets the result when its input changes", async () => {
    const outcome = {
      decision: "skip",
      durationMilliseconds: 12,
      stdoutPreview: "",
      stderrPreview: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 1,
      stdoutWillBeIncluded: false,
      effectivePromptBytes: 5,
    };
    const fixture = automationStore([{ automation: null }], {
      testThreadAutomationPrecheck: vi.fn().mockResolvedValue(outcome),
    });
    const { result } = renderHook(() => useEditor(fixture, options));
    expect(result.current.precheckTest.canTest).toBe(false);
    act(() => result.current.update({ prompt: "Check", precheckEnabled: true, precheckCommand: "false" }));
    expect(result.current.precheckTest.canTest).toBe(true);
    act(() => result.current.precheckTest.run());
    await waitFor(() => expect(result.current.precheckTest.result).toEqual(outcome));
    expect(fixture.api.testThreadAutomationPrecheck).toHaveBeenCalledWith(
      THREAD_ID,
      "Check",
      { command: "false", timeoutSeconds: 30, includeStdout: false },
      expect.any(AbortSignal),
    );
    act(() => result.current.update({ precheckCommand: "true" }));
    expect(result.current.precheckTest.result).toBeUndefined();
  });
});
