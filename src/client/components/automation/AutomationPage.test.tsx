// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/ApiClient.js";
import { automationPath, automationsPath, navigate, threadPath } from "../../app/router.js";
import { installThreadPanelOpenRequestListener } from "../../workspace-panels/thread-panel-navigation.js";
import { AutomationPage } from "./AutomationPage.js";
import { useAutomationThreadId } from "./automation-route-thread.js";
import { AUTOMATION_ID, THREAD_ID, automationStore, definition, installAutomationDom, run } from "./automation-test-fixture.js";

beforeEach(installAutomationDom);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); navigate("/", { replace: true }); });
const TITLE = "Checkout flow refactor";
/** The automation and its thread, which is titled apart from it. */
function sourced(overrides: Parameters<typeof definition>[0] = {}) {
  return definition({ source: { ...definition().source, title: TITLE }, ...overrides });
}
function mount(value = definition(), api: Parameters<typeof automationStore>[1] = {}) {
  const fixture = automationStore([{ title: TITLE, automation: value }], api);
  render(<AutomationPage store={fixture.store} threadRegistry={fixture.threadRegistry} automationId={value.id} />);
  return fixture;
}
/** History down to the automation page, from `entries` (the first replaces the current entry). */
function openFrom(...entries: string[]) {
  entries.forEach((entry, index) => navigate(entry, { replace: index === 0 }));
  navigate(automationPath(AUTOMATION_ID));
}
const backLink = () => document.querySelector<HTMLAnchorElement>('[data-slot="settings-page-back"]')!;

