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

});
