// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automationsPath, navigate, threadPath } from "../../app/router.js";
import { setSidebarInventoryScope } from "../../app/sidebar-view-store.js";
import { setAutomationGroupCollapsed } from "../../automation/automations-view-preferences.js";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { AutomationsView } from "./AutomationsView.js";
import { AUTOMATION_ID, THREAD_ID, automationStore, definition, installAutomationDom, type AutomationStore } from "./automation-test-fixture.js";

beforeEach(installAutomationDom);
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); localStorage.clear();
  // Drops the cached sidebar Scope and list preferences with the storage.
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
});
const otherId = "30000000-0000-4000-8000-000000000002";
const thirdId = "30000000-0000-4000-8000-000000000003";

function renderList(fixture: AutomationStore, threadId?: string, store: ApplicationClientStore = fixture.store) {
  return render(<AutomationsView store={store} threadRegistry={fixture.threadRegistry} threadId={threadId} />);
}

/** The fixture's store with a second, empty project for the sidebar Scope. */
function withBillingProject(fixture: AutomationStore): ApplicationClientStore {
  const state = fixture.store.getSnapshot();
  const scoped = { ...state, snapshot: { ...state.snapshot!, projects: [...state.snapshot!.projects, { id: "project-2", name: "billing-service" }] } };
  return { ...(fixture.store as object), getSnapshot: () => scoped } as unknown as ApplicationClientStore;
}

const wideMeta = (row: HTMLElement) => row.querySelector('[data-layout="wide"]');
const narrowMeta = (row: HTMLElement) => row.querySelector('[data-layout="narrow"]');

describe("automation collections", () => {
  it("reads all pages and shows two independent names from one unloaded source", async () => {
    const first = definition({ name: "Daily update" });
    const second = definition({ id: otherId, name: "Call dentist" });
    const list = vi.fn().mockResolvedValueOnce({ items: [first], nextCursor: "next" }).mockResolvedValueOnce({ items: [second], nextCursor: null });
    const fixture = automationStore([], { listAutomations: list });
    renderList(fixture);
    expect(await screen.findByRole("link", { name: "Daily update" })).toHaveAttribute("href", `/automations/${AUTOMATION_ID}`);
    expect(screen.getByRole("link", { name: "Call dentist" })).toHaveAttribute("href", `/automations/${otherId}`);
    expect(screen.getAllByTestId("automation-row")).toHaveLength(2);
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "next" }));
  });

  it("names each row's thread, project and backend, with Open thread in ⋯", async () => {
    const fixture = automationStore([{ title: "Checkout flow refactor", automation: definition() }]);
    renderList(fixture);
    const row = await screen.findByTestId("automation-row");
    expect(wideMeta(row)).toHaveTextContent(/^Checkout flow refactor · Every day at 2:00 AM UTC · acme-web · Pi SDK$/u);
    expect(narrowMeta(row)).toHaveTextContent(/^Checkout flow refactor · Every day at 2:00 AM UTC$/u);
    await userEvent.setup().click(within(row).getByRole("button", { name: "Actions for Nightly dependency audit" }));
    expect(await screen.findByRole("menuitem", { name: "Open thread" })).toBeInTheDocument();
  });

  it("targets row controls at the selected automation and preserves its sibling", async () => {
    const first = definition({ name: "Daily update" });
    const second = definition({ id: otherId, name: "Call dentist" });
    const pause = vi.fn().mockResolvedValue({ ...second, status: "paused" });
    const fixture = automationStore([], { listAutomations: vi.fn().mockResolvedValue({ items: [first, second], nextCursor: null }), setAutomationState: pause });
    renderList(fixture);
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
    renderList(fixture);
    await screen.findByRole("link", { name: "Daily update" });
    await userEvent.setup().type(screen.getByRole("searchbox", { name: "Search automations" }), "weather");
    expect(screen.getByRole("link", { name: "Daily update" })).toBeInTheDocument();
    act(() => fixture.invalidate(otherId));
    await waitFor(() => expect(fixture.api.listAutomations).toHaveBeenCalledTimes(2));
  });

  it("keeps exhausted reminders in the collapsed Finished group", async () => {
    const fixture = automationStore([], { listAutomations: vi.fn().mockResolvedValue({ items: [definition({ name: "Completed reminder", status: "exhausted", nextRunAt: undefined })], nextCursor: null }) });
    renderList(fixture);
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
    renderList(fixture);
    await screen.findByRole("link", { name: "Daily update" });
    act(() => fixture.invalidateSource(THREAD_ID));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("link", { name: "Daily update" })).toHaveTextContent("Changed source"));
  });

  it("shows placeholder rows and no count until the first load, and an outline Retry after a failure", async () => {
    let fail!: (reason: unknown) => void;
    const list = vi.fn()
      .mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue({ items: [definition()], nextCursor: null });
    const fixture = automationStore([], { listAutomations: list });
    renderList(fixture);
    expect(screen.getByRole("status", { name: "Loading automations" })).toBeInTheDocument();
    expect(screen.queryByTestId("automations-count")).not.toBeInTheDocument();
    await act(async () => fail(new Error("The server is unavailable.")));
    expect(await screen.findByText("The server is unavailable.")).toBeInTheDocument();
    // A failed load says nothing about the collection.
    expect(screen.queryByRole("status", { name: "Loading automations" })).not.toBeInTheDocument();
    expect(screen.queryByText("No automations yet")).not.toBeInTheDocument();
    expect(screen.queryByTestId("automations-count")).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveAttribute("data-variant", "outline");
    expect(retry).toHaveAttribute("data-size", "sm");
    await userEvent.setup().click(retry);
    expect(await screen.findByRole("link", { name: "Nightly dependency audit" })).toBeInTheDocument();
    expect(screen.getByTestId("automations-count")).toHaveTextContent(/^1\s*automations$/u);
  });
});

