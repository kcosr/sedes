// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import type { Workpad, WorkpadDraft, WorkpadRevision } from "../../shared/protocol/workpads.js";
import { WorkpadsPanel } from "./WorkpadsPanel.js";
import type { WorkspacePanelContext } from "../workspace-panels/registry.js";
import { navigate } from "../app/router.js";
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
    host: { close: vi.fn(), setBusy: vi.fn(), setDirty: vi.fn(), setSubtitle: vi.fn(), consumeIntent: vi.fn() },
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

  it("retains the selected document and unsynced editor across thread switches but guards leaving threads", async () => {
    const { store, api } = fixture();
    const context = { ...panelContext(store), threadId: "first-thread", workspaceId: "first-project" };
    navigate("/threads/first-thread");
    const view = render(<WorkpadsPanel context={context} />);
    fireEvent.click(await screen.findByRole("button", { name: /Integration/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit workpad" }));
    const editor = await screen.findByRole("textbox", { name: "Workpad content" });
    vi.useFakeTimers();
    fireEvent.change(editor, { target: { value: "Unsynced across projects" } });

    const reads = api.getWorkpad.mock.calls.length;
    act(() => { navigate("/threads/second-thread"); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.rerender(<WorkpadsPanel context={{ ...context, threadId: "second-thread", workspaceId: "second-project" }} />);
    expect(screen.getByRole("textbox", { name: "Workpad content" })).toBe(editor);
    expect(editor).toHaveValue("Unsynced across projects");
    expect(api.getWorkpad).toHaveBeenCalledTimes(reads);
    expect(api.listWorkpads).toHaveBeenLastCalledWith(expect.objectContaining({ scope: { kind: "thread", threadId: "first-thread" } }));
    act(() => { navigate("/"); });
    expect(screen.getByRole("dialog", { name: "Leave unsynced workpad?" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/threads/second-thread");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
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

});
