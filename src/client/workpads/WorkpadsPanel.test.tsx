// @vitest-environment jsdom
import { useSyncExternalStore, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { ApiError } from "../api/ApiClient.js";
import * as markdownChecklists from "../components/conversation/markdown-checklists.js";
import type { Workpad, WorkpadCounts, WorkpadDraft, WorkpadRevision, WorkpadSummary } from "../../shared/protocol/workpads.js";
import { WorkpadsPanel } from "./WorkpadsPanel.js";
import { workpadsTenant } from "./workpads-tenant.js";
import type { WorkspacePanelContext, WorkspacePanelHost } from "../workspace-panels/registry.js";
import { CLOSE_WORKPAD_EVENT } from "../app/android-back.js";
import { getWorkpadsPanelPreferences, setWorkpadsLastView, setWorkpadsViewOptions } from "../app/workpads-panel-store.js";
import { PanelChrome, type PanelChromeStatus } from "../workspace-panels/PanelChrome.js";
import { StablePaneSlot } from "../workspace-panels/StablePaneSlot.js";
import { installNavigationBlocker, navigate } from "../app/router.js";
const author = { kind: "user" as const, threadId: null, clientId: null, name: "You", nameSnapshot: "You" };
const time = "2026-09-08T00:00:00.000Z";
const pad: Workpad = { id: "pad", title: "Integration", scope: { kind: "global" }, revision: 1, content: "Original", attribution: [], author, archivedAt: null, createdAt: time, updatedAt: time };
const revision: WorkpadRevision = { ...pad, workpadId: pad.id, changes: [] };
const initialDraft: WorkpadDraft = { workpadId: pad.id, revision: 0, baseRevision: 1, content: pad.content, updatedAt: time };
const viewCounts = (value: Partial<WorkpadCounts["active"]> = {}): WorkpadCounts["active"] => ({ thread: null, project: null, projectWithThreads: null, global: 0, all: 0, ...value });
const noCounts: WorkpadCounts = { active: viewCounts(), archived: viewCounts() };
function fixture(overrides: Record<string, unknown> = {}) {
  let savedDraft = initialDraft;
  const api = {
    listWorkpads: vi.fn(async (_request?: Record<string, unknown>): Promise<{ items: WorkpadSummary[]; nextCursor?: string }> => ({ items: [pad] })),
    getWorkpadCounts: vi.fn(async (_request?: { threadId?: string; projectId?: string }): Promise<WorkpadCounts> => noCounts),
    getWorkpad: vi.fn(async () => pad),
    getWorkpadRevision: vi.fn(async () => revision),
    listWorkpadRevisions: vi.fn(async (_id: string, _cursor?: string): Promise<{ items: WorkpadRevision[]; nextCursor?: string }> => ({ items: [revision] })),
    getWorkpadDraft: vi.fn(async () => savedDraft),
    saveWorkpadDraft: vi.fn(async (_id: string, value: { expectedRevision: number; baseRevision: number; content: string }) => { savedDraft = { ...savedDraft, ...value, revision: value.expectedRevision + 1 }; return savedDraft; }),
    commitWorkpadDraft: vi.fn(async () => ({ workpad: { ...pad, revision: 2 }, draft: { ...savedDraft, revision: 2 } })),
    updateWorkpad: vi.fn(async (_id: string, _change: object) => ({ ...pad, revision: 2 })),
    deleteWorkpad: vi.fn(async (_id: string): Promise<void> => undefined),
    ...overrides,
  };
  type Change = { workpadId: string; revision: number; change: "document" | "draft" } | undefined;
  const listeners = new Set<(change: Change) => void>();
  const normalized = { subscribeWorkpadChanges: (listener: (change: Change) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const emit = (change?: Change) => { for (const listener of listeners) listener(change); };
  const state = { snapshot: { workspaces: [] }, visibleThreads: [] };
  const store = { api, normalized, subscribe: () => () => undefined, getSnapshot: () => state, workspaceIdForThread: () => undefined } as unknown as ApplicationClientStore;
  return { api, store, emit };
}
/** What each host has published for its panel header, kept as PanelLayout keeps it. */
const published = new WeakMap<WorkspacePanelHost, { get: () => PanelChromeStatus; subscribe: (listener: () => void) => () => void }>();
/** A panel context whose host methods are spies that also feed the header. */
function panelContext(store: ApplicationClientStore) {
  let status: PanelChromeStatus = {};
  const listeners = new Set<() => void>();
  const publish = (change: PanelChromeStatus) => { status = { ...status, ...change }; for (const listener of listeners) listener(); };
  const host = {
    close: vi.fn(), consumeIntent: vi.fn(),
    setBusy: vi.fn((busy: boolean) => publish({ busy })),
    setDirty: vi.fn((dirty: boolean) => publish({ dirty })),
    setSubtitle: vi.fn((subtitle?: string) => publish({ subtitle })),
  };
  published.set(host, { get: () => status, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } });
  return {
    applicationStore: store, visible: true, presentation: "dock" as const,
    threadRegistry: {} as WorkspacePanelContext["threadRegistry"],
    chromeActionsTarget: document.createElement("div"),
    host,
  };
}
/**
 * The panel under the real shared header, wired as PanelLayout wires a
 * tenant: the header's actions slot adopts the panel's chrome actions, and
 * its ⋯ shows the Dock group and then the items the panel publishes.
 */
function Panel({ context }: { context: WorkspacePanelContext }) {
  const source = published.get(context.host)!;
  const status = useSyncExternalStore(source.subscribe, source.get);
  return <>
    <PanelChrome tenant={workpadsTenant} status={status}
      panelActions={<StablePaneSlot className="workspace-panel-chrome-actions-slot" target={context.chromeActionsTarget} />}
      controls={{ onCollapse: () => undefined, onClose: () => undefined, onDock: () => undefined }} />
    <WorkpadsPanel context={context} />
  </>;
}
const header = () => screen.getByRole("banner", { name: "Workpads panel header" });
const openRow = async (name = "Integration") => { fireEvent.click(await screen.findByRole("button", { name })); };
/** Opens a dropdown from its trigger, as Radix expects a primary pointer press. */
const openMenu = (trigger: string) => { fireEvent.pointerDown(screen.getByRole("button", { name: trigger }), { button: 0, ctrlKey: false }); return screen.getAllByRole("menu").at(-1)!; };
const headerMenu = () => openMenu("Workpads panel actions");
/** The open workpad's own ⋯, in its toolbar. */
const documentMenu = () => openMenu("Workpad actions");
const viewOptions = () => openMenu("View options");
const segment = (name: string) => within(screen.getByRole("radiogroup", { name: "Workpad scope" })).getByRole("radio", { name });
/** The selected scope segment: choosing it again returns from an open workpad to its list. */
const currentSegment = () => within(screen.getByRole("radiogroup", { name: "Workpad scope" })).getAllByRole("radio")
  .find(radio => radio.getAttribute("aria-checked") === "true")!;
const backToList = () => { fireEvent.click(currentSegment()); };
const closeMenu = () => { fireEvent.keyDown(screen.getAllByRole("menu").at(-1)!, { key: "Escape" }); };
const choose = (name: string | RegExp) => { fireEvent.click(screen.getByRole("menuitem", { name })); };
const menuLabels = (menu: HTMLElement) => [...menu.querySelectorAll("[role^=menuitem]")].map(item => item.textContent);
/** Opens a submenu from its row in the open menu. */
const openSubmenu = (name: string) => { fireEvent.click(screen.getByRole("menuitem", { name })); return screen.getByRole("menu", { name }); };
const addRow = () => screen.getByRole("textbox", { name: "New workpad title" }) as HTMLInputElement;
const create = (title: string) => { fireEvent.change(addRow(), { target: { value: title } }); fireEvent.submit(addRow().form!); };
/** The open workpad's ⋯ › Rename…, then the dialog's title and Rename. */
const rename = (title: string) => {
  documentMenu(); choose("Rename…");
  fireEvent.change(screen.getByRole("textbox", { name: "Workpad title" }), { target: { value: title } });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
};
const openSearch = () => { fireEvent.click(screen.getByRole("button", { name: "Search workpads" })); return screen.getByRole("textbox", { name: "Search workpads" }); };
const chooseRevision = (name: RegExp) => { openMenu("Revision history"); fireEvent.click(screen.getByRole("menuitemradio", { name })); };
const startEditing = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
  return screen.findByRole("textbox", { name: "Workpad content" });
};
/** The open workpad's ⋯ › Discard draft…, then the confirmation. */
const discardDraft = async () => {
  documentMenu(); choose("Discard draft…");
  await act(async () => { fireEvent.click(within(screen.getByRole("dialog", { name: "Discard draft?" })).getByRole("button", { name: "Discard draft" })); });
};
/** Viewer preferences live in local storage; each test starts from the defaults. */
function resetStorage() {
  window.localStorage.clear();
  // Module caches drop their snapshot on a storage event without a key.
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
}
beforeEach(() => {
  resetStorage();
  navigate("/", { replace: true });
  // PanelChrome reads the single-pane query; this is the docked desktop layout.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
  // The destination pickers scroll their active option into view; jsdom has no layout.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); resetStorage(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView"); });
describe("WorkpadsPanel", () => {
  it("commits the displayed checklist revision once, preserving focus and never saving a draft", async () => {
    const content = "- [ ] First\n- [ ] Second\n";
    const updated = { ...pad, revision: 2, content: "- [ ] First\n- [x] Second\n" };
    let resolve!: (value: Workpad) => void;
    const updateWorkpad = vi.fn(() => new Promise<Workpad>(done => { resolve = done; }));
    const { store, api } = fixture({ updateWorkpad });
    api.getWorkpad.mockResolvedValue({ ...pad, content });
    api.getWorkpadRevision.mockResolvedValue({ ...revision, content });
    const context = panelContext(store);
    render(<Panel context={context} />);
    await openRow();
    const checkbox = await screen.findByRole("checkbox", { name: "Second" });
    checkbox.focus();
    fireEvent.click(checkbox);
    expect(updateWorkpad).toHaveBeenCalledExactlyOnceWith(pad.id, { expectedRevision: 1, edit: { kind: "replace", content: updated.content } });
    expect(checkbox).toHaveAttribute("aria-disabled", "true");
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Saving checklist item…");
    expect(context.host.setBusy).toHaveBeenLastCalledWith(true);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("checkbox", { name: "First" }));
    expect(updateWorkpad).toHaveBeenCalledTimes(1);
    api.getWorkpad.mockResolvedValue(updated);
    api.getWorkpadRevision.mockResolvedValue({ ...revision, ...updated });
    api.listWorkpadRevisions.mockResolvedValue({ items: [{ ...revision, ...updated }, revision] });
    await act(async () => { resolve(updated); });
    expect(screen.getByRole("checkbox", { name: "Second" })).toBe(checkbox);
    expect(checkbox).toBeChecked();
    expect(checkbox).toHaveFocus();
    expect(checkbox).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
    expect(api.getWorkpadDraft).not.toHaveBeenCalled();
    expect(api.saveWorkpadDraft).not.toHaveBeenCalled();
    expect(api.commitWorkpadDraft).not.toHaveBeenCalled();
  });

  it("refreshes after a checklist conflict and requires a fresh click against the new source", async () => {
    const content = "- [ ] Check";
    const changed = { ...pad, revision: 2, content: "Agent introduction\n\n- [ ] Check" };
    const updated = { ...changed, revision: 3, content: "Agent introduction\n\n- [x] Check" };
    const { store, api } = fixture();
    api.getWorkpad.mockResolvedValue({ ...pad, content });
    api.getWorkpadRevision.mockResolvedValue({ ...revision, content });
    render(<Panel context={panelContext(store)} />);
    await openRow();
    const checkbox = await screen.findByRole("checkbox", { name: "Check" });
    api.updateWorkpad.mockRejectedValueOnce(new ApiError(409, "conflict", "The workpad changed. Read its latest revision before editing.", false));
    api.getWorkpad.mockResolvedValue(changed);
    api.getWorkpadRevision.mockResolvedValue({ ...revision, ...changed });
    fireEvent.click(checkbox);
    await screen.findByText("Agent introduction");
    expect(screen.getByRole("alert")).toHaveTextContent("The workpad changed.");
    expect(screen.getByRole("checkbox", { name: "Check" })).not.toBeChecked();
    expect(api.updateWorkpad).toHaveBeenCalledExactlyOnceWith(pad.id, { expectedRevision: 1, edit: { kind: "replace", content: "- [x] Check" } });
    api.updateWorkpad.mockResolvedValue(updated);
    api.getWorkpad.mockResolvedValue(updated);
    api.getWorkpadRevision.mockResolvedValue({ ...revision, ...updated });
    fireEvent.click(screen.getByRole("checkbox", { name: "Check" }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Check" })).toBeChecked());
    expect(api.updateWorkpad).toHaveBeenLastCalledWith(pad.id, { expectedRevision: 2, edit: { kind: "replace", content: updated.content } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([false, true])("blocks editing after a failed checklist refresh until reload succeeds (write committed: %s)", async committed => {
    const content = "- [ ] Check";
    const { store, api } = fixture();
    api.getWorkpad.mockResolvedValue({ ...pad, content });
    api.getWorkpadRevision.mockResolvedValue({ ...revision, content });
    render(<Panel context={panelContext(store)} />);
    await openRow();
    const checkbox = await screen.findByRole("checkbox", { name: "Check" });
    if (!committed) api.updateWorkpad.mockRejectedValueOnce(new Error("Connection lost"));
    api.getWorkpad.mockRejectedValueOnce(new Error("Still offline"));
    fireEvent.click(checkbox);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(committed ? "Checklist change saved" : "Connection lost"));
    expect(checkbox).toBeDisabled();
    expect(checkbox).not.toBeChecked();
    const edit = screen.getByRole("button", { name: "Edit workpad" });
    expect(edit).toBeDisabled();
    fireEvent.click(edit);
    expect(api.getWorkpadDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.getByRole("button", { name: "Reload workpad" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload workpad" }));
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    expect(api.updateWorkpad).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(edit).not.toBeDisabled();
    const editor = await startEditing();
    fireEvent.change(editor, { target: { value: "New unsynced draft" } });
    expect(editor).toHaveValue("New unsynced draft");
    expect(screen.queryByRole("button", { name: "Reload workpad" })).not.toBeInTheDocument();
  });

  it("clears checklist recovery when returning to the workpad list", async () => {
    const content = "- [ ] Check";
    const { store, api } = fixture();
    api.getWorkpad.mockResolvedValue({ ...pad, content });
    api.getWorkpadRevision.mockResolvedValue({ ...revision, content });
    render(<Panel context={panelContext(store)} />);
    await openRow();
    const checkbox = await screen.findByRole("checkbox", { name: "Check" });
    api.updateWorkpad.mockRejectedValueOnce(new Error("Connection lost"));
    api.getWorkpad.mockRejectedValueOnce(new Error("Still offline"));
    fireEvent.click(checkbox);
    await waitFor(() => expect(screen.getByRole("button", { name: "Reload workpad" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Reload this workpad");
    backToList();
    await screen.findByRole("button", { name: "Integration" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload workpad" })).not.toBeInTheDocument();
    await openRow();
    expect(await screen.findByRole("checkbox", { name: "Check" })).not.toBeDisabled();
  });

  it("does not reparse the Workpad on unrelated application publications", async () => {
    const parser = vi.spyOn(markdownChecklists, "rehypeChecklistInputs");
    const content = "- [ ] Check";
    const { store: base, api, emit } = fixture();
    const { store, publish } = withSnapshot(base, { workspaces: [] });
    api.getWorkpad.mockResolvedValue({ ...pad, content });
    api.getWorkpadRevision.mockResolvedValue({ ...revision, content });
    render(<Panel context={panelContext(store)} />);
    await openRow();
    await screen.findByRole("checkbox", { name: "Check" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit workpad" })).not.toBeDisabled());
    const parses = parser.mock.calls.length;
    expect(parses).toBeGreaterThan(0);
    publish({ workspaces: [], threads: [{ id: "unrelated", title: { text: "Changed title" } }] });
    expect(parser).toHaveBeenCalledTimes(parses);
    api.getWorkpad.mockResolvedValue({ ...pad, revision: 2, content: "- [x] Check" });
    api.getWorkpadRevision.mockResolvedValue({ ...revision, revision: 2, content: "- [x] Check" });
    await act(async () => { emit({ workpadId: pad.id, revision: 2, change: "document" }); });
    expect(parser.mock.calls.length).toBeGreaterThan(parses);
    expect(screen.getByRole("checkbox", { name: "Check" })).toBeChecked();
  });

  it("retains a dirty synchronized draft when preview checkboxes change the saved document", async () => {
    const content = "- [ ] Check";
    const updated = { ...pad, revision: 2, content: "- [x] Check" };
    const dirty = { ...initialDraft, revision: 5, content: `${content}\nMy draft` };
    const { store, api } = fixture();
    api.getWorkpad.mockResolvedValue({ ...pad, content });
    api.getWorkpadRevision.mockImplementation(async (_id?: string, number?: number) => ({ ...revision, revision: number ?? 1, content: number === 2 ? updated.content : content }));
    api.getWorkpadDraft.mockResolvedValue(dirty);
    render(<Panel context={panelContext(store)} />);
    await openRow();
    const checkbox = await screen.findByRole("checkbox", { name: "Check" });
    api.updateWorkpad.mockResolvedValue(updated);
    api.getWorkpad.mockResolvedValue(updated);
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    const editor = await startEditing();
    expect(editor).toHaveValue(dirty.content);
    expect(screen.getByRole("alert")).toHaveTextContent("The document changed.");
    expect(api.saveWorkpadDraft).not.toHaveBeenCalled();
    expect(api.commitWorkpadDraft).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps historical checklist revisions read-only (archived: %s)", async archived => {
    const content = "- [ ] Check";
    const { store, api } = fixture();
    api.getWorkpad.mockResolvedValue({ ...pad, revision: 2, content, archivedAt: archived ? time : null });
    api.getWorkpadRevision.mockImplementation(async (_id?: string, number?: number) => ({ ...revision, revision: number ?? 1, content }));
    api.listWorkpadRevisions.mockResolvedValue({ items: [{ ...revision, revision: 2 }, revision] });
    render(<Panel context={panelContext(store)} />);
    await openRow();
    const latestCheckbox = await screen.findByRole("checkbox", { name: "Check" });
    if (archived) expect(latestCheckbox).toBeDisabled();
    else expect(latestCheckbox).not.toBeDisabled();
    chooseRevision(/^Revision 1/);
    await screen.findByText("Viewing revision 1. The latest is revision 2.");
    expect(screen.getByRole("checkbox", { name: "Check" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Check" }));
    expect(api.updateWorkpad).not.toHaveBeenCalled();
  });

  it("fences a pending checklist response after approved navigation to another thread", async () => {
    const content = "- [ ] Check";
    let resolve!: (value: Workpad) => void;
    const updateWorkpad = vi.fn(() => new Promise<Workpad>(done => { resolve = done; }));
    const { store, api } = fixture({ updateWorkpad });
    api.getWorkpad.mockResolvedValue({ ...pad, content });
    api.getWorkpadRevision.mockResolvedValue({ ...revision, content });
    const context = { ...panelContext(store), threadId: "first-thread" };
    navigate("/threads/first-thread");
    const view = render(<Panel context={context} />);
    await openRow();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Check" }));
    act(() => navigate("/threads/second-thread"));
    expect(screen.getByRole("dialog", { name: "Leave pending workpad changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    view.rerender(<Panel context={{ ...context, threadId: "second-thread" }} />);
    expect(screen.queryByRole("checkbox", { name: "Check" })).not.toBeInTheDocument();
    const reads = api.getWorkpad.mock.calls.length;
    await act(async () => { resolve({ ...pad, revision: 2, content: "- [x] Check" }); });
    expect(api.getWorkpad).toHaveBeenCalledTimes(reads);
    expect(screen.queryByRole("checkbox", { name: "Check" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/threads/second-thread");
  });

  it("saves an explicitly edited draft against its base document revision", async () => {
    const { store, api } = fixture();
    render(<Panel context={panelContext(store)} />);
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    fireEvent.change(editor, { target: { value: "Original with new agreement" } });
    expect(api.commitWorkpadDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save workpad" }));
    await waitFor(() => expect(api.commitWorkpadDraft).toHaveBeenCalledWith("pad", { expectedDraftRevision: 1, expectedRevision: 1 }));
    expect(api.saveWorkpadDraft).toHaveBeenCalledWith("pad", { expectedRevision: 0, baseRevision: 1, content: "Original with new agreement" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument());
  });
  it("reports unsynced text to the panel host and retains it while collapsed", async () => {
    const { store, api, emit } = fixture();
    const context = panelContext(store);
    const view = render(<Panel context={context} />);
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    fireEvent.change(editor, { target: { value: "Retained while collapsed" } });
    expect(context.host.setDirty).toHaveBeenLastCalledWith(true);
    expect(within(header()).getByLabelText("Unsaved changes")).toBeInTheDocument();
    view.rerender(<Panel context={{ ...context, visible: false }} />);
    expect(editor).toHaveValue("Retained while collapsed");
    const reads = api.getWorkpad.mock.calls.length;
    await act(async () => { emit({ workpadId: pad.id, revision: 2, change: "document" }); });
    expect(api.getWorkpad).toHaveBeenCalledTimes(reads);
    view.rerender(<Panel context={context} />);
    expect(editor).toHaveValue("Retained while collapsed");
    await waitFor(() => expect(api.getWorkpad).toHaveBeenCalledTimes(reads + 1));
  });

  it("guards thread changes until the user confirms leaving unsynced text", async () => {
    const { store, api } = fixture();
    const context = { ...panelContext(store), threadId: "first-thread", workspaceId: "first-project" };
    navigate("/threads/first-thread");
    const view = render(<Panel context={context} />);
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Unsynced across projects" } });

    act(() => { navigate("/threads/second-thread"); });
    expect(screen.getByRole("dialog", { name: "Leave unsynced workpad?" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/threads/first-thread");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(editor).toHaveValue("Unsynced across projects");
    expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "thread", threadId: "first-thread" } }));

    act(() => { navigate("/threads/second-thread"); });
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    expect(window.location.pathname).toBe("/threads/second-thread");
    view.rerender(<Panel context={{ ...context, threadId: "second-thread", workspaceId: "second-project" }} />);
    expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "thread", threadId: "second-thread" } }));
    expect(api.saveWorkpadDraft).not.toHaveBeenCalled();
  });

  it("clears the old document and follows a new thread while retaining list filters", async () => {
    const { store, api } = fixture();
    const context = { ...panelContext(store), threadId: "first-thread" };
    const view = render(<Panel context={context} />);
    await screen.findByRole("button", { name: "Integration" });
    fireEvent.change(openSearch(), { target: { value: "integration" } });
    await openRow();
    await screen.findByText("Original");
    view.rerender(<Panel context={{ ...context, threadId: "second-thread" }} />);
    expect(screen.queryByText("Original")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search workpads" })).toHaveValue("integration");
    await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: { kind: "thread", threadId: "second-thread" }, query: "integration",
    })));
  });

  it("retains a global document and unsynced editor across thread switches", async () => {
    const { store, api } = fixture();
    const context = { ...panelContext(store), threadId: "first-thread" };
    navigate("/threads/first-thread");
    const view = render(<Panel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Global typing" } });
    const reads = api.getWorkpad.mock.calls.length;
    act(() => navigate("/threads/second-thread"));
    expect(window.location.pathname).toBe("/threads/second-thread");
    view.rerender(<Panel context={{ ...context, threadId: "second-thread" }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Workpad content" })).toBe(editor);
    expect(editor).toHaveValue("Global typing");
    expect(api.getWorkpad).toHaveBeenCalledTimes(reads);
    expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "global" } }));
  });

  it("ignores a late list response from the previous thread", async () => {
    let resolveOld!: (value: { items: Workpad[] }) => void;
    const listWorkpads = vi.fn((request: { scope: { threadId?: string } }) => request.scope.threadId === "first-thread"
      ? new Promise<{ items: Workpad[] }>(resolve => { resolveOld = resolve; })
      : Promise.resolve({ items: [{ ...pad, title: "Second thread document" }] }));
    const { store } = fixture({ listWorkpads });
    const context = { ...panelContext(store), threadId: "first-thread" };
    const view = render(<Panel context={context} />);
    await waitFor(() => expect(resolveOld).toBeDefined());
    view.rerender(<Panel context={{ ...context, threadId: "second-thread" }} />);
    await screen.findByRole("button", { name: "Second thread document" });
    await act(async () => { resolveOld({ items: [pad] }); });
    expect(screen.queryByRole("button", { name: "Integration" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Second thread document" })).toBeInTheDocument();
  });

  it("ignores a document still opening when the active thread changes", async () => {
    let resolveOld!: (value: Workpad) => void;
    const { store, api } = fixture();
    api.getWorkpad.mockImplementationOnce(() => new Promise<Workpad>(resolve => { resolveOld = resolve; }));
    const context = { ...panelContext(store), threadId: "first-thread" };
    const view = render(<Panel context={context} />);
    await openRow();
    await waitFor(() => expect(resolveOld).toBeDefined());
    view.rerender(<Panel context={{ ...context, threadId: "second-thread" }} />);
    await act(async () => { resolveOld(pad); });
    await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "thread", threadId: "second-thread" } })));
    expect(screen.queryByText("Original")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit workpad" })).not.toBeInTheDocument();
  });

  it("ignores a late revision read after changing threads", async () => {
    let resolveOld!: (value: WorkpadRevision) => void;
    const { store, api } = fixture();
    api.getWorkpad.mockResolvedValue({ ...pad, revision: 2 });
    api.getWorkpadRevision.mockResolvedValue({ ...revision, revision: 2 });
    api.listWorkpadRevisions.mockResolvedValue({ items: [{ ...revision, revision: 2 }, revision] });
    const context = { ...panelContext(store), threadId: "first-thread" };
    const view = render(<Panel context={context} />);
    await openRow();
    await screen.findByText("Original");
    api.getWorkpadRevision.mockImplementationOnce(() => new Promise<WorkpadRevision>(resolve => { resolveOld = resolve; }));
    chooseRevision(/^Revision 1/);
    await waitFor(() => expect(resolveOld).toBeDefined());
    view.rerender(<Panel context={{ ...context, threadId: "second-thread" }} />);
    await act(async () => { resolveOld({ ...revision, content: "Old history" }); });
    expect(screen.queryByText("Old history")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revision history" })).not.toBeInTheDocument();
  });

  it("does not open a workpad created for the previous thread after switching", async () => {
    let resolveCreated!: (value: Workpad) => void;
    const createWorkpad = vi.fn(() => new Promise<Workpad>(resolve => { resolveCreated = resolve; }));
    const { store, api } = fixture({ createWorkpad });
    const context = { ...panelContext(store), threadId: "first-thread" };
    const view = render(<Panel context={context} />);
    create("Created for first");
    expect(createWorkpad).toHaveBeenCalledWith({ title: "Created for first", scope: { kind: "thread", threadId: "first-thread" } });
    view.rerender(<Panel context={{ ...context, threadId: "second-thread" }} />);
    expect(screen.getByRole("dialog", { name: "Leave pending workpad changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    await act(async () => { resolveCreated(pad); });
    expect(api.getWorkpad).not.toHaveBeenCalled();
    expect(api.getWorkpadDraft).not.toHaveBeenCalled();
    expect(addRow()).toHaveValue("");
    expect(screen.queryByText("Original")).not.toBeInTheDocument();
  });

  it("does not reopen a renamed document after switching threads", async () => {
    let resolveRenamed!: (value: Workpad) => void;
    const updateWorkpad = vi.fn(() => new Promise<Workpad>(resolve => { resolveRenamed = resolve; }));
    const { store, api } = fixture({ updateWorkpad });
    const context = { ...panelContext(store), threadId: "first-thread" };
    const view = render(<Panel context={context} />);
    await openRow();
    await screen.findByRole("button", { name: "Edit workpad" });
    rename("Renamed document");
    await waitFor(() => expect(resolveRenamed).toBeDefined());
    const reads = api.getWorkpad.mock.calls.length;
    view.rerender(<Panel context={{ ...context, threadId: "second-thread" }} />);
    expect(screen.getByRole("dialog", { name: "Leave pending workpad changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    await act(async () => { resolveRenamed({ ...pad, title: "Renamed document" }); });
    expect(api.getWorkpad).toHaveBeenCalledTimes(reads);
    expect(screen.queryByRole("textbox", { name: "Workpad title" })).not.toBeInTheDocument();
    expect(screen.queryByText("Original")).not.toBeInTheDocument();
  });

  it.each(["commit", "rename"])("guards a pending %s and shows its failure after cancelling navigation", async operation => {
    let rejectOperation!: (error: Error) => void;
    const pending = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectOperation = reject; }));
    const { store } = fixture(operation === "commit" ? { commitWorkpadDraft: pending } : { updateWorkpad: pending });
    const context = { ...panelContext(store), threadId: "first-thread" };
    navigate("/threads/first-thread");
    render(<Panel context={context} />);
    await openRow();
    if (operation === "commit") {
      // Save needs a change to commit; the draft syncs before the commit starts.
      fireEvent.change(await startEditing(), { target: { value: "Original, committed" } });
      fireEvent.click(screen.getByRole("button", { name: "Save workpad" }));
    } else {
      await screen.findByRole("button", { name: "Edit workpad" });
      rename("Updated title");
    }
    await waitFor(() => expect(pending).toHaveBeenCalled());
    act(() => navigate("/threads/second-thread"));
    expect(window.location.pathname).toBe("/threads/first-thread");
    expect(screen.getByRole("dialog", { name: "Leave pending workpad changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await act(async () => { rejectOperation(new Error("Workpad changed on the server")); });
    expect(screen.getByRole("alert")).toHaveTextContent("Workpad changed on the server");
    expect(window.location.pathname).toBe("/threads/first-thread");
  });

  it("allows Settings categories without discarding and protects leaving the retained thread", async () => {
    const { store } = fixture();
    const context = { ...panelContext(store), threadId: "first-thread", workspaceId: "first-project" };
    navigate("/threads/first-thread");
    render(<Panel context={context} />);
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Still unsynced" } });
    act(() => navigate("/settings/general"));
    act(() => navigate("/settings/appearance"));
    expect(window.location.pathname).toBe("/settings/appearance");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => navigate("/threads/first-thread"));
    expect(window.location.pathname).toBe("/threads/first-thread");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => navigate("/settings/appearance"));
    act(() => navigate("/threads/second-thread"));
    expect(screen.getByRole("dialog", { name: "Leave unsynced workpad?" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/settings/appearance");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    act(() => navigate("/"));
    expect(window.location.pathname).toBe("/settings/appearance");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(editor).toHaveValue("Still unsynced");
    act(() => navigate("/"));
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    expect(window.location.pathname).toBe("/");
  });

  it("does not let an older search response replace the current results", async () => {
    let resolveOld!: (value: { items: Workpad[] }) => void;
    const listWorkpads = vi.fn((request: { query?: string }) => request.query === "old" ? new Promise<{items:Workpad[]}>(resolve => { resolveOld = resolve; }) : Promise.resolve({ items: [{ ...pad, title: request.query === "new" ? "New result" : "Integration" }] }));
    const { store } = fixture({ listWorkpads });
    render(<Panel context={panelContext(store)} />);
    await screen.findByRole("button", { name: "Integration" });
    fireEvent.change(openSearch(), { target: { value: "old" } });
    await waitFor(() => expect(resolveOld).toBeDefined());
    fireEvent.change(screen.getByRole("textbox", { name: "Search workpads" }), { target: { value: "new" } });
    await screen.findByRole("button", { name: "New result" });
    await act(async () => { resolveOld({ items: [{ ...pad, title: "Old result" }] }); });
    expect(screen.queryByRole("button", { name: "Old result" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New result" })).toBeInTheDocument();
  });
  it("refreshes on document events and reconnect, without periodic reads", async () => {
    const { store, api, emit } = fixture();
    render(<Panel context={panelContext(store)} />);
    await openRow();
    await screen.findByRole("button", { name: "Edit workpad" });
    vi.useFakeTimers();
    const reads = api.getWorkpad.mock.calls.length;
    const lists = api.listWorkpads.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.getWorkpad).toHaveBeenCalledTimes(reads);
    expect(api.listWorkpads).toHaveBeenCalledTimes(lists);
    api.getWorkpad.mockResolvedValue({ ...pad, revision: 2, content: "Agent update" });
    api.getWorkpadRevision.mockResolvedValue({ ...revision, revision: 2, content: "Agent update" });
    api.listWorkpadRevisions.mockResolvedValue({ items: [{ ...revision, revision: 2 }] });
    await act(async () => { emit({ workpadId: pad.id, revision: 2, change: "document" }); });
    expect(screen.getByText("Agent update")).toBeInTheDocument();
    expect(api.getWorkpad).toHaveBeenCalledTimes(reads + 1);
    const afterEvent = api.getWorkpad.mock.calls.length;
    await act(async () => { emit(); });
    expect(api.getWorkpad).toHaveBeenCalledTimes(afterEvent + 1);
  });
  it("preserves dirty text on agent updates and refreshes only the draft for draft events", async () => {
    const { store, api, emit } = fixture();
    render(<Panel context={panelContext(store)} />);
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    fireEvent.change(editor, { target: { value: "My unsaved text" } });
    api.getWorkpad.mockResolvedValue({ ...pad, revision: 2, content: "Agent update" });
    api.getWorkpadRevision.mockResolvedValue({ ...revision, revision: 2, content: "Agent update" });
    await act(async () => { emit({ workpadId: pad.id, revision: 2, change: "document" }); });
    expect(editor).toHaveValue("My unsaved text");
    expect(screen.getByRole("button", { name: "Save workpad" })).toBeDisabled();
    const lists = api.listWorkpads.mock.calls.length;
    const reads = api.getWorkpad.mock.calls.length;
    api.getWorkpadDraft.mockResolvedValue({ ...initialDraft, revision: 1, content: "Other device" });
    await act(async () => { emit({ workpadId: pad.id, revision: 1, change: "draft" }); });
    expect(editor).toHaveValue("My unsaved text");
    expect(screen.getByText("This draft changed on another device.")).toBeInTheDocument();
    expect(api.listWorkpads).toHaveBeenCalledTimes(lists);
    expect(api.getWorkpad).toHaveBeenCalledTimes(reads);
  });
  it("keeps unsynced typing on a clean draft follow and presents document reconciliation", async () => {
    const { store, api, emit } = fixture();
    render(<Panel context={panelContext(store)} />);
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "My unsynced typing" } });
    api.getWorkpad.mockResolvedValue({ ...pad, revision: 2, content: "Agent update" });
    api.getWorkpadRevision.mockResolvedValue({ ...revision, revision: 2, content: "Agent update" });
    api.getWorkpadDraft.mockResolvedValue({ ...initialDraft, revision: 1, baseRevision: 2, content: "Agent update" });
    await act(async () => { emit({ workpadId: pad.id, revision: 2, change: "document" }); });
    expect(editor).toHaveValue("My unsynced typing");
    expect(screen.getByRole("alert")).toHaveTextContent(/^The document changed\.Review the latest version before saving\./);
    expect(screen.queryByText("This draft changed on another device.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(screen.getByText("Starting version · revision 1")).toBeInTheDocument();
    expect(screen.getByText("Original")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.saveWorkpadDraft).toHaveBeenCalledWith("pad", { expectedRevision: 1, baseRevision: 1, content: "My unsynced typing" });
    expect(editor).toHaveValue("My unsynced typing");
  });

  it("prevents discard from racing a pending autosave and uses the saved counter", async () => {
    let resolve!: (draft: WorkpadDraft) => void;
    const discardWorkpadDraft = vi.fn(async () => undefined);
    const { store, api } = fixture({ discardWorkpadDraft });
    api.saveWorkpadDraft.mockImplementationOnce(() => new Promise<WorkpadDraft>(done => { resolve = done; }));
    render(<Panel context={panelContext(store)} />);
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Pending typing" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    documentMenu();
    expect(screen.getByRole("menuitem", { name: "Discard draft…" })).toHaveAttribute("aria-disabled", "true");
    choose("Discard draft…");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(discardWorkpadDraft).not.toHaveBeenCalled();
    await act(async () => { resolve({ ...initialDraft, revision: 1, content: "Pending typing" }); });
    expect(screen.getByRole("menuitem", { name: "Discard draft…" })).not.toHaveAttribute("aria-disabled");
    closeMenu();
    await discardDraft();
    expect(discardWorkpadDraft).toHaveBeenCalledWith("pad", 1);
    expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cancels debounced autosave before sending a slow discard", async () => {
    let resolve!: () => void;
    const discardWorkpadDraft = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    const { store, api } = fixture({ discardWorkpadDraft });
    render(<Panel context={panelContext(store)} />);
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Never synced" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    // Confirming takes no time, so the debounce is still a second short.
    await discardDraft();
    expect(discardWorkpadDraft).toHaveBeenCalledWith("pad", 0);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(api.saveWorkpadDraft).not.toHaveBeenCalled();
    await act(async () => { resolve(); });
    expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("queues events received while opening a workpad instead of losing them", async () => {
    let resolve!: (value: Workpad) => void;
    const { store, api, emit } = fixture();
    api.getWorkpad.mockImplementationOnce(() => new Promise<Workpad>(done => { resolve = done; }));
    render(<Panel context={panelContext(store)} />);
    await openRow();
    await waitFor(() => expect(resolve).toBeDefined());
    api.getWorkpad.mockResolvedValue({ ...pad, revision: 2, content: "Arrived while opening" });
    api.getWorkpadRevision.mockImplementation(async (_id?: string, number?: number) => ({ ...revision, revision: number ?? 1, content: number === 2 ? "Arrived while opening" : "Original" }));
    await act(async () => { emit({ workpadId: pad.id, revision: 2, change: "document" }); resolve(pad); });
    await screen.findByText("Arrived while opening");
    expect(api.getWorkpad).toHaveBeenCalledTimes(2);
  });

  it("keeps a historical document selected when a new revision arrives", async () => {
    const { store, api, emit } = fixture();
    api.getWorkpad.mockResolvedValue({ ...pad, revision: 2, content: "Current document" });
    api.getWorkpadRevision.mockImplementation(async (_id?: string, number?: number) => ({ ...revision, revision: number ?? 1, content: number === 1 ? "Historical document" : "Current document" }));
    api.listWorkpadRevisions.mockResolvedValue({ items: [{ ...revision, revision: 2 }, revision] });
    render(<Panel context={panelContext(store)} />);
    await openRow();
    await screen.findByText("Current document");
    chooseRevision(/^Revision 1/);
    await screen.findByText("Historical document");
    api.getWorkpad.mockResolvedValue({ ...pad, revision: 3, content: "New document" });
    api.listWorkpadRevisions.mockResolvedValue({ items: [{ ...revision, revision: 3 }, { ...revision, revision: 2 }, revision] });
    await act(async () => { emit({ workpadId: pad.id, revision: 3, change: "document" }); });
    expect(screen.getByText("Historical document")).toBeInTheDocument();
    expect(screen.getByText("Viewing revision 1. The latest is revision 3.")).toBeInTheDocument();
    openMenu("Revision history");
    expect(screen.getByRole("menuitemradio", { name: /^Revision 1/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /^Revision 3 · latest/ })).toHaveAttribute("aria-checked", "false");
  });

  it("clears recovered refresh failures without clearing mutation errors", async () => {
    const { store, api, emit } = fixture();
    render(<Panel context={panelContext(store)} />);
    await openRow();
    await screen.findByRole("button", { name: "Edit workpad" });
    api.getWorkpad.mockRejectedValueOnce(new Error("Failed to fetch"));
    await act(async () => { emit({ workpadId: pad.id, revision: 2, change: "document" }); });
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to fetch");
    await act(async () => { emit(); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    fireEvent.change(editor, { target: { value: "My pending changes" } });
    api.commitWorkpadDraft.mockRejectedValueOnce(new Error("Save rejected"));
    fireEvent.click(screen.getByRole("button", { name: "Save workpad" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Save rejected"));
    await act(async () => { emit(); });
    expect(screen.getByRole("alert")).toHaveTextContent("Save rejected");
    expect(editor).toHaveValue("My pending changes");
  });


  // Two same-named projects are told apart by their hosts; acme-web has two locations.
  const projectCatalog = {
    environments: [
      { id: "local", kind: "local", label: { text: "Local" }, available: true },
      { id: "build", kind: "ssh", label: { text: "Build host" }, available: true },
    ],
    projects: [
      { id: "project-web", name: "acme-web", revision: 0 },
      { id: "project-docs", name: "docs", revision: 0 },
      { id: "project-docs-build", name: "docs", revision: 0 },
    ],
    workspaces: [
      { id: "web-local", environmentId: "local", projectId: "project-web", label: { text: "acme-web" }, displayPath: { text: "/src/acme-web" }, available: true },
      { id: "web-build", environmentId: "build", projectId: "project-web", label: { text: "acme-web" }, displayPath: { text: "/srv/acme-web" }, available: true },
      { id: "docs-local", environmentId: "local", projectId: "project-docs", label: { text: "docs" }, displayPath: { text: "/src/docs" }, available: true },
      { id: "docs-build", environmentId: "build", projectId: "project-docs-build", label: { text: "docs" }, displayPath: { text: "/srv/docs" }, available: true },
    ],
    // What the Browse and Move pickers offer besides projects.
    threads: [
      { id: "thread-build", workspaceId: "web-build", title: { text: "Build thread" }, inventoryState: "active" },
      { id: "thread-manual", workspaceId: "web-local", title: { text: "Manual thread" }, inventoryState: "active" },
    ],
  };
  /** A store whose snapshot can arrive after the panel mounts. */
  function withSnapshot(store: ApplicationClientStore, snapshot: object | undefined, visibleThreads = [{ id: "thread-build", title: { text: "Build thread" } }]) {
    let state = { snapshot, visibleThreads };
    const listeners = new Set<() => void>();
    return {
      store: { ...store, getSnapshot: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } as unknown as ApplicationClientStore,
      publish: (next: object) => { state = { ...state, snapshot: next }; act(() => listeners.forEach(listener => listener())); },
    };
  }

  it("scopes Project to the thread's project and names destinations after the followed thread", async () => {
    const { store: base, api } = fixture();
    const { store } = withSnapshot(base, projectCatalog);
    // The thread runs in acme-web's build-host location.
    render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
    await waitFor(() => expect(api.listWorkpads).toHaveBeenCalled());
    fireEvent.click(segment("Project"));
    expect(addRow()).toHaveAttribute("placeholder", "New workpad in this project…");
    await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: { kind: "project", projectId: "project-web" }, scopeMode: "exact",
    })));
    // Move to › Choose… leads with the followed thread and project, then
    // offers each other project once by its label.
    await screen.findByRole("button", { name: "Integration" });
    openMenu("Actions for “Integration”");
    fireEvent.click(within(openSubmenu("Move to")).getByRole("menuitem", { name: "Choose…" }));
    const dialog = screen.getByRole("dialog", { name: "Move workpad" });
    expect(within(dialog).getByRole("option", { name: "This thread · Build thread" })).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: "This project · acme-web" })).toBeInTheDocument();
    const projects = within(within(dialog).getByRole("group", { name: "Projects" })).getAllByRole("option");
    expect(projects.map(option => option.textContent)).toEqual(["docs /src/docs", "docs · Build host /srv/docs"]);
  });

  it("adopts the thread's project when the snapshot arrives after the panel", async () => {
    const { store: base, api } = fixture();
    const { store, publish } = withSnapshot(base, undefined);
    render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "docs-build" }} />);
    publish(projectCatalog);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    expect(addRow()).toHaveAttribute("placeholder", "New workpad in this project…");
    await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: { kind: "project", projectId: "project-docs-build" },
    })));
  });

  it("follows the thread's project when the chat moves to another project", async () => {
    const { store: base, api } = fixture();
    const { store } = withSnapshot(base, projectCatalog);
    const context = { ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" };
    const view = render(<Panel context={context} />);
    fireEvent.click(segment("Project"));
    await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-web" } })));
    view.rerender(<Panel context={{ ...context, threadId: "thread-docs", workspaceId: "docs-local" }} />);
    expect(segment("Project")).toBeChecked();
    await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-docs" } })));
  });

  it.each(["Thread", "Project"])("holds the %s scope controls while creating and shows the result", async kind => {
    let resolveCreated!: (value: Workpad) => void;
    const createWorkpad = vi.fn(() => new Promise<Workpad>(resolve => { resolveCreated = resolve; }));
    const { store: base } = fixture({ createWorkpad });
    const { store } = withSnapshot(base, projectCatalog);
    const context = { ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" };
    render(<Panel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: kind }));
    create("Pending creation");
    expect(createWorkpad).toHaveBeenCalled();
    expect(context.host.setBusy).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("radio", { name: "Global" })).toBeDisabled();
    // The view's options cannot change what it lists either.
    viewOptions();
    expect(screen.getByRole("menuitemradio", { name: "Title" })).toHaveAttribute("aria-disabled", "true");
    closeMenu();
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    expect(screen.getByRole("radio", { name: kind })).toBeChecked();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => { resolveCreated(pad); });
    expect(await screen.findByRole("textbox", { name: "Workpad content" })).toHaveValue("Original");
    backToList();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Global" })).toBeEnabled());
    expect(context.host.setBusy).toHaveBeenLastCalledWith(false);
    viewOptions();
    expect(screen.getByRole("menuitemradio", { name: "Title" })).not.toHaveAttribute("aria-disabled");
  });

  it("keeps a Thread editor when only the thread's project changes", async () => {
    const { store: base, api } = fixture();
    const { store, publish } = withSnapshot(base, projectCatalog);
    render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Thread typing" } });
    publish({ ...projectCatalog, workspaces: projectCatalog.workspaces.map(workspace => workspace.id === "web-build" ? { ...workspace, projectId: "project-docs" } : workspace) });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(editor).toHaveValue("Thread typing");
    expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "thread", threadId: "thread-build" } }));
  });

  it.each([false, true])("honors one leave confirmation after a catalog update (project changed: %s)", async reassigned => {
    const { store: base } = fixture();
    const { store: catalogStore, publish } = withSnapshot(base, projectCatalog);
    const store = { ...catalogStore, workspaceIdForThread: () => "docs-local" } as unknown as ApplicationClientStore;
    const context = { ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" };
    navigate("/threads/thread-build");
    const view = render(<Panel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Unsynced before navigating" } });
    act(() => navigate("/threads/thread-docs"));
    publish({ ...projectCatalog, workspaces: projectCatalog.workspaces.map(workspace => reassigned && workspace.id === "web-build" ? { ...workspace, projectId: "project-docs-build" } : workspace) });
    expect(editor).toHaveValue("Unsynced before navigating");
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    expect(window.location.pathname).toBe("/threads/thread-docs");
    view.rerender(<Panel context={{ ...context, threadId: "thread-docs", workspaceId: "docs-local" }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
  });

  it("retains a project editor within its project and guards leaving that project", async () => {
    const { store: base, api } = fixture();
    const { store: catalogStore } = withSnapshot(base, projectCatalog);
    const store = { ...catalogStore, workspaceIdForThread: (id: string) => id === "thread-local" ? "web-local" : "docs-local" } as ApplicationClientStore;
    const context = { ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" };
    navigate("/threads/thread-build");
    const view = render(<Panel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Project typing" } });
    act(() => navigate("/threads/thread-local"));
    expect(window.location.pathname).toBe("/threads/thread-local");
    view.rerender(<Panel context={{ ...context, threadId: "thread-local", workspaceId: "web-local" }} />);
    expect(screen.getByRole("textbox", { name: "Workpad content" })).toBe(editor);
    expect(editor).toHaveValue("Project typing");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => navigate("/threads/thread-docs"));
    expect(screen.getByRole("dialog", { name: "Leave unsynced workpad?" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/threads/thread-local");
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    view.rerender(<Panel context={{ ...context, threadId: "thread-docs", workspaceId: "docs-local" }} />);
    expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-docs" } }));
    expect(api.saveWorkpadDraft).not.toHaveBeenCalled();
  });

  it("does not reuse a leave approval when another navigation blocker keeps the old thread", async () => {
    const { store: base } = fixture();
    const { store: catalogStore, publish } = withSnapshot(base, projectCatalog);
    const store = { ...catalogStore, workspaceIdForThread: () => "docs-local" } as unknown as ApplicationClientStore;
    const context = { ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" };
    navigate("/threads/thread-build");
    render(<Panel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Protected typing" } });
    const removeBlocker = installNavigationBlocker(() => false);
    try {
      act(() => navigate("/threads/second-thread"));
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Leave anyway" })); });
      expect(window.location.pathname).toBe("/threads/thread-build");
      publish({ ...projectCatalog, workspaces: projectCatalog.workspaces.map(workspace => workspace.id === "web-build" ? { ...workspace, projectId: "project-docs" } : workspace) });
      expect(screen.getByRole("dialog", { name: "Leave unsynced workpad?" })).toBeInTheDocument();
      expect(editor).toBeInTheDocument();
      expect(editor).toHaveValue("Protected typing");
    } finally {
      removeBlocker();
    }
  });

  it("dismisses an obsolete scope-change dialog when the workspace returns to its original project", async () => {
    const { store: base } = fixture();
    const { store, publish } = withSnapshot(base, projectCatalog);
    const context = { ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" };
    render(<Panel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Still in the original project" } });
    publish({ ...projectCatalog, workspaces: projectCatalog.workspaces.map(workspace => workspace.id === "web-build" ? { ...workspace, projectId: "project-docs" } : workspace) });
    expect(screen.getByRole("dialog", { name: "Leave unsynced workpad?" })).toBeInTheDocument();
    publish(projectCatalog);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Workpad content" })).toBe(editor);
    expect(editor).toHaveValue("Still in the original project");
  });

  it.each(["Keep editing", "Leave anyway"])("protects unsynced text when the active workspace changes projects: %s", async choice => {
    const { store: base, api } = fixture();
    const { store, publish } = withSnapshot(base, projectCatalog);
    const context = { ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" };
    render(<Panel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Typing during reassociation" } });
    publish({ ...projectCatalog, workspaces: projectCatalog.workspaces.map(workspace => workspace.id === "web-build" ? { ...workspace, projectId: "project-docs" } : workspace) });
    expect(screen.getByRole("dialog", { name: "Leave unsynced workpad?" })).toBeInTheDocument();
    expect(editor).toHaveValue("Typing during reassociation");
    fireEvent.click(screen.getByRole("button", { name: choice }));
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    if (choice === "Keep editing") {
      expect(screen.getByRole("textbox", { name: "Workpad content" })).toBe(editor);
      expect(editor).toHaveValue("Typing during reassociation");
      expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-web" } }));
    } else {
      expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
      expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-docs" } }));
      expect(api.saveWorkpadDraft).not.toHaveBeenCalled();
    }
  });

  it("does not reuse the previous project while the new thread's project is unavailable", async () => {
    const { store: base, api } = fixture();
    const { store, publish } = withSnapshot(base, projectCatalog);
    const context = { ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" };
    const view = render(<Panel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    await openRow();
    await screen.findByText("Original");
    vi.useFakeTimers();
    view.rerender(<Panel context={{ ...context, threadId: "thread-new", workspaceId: "new-location" }} />);
    expect(screen.queryByText("Original")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    // Without a project, Project is unavailable and Workpads shows Global, as Tasks does.
    expect(segment("Project")).toBeDisabled();
    expect(segment("Global")).toBeChecked();
    expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "global" }, scopeMode: "exact" }));
    publish({ ...projectCatalog, workspaces: [...projectCatalog.workspaces, { ...projectCatalog.workspaces[2], id: "new-location" }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-docs" } }));
  });

  it("names where each row belongs in lists that mix scopes, and the open workpad's place", async () => {
    const projectPad: Workpad = { ...pad, id: "project-pad", title: "Project notes", scope: { kind: "project", projectId: "project-web" } };
    const threadPad: Workpad = { ...pad, id: "thread-pad", title: "Thread notes", scope: { kind: "thread", threadId: "thread-build" } };
    const globalPad: Workpad = { ...pad, id: "global-pad", title: "Global notes" };
    const listWorkpads = vi.fn(async (request?: Record<string, unknown>) => ({
      items: request?.scopeMode === "subtree" ? (request.scope as { kind: string }).kind === "global" ? [globalPad, projectPad, threadPad] : [projectPad, threadPad]
        : (request?.scope as { kind: string }).kind === "project" ? [projectPad] : [pad],
    }));
    const { store: base } = fixture({
      listWorkpads,
      getWorkpad: vi.fn(async () => projectPad),
      getWorkpadRevision: vi.fn(async () => ({ ...revision, scope: projectPad.scope })),
    });
    const { store } = withSnapshot(base, projectCatalog);
    render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
    // One scope in view needs no line on its rows.
    expect(await screen.findByRole("button", { name: "Integration" })).not.toHaveAttribute("aria-describedby");
    fireEvent.click(segment("Project"));
    viewOptions();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Include thread workpads" }));
    closeMenu();
    // Project with its threads' workpads names each row's place, as Tasks
    // rows do: a thread where it runs, its project having two locations.
    expect(await screen.findByRole("button", { name: "Thread notes" })).toHaveAccessibleDescription("In Build thread · Build host");
    expect(screen.getByRole("button", { name: "Project notes" })).toHaveAccessibleDescription("In acme-web");
    expect(screen.getByRole("button", { name: "Thread notes" }).querySelector(".scope-location")).toHaveTextContent("Build thread · Build host");
    // All adds a thread's project.
    fireEvent.click(segment("All"));
    expect(await screen.findByRole("button", { name: "Global notes" })).toHaveAccessibleDescription("In Global");
    expect(screen.getByRole("button", { name: "Thread notes" })).toHaveAccessibleDescription("In Build thread · acme-web · Build host");
    // The open workpad names its place the same way, never a generic kind.
    fireEvent.click(screen.getByRole("button", { name: "Project notes" }));
    await screen.findByRole("button", { name: "Edit workpad" });
    expect(document.querySelector(".workpads-doc-meta")).toHaveTextContent(/^Revision 1 · .+ · You · acme-web$/);
    expect(document.querySelector(".workpads-doc-scope .lucide-folder")).not.toBeNull();
  });

  describe("header, toolbar and document controls", () => {
    it("keeps the panel header and scope control while a workpad is open, its toolbar leading with the title", async () => {
      const { store, api } = fixture();
      const context = panelContext(store);
      const view = render(<Panel context={context} />);
      await openRow();
      await screen.findByRole("button", { name: "Edit workpad" });
      // The header stays Workpads, with its icon, search and View options.
      expect(header()).toHaveTextContent(/^Workpads$/);
      expect(header().querySelector(".lucide-notepad-text")).not.toBeNull();
      expect(within(header()).getByRole("button", { name: "Search workpads" })).toBeInTheDocument();
      expect(within(header()).getByRole("button", { name: "View options" })).toBeInTheDocument();
      expect(context.host.setSubtitle).not.toHaveBeenCalled();
      // The scope control stays above the document; the add row and chips do not.
      expect(segment("Global")).toBeChecked();
      expect(screen.queryByRole("textbox", { name: "New workpad title" })).not.toBeInTheDocument();
      // The document's own toolbar: the title, then its actions. The scope
      // control is the way back, so there is no back button of its own.
      const toolbar = document.querySelector(".workpads-doc-toolbar") as HTMLElement;
      expect(toolbar.firstElementChild).toHaveClass("workpads-doc-heading");
      expect(within(toolbar).getByRole("heading", { name: "Integration" })).toBeInTheDocument();
      expect(within(toolbar).getByRole("button", { name: "Workpad actions" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /back/i })).not.toBeInTheDocument();
      // The selected view says choosing it again goes back.
      expect(segment("Global")).toHaveAttribute("title", "Back to workpads");
      expect(segment("Global")).toHaveAccessibleDescription("0 workpads. Back to workpads");
      expect(segment("All")).not.toHaveAttribute("title");
      // Leaving an editor syncs its text first.
      fireEvent.change(await startEditing(), { target: { value: "Synced on the way out" } });
      backToList();
      await screen.findByRole("button", { name: "Integration" });
      expect(api.saveWorkpadDraft).toHaveBeenCalledWith("pad", { expectedRevision: 0, baseRevision: 1, content: "Synced on the way out" });
      expect(addRow()).toBeInTheDocument();
      // With the list shown, the selected view has nothing more to do.
      expect(segment("Global")).not.toHaveAttribute("title");
      expect(segment("Global")).toHaveAccessibleDescription("0 workpads");
      view.unmount();
      // Nothing is published to the panel's ⋯: it is the panel's own.
    });

    it("keeps document actions in the workpad's own ⋯, and only Discard draft… while editing", async () => {
      const { store } = fixture();
      render(<Panel context={panelContext(store)} />);
      await openRow();
      await screen.findByRole("button", { name: "Edit workpad" });
      // The panel's ⋯ is the panel's: Dock alone.
      expect(menuLabels(headerMenu())).toEqual(["Left", "Right", "Top", "Bottom"]);
      closeMenu();
      expect(menuLabels(documentMenu())).toEqual(["Rename…", "Move to", "Archive", "Delete…"]);
      // Delete… ends the menu, destructive and apart.
      expect(screen.getByRole("menuitem", { name: "Delete…" })).toHaveAttribute("data-variant", "destructive");
      expect(screen.getByRole("menuitem", { name: "Delete…" }).previousElementSibling).toHaveAttribute("role", "separator");
      closeMenu();
      await startEditing();
      expect(menuLabels(documentMenu())).toEqual(["Discard draft…"]);
      closeMenu();
      fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
      await screen.findByRole("button", { name: "Edit workpad" });
      expect(menuLabels(documentMenu())).toEqual(["Rename…", "Move to", "Archive", "Delete…"]);
    });

    it("creates from the add row and opens the new workpad in edit mode", async () => {
      const created: Workpad = { ...pad, id: "created", title: "Launch notes", content: "" };
      const createWorkpad = vi.fn(async () => created);
      const { store, api } = fixture({ createWorkpad });
      api.getWorkpad.mockResolvedValue(created);
      api.getWorkpadRevision.mockResolvedValue({ ...revision, ...created, workpadId: created.id });
      api.listWorkpadRevisions.mockResolvedValue({ items: [{ ...revision, ...created, workpadId: created.id }] });
      api.getWorkpadDraft.mockResolvedValue({ ...initialDraft, workpadId: created.id, content: "" });
      const context = { ...panelContext(store), threadId: "first-thread" };
      render(<Panel context={context} />);
      await screen.findByRole("button", { name: "Integration" });
      // A blank title creates nothing; Escape clears the row.
      create("   ");
      expect(createWorkpad).not.toHaveBeenCalled();
      fireEvent.change(addRow(), { target: { value: "Abandoned" } });
      fireEvent.keyDown(addRow(), { key: "Escape" });
      expect(addRow()).toHaveValue("");
      create("  Launch notes  ");
      expect(createWorkpad).toHaveBeenCalledWith({ title: "Launch notes", scope: { kind: "thread", threadId: "first-thread" } });
      const editor = await screen.findByRole("textbox", { name: "Workpad content" });
      expect(editor).toHaveValue("");
      expect(api.getWorkpad).toHaveBeenCalledWith("created");
      expect(api.getWorkpadDraft).toHaveBeenCalledWith("created");
      expect(screen.getByRole("button", { name: "Done editing" })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Launch notes" })).toBeInTheDocument();
      backToList();
      await waitFor(() => expect(addRow()).toHaveValue(""));
    });

    it("names the add row after the scope it creates in, and adds from All to Global", async () => {
      const createWorkpad = vi.fn(async () => pad);
      const { store: base } = fixture({ createWorkpad });
      const { store } = withSnapshot(base, projectCatalog);
      render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
      expect(addRow()).toHaveAttribute("placeholder", "New workpad in this thread…");
      fireEvent.click(segment("Project"));
      expect(addRow()).toHaveAttribute("placeholder", "New workpad in this project…");
      fireEvent.click(segment("Global"));
      expect(addRow()).toHaveAttribute("placeholder", "New global workpad…");
      fireEvent.click(segment("All"));
      expect(addRow()).toHaveAttribute("placeholder", "New global workpad…");
      create("Shared notes");
      expect(createWorkpad).toHaveBeenCalledWith({ title: "Shared notes", scope: { kind: "global" } });
    });

    it("renames and archives a listed workpad from its row ⋯ without opening it", async () => {
      const { store, api } = fixture();
      render(<Panel context={panelContext(store)} />);
      await screen.findByRole("button", { name: "Integration" });
      expect(menuLabels(openMenu("Actions for “Integration”"))).toEqual(["Rename…", "Move to", "Archive", "Delete…"]);
      expect(screen.getByRole("menuitem", { name: "Delete…" })).toHaveAttribute("data-variant", "destructive");
      choose("Rename…");
      const title = screen.getByRole("textbox", { name: "Workpad title" });
      expect(title).toHaveValue("Integration");
      fireEvent.change(title, { target: { value: "  " } });
      expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
      fireEvent.change(title, { target: { value: "Integration plan" } });
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
      await waitFor(() => expect(api.updateWorkpad).toHaveBeenCalledWith("pad", { expectedRevision: 1, title: "Integration plan" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      const lists = api.listWorkpads.mock.calls.length;
      openMenu("Actions for “Integration”");
      choose("Archive");
      await waitFor(() => expect(api.updateWorkpad).toHaveBeenLastCalledWith("pad", { expectedRevision: 1, archived: true }));
      await waitFor(() => expect(api.listWorkpads).toHaveBeenCalledTimes(lists + 1));
      expect(api.getWorkpad).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Edit workpad" })).not.toBeInTheDocument();
    });

    it("offers Unarchive on an open archived workpad and keeps it read-only", async () => {
      const archivedPad: Workpad = { ...pad, archivedAt: time };
      const { store, api } = fixture({ getWorkpad: vi.fn(async () => archivedPad) });
      render(<Panel context={panelContext(store)} />);
      await openRow();
      expect(await screen.findByText("This workpad is archived.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Edit workpad" })).toBeDisabled();
      expect(menuLabels(documentMenu())).toContain("Unarchive");
      closeMenu();
      fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));
      await waitFor(() => expect(api.updateWorkpad).toHaveBeenCalledWith("pad", { expectedRevision: 1, archived: false }));
    });

    it("marks a row last edited by someone else, never by you", async () => {
      const agent = { kind: "agent" as const, threadId: "thread-agent", clientId: null, name: "Planner", nameSnapshot: "Planner" };
      const { store } = fixture({ listWorkpads: vi.fn(async () => ({ items: [pad, { ...pad, id: "agent-pad", title: "Agent notes", author: agent }] })) });
      render(<Panel context={panelContext(store)} />);
      const meta = (title: string) => screen.getByRole("button", { name: title }).closest("li")!.querySelector(".workpads-row-meta");
      await screen.findByRole("button", { name: "Agent notes" });
      expect(within(meta("Agent notes") as HTMLElement).getByLabelText("Last edited by Planner")).toBeInTheDocument();
      expect(meta("Agent notes")).toHaveAttribute("title", expect.stringMatching(/^Last edited by Planner · /));
      expect(meta("Integration")!.querySelector(".workpads-row-agent")).toBeNull();
      expect(meta("Integration")).toHaveAttribute("title", expect.stringMatching(/^Last edited by you · /));
    });

    it("moves the open workpad to Global from its ⋯", async () => {
      const threadPad: Workpad = { ...pad, scope: { kind: "thread", threadId: "first-thread" } };
      const { store, api } = fixture({
        listWorkpads: vi.fn(async () => ({ items: [threadPad] })),
        getWorkpad: vi.fn(async () => threadPad),
        getWorkpadRevision: vi.fn(async () => ({ ...revision, scope: threadPad.scope })),
        updateWorkpad: vi.fn(async () => ({ ...pad, revision: 2 })),
      });
      render(<Panel context={{ ...panelContext(store), threadId: "first-thread" }} />);
      await openRow();
      await screen.findByRole("button", { name: "Edit workpad" });
      documentMenu();
      const move = openSubmenu("Move to");
      expect(menuLabels(move)).toEqual(["This threadCurrent", "This projectNo project", "Global", "Choose…"]);
      expect(within(move).getByRole("menuitem", { name: /^This thread/ })).toHaveAttribute("aria-disabled", "true");
      expect(within(move).getByRole("menuitem", { name: /^This project/ })).toHaveAttribute("aria-disabled", "true");
      api.getWorkpad.mockResolvedValue({ ...pad, revision: 2 });
      api.getWorkpadRevision.mockResolvedValue({ ...revision, revision: 2 });
      fireEvent.click(within(move).getByRole("menuitem", { name: "Global" }));
      await waitFor(() => expect(api.updateWorkpad).toHaveBeenCalledWith("pad", { expectedRevision: 1, scope: { kind: "global" } }));
      // The open workpad reloads with the result.
      await waitFor(() => expect(document.querySelector(".workpads-doc-meta")).toHaveTextContent(/^Revision 2 · .+ · Global$/));
      expect(api.getWorkpad).toHaveBeenCalledTimes(2);
    });

    it("moves a listed workpad to a chosen project through Move to › Choose…", async () => {
      const { store: base, api } = fixture();
      const { store } = withSnapshot(base, projectCatalog);
      render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
      fireEvent.click(screen.getByRole("radio", { name: "Global" }));
      await screen.findByRole("button", { name: "Integration" });
      openMenu("Actions for “Integration”");
      fireEvent.click(within(openSubmenu("Move to")).getByRole("menuitem", { name: "Choose…" }));
      const dialog = screen.getByRole("dialog", { name: "Move workpad" });
      expect(within(dialog).getByRole("option", { name: "Global" })).toHaveAttribute("aria-selected", "true");
      fireEvent.click(within(dialog).getByRole("option", { name: /^docs · Build host/ }));
      await waitFor(() => expect(api.updateWorkpad).toHaveBeenCalledWith("pad", { expectedRevision: 1, scope: { kind: "project", projectId: "project-docs-build" } }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(api.getWorkpad).not.toHaveBeenCalled();
    });

    it("renames against the revision live refresh last listed, not the one the dialog opened with", async () => {
      let listed = pad;
      const { store, api, emit } = fixture({ listWorkpads: vi.fn(async () => ({ items: [listed] })) });
      render(<Panel context={panelContext(store)} />);
      await screen.findByRole("button", { name: "Integration" });
      openMenu("Actions for “Integration”"); choose("Rename…");
      // An agent saves while the dialog is open; the list refresh carries it.
      listed = { ...pad, revision: 5 };
      await act(async () => { emit({ workpadId: pad.id, revision: 5, change: "document" }); });
      await waitFor(() => expect(api.listWorkpads.mock.calls.length).toBeGreaterThan(1));
      fireEvent.change(screen.getByRole("textbox", { name: "Workpad title" }), { target: { value: "Renamed" } });
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
      await waitFor(() => expect(api.updateWorkpad).toHaveBeenCalledWith("pad", { expectedRevision: 5, title: "Renamed" }));
    });

    it("keeps the discard confirmation open with its error when discarding fails", async () => {
      const { store } = fixture({ discardWorkpadDraft: vi.fn(async () => { throw new Error("Draft changed elsewhere."); }) });
      render(<Panel context={panelContext(store)} />);
      await openRow();
      await startEditing();
      await discardDraft();
      const dialog = await screen.findByRole("dialog", { name: "Discard draft?" });
      expect(await within(dialog).findByText("Draft changed elsewhere.")).toBeInTheDocument();
      // The editor stays open behind the modal confirmation.
      expect(screen.getByRole("textbox", { name: "Workpad content", hidden: true })).toBeInTheDocument();
    });

    it("shows Include thread workpads as a removable chip and a dot, in Project only", async () => {
      const { store: base, api } = fixture();
      const { store } = withSnapshot(base, projectCatalog);
      render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
      const options = () => screen.getByRole("button", { name: "View options" });
      expect(options()).not.toHaveAttribute("data-filtering");
      fireEvent.click(segment("Project"));
      viewOptions();
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Include thread workpads" }));
      closeMenu();
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-web" }, scopeMode: "subtree" })));
      expect(screen.getByRole("button", { name: "Remove filter: Thread workpads" })).toBeInTheDocument();
      expect(options()).toHaveAttribute("data-filtering", "true");
      // The option is Project's own: other views show neither.
      fireEvent.click(segment("Thread"));
      expect(screen.queryByRole("group", { name: "View filters" })).not.toBeInTheDocument();
      expect(options()).not.toHaveAttribute("data-filtering");
      fireEvent.click(segment("Project"));
      fireEvent.click(screen.getByRole("button", { name: "Remove filter: Thread workpads" }));
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-web" }, scopeMode: "exact" })));
      expect(screen.queryByRole("group", { name: "View filters" })).not.toBeInTheDocument();
      expect(getWorkpadsPanelPreferences().views.project.includeThreadWorkpads).toBe(false);
    });

    it("offers Sort and the view's own option in View options, remembered per view", async () => {
      const { store: base, api } = fixture();
      const { store } = withSnapshot(base, projectCatalog);
      render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
      await screen.findByRole("button", { name: "Integration" });
      const rows = (menu: HTMLElement) => [...menu.querySelectorAll("[role=menuitemradio], [role=menuitemcheckbox]")].map(item => item.textContent);
      // Thread and Global sort only; Recently updated is the panel's default.
      let menu = viewOptions();
      expect(rows(menu)).toEqual(["Newest", "Recently updated", "Title"]);
      expect(within(menu).queryByText("Show")).not.toBeInTheDocument();
      expect(screen.getByRole("menuitemradio", { name: "Recently updated" })).toHaveAttribute("aria-checked", "true");
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Title" }));
      closeMenu();
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "thread", threadId: "thread-build" }, sort: "title" })));
      fireEvent.click(segment("All"));
      menu = viewOptions();
      // All is one flat list: sort is its only option.
      expect(rows(menu)).toEqual(["Newest", "Recently updated", "Title"]);
      // Each view keeps its own sort.
      expect(screen.getByRole("menuitemradio", { name: "Recently updated" })).toHaveAttribute("aria-checked", "true");
      closeMenu();
      fireEvent.click(segment("Project"));
      expect(rows(viewOptions())).toEqual(["Newest", "Recently updated", "Title", "Include thread workpads"]);
      closeMenu();
      expect(getWorkpadsPanelPreferences().views.thread.sort).toBe("title");
      expect(getWorkpadsPanelPreferences().views.all.sort).toBe("updated");
    });

    it("opens search from the header and clears it on Escape or Close search", async () => {
      const { store, api } = fixture();
      render(<Panel context={panelContext(store)} />);
      await screen.findByRole("button", { name: "Integration" });
      const toggle = screen.getByRole("button", { name: "Search workpads" });
      expect(screen.queryByRole("textbox", { name: "Search workpads" })).not.toBeInTheDocument();
      fireEvent.change(openSearch(), { target: { value: "agreement" } });
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ query: "agreement" })));
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Search workpads" }), { key: "Escape" });
      expect(screen.queryByRole("textbox", { name: "Search workpads" })).not.toBeInTheDocument();
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      await waitFor(() => expect(api.listWorkpads.mock.lastCall).toEqual([expect.not.objectContaining({ query: expect.anything() })]));
      const search = openSearch();
      expect(search).toHaveValue("");
      fireEvent.change(search, { target: { value: "retry" } });
      fireEvent.click(screen.getByRole("button", { name: "Close search" }));
      expect(screen.queryByRole("textbox", { name: "Search workpads" })).not.toBeInTheDocument();
      fireEvent.click(toggle);
      expect(screen.getByRole("textbox", { name: "Search workpads" })).toHaveValue("");
      // The header button closes it too.
      fireEvent.click(toggle);
      expect(screen.queryByRole("textbox", { name: "Search workpads" })).not.toBeInTheDocument();
    });

    it("switches revisions from the History menu and returns to the latest", async () => {
      const { store, api } = fixture();
      const contents: Record<number, string> = { 0: "First words", 1: "Historical document", 2: "Current document" };
      api.getWorkpad.mockResolvedValue({ ...pad, revision: 2, content: contents[2]! });
      api.getWorkpadRevision.mockImplementation(async (_id?: string, number?: number) => ({ ...revision, revision: number ?? 2, content: contents[number ?? 2]! }));
      api.listWorkpadRevisions.mockResolvedValueOnce({ items: [{ ...revision, revision: 2 }, revision], nextCursor: "older" });
      api.listWorkpadRevisions.mockResolvedValueOnce({ items: [{ ...revision, revision: 0 }] });
      render(<Panel context={panelContext(store)} />);
      await openRow();
      await screen.findByText("Current document");
      openMenu("Revision history");
      const history = screen.getByRole("group", { name: "Revision" });
      expect(within(history).getAllByRole("menuitemradio").map(item => [item.textContent, item.getAttribute("aria-checked")])).toEqual([
        [expect.stringMatching(/^Revision 2 · latestYou · /), "true"],
        [expect.stringMatching(/^Revision 1You · /), "false"],
      ]);
      // Older revisions load into the open menu, the first one reading Created.
      choose("Older revisions");
      expect(await within(history).findByRole("menuitemradio", { name: /^CreatedYou · / })).toBeInTheDocument();
      expect(api.listWorkpadRevisions).toHaveBeenLastCalledWith("pad", "older");
      expect(screen.queryByRole("menuitem", { name: "Older revisions" })).not.toBeInTheDocument();
      fireEvent.click(within(history).getByRole("menuitemradio", { name: /^Revision 1/ }));
      await screen.findByText("Historical document");
      expect(screen.getByText("Viewing revision 1. The latest is revision 2.")).toBeInTheDocument();
      expect(document.querySelector(".workpads-doc-meta")).toHaveTextContent(/^Revision 1 · .+ · You · Global$/);
      fireEvent.click(screen.getByRole("button", { name: "Back to latest" }));
      await screen.findByText("Current document");
      expect(screen.queryByRole("button", { name: "Back to latest" })).not.toBeInTheDocument();
      chooseRevision(/^Created/);
      await screen.findByText("First words");
      expect(screen.getByText("Viewing the first version. The latest is revision 2.")).toBeInTheDocument();
    });

    it("keeps Save disabled until the text differs from its base", async () => {
      const { store } = fixture();
      render(<Panel context={panelContext(store)} />);
      await openRow();
      const editor = await startEditing();
      const save = screen.getByRole("button", { name: "Save workpad" });
      expect(save).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent("No changes");
      fireEvent.change(editor, { target: { value: "Original, amended" } });
      expect(save).toBeEnabled();
      fireEvent.change(editor, { target: { value: "Original" } });
      expect(save).toBeDisabled();
    });

    it("saves with Ctrl+S in the editor", async () => {
      const { store, api } = fixture();
      render(<Panel context={panelContext(store)} />);
      await openRow();
      const editor = await startEditing();
      // The shortcut is always taken from the browser, but saves only a change.
      expect(fireEvent.keyDown(editor, { key: "s", ctrlKey: true })).toBe(false);
      expect(api.commitWorkpadDraft).not.toHaveBeenCalled();
      fireEvent.change(editor, { target: { value: "Original, saved by shortcut" } });
      fireEvent.keyDown(editor, { key: "S", ctrlKey: true, shiftKey: true });
      expect(api.commitWorkpadDraft).not.toHaveBeenCalled();
      fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
      await waitFor(() => expect(api.commitWorkpadDraft).toHaveBeenCalledWith("pad", { expectedDraftRevision: 1, expectedRevision: 1 }));
      expect(api.saveWorkpadDraft).toHaveBeenCalledWith("pad", { expectedRevision: 0, baseRevision: 1, content: "Original, saved by shortcut" });
    });

    it("asks for confirmation before discarding the draft", async () => {
      const discardWorkpadDraft = vi.fn(async () => undefined);
      const { store } = fixture({ discardWorkpadDraft });
      render(<Panel context={panelContext(store)} />);
      await openRow();
      const editor = await startEditing();
      vi.useFakeTimers();
      fireEvent.change(editor, { target: { value: "Throwaway" } });
      documentMenu(); choose("Discard draft…");
      const dialog = screen.getByRole("dialog", { name: "Discard draft?" });
      expect(dialog).toHaveTextContent("Your unsaved edits to this workpad will be lost. Saved revisions are kept.");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(discardWorkpadDraft).not.toHaveBeenCalled();
      expect(editor).toHaveValue("Throwaway");
      await discardDraft();
      expect(discardWorkpadDraft).toHaveBeenCalledWith("pad", 0);
      expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Edit workpad" })).toBeInTheDocument();
    });

    // run() drops a second operation, so a control left enabled during a slow
    // commit would close its confirmation without doing anything.
    it("disables Discard draft… while another workpad operation runs", async () => {
      const commitWorkpadDraft = vi.fn(() => new Promise<never>(() => undefined));
      const { store } = fixture({ commitWorkpadDraft });
      render(<Panel context={panelContext(store)} />);
      await openRow();
      fireEvent.change(await startEditing(), { target: { value: "Original, committing" } });
      fireEvent.click(screen.getByRole("button", { name: "Save workpad" }));
      await waitFor(() => expect(commitWorkpadDraft).toHaveBeenCalled());
      // The way back waits too.
      expect(currentSegment()).toBeDisabled();
      documentMenu();
      expect(screen.getByRole("menuitem", { name: "Discard draft…" })).toHaveAttribute("aria-disabled", "true");
    });
  });

  describe("scope views and counts", () => {
    const counts: WorkpadCounts = {
      active: { thread: 2, project: 1, projectWithThreads: 4, global: 3, all: 9 },
      archived: { thread: 0, project: 0, projectWithThreads: 1, global: 0, all: 1 },
    };
    const labels = () => [...screen.getByRole("radiogroup", { name: "Workpad scope" }).querySelectorAll("[role=radio]")].map(node => node.textContent);

    it("shows Thread, Project, Global and All with their counts, Project's with its threads' while included", async () => {
      const { store: base, api } = fixture({ getWorkpadCounts: vi.fn(async () => counts) });
      const { store } = withSnapshot(base, projectCatalog);
      render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
      await waitFor(() => expect(labels()).toEqual(["Thread2", "Project1", "Global3", "All9"]));
      expect(api.getWorkpadCounts).toHaveBeenCalledWith({ threadId: "thread-build", projectId: "project-web" });
      expect(segment("Thread")).toHaveAccessibleDescription("2 workpads");
      expect(segment("Project")).toHaveAccessibleDescription("1 workpad");
      act(() => setWorkpadsViewOptions("project", { includeThreadWorkpads: true }));
      expect(labels()).toEqual(["Thread2", "Project4", "Global3", "All9"]);
    });

    it("disables an unavailable view with its reason, and opens on the next view that applies", async () => {
      const { store: base, api } = fixture();
      const archivedThread = { id: "thread-old", workspaceId: "web-build", title: { text: "Old thread" }, inventoryState: "archived" };
      const { store } = withSnapshot(base, { ...projectCatalog, threads: [...projectCatalog.threads, archivedThread] });
      // The tooltip's positioning measures its arrow.
      vi.stubGlobal("ResizeObserver", class { observe(): void {} unobserve(): void {} disconnect(): void {} });
      render(<Panel context={{ ...panelContext(store), threadId: "thread-old", workspaceId: "web-build" }} />);
      expect(segment("Thread")).toBeDisabled();
      expect(segment("Project")).toBeChecked();
      expect(screen.getByRole("radiogroup", { name: "Workpad scope" })).toHaveAccessibleDescription(
        "Thread: This thread is archived. Restore it to see its workpads.");
      // A disabled segment takes no pointer events: a tap lands on its slot.
      fireEvent.click(segment("Thread").parentElement!);
      expect(await screen.findByRole("tooltip")).toHaveTextContent("This thread is archived. Restore it to see its workpads.");
      await waitFor(() => expect(api.getWorkpadCounts).toHaveBeenCalledWith({ projectId: "project-web" }));
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-web" } })));
    });

    it("refetches counts whenever the list refreshes, but not for a search", async () => {
      const { store, api, emit } = fixture();
      render(<Panel context={{ ...panelContext(store), threadId: "first-thread" }} />);
      await screen.findByRole("button", { name: "Integration" });
      await waitFor(() => expect(api.getWorkpadCounts).toHaveBeenCalledTimes(1));
      await act(async () => { emit({ workpadId: pad.id, revision: 2, change: "document" }); });
      await waitFor(() => expect(api.getWorkpadCounts).toHaveBeenCalledTimes(2));
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      await waitFor(() => expect(api.getWorkpadCounts).toHaveBeenCalledTimes(3));
      openMenu("Actions for “Integration”"); choose("Archive");
      await waitFor(() => expect(api.getWorkpadCounts).toHaveBeenCalledTimes(4));
      fireEvent.change(openSearch(), { target: { value: "integration" } });
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ query: "integration" })));
      expect(api.getWorkpadCounts).toHaveBeenCalledTimes(4);
    });

    it("goes without counts when they cannot be read", async () => {
      const { store } = fixture({ getWorkpadCounts: vi.fn(async () => { throw new Error("Not found"); }) });
      render(<Panel context={{ ...panelContext(store), threadId: "first-thread" }} />);
      await screen.findByRole("button", { name: "Integration" });
      await waitFor(() => expect(screen.getByRole("button", { name: /^Archived/ })).toHaveTextContent(/^Archived$/));
      expect(labels()).toEqual(["Thread", "Project", "Global", "All"]);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("remembers the view it shows on this device", async () => {
      const { store } = fixture();
      const view = render(<Panel context={{ ...panelContext(store), threadId: "first-thread" }} />);
      expect(segment("Thread")).toBeChecked();
      fireEvent.click(segment("Global"));
      expect(getWorkpadsPanelPreferences().lastView).toBe("global");
      view.unmount();
      render(<Panel context={{ ...panelContext(store), threadId: "first-thread" }} />);
      expect(segment("Global")).toBeChecked();
    });
  });

  describe("All", () => {
    const globalPad: WorkpadSummary = { ...pad, id: "global-pad", title: "Global notes" };
    const webPad: WorkpadSummary = { ...pad, id: "web-pad", title: "Web notes", scope: { kind: "project", projectId: "project-web" } };
    const buildPad = (id: string, title: string): WorkpadSummary => ({ ...pad, id, title, scope: { kind: "thread", threadId: "thread-build" } });
    const docsPad: WorkpadSummary = { ...pad, id: "docs-pad", title: "Docs notes", scope: { kind: "project", projectId: "project-docs" } };
    const names = () => [...document.querySelectorAll(".workpads-row-name")].map(node => node.textContent);

    it("lists every workpad in one flat list, each row naming its place, and Load more continues it", async () => {
      const first = [webPad, globalPad, buildPad("build-1", "Build log")];
      const second = [buildPad("build-1", "Build log"), buildPad("build-2", "Build plan"), docsPad];
      const listWorkpads = vi.fn(async (request?: Record<string, unknown>) =>
        request?.cursor === "page-2" ? { items: second } : { items: first, nextCursor: "page-2" });
      const { store: base } = fixture({ listWorkpads });
      const { store } = withSnapshot(base, projectCatalog);
      render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
      fireEvent.click(segment("All"));
      // In the server's order, most recently updated first, under no headings.
      await waitFor(() => expect(names()).toEqual(["Web notes", "Global notes", "Build log"]));
      const request = listWorkpads.mock.lastCall![0]!;
      expect(request).toEqual({ scope: { kind: "global" }, scopeMode: "subtree", sort: "updated" });
      expect(document.querySelector(".list-heading")).toBeNull();
      // Each row's second line names its scope: Global, a project, or a
      // thread with its project and, the project having two locations, where it runs.
      expect(screen.getByRole("button", { name: "Global notes" })).toHaveAccessibleDescription("In Global");
      expect(screen.getByRole("button", { name: "Web notes" })).toHaveAccessibleDescription("In acme-web");
      expect(screen.getByRole("button", { name: "Build log" })).toHaveAccessibleDescription("In Build thread · acme-web · Build host");
      const icon = (title: string, name: string) => screen.getByRole("button", { name: title }).querySelector(`.scope-location .lucide-${name}`);
      expect(icon("Global notes", "globe")).not.toBeNull();
      expect(icon("Web notes", "folder")).not.toBeNull();
      expect(icon("Build log", "message-square")).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      // A workpad the next page repeats is listed once, where it came first.
      await waitFor(() => expect(names()).toEqual(["Web notes", "Global notes", "Build log", "Build plan", "Docs notes"]));
      expect(screen.getByRole("button", { name: "Docs notes" })).toHaveAccessibleDescription("In docs");
      // The panel's ⋯ has nothing to collapse.
      expect(menuLabels(headerMenu())).toEqual(["Left", "Right", "Top", "Bottom"]);
    });

    it("keeps the sort chosen for All, with no grouping to offer", async () => {
      const { store: base, api } = fixture({ listWorkpads: vi.fn(async () => ({ items: [globalPad, webPad] })) });
      const { store } = withSnapshot(base, projectCatalog);
      setWorkpadsViewOptions("all", { sort: "title" });
      setWorkpadsLastView("all");
      render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
      expect(await screen.findByRole("button", { name: "Web notes" })).toHaveAccessibleDescription("In acme-web");
      expect(api.listWorkpads.mock.lastCall![0]).toEqual({ scope: { kind: "global" }, scopeMode: "subtree", sort: "title" });
      viewOptions();
      expect(screen.queryByRole("menuitemcheckbox", { name: "Group by project" })).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitemcheckbox", { name: "Include thread workpads" })).not.toBeInTheDocument();
      closeMenu();
    });
  });

  describe("Archived section", () => {
    const archivedPad = (id: string, title: string, scope: Workpad["scope"] = { kind: "thread", threadId: "thread-build" }): Workpad =>
      ({ ...pad, id, title, scope, archivedAt: time });
    const archivedCounts = (thread: number): WorkpadCounts => ({ active: viewCounts({ thread: 1, project: 0, projectWithThreads: 1, global: 1, all: 2 }), archived: viewCounts({ thread, project: 0, projectWithThreads: thread, global: 0, all: thread }) });
    const heading = () => screen.getByRole("button", { name: /^Archived/ });

    it("ends the list collapsed with the view's archived count, and lists them, paged, when expanded", async () => {
      const listWorkpads = vi.fn(async (request?: Record<string, unknown>) => !request?.archived ? { items: [pad] }
        : request.cursor === "older" ? { items: [archivedPad("old-3", "Retired plan")] }
        : { items: [archivedPad("old-1", "Old notes"), archivedPad("old-2", "Old draft")], nextCursor: "older" });
      const { store: base, api } = fixture({ listWorkpads, getWorkpadCounts: vi.fn(async () => archivedCounts(3)), getWorkpad: vi.fn(async () => archivedPad("old-1", "Old notes")) });
      const { store } = withSnapshot(base, projectCatalog);
      render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
      await screen.findByRole("button", { name: "Integration" });
      await waitFor(() => expect(heading()).toHaveTextContent(/^Archived3$/));
      expect(heading()).toHaveAttribute("aria-expanded", "false");
      // The label leads, level with the rows' titles; the chevron follows the count.
      expect(heading().firstElementChild).toHaveClass("list-heading-label");
      expect(heading().lastElementChild).toHaveClass("list-heading-chevron");
      expect(screen.getByRole("region", { name: "Archived workpads" })).toBeInTheDocument();
      expect(api.listWorkpads).not.toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
      // The View options of the view apply: its scope and sort.
      act(() => setWorkpadsViewOptions("thread", { sort: "title" }));
      fireEvent.click(heading());
      expect(await screen.findByRole("button", { name: "Old draft" })).toBeInTheDocument();
      expect(api.listWorkpads).toHaveBeenCalledWith({ scope: { kind: "thread", threadId: "thread-build" }, scopeMode: "exact", sort: "title", archived: true });
      // Its rows offer Unarchive, not Archive.
      expect(menuLabels(openMenu("Actions for “Old notes”"))).toEqual(["Rename…", "Move to", "Unarchive", "Delete…"]);
      closeMenu();
      const section = screen.getByRole("region", { name: "Archived workpads" });
      fireEvent.click(within(section).getByRole("button", { name: "Load more" }));
      expect(await screen.findByRole("button", { name: "Retired plan" })).toBeInTheDocument();
      expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ archived: true, cursor: "older" }));
      // An archived workpad opens read-only, with Unarchive.
      fireEvent.click(screen.getByRole("button", { name: "Old notes" }));
      expect(await screen.findByText("This workpad is archived.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Edit workpad" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));
      await waitFor(() => expect(api.updateWorkpad).toHaveBeenCalledWith("old-1", { expectedRevision: 1, archived: false }));
    });

    it("is absent while the view has no archived workpads", async () => {
      const { store } = fixture({ getWorkpadCounts: vi.fn(async () => archivedCounts(0)) });
      render(<Panel context={{ ...panelContext(store), threadId: "thread-build" }} />);
      await screen.findByRole("button", { name: "Integration" });
      await waitFor(() => expect(segment("Thread")).toHaveAccessibleDescription("1 workpad"));
      expect(screen.queryByRole("button", { name: /^Archived/ })).not.toBeInTheDocument();
    });

    it("says when everything in the view is archived", async () => {
      const { store } = fixture({ listWorkpads: vi.fn(async () => ({ items: [] })), getWorkpadCounts: vi.fn(async () => archivedCounts(2)) });
      render(<Panel context={{ ...panelContext(store), threadId: "thread-build" }} />);
      expect(await screen.findByText("Nothing active.")).toBeInTheDocument();
      expect(screen.getByText("Every workpad here is archived.")).toBeInTheDocument();
    });

    it("refreshes an expanded section with the list, and archiving moves a row into it", async () => {
      let archived: Workpad[] = [];
      let active: Workpad[] = [pad];
      const listWorkpads = vi.fn(async (request?: Record<string, unknown>) => ({ items: request?.archived ? archived : active }));
      const updateWorkpad = vi.fn(async () => { active = []; archived = [{ ...pad, archivedAt: time, revision: 2 }]; return { ...pad, revision: 2 }; });
      const { store, api } = fixture({ listWorkpads, updateWorkpad, getWorkpadCounts: vi.fn(async () => archivedCounts(1)) });
      render(<Panel context={{ ...panelContext(store), threadId: "thread-build" }} />);
      await screen.findByRole("button", { name: "Integration" });
      fireEvent.click(await screen.findByRole("button", { name: /^Archived/ }));
      await waitFor(() => expect(listWorkpads).toHaveBeenCalledWith(expect.objectContaining({ archived: true })));
      expect(screen.getByText("No archived workpads")).toBeInTheDocument();
      openMenu("Actions for “Integration”"); choose("Archive");
      const section = screen.getByRole("region", { name: "Archived workpads" });
      expect(await within(section).findByRole("button", { name: "Integration" })).toBeInTheDocument();
      expect(api.updateWorkpad).toHaveBeenCalledWith("pad", { expectedRevision: 1, archived: true });
      expect(screen.getAllByRole("button", { name: "Integration" })).toHaveLength(1);
    });

    it("names each archived workpad's place in All", async () => {
      const listWorkpads = vi.fn(async (request?: Record<string, unknown>) => ({
        items: request?.archived ? [archivedPad("old-1", "Old notes", { kind: "project", projectId: "project-docs" })] : [pad],
      }));
      const { store: base } = fixture({ listWorkpads, getWorkpadCounts: vi.fn(async () => archivedCounts(1)) });
      const { store } = withSnapshot(base, projectCatalog);
      setWorkpadsLastView("all");
      render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
      fireEvent.click(await screen.findByRole("button", { name: /^Archived/ }));
      expect(await screen.findByRole("button", { name: "Old notes" })).toHaveAccessibleDescription("In docs");
      expect(listWorkpads).toHaveBeenCalledWith({ scope: { kind: "global" }, scopeMode: "subtree", sort: "updated", archived: true });
    });
  });

  describe("Delete", () => {
    const other: Workpad = { ...pad, id: "other", title: "Other" };
    const globalCounts = (global: number, archived = 0): WorkpadCounts => ({ active: viewCounts({ global, all: global }), archived: viewCounts({ global: archived, all: archived }) });
    const deleteDialog = () => screen.getByRole("dialog", { name: "Delete workpad?" });
    /** A list of `listed` until `deleteWorkpad` resolves, then without the deleted one. */
    function deletable(listed: Workpad[], archived: Workpad[] = []) {
      let deleted: string | undefined;
      let finish: (() => void) | undefined;
      const remaining = (items: Workpad[]) => items.filter(({ id }) => id !== deleted);
      const f = fixture({
        listWorkpads: vi.fn(async (request?: Record<string, unknown>) => ({ items: remaining(request?.archived ? archived : listed) })),
        getWorkpadCounts: vi.fn(async () => globalCounts(remaining(listed).length, remaining(archived).length)),
        deleteWorkpad: vi.fn((id: string) => new Promise<void>(resolve => { finish = () => { deleted = id; resolve(); }; })),
      });
      return { ...f, finish: async () => { await act(async () => { finish!(); }); } };
    }

    it("confirms deleting a listed workpad from its row ⋯, then drops its row, refreshes counts and announces it", async () => {
      const { store, api, finish } = deletable([pad, other]);
      const context = panelContext(store);
      render(<Panel context={context} />);
      await screen.findByRole("button", { name: "Other" });
      await waitFor(() => expect(segment("Global")).toHaveAccessibleDescription("2 workpads"));
      openMenu("Actions for “Integration”"); choose("Delete…");
      expect(deleteDialog()).toHaveAccessibleDescription("“Integration” will be permanently deleted, with its content, revision history, and any draft. This can’t be undone.");
      // Cancel deletes nothing.
      fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(api.deleteWorkpad).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Integration" })).toBeInTheDocument();

      const lists = api.listWorkpads.mock.calls.length;
      const counts = api.getWorkpadCounts.mock.calls.length;
      openMenu("Actions for “Integration”"); choose("Delete…");
      const confirm = within(deleteDialog()).getByRole("button", { name: "Delete" });
      expect(confirm).toHaveAttribute("data-variant", "destructive");
      fireEvent.click(confirm);
      expect(api.deleteWorkpad).toHaveBeenCalledExactlyOnceWith("pad");
      // Busy like any other workpad change, until it completes.
      expect(within(deleteDialog()).getByRole("button", { name: "Deleting…" })).toBeDisabled();
      expect(context.host.setBusy).toHaveBeenLastCalledWith(true);
      await finish();
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Integration" })).not.toBeInTheDocument();
      expect(api.listWorkpads.mock.calls.length).toBeGreaterThan(lists);
      expect(api.getWorkpadCounts.mock.calls.length).toBeGreaterThan(counts);
      await waitFor(() => expect(segment("Global")).toHaveAccessibleDescription("1 workpad"));
      expect(await screen.findByRole("status")).toHaveTextContent("Deleted “Integration”.");
      // Focus moves to the next row, as the deleted one's ⋯ is gone.
      expect(screen.getByRole("button", { name: "Other" })).toHaveFocus();
      expect(context.host.setBusy).toHaveBeenLastCalledWith(false);
      expect(api.getWorkpad).not.toHaveBeenCalled();
    });

    it("deletes the open workpad from its toolbar ⋯ and returns to the list", async () => {
      const { store, api, finish } = deletable([pad, other]);
      render(<Panel context={panelContext(store)} />);
      await openRow();
      await screen.findByRole("button", { name: "Edit workpad" });
      documentMenu(); choose("Delete…");
      fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Delete" }));
      await finish();
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.deleteWorkpad).toHaveBeenCalledExactlyOnceWith("pad");
      expect(screen.queryByRole("button", { name: "Workpad actions" })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Integration" })).not.toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Other" })).toHaveFocus();
      expect(screen.queryByRole("button", { name: "Integration" })).not.toBeInTheDocument();
      expect(addRow()).toBeInTheDocument();
      expect(segment("Global")).not.toHaveAttribute("title");
    });

    it("deletes an archived workpad, refreshing the Archived section and its count", async () => {
      const archived: Workpad = { ...pad, id: "old", title: "Old notes", archivedAt: time };
      const { store, api, finish } = deletable([other], [archived, { ...archived, id: "older", title: "Older notes" }]);
      render(<Panel context={panelContext(store)} />);
      const heading = () => screen.getByRole("button", { name: /^Archived/ });
      await waitFor(() => expect(heading()).toHaveTextContent(/^Archived2$/));
      fireEvent.click(heading());
      await screen.findByRole("button", { name: "Old notes" });
      openMenu("Actions for “Old notes”"); choose("Delete…");
      fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Delete" }));
      await finish();
      await waitFor(() => expect(heading()).toHaveTextContent(/^Archived1$/));
      expect(api.deleteWorkpad).toHaveBeenCalledExactlyOnceWith("old");
      expect(screen.queryByRole("button", { name: "Old notes" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Older notes" })).toHaveFocus();
    });

    it("keeps the confirmation open with the error when deleting fails", async () => {
      const { store, api } = fixture({ deleteWorkpad: vi.fn(async () => { throw new ApiError(404, "not_found", "The workpad was not found.", false); }) });
      render(<Panel context={panelContext(store)} />);
      await openRow();
      await screen.findByRole("button", { name: "Edit workpad" });
      documentMenu(); choose("Delete…");
      await act(async () => { fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Delete" })); });
      expect(within(deleteDialog()).getByRole("alert")).toHaveTextContent("The workpad was not found.");
      expect(api.deleteWorkpad).toHaveBeenCalledOnce();
      fireEvent.click(within(deleteDialog()).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      // The workpad stays open, and the panel itself reports nothing.
      expect(screen.getByRole("heading", { name: "Integration" })).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText(/^Deleted/)).not.toBeInTheDocument();
    });

    it("closes a workpad deleted elsewhere, but keeps an open editor's text", async () => {
      const gone = new ApiError(404, "not_found", "The workpad was not found.", false);
      const { store, api, emit } = fixture();
      render(<Panel context={panelContext(store)} />);
      await openRow();
      await screen.findByRole("button", { name: "Edit workpad" });
      // An editor keeps its text on screen, so it can still be copied.
      fireEvent.change(await startEditing(), { target: { value: "Unsaved words" } });
      api.getWorkpad.mockRejectedValue(gone);
      api.getWorkpadDraft.mockRejectedValue(gone);
      api.listWorkpads.mockResolvedValue({ items: [] });
      act(() => emit({ workpadId: pad.id, revision: 1, change: "document" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("The workpad was not found.");
      expect(screen.getByRole("textbox", { name: "Workpad content" })).toHaveValue("Unsaved words");
      cleanup();

      const reading = fixture();
      render(<Panel context={panelContext(reading.store)} />);
      await openRow();
      await screen.findByRole("button", { name: "Edit workpad" });
      reading.api.getWorkpad.mockRejectedValue(gone);
      reading.api.listWorkpads.mockResolvedValue({ items: [] });
      act(() => reading.emit({ workpadId: pad.id, revision: 1, change: "document" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("“Integration” was deleted.");
      expect(screen.queryByRole("heading", { name: "Integration" })).not.toBeInTheDocument();
      expect(addRow()).toBeInTheDocument();
      expect(reading.api.deleteWorkpad).not.toHaveBeenCalled();
    });
  });

  describe("an open workpad", () => {
    it("returns to a view's list from its segment, and to its own view's by choosing it again", async () => {
      const { store, api } = fixture();
      render(<Panel context={{ ...panelContext(store), threadId: "first-thread" }} />);
      await openRow();
      await screen.findByRole("button", { name: "Edit workpad" });
      fireEvent.click(segment("Global"));
      expect(await screen.findByRole("button", { name: "Integration" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Integration" })).not.toBeInTheDocument();
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "global" } })));
      await openRow();
      await screen.findByRole("button", { name: "Edit workpad" });
      fireEvent.click(segment("Global"));
      expect(await screen.findByRole("textbox", { name: "New workpad title" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Edit workpad" })).not.toBeInTheDocument();
      expect(segment("Global")).toBeChecked();
    });

    it("returns to the list from the keyboard: Enter or Space on the selected view", async () => {
      const user = userEvent.setup();
      const { store, api } = fixture();
      render(<Panel context={{ ...panelContext(store), threadId: "first-thread" }} />);
      for (const key of ["{Enter}", " "]) {
        await openRow();
        // An editor's text syncs on the way out, as on every way back.
        fireEvent.change(await startEditing(), { target: { value: `Typed before ${key}` } });
        // The selected segment is the scope control's tab stop.
        segment("Thread").focus();
        expect(segment("Thread")).toHaveFocus();
        await user.keyboard(key);
        expect(await screen.findByRole("textbox", { name: "New workpad title" })).toBeInTheDocument();
        expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
        expect(api.saveWorkpadDraft).toHaveBeenLastCalledWith("pad", expect.objectContaining({ content: `Typed before ${key}` }));
        expect(segment("Thread")).toBeChecked();
      }
    });

    it("returns to the list for Search and for View options", async () => {
      const { store, api } = fixture();
      render(<Panel context={{ ...panelContext(store), threadId: "first-thread" }} />);
      await openRow();
      await screen.findByRole("button", { name: "Edit workpad" });
      fireEvent.click(screen.getByRole("button", { name: "Search workpads" }));
      expect(await screen.findByRole("textbox", { name: "Search workpads" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Edit workpad" })).not.toBeInTheDocument();
      await openRow();
      await screen.findByRole("button", { name: "Edit workpad" });
      // The search waits for the list, open as it was left.
      expect(screen.queryByRole("textbox", { name: "Search workpads" })).not.toBeInTheDocument();
      viewOptions();
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Newest" }));
      closeMenu();
      await waitFor(() => expect(screen.queryByRole("button", { name: "Edit workpad" })).not.toBeInTheDocument());
      expect(screen.getByRole("textbox", { name: "Search workpads" })).toBeInTheDocument();
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "newest" })));
    });

    it("confirms leaving unsynced text before another view replaces it", async () => {
      const { store, api } = fixture();
      render(<Panel context={{ ...panelContext(store), threadId: "first-thread" }} />);
      await openRow();
      const editor = await startEditing();
      vi.useFakeTimers();
      fireEvent.change(editor, { target: { value: "Unsynced before switching" } });
      fireEvent.click(segment("Global"));
      expect(screen.getByRole("dialog", { name: "Leave unsynced workpad?" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
      expect(segment("Thread")).toBeChecked();
      expect(editor).toHaveValue("Unsynced before switching");
      expect(getWorkpadsPanelPreferences().lastView).toBe("thread");
      fireEvent.click(segment("Global"));
      fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
      expect(segment("Global")).toBeChecked();
      expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "global" } }));
      expect(api.saveWorkpadDraft).not.toHaveBeenCalled();
    });

    it("closes on Android Back, which a list or a hidden panel leaves alone", async () => {
      const { store } = fixture();
      const context = panelContext(store);
      const view = render(<Panel context={context} />);
      await screen.findByRole("button", { name: "Integration" });
      const androidBack = () => { const event = new Event(CLOSE_WORKPAD_EVENT, { cancelable: true }); act(() => { window.dispatchEvent(event); }); return event.defaultPrevented; };
      expect(androidBack()).toBe(false);
      await openRow();
      await screen.findByRole("button", { name: "Edit workpad" });
      view.rerender(<Panel context={{ ...context, visible: false }} />);
      expect(androidBack()).toBe(false);
      view.rerender(<Panel context={context} />);
      expect(androidBack()).toBe(true);
      expect(await screen.findByRole("textbox", { name: "New workpad title" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Edit workpad" })).not.toBeInTheDocument();
    });
  });
});