describe("automation resource page", () => {
  it("aborts definition and history reads before local Delete without waiting for an event", async () => {
    let finishHistory!: (page: { items: ReturnType<typeof run>[]; nextCursor: null }) => void;
    const list = vi.fn().mockImplementation(() => new Promise((resolve) => { finishHistory = resolve; }));
    const fixture = mount(definition(), { listAutomationRuns: list });
    await screen.findByRole("heading", { name: "Nightly dependency audit" });
    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    let finishDefinition!: (value: ReturnType<typeof definition>) => void;
    fixture.api.getAutomation.mockImplementationOnce(() => new Promise((resolve) => { finishDefinition = resolve; }));
    act(() => fixture.invalidate(AUTOMATION_ID));
    await waitFor(() => expect(fixture.api.getAutomation).toHaveBeenCalledTimes(2));
    const definitionSignal = fixture.api.getAutomation.mock.calls[1]![1] as AbortSignal;
    const historySignal = list.mock.calls[0]![1].signal as AbortSignal;
    fixture.api.deleteAutomation.mockImplementation(async () => {
      expect(definitionSignal.aborted).toBe(true);
      expect(historySignal.aborted).toBe(true);
      fixture.invalidateSource(THREAD_ID);
      fixture.invalidate();
      return { deleted: true };
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "More automation actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete automation…" }));
    await user.click(screen.getByRole("button", { name: "Delete automation" }));
    await waitFor(() => expect(window.location.pathname).toBe("/automations"));
    await act(async () => {
      finishDefinition(definition({ revision: 99 }));
      finishHistory({ items: [run()], nextCursor: null });
    });
    act(() => { fixture.invalidateSource(THREAD_ID); fixture.invalidate(); });
    expect(fixture.api.getAutomation).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledOnce();
    expect(fixture.api.deleteAutomation).toHaveBeenCalledOnce();
  });

  it("consumes a null acknowledgement result as authoritative removal without a probe", async () => {
    const failed = run({ state: "failed" });
    const current = definition({ status: "exhausted", attention: { runId: failed.id, kind: "failed" }, lastRun: failed });
    const fixture = mount(current, { acknowledgeAutomationRun: vi.fn().mockResolvedValue({ run: failed, automation: null }) });
    const button = await screen.findByRole("button", { name: "Acknowledge failure" });
    await userEvent.setup().click(button);
    expect(await screen.findByText("This automation was deleted.")).toBeInTheDocument();
    expect(fixture.api.getAutomation).toHaveBeenCalledOnce();
  });

  it("shows one named resource and scopes history and actions by automation ID", async () => {
    const fixture = mount(definition({ name: "Daily update" }), { runAutomationNow: vi.fn().mockResolvedValue(run()) });
    expect(await screen.findByRole("heading", { name: "Daily update" })).toBeInTheDocument();
    expect(fixture.api.getAutomation).toHaveBeenCalledWith(AUTOMATION_ID, expect.any(AbortSignal));
    await waitFor(() => expect(fixture.api.listAutomationRuns).toHaveBeenCalledWith(AUTOMATION_ID, expect.objectContaining({ filter: "all" })));
    await userEvent.setup().click(screen.getByRole("button", { name: "Run now" }));
    expect(fixture.api.runAutomationNow).toHaveBeenCalledWith(AUTOMATION_ID, expect.any(String));
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
    const fixture = mount(current, { acknowledgeAutomationRun: acknowledge });
    expect(await screen.findByText("Daily update failed")).toBeInTheDocument();
    fixture.api.getAutomation.mockResolvedValue(definition({ lastRun: skipped }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Acknowledge failure" }));
    expect(acknowledge).toHaveBeenCalledWith(AUTOMATION_ID, failed.id);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Acknowledge failure" })).not.toBeInTheDocument());
  });

  it.each([false, true])("does not restore a one-shot retired by Pause (deletion arrived first: %s)", async (deletionArrivesFirst) => {
    const current = definition({
      scheduleKind: "date_time", schedule: { kind: "date_time", runAt: "2026-10-01T12:00:00.000Z" },
      misfirePolicy: null, nextRunAt: undefined,
      lastRun: run({ state: "deferred", occurrence: "manual" }),
    });
    let finishPause!: (value: ReturnType<typeof definition>) => void;
    const pause = vi.fn().mockImplementation(() => new Promise((resolve) => { finishPause = resolve; }));
    const fixture = mount(current, { setAutomationState: pause });
    const button = await screen.findByRole("button", { name: "Pause automation" });
    await userEvent.setup().click(button);
    expect(pause).toHaveBeenCalledWith(AUTOMATION_ID, "pause", current.revision, expect.any(String));
    fixture.api.getAutomation.mockRejectedValue(new ApiError(404, "not_found", "This automation was retired", false));
    if (deletionArrivesFirst) {
      act(() => fixture.invalidate(AUTOMATION_ID));
      await screen.findByText("This automation was retired");
    }
    await act(async () => finishPause({ ...current, status: "paused", revision: current.revision + 1 }));
    expect(await screen.findByText("This automation was retired")).toBeInTheDocument();
    await waitFor(() => expect(fixture.api.getAutomation).toHaveBeenCalledTimes(deletionArrivesFirst ? 3 : 2));
    expect(screen.queryByRole("heading", { name: current.name })).toBeNull();
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


  it("shows Fork for a run mode that forks, as the editor names it", async () => {
    mount(definition({ runMode: "clone" }));
    expect(await screen.findByText("Fork")).toBeInTheDocument();
  });

  it("pauses and enables with circle glyphs, apart from Run now's play", async () => {
    mount();
    const pause = await screen.findByRole("button", { name: "Pause automation" });
    expect(pause.querySelector(".lucide-circle-pause")).not.toBeNull();
    cleanup();
    mount(definition({ status: "paused" }));
    const enable = await screen.findByRole("button", { name: "Enable automation" });
    expect(enable.querySelector(".lucide-circle-play")).not.toBeNull();
    expect(enable.querySelector(".lucide-play")).toBeNull();
  });
});

describe("automation page navigation", () => {
  it("leads back to the list it was opened from, by one link that names it", async () => {
    openFrom(automationsPath(THREAD_ID));
    mount(sourced());
    await screen.findByRole("heading", { name: "Nightly dependency audit" });
    expect(document.querySelectorAll('[data-slot="settings-page-back"]')).toHaveLength(1);
    expect(screen.queryByRole("navigation", { name: "Automation navigation" })).toBeNull();
    expect(backLink()).toHaveTextContent("Automations");
    expect(backLink()).toHaveAttribute("href", automationsPath(THREAD_ID));
    const length = window.history.length;
    fireEvent.click(backLink());
    await waitFor(() => expect(window.location.pathname).toBe(automationsPath(THREAD_ID)));
    expect(window.history.length).toBe(length);
  });

  it("leads back to every automation when opened from there", async () => {
    openFrom(threadPath(THREAD_ID), automationsPath());
    mount(sourced());
    await screen.findByRole("heading", { name: "Nightly dependency audit" });
    expect(backLink()).toHaveTextContent("Automations");
    expect(backLink()).toHaveAttribute("href", "/automations");
    fireEvent.click(backLink());
    await waitFor(() => expect(window.location.pathname).toBe("/automations"));
  });

  it("names the thread when opened from it, as from a transcript notice", async () => {
    openFrom(threadPath(THREAD_ID));
    mount(sourced());
    await screen.findByRole("heading", { name: "Nightly dependency audit" });
    expect(backLink()).toHaveTextContent(TITLE);
    expect(backLink()).toHaveAttribute("href", threadPath(THREAD_ID));
    fireEvent.click(backLink());
    await waitFor(() => expect(window.location.pathname).toBe(threadPath(THREAD_ID)));
  });

  it("goes up to the thread's list in place of a page opened from elsewhere", async () => {
    openFrom("/settings/general");
    mount(sourced());
    await screen.findByRole("heading", { name: "Nightly dependency audit" });
    expect(backLink()).toHaveTextContent("Automations");
    const length = window.history.length;
    fireEvent.click(backLink());
    expect(window.location.pathname).toBe(automationsPath(THREAD_ID));
    expect(window.history.length).toBe(length);
  });

  it("goes where its link does on Escape, after an open menu takes its own", async () => {
    openFrom(automationsPath(THREAD_ID));
    mount(sourced());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "More automation actions" }));
    await screen.findByRole("menuitem", { name: "Open thread" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(window.location.pathname).toBe(automationPath(AUTOMATION_ID));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(window.location.pathname).toBe(automationsPath(THREAD_ID)));
  });

  it("names its thread in the meta line, a link that walks back to the thread it came down from", async () => {
    openFrom(threadPath(THREAD_ID), automationsPath(THREAD_ID));
    mount(sourced());
    const link = await screen.findByRole("link", { name: TITLE });
    expect(link.closest(".automation-page-meta")).not.toBeNull();
    expect(link.parentElement).toHaveTextContent(`In ${TITLE}`);
    expect(link).toHaveAttribute("href", threadPath(THREAD_ID));
    const length = window.history.length;
    fireEvent.click(link);
    await waitFor(() => expect(window.location.pathname).toBe(threadPath(THREAD_ID)));
    expect(window.history.length).toBe(length);
  });

  it("opens the thread from ⋯ with its Chat in front when history did not come from it", async () => {
    openFrom(automationsPath());
    mount(sourced());
    const requests: string[] = [];
    const stop = installThreadPanelOpenRequestListener(window, (request) => requests.push(request.threadId));
    try {
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "More automation actions" }));
      const menu = await screen.findByRole("menu");
      const items = within(menu).getAllByRole("menuitem").map((item) => item.textContent);
      expect(items).toEqual(["Open thread", "Delete automation…"]);
      const length = window.history.length;
      await user.click(within(menu).getByRole("menuitem", { name: "Open thread" }));
      expect(window.location.pathname).toBe(threadPath(THREAD_ID));
      expect(window.history.length).toBe(length + 1);
      expect(requests).toEqual([THREAD_ID]);
    } finally { stop(); }
  });

  it("opens a failed run's thread from its callout through the same way", async () => {
    openFrom(threadPath(THREAD_ID));
    const failed = run({ state: "failed" });
    mount(sourced({ lastRun: failed, attention: { runId: failed.id, kind: "failed", diagnostic: "Daily update failed" } }));
    await screen.findByText("Daily update failed");
    const length = window.history.length;
    await userEvent.setup().click(screen.getByRole("button", { name: "Open thread" }));
    await waitFor(() => expect(window.location.pathname).toBe(threadPath(THREAD_ID)));
    expect(window.history.length).toBe(length);
  });

  it("returns to the list it was opened from after a delete, past its editor", async () => {
    openFrom(automationsPath(THREAD_ID), automationPath(AUTOMATION_ID), `${automationPath(AUTOMATION_ID)}/edit`);
    const fixture = mount(sourced());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "More automation actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete automation…" }));
    const length = window.history.length;
    await user.click(within(await screen.findByRole("dialog", { name: "Delete this automation?" })).getByRole("button", { name: "Delete automation" }));
    expect(fixture.api.deleteAutomation).toHaveBeenCalledWith(AUTOMATION_ID, 3, expect.any(String));
    await waitFor(() => expect(window.location.pathname).toBe(automationsPath(THREAD_ID)));
    expect(window.history.length).toBe(length);
  });

  it("replaces itself with the thread's list after a delete when no list lies behind it", async () => {
    openFrom(threadPath(THREAD_ID));
    mount(sourced());
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "More automation actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete automation…" }));
    const length = window.history.length;
    await user.click(within(await screen.findByRole("dialog", { name: "Delete this automation?" })).getByRole("button", { name: "Delete automation" }));
    await waitFor(() => expect(window.location.pathname).toBe(automationsPath(THREAD_ID)));
    expect(window.history.length).toBe(length);
  });

  it("tells the shell its thread once loaded, so the sidebar keeps it selected", async () => {
    const id = "30000000-0000-4000-8000-0000000000aa";
    const selected = renderHook(() => useAutomationThreadId(id));
    expect(selected.result.current).toBeUndefined();
    mount(sourced({ id }));
    await screen.findByRole("heading", { name: "Nightly dependency audit" });
    expect(selected.result.current).toBe(THREAD_ID);
  });
});

