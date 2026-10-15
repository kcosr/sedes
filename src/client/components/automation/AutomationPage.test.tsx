// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationPage } from "./AutomationPage.js";
import { AUTOMATION_ID, THREAD_ID, automationStore, definition, installAutomationDom, run } from "./automation-test-fixture.js";

beforeEach(installAutomationDom);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(value = definition(), api: Parameters<typeof automationStore>[1] = {}) {
  const fixture = automationStore([{ automation: value }], api);
  render(<AutomationPage store={fixture.store} threadRegistry={fixture.threadRegistry} automationId={value.id} />);
  return fixture;
}

describe("automation resource page", () => {
  it("shows one named resource and scopes history and actions by automation ID", async () => {
    const fixture = mount(definition({ name: "Daily update" }), { runAutomationNow: vi.fn().mockResolvedValue(run()) });
    expect(await screen.findByRole("heading", { name: "Daily update" })).toBeInTheDocument();
    expect(fixture.api.getAutomation).toHaveBeenCalledWith(AUTOMATION_ID, expect.any(AbortSignal));
    await waitFor(() => expect(fixture.api.listAutomationRuns).toHaveBeenCalledWith(AUTOMATION_ID, expect.objectContaining({ filter: "all" })));
    await userEvent.setup().click(screen.getByRole("button", { name: "Run now" }));
    expect(fixture.api.runAutomationNow).toHaveBeenCalledWith(AUTOMATION_ID, expect.any(String));
    expect(screen.getByRole("link", { name: "Open thread" })).toHaveAttribute("href", `/threads/${THREAD_ID}`);
    expect(screen.getByRole("link", { name: "Thread automations" })).toHaveAttribute("href", `/threads/${THREAD_ID}/automations`);
  });

  it("retries an ambiguous manual request with the same mutation identity", async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValueOnce(run());
    mount(definition(), { runAutomationNow: invoke });
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "Run now" });
    await user.click(button);
    await screen.findByText("Connection lost");
    await user.click(button);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(invoke.mock.calls[0]![1]).toBe(invoke.mock.calls[1]![1]);
  });

  it("retains exhausted one-shots and their run history", async () => {
    const delivered = run();
    const fixture = mount(definition({ name: "Dentist reminder", status: "exhausted", nextRunAt: undefined, scheduleKind: "date_time", schedule: { kind: "date_time", runAt: "2026-10-01T12:00:00.000Z" }, misfirePolicy: null, lastRun: delivered }), { listAutomationRuns: vi.fn().mockResolvedValue({ items: [delivered], nextCursor: null, counts: { all: 1, problems: 0, skipped: 0 } }) });
    expect(await screen.findByRole("heading", { name: "Dentist reminder" })).toBeInTheDocument();
    expect(screen.getByText("Finished")).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Runs, newest first" })).toBeInTheDocument();
    expect(fixture.api.listAutomationRuns).toHaveBeenCalledWith(AUTOMATION_ID, expect.anything());
    expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled();
  });

  it("acknowledges the actual failure even after a newer skipped run", async () => {
    const failed = run({ state: "failed" });
    const skipped = run({ state: "skipped" });
    const current = definition({ lastRun: skipped, attention: { runId: failed.id, kind: "failed", diagnostic: "Daily update failed" } });
    const acknowledge = vi.fn().mockResolvedValue({ run: { ...failed, acknowledgedAt: new Date().toISOString() }, automation: definition({ lastRun: skipped }) });
    mount(current, { acknowledgeAutomationRun: acknowledge });
    expect(await screen.findByText("Daily update failed")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Acknowledge failure" }));
    expect(acknowledge).toHaveBeenCalledWith(AUTOMATION_ID, failed.id);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Acknowledge failure" })).not.toBeInTheDocument());
  });

  it("refreshes only the selected resource and keeps the source title separate", async () => {
    const fixture = mount();
    await screen.findByRole("heading", { name: "Nightly dependency audit" });
    fixture.api.getAutomation.mockResolvedValue(definition({ name: "Renamed automation", revision: 4 }));
    act(() => fixture.invalidate("30000000-0000-4000-8000-000000000002"));
    expect(fixture.api.getAutomation).toHaveBeenCalledOnce();
    act(() => fixture.invalidate(AUTOMATION_ID));
    expect(await screen.findByRole("heading", { name: "Renamed automation" })).toBeInTheDocument();
  });

  it("loads an unloaded source by its real thread ID after resolving a resource deep link", async () => {
    const value = definition({ threadId: "10000000-0000-4000-8000-000000000009" });
    const fixture = automationStore([], { getAutomation: vi.fn().mockResolvedValue(value) });
    render(<AutomationPage store={fixture.store} threadRegistry={fixture.threadRegistry} automationId={value.id} />);
    await waitFor(() => expect(fixture.threadRegistry.retain).toHaveBeenCalledWith(value.threadId));
    act(() => fixture.threadRegistry.settle({ thread: { id: value.threadId, title: "Unloaded fork", automation: value } }));
    expect(await screen.findByRole("heading", { name: value.name })).toBeInTheDocument();
  });
  it("explains that a snoozed one-time reminder waits instead of being skipped", async () => {
    const value = definition({ scheduleKind: "date_time", schedule: { kind: "date_time", runAt: "2099-01-01T12:00:00.000Z" }, misfirePolicy: null });
    const fixture = automationStore([{ inventoryState: "snoozed", snoozedUntil: "2099-01-02T12:00:00.000Z", automation: value }]);
    render(<AutomationPage store={fixture.store} threadRegistry={fixture.threadRegistry} automationId={value.id} />);
    expect(await screen.findByText(/a one-time reminder still runs once/)).toBeInTheDocument();
    expect(screen.queryByText(/Scheduled runs are skipped/)).not.toBeInTheDocument();
  });

});
