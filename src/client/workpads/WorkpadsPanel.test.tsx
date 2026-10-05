// @vitest-environment jsdom
import { useSyncExternalStore, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import type { Workpad, WorkpadDraft, WorkpadRevision } from "../../shared/protocol/workpads.js";
import { WorkpadsPanel } from "./WorkpadsPanel.js";
import { workpadsTenant } from "./workpads-tenant.js";
import type { WorkspacePanelBack, WorkspacePanelContext, WorkspacePanelHost } from "../workspace-panels/registry.js";
import { PanelChrome, type PanelChromeStatus } from "../workspace-panels/PanelChrome.js";
import { StablePaneSlot } from "../workspace-panels/StablePaneSlot.js";
import { installNavigationBlocker, navigate } from "../app/router.js";
const author = { kind: "user" as const, threadId: null, clientId: null, name: "You", nameSnapshot: "You" };
const time = "2026-09-08T00:00:00.000Z";
const pad: Workpad = { id: "pad", title: "Integration", scope: { kind: "global" }, revision: 1, content: "Original", attribution: [], author, archivedAt: null, createdAt: time, updatedAt: time };
const revision: WorkpadRevision = { ...pad, workpadId: pad.id, changes: [] };
const initialDraft: WorkpadDraft = { workpadId: pad.id, revision: 0, baseRevision: 1, content: pad.content, updatedAt: time };
function fixture(overrides: Record<string, unknown> = {}) {
  let savedDraft = initialDraft;
  const api = {
    listWorkpads: vi.fn(async () => ({ items: [pad] })),
    getWorkpad: vi.fn(async () => pad),
    getWorkpadRevision: vi.fn(async () => revision),
    listWorkpadRevisions: vi.fn(async (_id: string, _cursor?: string): Promise<{ items: WorkpadRevision[]; nextCursor?: string }> => ({ items: [revision] })),
    getWorkpadDraft: vi.fn(async () => savedDraft),
    saveWorkpadDraft: vi.fn(async (_id: string, value: { expectedRevision: number; baseRevision: number; content: string }) => { savedDraft = { ...savedDraft, ...value, revision: value.expectedRevision + 1 }; return savedDraft; }),
    commitWorkpadDraft: vi.fn(async () => ({ workpad: { ...pad, revision: 2 }, draft: { ...savedDraft, revision: 2 } })),
    updateWorkpad: vi.fn(async (_id: string, _change: object) => ({ ...pad, revision: 2 })),
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
    setBack: vi.fn((back?: WorkspacePanelBack) => publish({ back })),
    setMenuItems: vi.fn((menuItems?: ReactNode) => publish({ menuItems })),
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
      controls={{ onCollapse: () => undefined, onClose: () => undefined, onDock: () => undefined, renderMenuItems: status.menuItems }} />
    <WorkpadsPanel context={context} />
  </>;
}
const header = () => screen.getByRole("banner", { name: "Workpads panel header" });
const openRow = async (name = "Integration") => { fireEvent.click(await screen.findByRole("button", { name })); };
/** Opens a dropdown from its trigger, as Radix expects a primary pointer press. */
const openMenu = (trigger: string) => { fireEvent.pointerDown(screen.getByRole("button", { name: trigger }), { button: 0, ctrlKey: false }); return screen.getAllByRole("menu").at(-1)!; };
const headerMenu = () => openMenu("Workpads panel actions");
const viewOptions = () => openMenu("View options");
const closeMenu = () => { fireEvent.keyDown(screen.getAllByRole("menu").at(-1)!, { key: "Escape" }); };
const choose = (name: string | RegExp) => { fireEvent.click(screen.getByRole("menuitem", { name })); };
const menuLabels = (menu: HTMLElement) => [...menu.querySelectorAll("[role^=menuitem]")].map(item => item.textContent);
/** Opens a submenu from its row in the open menu. */
const openSubmenu = (name: string) => { fireEvent.click(screen.getByRole("menuitem", { name })); return screen.getByRole("menu", { name }); };
const addRow = () => screen.getByRole("textbox", { name: "New workpad title" }) as HTMLInputElement;
const create = (title: string) => { fireEvent.change(addRow(), { target: { value: title } }); fireEvent.submit(addRow().form!); };
/** The open workpad's header ⋯ › Rename…, then the dialog's title and Rename. */
const rename = (title: string) => {
  headerMenu(); choose("Rename…");
  fireEvent.change(screen.getByRole("textbox", { name: "Workpad title" }), { target: { value: title } });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
};
/** View options › Browse another thread or project…, then one destination. */
const browse = (option: string | RegExp) => {
  viewOptions(); choose("Browse another thread or project…");
  fireEvent.click(within(screen.getByRole("dialog", { name: "Browse workpads" })).getByRole("option", { name: option }));
};
const openSearch = () => { fireEvent.click(screen.getByRole("button", { name: "Search workpads" })); return screen.getByRole("textbox", { name: "Search workpads" }); };
const chooseRevision = (name: RegExp) => { openMenu("Revision history"); fireEvent.click(screen.getByRole("menuitemradio", { name })); };
const startEditing = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
  return screen.findByRole("textbox", { name: "Workpad content" });
};
/** The header ⋯ › Discard draft…, then the confirmation. */
const discardDraft = async () => {
  headerMenu(); choose("Discard draft…");
  await act(async () => { fireEvent.click(within(screen.getByRole("dialog", { name: "Discard draft?" })).getByRole("button", { name: "Discard draft" })); });
};
beforeEach(() => {
  navigate("/", { replace: true });
  // PanelChrome reads the single-pane query; this is the docked desktop layout.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
  // The destination pickers scroll their active option into view; jsdom has no layout.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView"); });
describe("WorkpadsPanel", () => {
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
    act(() => navigate("/threads/first-thread/automation"));
    expect(window.location.pathname).toBe("/threads/first-thread/automation");
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
    headerMenu();
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

  it("scopes Project to the thread's project and lists each project once by its label", async () => {
    const { store: base, api } = fixture();
    const { store } = withSnapshot(base, projectCatalog);
    // The thread runs in acme-web's build-host location.
    render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
    await waitFor(() => expect(api.listWorkpads).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    expect(addRow()).toHaveAttribute("placeholder", "New workpad in this project…");
    await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: { kind: "project", projectId: "project-web" }, scopeMode: "exact",
    })));
    // Browsing offers each project once, the one in view selected.
    viewOptions(); choose("Browse another thread or project…");
    const dialog = screen.getByRole("dialog", { name: "Browse workpads" });
    const projects = within(within(dialog).getByRole("group", { name: "Projects" })).getAllByRole("option");
    expect(projects.map(option => option.textContent)).toEqual([
      "acme-web 2 locations · Local, Build host", "docs /src/docs", "docs · Build host /srv/docs",
    ]);
    expect(projects.map(option => option.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
  });

  it("adopts the thread's project when the snapshot arrives after the panel", async () => {
    const { store: base, api } = fixture();
    const { store, publish } = withSnapshot(base, undefined);
    render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "docs-build" }} />);
    publish(projectCatalog);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    // The thread's own project: nothing is being browsed.
    expect(addRow()).toHaveAttribute("placeholder", "New workpad in this project…");
    expect(screen.queryByRole("button", { name: /^Remove filter/ })).not.toBeInTheDocument();
    await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: { kind: "project", projectId: "project-docs-build" },
    })));
  });

  it("follows the active project after a manual project selection", async () => {
    const { store: base, api } = fixture();
    const { store } = withSnapshot(base, projectCatalog);
    const context = { ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" };
    const view = render(<Panel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    browse(/^docs · Build host/);
    await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-docs-build" } })));
    expect(screen.getByRole("button", { name: "Remove filter: docs · Build host" })).toBeInTheDocument();
    view.rerender(<Panel context={{ ...context, threadId: "thread-docs", workspaceId: "docs-local" }} />);
    expect(screen.queryByRole("button", { name: /^Remove filter/ })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Project" })).toBeChecked();
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
    // The thread or project in view cannot be swapped out either.
    viewOptions();
    expect(screen.getByRole("menuitem", { name: "Browse another thread or project…" })).toHaveAttribute("aria-disabled", "true");
    closeMenu();
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    expect(screen.getByRole("radio", { name: kind })).toBeChecked();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => { resolveCreated(pad); });
    expect(await screen.findByRole("textbox", { name: "Workpad content" })).toHaveValue("Original");
    fireEvent.click(within(header()).getByRole("button", { name: "Back to workpads" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Global" })).toBeEnabled());
    expect(context.host.setBusy).toHaveBeenLastCalledWith(false);
    viewOptions();
    expect(screen.getByRole("menuitem", { name: "Browse another thread or project…" })).not.toHaveAttribute("aria-disabled");
  });

  it("preserves a manual Thread target when only the active workspace's project changes", async () => {
    const { store: base, api } = fixture();
    const { store, publish } = withSnapshot(base, projectCatalog, [
      { id: "thread-build", title: { text: "Build thread" } },
      { id: "thread-manual", title: { text: "Manual thread" } },
    ]);
    render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
    browse(/^Manual thread/);
    await openRow();
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Manual thread typing" } });
    publish({ ...projectCatalog, workspaces: projectCatalog.workspaces.map(workspace => workspace.id === "web-build" ? { ...workspace, projectId: "project-docs" } : workspace) });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(editor).toHaveValue("Manual thread typing");
    expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "thread", threadId: "thread-manual" } }));
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
    const lists = api.listWorkpads.mock.calls.length;
    vi.useFakeTimers();
    view.rerender(<Panel context={{ ...context, threadId: "thread-new", workspaceId: "new-location" }} />);
    expect(screen.queryByText("Original")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.listWorkpads).toHaveBeenCalledTimes(lists);
    publish({ ...projectCatalog, workspaces: [...projectCatalog.workspaces, { ...projectCatalog.workspaces[2], id: "new-location" }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-docs" } }));
  });

  it("names a project workpad's project in its nested row and document meta line", async () => {
    const projectPad: Workpad = { ...pad, scope: { kind: "project", projectId: "project-docs-build" } };
    const { store: base } = fixture({
      listWorkpads: vi.fn(async () => ({ items: [projectPad] })),
      getWorkpad: vi.fn(async () => projectPad),
      getWorkpadRevision: vi.fn(async () => ({ ...revision, scope: projectPad.scope })),
    });
    const { store } = withSnapshot(base, projectCatalog);
    const context = panelContext(store);
    render(<Panel context={context} />);
    // One scope in view needs no label on its rows, nor your own name.
    expect(await screen.findByRole("button", { name: "Integration" })).toHaveTextContent(/^Integration$/);
    viewOptions();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Include nested scopes" }));
    // View options stay open for another pick.
    closeMenu();
    // Mixed scopes name each row's own, a project by its label.
    const row = await screen.findByRole("button", { name: "IntegrationProject · docs · Build host" });
    fireEvent.click(row);
    await screen.findByRole("button", { name: "Edit workpad" });
    expect(document.querySelector(".workpads-doc-meta")).toHaveTextContent(/^Revision 1 · .+ · You · Project · docs · Build host$/);
    expect(context.host.setSubtitle).toHaveBeenLastCalledWith("Integration");
    expect(header()).toHaveTextContent(/^WorkpadsIntegration$/);
  });

  describe("header, toolbar and document controls", () => {
    it("publishes a back step while a workpad is open and clears it on leaving", async () => {
      const { store, api } = fixture();
      const context = panelContext(store);
      const view = render(<Panel context={context} />);
      await screen.findByRole("button", { name: "Integration" });
      expect(within(header()).queryByRole("button", { name: "Back to workpads" })).not.toBeInTheDocument();
      expect(header().querySelector(".lucide-notepad-text")).not.toBeNull();
      await openRow();
      // The back step takes the tenant icon's place, the title follows as the subtitle.
      const back = await within(header()).findByRole("button", { name: "Back to workpads" });
      expect(context.host.setBack).toHaveBeenLastCalledWith({ label: "Back to workpads", disabled: false, onBack: expect.any(Function) });
      expect(header().querySelector(".lucide-notepad-text")).toBeNull();
      expect(header()).toHaveTextContent(/^WorkpadsIntegration$/);
      // Leaving an editor syncs its text first.
      fireEvent.change(await startEditing(), { target: { value: "Synced on the way out" } });
      fireEvent.click(back);
      await screen.findByRole("button", { name: "Integration" });
      expect(api.saveWorkpadDraft).toHaveBeenCalledWith("pad", { expectedRevision: 0, baseRevision: 1, content: "Synced on the way out" });
      expect(context.host.setBack).toHaveBeenLastCalledWith(undefined);
      expect(context.host.setSubtitle).toHaveBeenLastCalledWith(undefined);
      expect(within(header()).queryByRole("button", { name: "Back to workpads" })).not.toBeInTheDocument();
      expect(header()).toHaveTextContent(/^Workpads$/);
      // Unmounting with a workpad open takes its header additions along.
      await openRow();
      await within(header()).findByRole("button", { name: "Back to workpads" });
      view.unmount();
      expect(context.host.setBack).toHaveBeenLastCalledWith(undefined);
      expect(context.host.setMenuItems).toHaveBeenLastCalledWith(undefined);
    });

    it("adds Rename, Move to and Archive to the header ⋯, and only Discard draft… while editing", async () => {
      const { store } = fixture();
      render(<Panel context={panelContext(store)} />);
      await screen.findByRole("button", { name: "Integration" });
      const dock = ["Left", "Right", "Top", "Bottom"];
      expect(menuLabels(headerMenu())).toEqual(dock);
      closeMenu();
      await openRow();
      await screen.findByRole("button", { name: "Edit workpad" });
      expect(menuLabels(headerMenu())).toEqual([...dock, "Rename…", "Move to", "Archive"]);
      closeMenu();
      await startEditing();
      expect(menuLabels(headerMenu())).toEqual([...dock, "Discard draft…"]);
      closeMenu();
      fireEvent.click(screen.getByRole("button", { name: "Done editing" }));
      await screen.findByRole("button", { name: "Edit workpad" });
      expect(menuLabels(headerMenu())).toEqual([...dock, "Rename…", "Move to", "Archive"]);
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
      expect(context.host.setSubtitle).toHaveBeenLastCalledWith("Launch notes");
      fireEvent.click(within(header()).getByRole("button", { name: "Back to workpads" }));
      await waitFor(() => expect(addRow()).toHaveValue(""));
    });

    it("names the add row after the scope it creates in", async () => {
      const { store: base, api } = fixture();
      const { store } = withSnapshot(base, projectCatalog);
      render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
      expect(addRow()).toHaveAttribute("placeholder", "New workpad in this thread…");
      fireEvent.click(screen.getByRole("radio", { name: "Project" }));
      expect(addRow()).toHaveAttribute("placeholder", "New workpad in this project…");
      fireEvent.click(screen.getByRole("radio", { name: "Global" }));
      expect(addRow()).toHaveAttribute("placeholder", "New global workpad…");
      browse(/^Manual thread/);
      expect(addRow()).toHaveAttribute("placeholder", "New workpad in Manual thread…");
      browse(/^docs · Build host/);
      expect(addRow()).toHaveAttribute("placeholder", "New workpad in docs · Build host…");
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-docs-build" } })));
      // Archived workpads are not created; the row goes away.
      viewOptions();
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Archived" }));
      // View options stay open for another pick.
      closeMenu();
      expect(screen.queryByRole("textbox", { name: "New workpad title" })).not.toBeInTheDocument();
    });

    it("renames and archives a listed workpad from its row ⋯ without opening it", async () => {
      const { store, api } = fixture();
      render(<Panel context={panelContext(store)} />);
      await screen.findByRole("button", { name: "Integration" });
      expect(menuLabels(openMenu("Actions for “Integration”"))).toEqual(["Rename…", "Move to", "Archive"]);
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
      expect(menuLabels(headerMenu())).toContain("Unarchive");
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

    it("moves the open workpad to Global from the header ⋯", async () => {
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
      headerMenu();
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

    it("shows a removable chip while browsing another thread and returns to the current one", async () => {
      const { store: base, api } = fixture();
      const { store } = withSnapshot(base, projectCatalog);
      render(<Panel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "thread", threadId: "thread-build" } })));
      expect(screen.getByRole("button", { name: "View options" })).not.toHaveAttribute("data-filtering");
      browse(/^Manual thread/);
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "thread", threadId: "thread-manual" } })));
      expect(screen.getByRole("radio", { name: "Thread" })).toBeChecked();
      expect(screen.getByRole("button", { name: "View options" })).toHaveAttribute("data-filtering", "true");
      fireEvent.click(screen.getByRole("button", { name: "Remove filter: Manual thread" }));
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "thread", threadId: "thread-build" } })));
      expect(screen.queryByRole("button", { name: /^Remove filter/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "View options" })).not.toHaveAttribute("data-filtering");
      expect(addRow()).toHaveAttribute("placeholder", "New workpad in this thread…");
    });

    it("shows nested scopes and archived as removable chips", async () => {
      const { store, api } = fixture();
      render(<Panel context={panelContext(store)} />);
      await screen.findByRole("button", { name: "Integration" });
      viewOptions();
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Include nested scopes" }));
      // View options stay open for another pick.
      closeMenu();
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scopeMode: "subtree", archived: false })));
      expect(screen.getByRole("button", { name: "Remove filter: Nested scopes" })).toBeInTheDocument();
      viewOptions();
      expect(screen.getByRole("menuitemcheckbox", { name: "Include nested scopes" })).toHaveAttribute("aria-checked", "true");
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Archived" }));
      // View options stay open for another pick.
      closeMenu();
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scopeMode: "subtree", archived: true })));
      expect(screen.getByRole("button", { name: "Remove filter: Archived" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "View options" })).toHaveAttribute("data-filtering", "true");
      fireEvent.click(screen.getByRole("button", { name: "Remove filter: Nested scopes" }));
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scopeMode: "exact", archived: true })));
      fireEvent.click(screen.getByRole("button", { name: "Remove filter: Archived" }));
      await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scopeMode: "exact", archived: false })));
      expect(screen.queryByRole("group", { name: "View filters" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "View options" })).not.toHaveAttribute("data-filtering");
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
      headerMenu(); choose("Discard draft…");
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
      expect(within(header()).getByRole("button", { name: "Back to workpads" })).toBeDisabled();
      headerMenu();
      expect(screen.getByRole("menuitem", { name: "Discard draft…" })).toHaveAttribute("aria-disabled", "true");
    });
  });
});