describe("automation page states", () => {
  it("keeps the page frame and its way up while the automation loads", () => {
    openFrom(automationsPath());
    mount(sourced(), { getAutomation: vi.fn(() => new Promise(() => undefined)) });
    const frame = screen.getByRole("region", { name: "Automation" });
    expect(frame).toHaveClass("automations-view");
    expect(within(frame).getByRole("status", { name: "Loading automation" })).toBeInTheDocument();
    expect(backLink()).toHaveTextContent("Automations");
    expect(backLink()).toHaveAttribute("href", "/automations");
  });

  it("says a missing automation was deleted, with a way to every automation", async () => {
    openFrom(threadPath(THREAD_ID));
    mount(sourced(), { getAutomation: vi.fn().mockRejectedValue(new ApiError(404, "not_found", "Automation was not found", false)) });
    expect(await screen.findByText("This automation was deleted")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't open this thread")).toBeNull();
    expect(screen.getByRole("region", { name: "Automation" })).toHaveClass("automations-view");
    // The thread is not known: up goes to every automation, in its place.
    expect(backLink()).toHaveTextContent("Automations");
    await userEvent.setup().click(screen.getByRole("button", { name: "All automations" }));
    expect(window.location.pathname).toBe("/automations");
  });

  it("names an automation it couldn't load apart from a thread it couldn't open", async () => {
    mount(sourced(), { getAutomation: vi.fn().mockRejectedValue(new Error("Network unavailable")) });
    expect(await screen.findByText("Couldn't open this automation")).toBeInTheDocument();
    expect(screen.getByText("Network unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("keeps its way up, named for the thread, when the thread can't be opened", async () => {
    openFrom(threadPath(THREAD_ID));
    const value = sourced();
    const fixture = automationStore([], { getAutomation: vi.fn().mockResolvedValue(value) });
    render(<AutomationPage store={fixture.store} threadRegistry={fixture.threadRegistry} automationId={value.id} />);
    await waitFor(() => expect(fixture.threadRegistry.retain).toHaveBeenCalledWith(THREAD_ID));
    act(() => fixture.threadRegistry.settle({ error: "Thread is gone" }));
    expect(await screen.findByText("Couldn't open this thread")).toBeInTheDocument();
    expect(backLink()).toHaveTextContent(TITLE);
  });
});