describe("a thread's automations", () => {
  it("names the thread in a back link that goes up to it, instead of Open thread", async () => {
    navigate(automationsPath(THREAD_ID));
    const fixture = automationStore([{ title: "Checkout flow refactor", automation: definition() }]);
    renderList(fixture, THREAD_ID);
    const back = screen.getByRole("link", { name: "Checkout flow refactor" });
    expect(back).toHaveAttribute("href", `/threads/${THREAD_ID}`);
    await screen.findByTestId("automation-row");
    expect(screen.getByRole("heading", { level: 1, name: "Automations" })).toBeInTheDocument();
    expect(screen.getByTestId("automations-count")).toHaveTextContent(/^1\s*automations$/u);
    expect(screen.queryByRole("button", { name: "Open thread" })).not.toBeInTheDocument();
    // The application store holds the thread, so no thread store is loaded.
    expect(fixture.threadRegistry.retain).not.toHaveBeenCalled();
    await userEvent.setup().click(back);
    await waitFor(() => expect(window.location.pathname).toBe(`/threads/${THREAD_ID}`));
  });

  it("ignores the sidebar Scope and has no search, View options or status line", async () => {
    setSidebarInventoryScope({ projectFilterId: "project-2" });
    const fixture = automationStore([{ title: "Checkout flow refactor", automation: definition() }]);
    const store = withBillingProject(fixture);
    // The global list honours the Scope, which leaves out this thread.
    renderList(fixture, undefined, store);
    expect(await screen.findByText(/^No automations in /u)).toBeInTheDocument();
    cleanup();

    renderList(fixture, THREAD_ID, store);
    expect(await screen.findByRole("link", { name: "Nightly dependency audit" })).toBeInTheDocument();
    expect(screen.getByTestId("automations-count")).toHaveTextContent(/^1\s*automations$/u);
    expect(screen.queryByText(/^No automations in /u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Scope:/u)).not.toBeInTheDocument();
    expect(screen.queryByText("All projects")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear scope" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("automations-status")).not.toBeInTheDocument();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View options" })).not.toBeInTheDocument();
  });

  it("leaves the thread, project and backend out of rows and Open thread out of ⋯", async () => {
    const fixture = automationStore([{ title: "Checkout flow refactor", automation: definition() }]);
    renderList(fixture, THREAD_ID);
    const row = await screen.findByTestId("automation-row");
    expect(wideMeta(row)).toHaveTextContent(/^Every day at 2:00 AM UTC$/u);
    expect(narrowMeta(row)).toHaveTextContent(/^Every day at 2:00 AM UTC$/u);
    for (const repeated of ["Checkout flow refactor", "acme-web", "Pi SDK"]) expect(row).not.toHaveTextContent(repeated);
    await userEvent.setup().click(within(row).getByRole("button", { name: "Actions for Nightly dependency audit" }));
    expect(await screen.findByRole("menuitem", { name: /^Edit/u })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Open thread" })).not.toBeInTheDocument();
  });

  it("lists every automation flat, in status order", async () => {
    const finished = definition({ name: "Afternoon reminder", status: "exhausted", nextRunAt: undefined });
    const paused = definition({ id: otherId, name: "Weekly release notes", status: "paused", nextRunAt: undefined });
    const upcoming = definition({ id: thirdId, name: "Nightly dependency audit" });
    const fixture = automationStore([{ title: "Checkout flow refactor", automation: upcoming }], {
      listAutomations: vi.fn().mockResolvedValue({ items: [finished, paused, upcoming], nextCursor: null }),
    });
    renderList(fixture, THREAD_ID);
    await screen.findByRole("link", { name: "Afternoon reminder" });
    expect(screen.getAllByTestId("automation-row").map((row) => row.dataset.automationId)).toEqual([thirdId, otherId, AUTOMATION_ID]);
    expect(screen.queryAllByTestId("automations-group")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Finished/u })).not.toBeInTheDocument();
  });

  it("shows a snoozed thread's suspended automations whatever the global list collapsed", async () => {
    setAutomationGroupCollapsed("status:suspended", true);
    const fixture = automationStore([{ title: "Checkout flow refactor", inventoryState: "snoozed", automation: definition() }], {
      listAutomations: vi.fn().mockResolvedValue({ items: [definition(), definition({ id: otherId, name: "Weekly release notes" })], nextCursor: null }),
    });
    renderList(fixture, THREAD_ID);
    const rows = await screen.findAllByTestId("automation-row");
    expect(rows.map((row) => row.dataset.group)).toEqual(["suspended", "suspended"]);
    expect(screen.getByRole("link", { name: "Weekly release notes" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Suspended/u })).not.toBeInTheDocument();
  });

  it("puts an outline Add automation last in the header", async () => {
    const fixture = automationStore([{ title: "Checkout flow refactor", automation: definition() }]);
    renderList(fixture, THREAD_ID);
    await screen.findByTestId("automation-row");
    const add = screen.getByRole("button", { name: "Add automation" });
    expect(add).toHaveAttribute("data-variant", "outline");
    expect(add).toHaveAttribute("data-size", "default");
    expect(add.closest("header")?.lastElementChild).toBe(add);
    await userEvent.setup().click(add);
    expect(window.location.pathname).toBe(`/threads/${THREAD_ID}/automations/new`);
    expect(fixture.api.listAutomations).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD_ID }));
  });

  it("offers Add automation in the empty state when the thread has none", async () => {
    const fixture = automationStore([{ title: "Spike: GraphQL gateway", automation: null }]);
    renderList(fixture, THREAD_ID);
    expect(await screen.findByText("No automations on this thread")).toBeInTheDocument();
    expect(screen.getByText("Send this thread a prompt on a schedule.")).toBeInTheDocument();
    expect(screen.getByTestId("automations-count")).toHaveTextContent(/^0\s*automations$/u);
    // The header has no second one.
    const [add, ...others] = screen.getAllByRole("button", { name: "Add automation" });
    expect(others).toHaveLength(0);
    expect(add).toHaveAttribute("data-variant", "default");
    expect(add!.closest('[data-slot="empty-state"]')).not.toBeNull();
  });

  it("goes up to its thread on Escape; the global list has no way up", async () => {
    const fixture = automationStore([{ title: "Checkout flow refactor", automation: null }], {
      listAutomations: vi.fn().mockResolvedValue({ items: [definition()], nextCursor: null }),
    });
    navigate(threadPath(THREAD_ID));
    navigate(automationsPath(THREAD_ID));
    const view = renderList(fixture, THREAD_ID);
    await screen.findByRole("link", { name: "Checkout flow refactor" });
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(window.location.pathname).toBe(threadPath(THREAD_ID)));
    view.unmount();
    navigate(automationsPath());
    renderList(fixture);
    await screen.findByRole("heading", { name: /Automations/ });
    await user.keyboard("{Escape}");
    expect(window.location.pathname).toBe(automationsPath());
  });

  it("names a thread the application store lacks from its automations, then from its own load", async () => {
    const archived = definition({ source: { ...definition().source, title: "Archived checkout", inventoryState: "archived" } });
    const fixture = automationStore([], { listAutomations: vi.fn().mockResolvedValue({ items: [archived], nextCursor: null }) });
    renderList(fixture, THREAD_ID);
    expect(screen.getByRole("link", { name: "Thread" })).toHaveAttribute("href", `/threads/${THREAD_ID}`);
    expect(await screen.findByRole("link", { name: "Archived checkout" })).toBeInTheDocument();
    expect(fixture.threadRegistry.retain).toHaveBeenCalledWith(THREAD_ID);
    act(() => fixture.threadRegistry.settle({ thread: { title: "Checkout flow refactor", inventoryState: "archived", automation: null } }));
    expect(await screen.findByRole("link", { name: "Checkout flow refactor" })).toHaveAttribute("href", `/threads/${THREAD_ID}`);
  });
});
