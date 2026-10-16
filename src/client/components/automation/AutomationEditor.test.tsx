// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/ApiClient.js";
import { AutomationEditor } from "./AutomationEditor.js";
import { AUTOMATION_ID, THREAD_ID, automationStore, definition, installAutomationDom } from "./automation-test-fixture.js";

beforeEach(installAutomationDom);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("automation editor", () => {
  it("aborts its resource read before local deletion and stays deleted without an event", async () => {
    const fixture = automationStore([{ automation: definition() }]);
    render(<AutomationEditor store={fixture.store} threadRegistry={fixture.threadRegistry} automationId={AUTOMATION_ID} />);
    await screen.findByRole("textbox", { name: "Name" });
    let finishRead!: (value: ReturnType<typeof definition>) => void;
    fixture.api.getAutomation.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const beforeRefresh = fixture.api.getAutomation.mock.calls.length;
    act(() => fixture.invalidate(AUTOMATION_ID));
    await waitFor(() => expect(fixture.api.getAutomation).toHaveBeenCalledTimes(beforeRefresh + 1));
    const signal = fixture.api.getAutomation.mock.calls.at(-1)![1] as AbortSignal;
    fixture.api.deleteAutomation.mockImplementation(async () => {
      expect(signal.aborted).toBe(true);
      fixture.invalidateSource(THREAD_ID);
      fixture.invalidate();
      return { deleted: true };
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete automation…" }));
    await user.click(screen.getByRole("button", { name: "Delete automation" }));
    await waitFor(() => expect(window.location.pathname).toBe("/automations"));
    await act(async () => finishRead(definition({ revision: 99 })));
    act(() => { fixture.invalidateSource(THREAD_ID); fixture.invalidate(); });
    expect(fixture.api.getAutomation).toHaveBeenCalledTimes(beforeRefresh + 1);
    expect(fixture.api.deleteAutomation).toHaveBeenCalledOnce();
  });

  it("adds a named sibling to an already automated source", async () => {
    const created = definition({ id: "30000000-0000-4000-8000-000000000002", name: "Reminder" });
    const fixture = automationStore([{ automation: definition() }], { createAutomation: vi.fn().mockResolvedValue(created) });
    render(<AutomationEditor store={fixture.store} threadRegistry={fixture.threadRegistry} threadId={THREAD_ID} />);
    expect(await screen.findByRole("heading", { name: "New automation" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Reminder");
    await user.type(screen.getByRole("textbox", { name: /^Prompt/ }), "Call the dentist");
    const save = screen.getByRole("button", { name: "Save and enable" });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(fixture.api.createAutomation).toHaveBeenCalledWith(THREAD_ID, expect.objectContaining({ name: "Reminder", initialState: "enabled" })));
    expect(fixture.api.updateAutomation).not.toHaveBeenCalled();
    await waitFor(() => expect(window.location.pathname).toBe(`/automations/${created.id}`));
  });

  it("edits the named resource and presents exactly This thread and Fork modes", async () => {
    const fixture = automationStore([{ automation: definition() }]);
    render(<AutomationEditor store={fixture.store} threadRegistry={fixture.threadRegistry} automationId={AUTOMATION_ID} />);
    expect(await screen.findByRole("heading", { name: "Edit automation" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Nightly dependency audit");
    expect(screen.getByRole("radio", { name: /^This thread/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^Fork/ })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Run in" }).querySelectorAll("[role=radio]")).toHaveLength(2);
    expect(fixture.api.getAutomation).toHaveBeenCalledWith(AUTOMATION_ID, expect.any(AbortSignal));
  });

  it("returns to the collection when a successful edit retires the finished one-shot", async () => {
    const fixture = automationStore([{ automation: definition() }], {
      updateAutomation: vi.fn().mockResolvedValue(definition({ revision: 4 })),
    });
    render(<AutomationEditor store={fixture.store} threadRegistry={fixture.threadRegistry} automationId={AUTOMATION_ID} />);
    const name = await screen.findByRole("textbox", { name: "Name" });
    const user = userEvent.setup();
    await user.type(name, " changed");
    fixture.api.getAutomation.mockRejectedValue(new ApiError(404, "not_found", "Automation retired", false));
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeEnabled());
    await user.click(save);
    await waitFor(() => expect(window.location.pathname).toBe(`/threads/${THREAD_ID}/automations`));
    expect(fixture.api.updateAutomation).toHaveBeenCalledOnce();
    expect(fixture.api.getAutomation).toHaveBeenLastCalledWith(AUTOMATION_ID, expect.any(AbortSignal));
    expect(fixture.api.createAutomation).not.toHaveBeenCalled();
  });

  it("discloses draft-only fork support", async () => {
    const fixture = automationStore([{ automation: definition() }], { getThreadAutomationCapability: vi.fn().mockResolvedValue({ available: true, canAttach: true, canRunNow: true, canCloneOnRun: true, forkDraftOnly: true }) });
    render(<AutomationEditor store={fixture.store} threadRegistry={fixture.threadRegistry} threadId={THREAD_ID} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /^Fork/ }));
    expect(screen.getByText(/After this source starts, Fork runs will fail/)).toBeInTheDocument();
  });
  it("keeps dirty fields mounted after a background refresh fails", async () => {
    const fixture = automationStore([{ automation: definition() }]);
    render(<AutomationEditor store={fixture.store} threadRegistry={fixture.threadRegistry} automationId={AUTOMATION_ID} />);
    const name = await screen.findByRole("textbox", { name: "Name" });
    const user = userEvent.setup();
    await user.clear(name); await user.type(name, "Unsaved daily name");
    const prompt = screen.getByRole("textbox", { name: /^Prompt/ });
    await user.type(prompt, " Keep this edit.");
    fixture.api.getAutomation.mockRejectedValue(new Error("Network unavailable"));
    act(() => fixture.invalidate(AUTOMATION_ID));
    await screen.findByText("The automation could not be refreshed");
    expect(screen.getByRole("textbox", { name: "Name" })).toBe(name);
    expect(name).toHaveValue("Unsaved daily name");
    expect((prompt as HTMLTextAreaElement).value).toContain("Keep this edit.");
    fixture.api.getAutomation.mockResolvedValue(definition());
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("The automation could not be refreshed")).not.toBeInTheDocument());
    expect(name).toHaveValue("Unsaved daily name");
  });

  it("keeps dirty fields but prevents saving a definition deleted elsewhere", async () => {
    const fixture = automationStore([{ automation: definition() }]);
    render(<AutomationEditor store={fixture.store} threadRegistry={fixture.threadRegistry} automationId={AUTOMATION_ID} />);
    const name = await screen.findByRole("textbox", { name: "Name" });
    const user = userEvent.setup();
    await user.type(name, " unsaved");
    fixture.api.getAutomation.mockRejectedValue(new ApiError(404, "not_found", "Automation was deleted", false));
    act(() => fixture.invalidate(AUTOMATION_ID));
    await screen.findByText("This automation was deleted");
    expect(name).toHaveValue("Nightly dependency audit unsaved");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(fixture.api.createAutomation).not.toHaveBeenCalled();
    expect(fixture.api.updateAutomation).not.toHaveBeenCalled();
  });

  it("keeps dirty fields after a deletion event without rereading the removed resource", async () => {
    const fixture = automationStore([{ automation: definition() }]);
    render(<AutomationEditor store={fixture.store} threadRegistry={fixture.threadRegistry} automationId={AUTOMATION_ID} />);
    const name = await screen.findByRole("textbox", { name: "Name" });
    const user = userEvent.setup();
    await user.type(name, " unsaved");
    fixture.api.getAutomation.mockResolvedValue(definition({ revision: 4 }));
    act(() => fixture.invalidate(AUTOMATION_ID));
    await screen.findByRole("button", { name: "Reload automation" });
    const reads = fixture.api.getAutomation.mock.calls.length;
    act(() => {
      fixture.invalidate(AUTOMATION_ID, true);
      fixture.invalidateSource(THREAD_ID);
      fixture.invalidate();
    });
    await screen.findByText("This automation was deleted");
    expect(screen.getByRole("textbox", { name: "Name" })).toBe(name);
    expect(name).toHaveValue("Nightly dependency audit unsaved");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Reload automation" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(fixture.api.getAutomation).toHaveBeenCalledTimes(reads);
    expect(fixture.api.updateAutomation).not.toHaveBeenCalled();
  });

  it("keeps an existing Fork editable while explaining its current source limitation", async () => {
    const saved = definition({ runMode: "clone" });
    const fixture = automationStore([{ automation: saved }], {
      getThreadAutomationCapability: vi.fn().mockResolvedValue({ available: false, canAttach: false, canRunNow: false, canCloneOnRun: false }),
      updateAutomation: vi.fn().mockResolvedValue(saved),
    });
    render(<AutomationEditor store={fixture.store} threadRegistry={fixture.threadRegistry} automationId={AUTOMATION_ID} />);
    const name = await screen.findByRole("textbox", { name: "Name" });
    expect(name).toHaveAttribute("maxlength", "160");
    expect(screen.getByText(/You can edit this automation while keeping Fork/)).toBeInTheDocument();
    await userEvent.setup().type(name, " edited");
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.setup().click(save);
    expect(fixture.api.updateAutomation).toHaveBeenCalledWith(AUTOMATION_ID, expect.objectContaining({ runMode: "clone", name: "Nightly dependency audit edited" }));
  });

});
