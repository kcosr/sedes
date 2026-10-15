// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationsView } from "./AutomationsView.js";
import { AUTOMATION_ID, THREAD_ID, automationStore, definition, installAutomationDom } from "./automation-test-fixture.js";

beforeEach(installAutomationDom);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
const otherId = "30000000-0000-4000-8000-000000000002";

describe("automation collections", () => {
  it("reads all pages and shows two independent names from one unloaded source", async () => {
    const first = definition({ name: "Daily update" });
    const second = definition({ id: otherId, name: "Call dentist" });
    const list = vi.fn().mockResolvedValueOnce({ items: [first], nextCursor: "next" }).mockResolvedValueOnce({ items: [second], nextCursor: null });
    const fixture = automationStore([], { listAutomations: list });
    render(<AutomationsView store={fixture.store} />);
    expect(await screen.findByRole("link", { name: "Daily update" })).toHaveAttribute("href", `/automations/${AUTOMATION_ID}`);
    expect(screen.getByRole("link", { name: "Call dentist" })).toHaveAttribute("href", `/automations/${otherId}`);
    expect(screen.getAllByTestId("automation-row")).toHaveLength(2);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "next" }));
  });

  it("thread collection always offers Add automation even with existing siblings", async () => {
    const fixture = automationStore([{ automation: definition() }]);
    render(<AutomationsView store={fixture.store} threadId={THREAD_ID} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add automation" }));
    expect(window.location.pathname).toBe(`/threads/${THREAD_ID}/automations/new`);
    expect(fixture.api.listAutomations).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD_ID }));
  });

  it("targets row controls at the selected automation and preserves its sibling", async () => {
    const first = definition({ name: "Daily update" });
    const second = definition({ id: otherId, name: "Call dentist" });
    const pause = vi.fn().mockResolvedValue({ ...second, status: "paused" });
    const fixture = automationStore([], { listAutomations: vi.fn().mockResolvedValue({ items: [first, second], nextCursor: null }), setAutomationState: pause });
    render(<AutomationsView store={fixture.store} />);
    await screen.findByRole("link", { name: "Call dentist" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Actions for Call dentist" }));
    await user.click(await screen.findByRole("menuitem", { name: /^Pause/ }));
    expect(pause).toHaveBeenCalledWith(otherId, "pause", 3, expect.any(String));
    expect(screen.getByRole("link", { name: "Daily update" })).toBeInTheDocument();
  });

  it("searches names, prompts and source titles and refreshes from collection invalidations", async () => {
    const first = definition({ name: "Daily update", prompt: "Weather and news" });
    const fixture = automationStore([], { listAutomations: vi.fn().mockResolvedValue({ items: [first], nextCursor: null }) });
    render(<AutomationsView store={fixture.store} />);
    await screen.findByRole("link", { name: "Daily update" });
    await userEvent.setup().type(screen.getByRole("searchbox", { name: "Search automations" }), "weather");
    expect(screen.getByRole("link", { name: "Daily update" })).toBeInTheDocument();
    act(() => fixture.invalidate(otherId));
    await waitFor(() => expect(fixture.api.listAutomations).toHaveBeenCalledTimes(2));
  });

  it("keeps exhausted reminders in the collapsed Finished group", async () => {
    const fixture = automationStore([], { listAutomations: vi.fn().mockResolvedValue({ items: [definition({ name: "Completed reminder", status: "exhausted", nextRunAt: undefined })], nextCursor: null }) });
    render(<AutomationsView store={fixture.store} />);
    const group = await screen.findByRole("button", { name: /Finished/ });
    expect(group).toHaveAttribute("aria-expanded", "false");
    await userEvent.setup().click(group);
    expect(screen.getByRole("link", { name: "Completed reminder" })).toBeInTheDocument();
  });
  it("refreshes an unloaded source when its thread summary changes", async () => {
    const value = definition({ name: "Daily update" });
    const list = vi.fn().mockResolvedValueOnce({ items: [value], nextCursor: null })
      .mockResolvedValue({ items: [{ ...value, source: { ...value.source, title: "Changed source" } }], nextCursor: null });
    const fixture = automationStore([], { listAutomations: list });
    render(<AutomationsView store={fixture.store} />);
    await screen.findByRole("link", { name: "Daily update" });
    act(() => fixture.invalidateSource(THREAD_ID));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("link", { name: "Daily update" })).toHaveTextContent("Changed source"));
  });

});
