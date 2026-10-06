// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigate } from "../../app/router.js";
import { localDateTimeValue } from "../../lib/time.js";
import { AutomationEditor } from "./AutomationEditor.js";
import { nextWholeHour } from "./automation-form.js";
import {
  automationStore,
  automationSummary,
  definition,
  THREAD_ID,
  type FixtureThread,
} from "./automation-test-fixture.js";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  navigate("/", { replace: true });
});

const attachable = {
  available: true,
  canAttach: true,
  canRunNow: false,
  canCloneOnRun: true,
};

function renderEditor(threads: readonly FixtureThread[], api: Parameters<typeof automationStore>[1] = {}) {
  const fixture = automationStore(threads, api);
  render(<AutomationEditor store={fixture.store} threadRegistry={fixture.threadRegistry} threadId={THREAD_ID} />);
  return fixture;
}

describe("AutomationEditor", () => {
  it("creates an automation every day from the next whole hour, and saves and enables it", async () => {
    navigate(`/threads/${THREAD_ID}`, { replace: true });
    navigate(`/automations/${THREAD_ID}/edit`);
    const created = definition({ status: "paused", revision: 1 });
    const fixture = renderEditor([{ automation: null }], {
      getThreadAutomationCapability: vi.fn().mockResolvedValue(attachable),
      createThreadAutomation: vi.fn().mockResolvedValue(created),
      setThreadAutomationState: vi.fn().mockResolvedValue(definition({ revision: 2 })),
    });
    expect(await screen.findByRole("heading", { level: 1, name: "New automation" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Nightly dependency audit" })).toHaveAttribute(
      "href",
      `/threads/${THREAD_ID}`,
    );
    expect(screen.getByRole("radio", { name: "Every interval" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("spinbutton", { name: "Every" })).toHaveValue(1);
    expect(screen.getByRole("combobox", { name: "Interval unit" })).toHaveValue("days");
    expect(screen.getByLabelText("Starting")).toHaveValue(nextWholeHour(new Date()));
    expect(screen.getByRole("radio", { name: /This thread/u })).toHaveAttribute("aria-checked", "true");

    const enable = screen.getByRole("button", { name: "Save and enable" });
    const paused = screen.getByRole("button", { name: "Save as paused" });
    expect(enable).toBeDisabled();
    expect(paused).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "Check dependencies");
    await waitFor(() => expect(enable).toBeEnabled());
    expect(await screen.findByText(/^Every day at /u)).toBeInTheDocument();
    await userEvent.click(enable);

    await waitFor(() => expect(window.location.pathname).toBe(`/automations/${THREAD_ID}`));
    expect(fixture.api.createThreadAutomation).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ prompt: "Check dependencies", runMode: "same_thread" }),
    );
    expect(fixture.api.setThreadAutomationState).toHaveBeenCalledWith(THREAD_ID, "enable", 1, expect.any(String));
  });

  it("saves a new automation paused from the secondary action", async () => {
    const fixture = renderEditor([{ automation: null }], {
      getThreadAutomationCapability: vi.fn().mockResolvedValue(attachable),
      createThreadAutomation: vi.fn().mockResolvedValue(definition({ status: "paused" })),
    });
    await userEvent.type(await screen.findByRole("textbox", { name: "Prompt" }), "Check");
    const paused = screen.getByRole("button", { name: "Save as paused" });
    await waitFor(() => expect(paused).toBeEnabled());
    await userEvent.click(paused);
    await waitFor(() => expect(window.location.pathname).toBe(`/automations/${THREAD_ID}`));
    expect(fixture.api.createThreadAutomation).toHaveBeenCalledOnce();
    expect(fixture.api.setThreadAutomationState).not.toHaveBeenCalled();
  });

  it("edits a saved automation and goes back up to its page", async () => {
    navigate(`/automations/${THREAD_ID}`, { replace: true });
    navigate(`/automations/${THREAD_ID}/edit`);
    const fixture = renderEditor([{ automation: automationSummary() }], {
      updateThreadAutomation: vi.fn().mockResolvedValue(definition({ prompt: "Check twice", revision: 4 })),
    });
    const prompt = await screen.findByRole("textbox", { name: "Prompt" });
    expect(screen.getByRole("heading", { level: 1, name: "Edit automation" })).toBeInTheDocument();
    expect(prompt).toHaveValue(definition().prompt);
    expect(screen.getByRole("radio", { name: "Cron" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("textbox", { name: "Cron expression" })).toHaveValue("0 2 * * *");
    expect(screen.getByRole("combobox", { name: "Time zone" })).toHaveValue("UTC");
    expect(screen.getByText("Every day at 2:00 AM UTC")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save as paused" })).toBeNull();

    await userEvent.clear(prompt);
    await userEvent.type(prompt, "Check twice");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(window.location.pathname).toBe(`/automations/${THREAD_ID}`));
    expect(fixture.api.updateThreadAutomation).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ prompt: "Check twice", expectedRevision: 3 }),
    );
  });

  it("guards unsaved edits with the discard dialog", async () => {
    navigate(`/automations/${THREAD_ID}/edit`, { replace: true });
    renderEditor([{ automation: automationSummary() }]);
    const prompt = await screen.findByRole("textbox", { name: "Prompt" });
    await userEvent.type(prompt, " Also check licenses.");
    act(() => navigate("/automations"));
    const discard = screen.getByRole("dialog", { name: "Discard automation changes?" });
    expect(window.location.pathname).toBe(`/automations/${THREAD_ID}/edit`);
    await userEvent.click(within(discard).getByRole("button", { name: "Keep editing" }));
    expect(prompt).toHaveValue(`${definition().prompt} Also check licenses.`);

    act(() => navigate("/automations"));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Discard automation changes?" })).getByRole("button", {
        name: "Discard and leave",
      }),
    );
    expect(window.location.pathname).toBe("/automations");
  });

  it("locks the form and guards leaving while a save is unresolved, and stays put after leaving", async () => {
    navigate(`/automations/${THREAD_ID}/edit`, { replace: true });
    let finishSave!: (value: ReturnType<typeof definition>) => void;
    const updateThreadAutomation = vi.fn(
      () =>
        new Promise<ReturnType<typeof definition>>((resolve) => {
          finishSave = resolve;
        }),
    );
    const fixture = automationStore([{ automation: automationSummary() }], { updateThreadAutomation });
    const view = render(<AutomationEditor store={fixture.store} threadRegistry={fixture.threadRegistry} threadId={THREAD_ID} />);
    const prompt = await screen.findByRole("textbox", { name: "Prompt" });
    await userEvent.type(prompt, " Also check licenses.");
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(updateThreadAutomation).toHaveBeenCalledOnce());

    // No edit can slip in while the request runs.
    expect(prompt).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Cron" })).toBeDisabled();

    act(() => navigate("/automations"));
    expect(window.location.pathname).toBe(`/automations/${THREAD_ID}/edit`);
    const discard = screen.getByRole("dialog", { name: "Discard automation changes?" });
    expect(discard).toHaveTextContent("The save hasn't finished");
    await userEvent.click(within(discard).getByRole("button", { name: "Discard and leave" }));
    expect(window.location.pathname).toBe("/automations");
    // The route change unmounts the editor, as the workbench does.
    view.unmount();

    await act(async () => {
      finishSave(definition({ prompt: `${definition().prompt} Also check licenses.`, revision: 4 }));
    });
    expect(window.location.pathname).toBe("/automations");
  });

  it("puts edits back on Cancel", async () => {
    renderEditor([{ automation: automationSummary() }]);
    const prompt = await screen.findByRole("textbox", { name: "Prompt" });
    await userEvent.type(prompt, " More.");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(prompt).toHaveValue(definition().prompt);
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("stops on a change made elsewhere until the user reloads", async () => {
    const getThreadAutomation = vi
      .fn()
      .mockResolvedValueOnce(definition())
      .mockResolvedValueOnce(definition({ prompt: "Their prompt", revision: 4 }));
    const fixture = renderEditor([{ automation: automationSummary() }], { getThreadAutomation });
    const prompt = await screen.findByRole("textbox", { name: "Prompt" });
    await userEvent.type(prompt, " Mine.");
    act(() => fixture.publish([{ automation: automationSummary({ revision: 4 }) }]));
    expect(
      screen.getByText("This automation changed elsewhere. Reload before making another change."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(prompt).toHaveValue(`${definition().prompt} Mine.`);
    await userEvent.click(screen.getByRole("button", { name: "Reload automation" }));
    await waitFor(() => expect(prompt).toHaveValue("Their prompt"));
    expect(screen.queryByText(/changed elsewhere/u)).toBeNull();
  });

  it("deletes from the danger zone and goes to the list", async () => {
    navigate(`/automations/${THREAD_ID}/edit`, { replace: true });
    const fixture = renderEditor([{ automation: automationSummary() }]);
    const trigger = await screen.findByRole("button", { name: "Delete automation…" });
    expect(trigger).toHaveAttribute("data-variant", "destructive-outline");
    await userEvent.click(trigger);
    const confirm = screen.getByRole("dialog", { name: "Delete this automation?" });
    expect(confirm).toHaveTextContent(
      "Scheduled and manual runs stop and the schedule is removed. The thread, its messages and any result threads stay. Run history is no longer shown.",
    );
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete automation" }));
    await waitFor(() => expect(window.location.pathname).toBe("/automations"));
    expect(fixture.api.deleteThreadAutomation).toHaveBeenCalledWith(THREAD_ID, 3, expect.any(String));
  });

  it("disables forks the thread cannot make and hides the misfire choice for one run", async () => {
    renderEditor([{ automation: null }], {
      getThreadAutomationCapability: vi.fn().mockResolvedValue({ ...attachable, canCloneOnRun: false }),
    });
    const fork = await screen.findByRole("radio", { name: /A new fork each run/u });
    expect(fork).toBeDisabled();
    expect(screen.getByText(/^Not available for this thread/u)).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "If Sedes was down" })).toBeInTheDocument();
    const anchors = screen.getByRole("navigation", { name: "Editor sections" });
    expect(within(anchors).getByRole("button", { name: "If Sedes was down" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Once" }));
    expect(screen.queryByRole("radiogroup", { name: "If Sedes was down" })).toBeNull();
    expect(within(anchors).queryByRole("button", { name: "If Sedes was down" })).toBeNull();
    expect(screen.getByLabelText("Date and time")).toHaveValue(nextWholeHour(new Date()));
  });

  it("opens the precheck disclosure and tests the command", async () => {
    const fixture = renderEditor([{ automation: null }], {
      getThreadAutomationCapability: vi.fn().mockResolvedValue(attachable),
      testThreadAutomationPrecheck: vi.fn().mockResolvedValue({
        decision: "invoke",
        durationMilliseconds: 20,
        stdoutPreview: "3 updates",
        stderrPreview: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        exitCode: 0,
        stdoutWillBeIncluded: true,
        effectivePromptBytes: 120,
      }),
    });
    const disclosure = await screen.findByRole("button", { name: /Before each run/u });
    expect(disclosure).toHaveTextContent("None. A shell command can decide whether each run goes ahead.");
    await userEvent.click(disclosure);
    await userEvent.click(screen.getByRole("switch", { name: "Run a precheck" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Shell command" }), "npm outdated");
    expect(disclosure).toHaveTextContent("npm outdated · 30 s · output not added");
    expect(screen.getByRole("button", { name: "Test precheck" })).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Prompt" }), "Check");
    await userEvent.click(screen.getByRole("button", { name: "Test precheck" }));
    expect(await screen.findByText("Would run the agent")).toBeInTheDocument();
    expect(screen.getByText(/Output added to prompt/u)).toBeInTheDocument();
    expect(fixture.api.testThreadAutomationPrecheck).toHaveBeenCalledOnce();
  });

  it("loads the destination's own automation when moving between editors", async () => {
    const otherId = "10000000-0000-4000-8000-000000000002";
    const getThreadAutomation = vi.fn(async (threadId: string) =>
      definition({ prompt: threadId === THREAD_ID ? "First prompt" : "Second prompt" }),
    );
    const updateThreadAutomation = vi.fn().mockResolvedValue(definition({ prompt: "Second prompt, edited", revision: 4 }));
    const fixture = automationStore(
      [
        { automation: automationSummary({ revision: 3 }) },
        { id: otherId, title: "Weekly release notes draft", automation: automationSummary({ revision: 3 }) },
      ],
      { getThreadAutomation, updateThreadAutomation },
    );
    const view = render(<AutomationEditor store={fixture.store} threadRegistry={fixture.threadRegistry} threadId={THREAD_ID} />);
    expect(await screen.findByRole("textbox", { name: "Prompt" })).toHaveValue("First prompt");

    view.rerender(<AutomationEditor store={fixture.store} threadRegistry={fixture.threadRegistry} threadId={otherId} />);
    // The first editor's form never shows under the second thread's name.
    expect(screen.queryByRole("textbox", { name: "Prompt" })).toBeNull();
    expect(await screen.findByRole("link", { name: "Weekly release notes draft" })).toBeInTheDocument();
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    expect(prompt).toHaveValue("Second prompt");
    expect(getThreadAutomation).toHaveBeenLastCalledWith(otherId, expect.any(AbortSignal));

    await userEvent.type(prompt, ", edited");
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await waitFor(() => expect(updateThreadAutomation).toHaveBeenCalledOnce());
    expect(updateThreadAutomation).toHaveBeenCalledWith(
      otherId,
      expect.objectContaining({ prompt: "Second prompt, edited", expectedRevision: 3 }),
    );
  });

  it("edits the automation of a thread the store does not hold, loaded as its route would", async () => {
    const fixture = renderEditor([{ id: "other", automation: null }]);
    expect(screen.getByRole("status", { name: "Loading automation" })).toBeInTheDocument();
    expect(fixture.threadRegistry.retain).toHaveBeenCalledWith(THREAD_ID);
    act(() => fixture.threadRegistry.settle({ thread: { title: "Deep fork", automation: automationSummary() } }));
    expect(await screen.findByRole("textbox", { name: "Prompt" })).toHaveValue(definition().prompt);
    expect(screen.getByRole("link", { name: "Deep fork" })).toBeInTheDocument();
  });

  it("says why it could not load a thread outside the store", () => {
    const fixture = renderEditor([{ id: "other", automation: null }]);
    act(() => fixture.threadRegistry.settle({ error: "The server is unavailable." }));
    expect(screen.getByText("Couldn't open this thread")).toBeInTheDocument();
    expect(screen.getByText("The server is unavailable.")).toBeInTheDocument();
  });

  it("formats a one-time run in the viewer's zone", async () => {
    const runAt = new Date(Date.now() + 2 * 86_400_000);
    renderEditor([{ automation: automationSummary({ scheduleKind: "date_time" }) }], {
      getThreadAutomation: vi.fn().mockResolvedValue(
        definition({ scheduleKind: "date_time", schedule: { kind: "date_time", runAt: runAt.toISOString() } }),
      ),
    });
    expect(await screen.findByLabelText("Date and time")).toHaveValue(localDateTimeValue(runAt));
  });
});
