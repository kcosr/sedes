// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import type { Workpad, WorkpadDraft, WorkpadRevision } from "../../shared/protocol/workpads.js";
import { WorkpadsPanel } from "./WorkpadsPanel.js";
import type { WorkspacePanelContext } from "../workspace-panels/registry.js";
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
    listWorkpadRevisions: vi.fn(async () => ({ items: [revision] })),
    getWorkpadDraft: vi.fn(async () => savedDraft),
    saveWorkpadDraft: vi.fn(async (_id: string, value: { expectedRevision: number; baseRevision: number; content: string }) => { savedDraft = { ...savedDraft, ...value, revision: value.expectedRevision + 1 }; return savedDraft; }),
    commitWorkpadDraft: vi.fn(async () => ({ workpad: { ...pad, revision: 2 }, draft: { ...savedDraft, revision: 2 } })),
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
function panelContext(store: ApplicationClientStore): WorkspacePanelContext {
  return {
    applicationStore: store, visible: true, presentation: "dock",
    threadRegistry: {} as WorkspacePanelContext["threadRegistry"],
    chromeActionsTarget: document.createElement("div"),
    host: { close: vi.fn(), setBusy: vi.fn(), setDirty: vi.fn(), setSubtitle: vi.fn(), setBack: vi.fn(), setMenuItems: vi.fn(), consumeIntent: vi.fn() },
  };
}
beforeEach(() => { navigate("/", { replace: true });  });
afterEach(() => { cleanup();  vi.useRealTimers(); });
describe("WorkpadsPanel", () => {
  it("saves an explicitly edited draft against its base document revision", async () => {
    const { store, api } = fixture();
    render(<WorkpadsPanel context={panelContext(store)} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
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
    const view = render(<WorkpadsPanel context={context} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    fireEvent.change(editor, { target: { value: "Retained while collapsed" } });
    expect(context.host.setDirty).toHaveBeenLastCalledWith(true);
    view.rerender(<WorkpadsPanel context={{ ...context, visible: false }} />);
    expect(editor).toHaveValue("Retained while collapsed");
    const reads = api.getWorkpad.mock.calls.length;
    await act(async () => { emit({ workpadId: pad.id, revision: 2, change: "document" }); });
    expect(api.getWorkpad).toHaveBeenCalledTimes(reads);
    view.rerender(<WorkpadsPanel context={context} />);
    expect(editor).toHaveValue("Retained while collapsed");
    await waitFor(() => expect(api.getWorkpad).toHaveBeenCalledTimes(reads + 1));
  });

  it("guards thread changes until the user confirms leaving unsynced text", async () => {
    const { store, api } = fixture();
    const context = { ...panelContext(store), threadId: "first-thread", workspaceId: "first-project" };
    navigate("/threads/first-thread");
    const view = render(<WorkpadsPanel context={context} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
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
    view.rerender(<WorkpadsPanel context={{ ...context, threadId: "second-thread", workspaceId: "second-project" }} />);
    expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "thread", threadId: "second-thread" } }));
    expect(api.saveWorkpadDraft).not.toHaveBeenCalled();
  });

  it("clears the old document and follows a new thread while retaining list filters", async () => {
    const { store, api } = fixture();
    const context = { ...panelContext(store), threadId: "first-thread" };
    const view = render(<WorkpadsPanel context={context} />);
    await screen.findByRole("button", { name: /Integration/ });
    fireEvent.change(screen.getByRole("textbox", { name: "Search workpads" }), { target: { value: "integration" } });
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    await screen.findByText("Original");
    view.rerender(<WorkpadsPanel context={{ ...context, threadId: "second-thread" }} />);
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
    const view = render(<WorkpadsPanel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Global typing" } });
    const reads = api.getWorkpad.mock.calls.length;
    act(() => navigate("/threads/second-thread"));
    expect(window.location.pathname).toBe("/threads/second-thread");
    view.rerender(<WorkpadsPanel context={{ ...context, threadId: "second-thread" }} />);
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
    const view = render(<WorkpadsPanel context={context} />);
    await waitFor(() => expect(resolveOld).toBeDefined());
    view.rerender(<WorkpadsPanel context={{ ...context, threadId: "second-thread" }} />);
    await screen.findByRole("button", { name: /Second thread document/ });
    await act(async () => { resolveOld({ items: [pad] }); });
    expect(screen.queryByRole("button", { name: /Integration/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Second thread document/ })).toBeInTheDocument();
  });

  it("ignores a document still opening when the active thread changes", async () => {
    let resolveOld!: (value: Workpad) => void;
    const { store, api } = fixture();
    api.getWorkpad.mockImplementationOnce(() => new Promise<Workpad>(resolve => { resolveOld = resolve; }));
    const context = { ...panelContext(store), threadId: "first-thread" };
    const view = render(<WorkpadsPanel context={context} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    await waitFor(() => expect(resolveOld).toBeDefined());
    view.rerender(<WorkpadsPanel context={{ ...context, threadId: "second-thread" }} />);
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
    const view = render(<WorkpadsPanel context={context} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    await screen.findByText("Original");
    api.getWorkpadRevision.mockImplementationOnce(() => new Promise<WorkpadRevision>(resolve => { resolveOld = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Previous revision" }));
    await waitFor(() => expect(resolveOld).toBeDefined());
    view.rerender(<WorkpadsPanel context={{ ...context, threadId: "second-thread" }} />);
    await act(async () => { resolveOld({ ...revision, content: "Old history" }); });
    expect(screen.queryByText("Old history")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Revision" })).not.toBeInTheDocument();
  });

  it("does not open a workpad created for the previous thread after switching", async () => {
    let resolveCreated!: (value: Workpad) => void;
    const createWorkpad = vi.fn(() => new Promise<Workpad>(resolve => { resolveCreated = resolve; }));
    const { store, api } = fixture({ createWorkpad });
    const context = { ...panelContext(store), threadId: "first-thread" };
    const view = render(<WorkpadsPanel context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "New workpad" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Created for first" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workpad" }));
    expect(createWorkpad).toHaveBeenCalledWith({ title: "Created for first", scope: { kind: "thread", threadId: "first-thread" } });
    view.rerender(<WorkpadsPanel context={{ ...context, threadId: "second-thread" }} />);
    expect(screen.getByRole("dialog", { name: "Leave pending workpad changes?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    await act(async () => { resolveCreated(pad); });
    expect(api.getWorkpad).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Title" })).not.toBeInTheDocument();
    expect(screen.queryByText("Original")).not.toBeInTheDocument();
  });

  it("does not reopen a renamed document after switching threads", async () => {
    let resolveRenamed!: (value: Workpad) => void;
    const updateWorkpad = vi.fn(() => new Promise<Workpad>(resolve => { resolveRenamed = resolve; }));
    const { store, api } = fixture({ updateWorkpad });
    const context = { ...panelContext(store), threadId: "first-thread" };
    const view = render(<WorkpadsPanel context={context} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workpad title" }), { target: { value: "Renamed document" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename workpad" }));
    await waitFor(() => expect(resolveRenamed).toBeDefined());
    const reads = api.getWorkpad.mock.calls.length;
    view.rerender(<WorkpadsPanel context={{ ...context, threadId: "second-thread" }} />);
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
    render(<WorkpadsPanel context={context} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    if (operation === "commit") {
      fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
      fireEvent.click(await screen.findByRole("button", { name: "Save workpad" }));
    } else {
      fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Workpad title" }), { target: { value: "Updated title" } });
      fireEvent.click(screen.getByRole("button", { name: "Rename workpad" }));
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
    render(<WorkpadsPanel context={context} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
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
    render(<WorkpadsPanel context={panelContext(store)} />);
    await screen.findByRole("button", { name: /Integration/ });
    fireEvent.change(screen.getByRole("textbox", { name: "Search workpads" }), { target: { value: "old" } });
    await waitFor(() => expect(resolveOld).toBeDefined());
    fireEvent.change(screen.getByRole("textbox", { name: "Search workpads" }), { target: { value: "new" } });
    await screen.findByRole("button", { name: /New result/ });
    await act(async () => { resolveOld({ items: [{ ...pad, title: "Old result" }] }); });
    expect(screen.queryByRole("button", { name: /Old result/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New result/ })).toBeInTheDocument();
  });
  it("refreshes on document events and reconnect, without periodic reads", async () => {
    const { store, api, emit } = fixture();
    render(<WorkpadsPanel context={panelContext(store)} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
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
    render(<WorkpadsPanel context={panelContext(store)} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
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
    render(<WorkpadsPanel context={panelContext(store)} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "My unsynced typing" } });
    api.getWorkpad.mockResolvedValue({ ...pad, revision: 2, content: "Agent update" });
    api.getWorkpadRevision.mockResolvedValue({ ...revision, revision: 2, content: "Agent update" });
    api.getWorkpadDraft.mockResolvedValue({ ...initialDraft, revision: 1, baseRevision: 2, content: "Agent update" });
    await act(async () => { emit({ workpadId: pad.id, revision: 2, change: "document" }); });
    expect(editor).toHaveValue("My unsynced typing");
    expect(screen.getByText("The document changed. Review the latest version before saving.")).toBeInTheDocument();
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
    render(<WorkpadsPanel context={panelContext(store)} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Pending typing" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    const discard = screen.getByRole("button", { name: "Discard draft" });
    expect(discard).toBeDisabled();
    fireEvent.click(discard);
    expect(discardWorkpadDraft).not.toHaveBeenCalled();
    await act(async () => { resolve({ ...initialDraft, revision: 1, content: "Pending typing" }); });
    expect(discard).toBeEnabled();
    await act(async () => { fireEvent.click(discard); });
    expect(discardWorkpadDraft).toHaveBeenCalledWith("pad", 1);
    expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cancels debounced autosave before sending a slow discard", async () => {
    let resolve!: () => void;
    const discardWorkpadDraft = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    const { store, api } = fixture({ discardWorkpadDraft });
    render(<WorkpadsPanel context={panelContext(store)} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Never synced" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); fireEvent.click(screen.getByRole("button", { name: "Discard draft" })); });
    expect(discardWorkpadDraft).toHaveBeenCalledWith("pad", 0);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(api.saveWorkpadDraft).not.toHaveBeenCalled();
    await act(async () => { resolve(); });
    expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("queues events received while opening a workpad instead of losing them", async () => {
    let resolve!: (value: Workpad) => void;
    const { store, api, emit } = fixture();
    api.getWorkpad.mockImplementationOnce(() => new Promise<Workpad>(done => { resolve = done; }));
    render(<WorkpadsPanel context={panelContext(store)} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
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
    render(<WorkpadsPanel context={panelContext(store)} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    await screen.findByText("Current document");
    fireEvent.click(screen.getByRole("button", { name: "Previous revision" }));
    await screen.findByText("Historical document");
    api.getWorkpad.mockResolvedValue({ ...pad, revision: 3, content: "New document" });
    api.listWorkpadRevisions.mockResolvedValue({ items: [{ ...revision, revision: 3 }, { ...revision, revision: 2 }, revision] });
    await act(async () => { emit({ workpadId: pad.id, revision: 3, change: "document" }); });
    expect(screen.getByText("Historical document")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Revision" })).toHaveValue("1");
  });

  it("clears recovered refresh failures without clearing mutation errors", async () => {
    const { store, api, emit } = fixture();
    render(<WorkpadsPanel context={panelContext(store)} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
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
    render(<WorkpadsPanel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
    await waitFor(() => expect(api.listWorkpads).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    const select = screen.getByRole("combobox", { name: "Workpad project" });
    expect(select).toHaveValue("project-web");
    expect([...select.querySelectorAll("option")].map(option => option.textContent)).toEqual([
      "acme-web", "docs", "docs · Build host",
    ]);
    await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: { kind: "project", projectId: "project-web" }, scopeMode: "exact",
    })));
  });

  it("adopts the thread's project when the snapshot arrives after the panel", async () => {
    const { store: base, api } = fixture();
    const { store, publish } = withSnapshot(base, undefined);
    render(<WorkpadsPanel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "docs-build" }} />);
    publish(projectCatalog);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    expect(screen.getByRole("combobox", { name: "Workpad project" })).toHaveValue("project-docs-build");
    await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: { kind: "project", projectId: "project-docs-build" },
    })));
  });

  it("follows the active project after a manual project selection", async () => {
    const { store: base, api } = fixture();
    const { store } = withSnapshot(base, projectCatalog);
    const context = { ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" };
    const view = render(<WorkpadsPanel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Workpad project" }), { target: { value: "project-docs-build" } });
    await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-docs-build" } })));
    view.rerender(<WorkpadsPanel context={{ ...context, threadId: "thread-docs", workspaceId: "docs-local" }} />);
    expect(screen.getByRole("combobox", { name: "Workpad project" })).toHaveValue("project-docs");
    await waitFor(() => expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-docs" } })));
  });

  it.each(["Thread", "Project"])("holds the %s scope controls while creating and shows the result", async kind => {
    let resolveCreated!: (value: Workpad) => void;
    const createWorkpad = vi.fn(() => new Promise<Workpad>(resolve => { resolveCreated = resolve; }));
    const { store: base } = fixture({ createWorkpad });
    const { store } = withSnapshot(base, projectCatalog);
    render(<WorkpadsPanel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
    fireEvent.click(screen.getByRole("radio", { name: kind }));
    fireEvent.click(screen.getByRole("button", { name: "New workpad" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Title" }), { target: { value: "Pending creation" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workpad" }));
    expect(createWorkpad).toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Global" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: kind === "Thread" ? "Workpad thread" : "Workpad project" })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    expect(screen.getByRole("radio", { name: kind })).toBeChecked();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => { resolveCreated(pad); });
    expect(await screen.findByText("Original")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to workpads" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Global" })).toBeEnabled());
    expect(screen.getByRole("combobox", { name: kind === "Thread" ? "Workpad thread" : "Workpad project" })).toBeEnabled();
  });

  it("preserves a manual Thread target when only the active workspace's project changes", async () => {
    const { store: base, api } = fixture();
    const { store, publish } = withSnapshot(base, projectCatalog, [
      { id: "thread-build", title: { text: "Build thread" } },
      { id: "thread-manual", title: { text: "Manual thread" } },
    ]);
    render(<WorkpadsPanel context={{ ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" }} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Workpad thread" }), { target: { value: "thread-manual" } });
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
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
    const view = render(<WorkpadsPanel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Unsynced before navigating" } });
    act(() => navigate("/threads/thread-docs"));
    publish({ ...projectCatalog, workspaces: projectCatalog.workspaces.map(workspace => reassigned && workspace.id === "web-build" ? { ...workspace, projectId: "project-docs-build" } : workspace) });
    expect(editor).toHaveValue("Unsynced before navigating");
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    expect(window.location.pathname).toBe("/threads/thread-docs");
    view.rerender(<WorkpadsPanel context={{ ...context, threadId: "thread-docs", workspaceId: "docs-local" }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Workpad content" })).not.toBeInTheDocument();
  });

  it("retains a project editor within its project and guards leaving that project", async () => {
    const { store: base, api } = fixture();
    const { store: catalogStore } = withSnapshot(base, projectCatalog);
    const store = { ...catalogStore, workspaceIdForThread: (id: string) => id === "thread-local" ? "web-local" : "docs-local" } as ApplicationClientStore;
    const context = { ...panelContext(store), threadId: "thread-build", workspaceId: "web-build" };
    navigate("/threads/thread-build");
    const view = render(<WorkpadsPanel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Project typing" } });
    act(() => navigate("/threads/thread-local"));
    expect(window.location.pathname).toBe("/threads/thread-local");
    view.rerender(<WorkpadsPanel context={{ ...context, threadId: "thread-local", workspaceId: "web-local" }} />);
    expect(screen.getByRole("textbox", { name: "Workpad content" })).toBe(editor);
    expect(editor).toHaveValue("Project typing");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => navigate("/threads/thread-docs"));
    expect(screen.getByRole("dialog", { name: "Leave unsynced workpad?" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/threads/thread-local");
    fireEvent.click(screen.getByRole("button", { name: "Leave anyway" }));
    view.rerender(<WorkpadsPanel context={{ ...context, threadId: "thread-docs", workspaceId: "docs-local" }} />);
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
    render(<WorkpadsPanel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
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
    render(<WorkpadsPanel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
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
    render(<WorkpadsPanel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
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
    const view = render(<WorkpadsPanel context={context} />);
    fireEvent.click(screen.getByRole("radio", { name: "Project" }));
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    await screen.findByText("Original");
    const lists = api.listWorkpads.mock.calls.length;
    vi.useFakeTimers();
    view.rerender(<WorkpadsPanel context={{ ...context, threadId: "thread-new", workspaceId: "new-location" }} />);
    expect(screen.queryByText("Original")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.listWorkpads).toHaveBeenCalledTimes(lists);
    publish({ ...projectCatalog, workspaces: [...projectCatalog.workspaces, { ...projectCatalog.workspaces[2], id: "new-location" }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "project", projectId: "project-docs" } }));
  });

  it("names a project workpad's project in its row and header", async () => {
    const projectPad: Workpad = { ...pad, scope: { kind: "project", projectId: "project-docs-build" } };
    const { store: base } = fixture({
      listWorkpads: vi.fn(async () => ({ items: [projectPad] })),
      getWorkpad: vi.fn(async () => projectPad),
      getWorkpadRevision: vi.fn(async () => ({ ...revision, scope: projectPad.scope })),
    });
    const { store } = withSnapshot(base, projectCatalog);
    render(<WorkpadsPanel context={panelContext(store)} />);
    const row = await screen.findByRole("button", { name: /Integration/ });
    expect(row).toHaveTextContent("Project · docs · Build host · You");
    fireEvent.click(row);
    await screen.findByRole("button", { name: "Edit workpad" });
    expect(document.querySelector(".workpads-title")).toHaveTextContent("IntegrationProject · docs · Build host");
  });
});
