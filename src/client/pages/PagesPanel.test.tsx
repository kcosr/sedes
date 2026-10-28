// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageRevision, PageRevisionPage } from "../../shared/protocol/pages.js";
import type { ConversationItem } from "../../shared/index.js";
import type { ThreadClientState, ThreadClientStore } from "../stores/ThreadClientStore.js";
import type { WorkspacePanelContext } from "../workspace-panels/registry.js";
import type { PageDocumentServices } from "../lib/page-services.js";
import { CLOSE_PAGE_EVENT } from "../app/android-back.js";
import { PagesPanel } from "./PagesPanel.js";
import { createPagesPanelIntent } from "./pages-panel-intent.js";

const documentState = vi.hoisted(() => ({ services: undefined as PageDocumentServices | undefined }));
vi.mock("./PageDocument.js", () => ({
  PageDocument: ({ page, services, visible, onBack, revisionRefreshKey }: {
    page: PageRevision; services: PageDocumentServices; visible: boolean; onBack: () => void; revisionRefreshKey?: string;
  }) => {
    const [browsed, setBrowsed] = useState(page.revision);
    documentState.services = services;
    return <article aria-label="Page document" data-visible={String(visible)} data-anchor={page.revision} data-refresh-key={revisionRefreshKey}>
      <button data-panel-autofocus onClick={onBack}>Back to pages</button>
      <h2>{page.title}</h2>
      <p>Viewing revision {browsed}</p>
      <button onClick={() => setBrowsed((revision) => revision - 1)}>Browse older revision</button>
    </article>;
  },
}));

afterEach(() => { cleanup(); documentState.services = undefined; });

const page: PageRevision = {
  pageId: "30000000-0000-4000-8000-000000000001",
  threadId: "thread-1",
  revision: 2,
  title: "Dashboard",
  viewport: {},
  createdAt: "2026-10-11T10:00:00.000Z",
  sha256: "a".repeat(64),
  byteSize: 256,
};
const otherPage: PageRevision = { ...page, pageId: "30000000-0000-4000-8000-000000000002", title: "Diagram", revision: 1 };

function storeFixture(threadId = "thread-1") {
  let state = { authoritative: false, connection: "disconnected" } as ThreadClientState;
  const listeners = new Set<() => void>();
  const methods = {
    listPages: vi.fn<(...args: unknown[]) => Promise<PageRevisionPage>>().mockResolvedValue({ items: [{ ...page, threadId }] }),
    preparePageDownload: vi.fn().mockResolvedValue({}),
    createPageRenderAdmission: vi.fn().mockResolvedValue({}),
    listPageRevisions: vi.fn().mockResolvedValue({ items: [] }),
    getPageRevision: vi.fn().mockResolvedValue({ ...page, threadId }),
    submitPageResponse: vi.fn().mockResolvedValue({}),
    readPageResponseReceipt: vi.fn().mockResolvedValue({}),
  };
  const store = {
    threadId,
    ...methods,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => state,
  } as unknown as ThreadClientStore;
  return {
    store, ...methods,
    publishItems(items: readonly ConversationItem[]) {
      state = { ...state, snapshot: { itemsById: Object.fromEntries(items.map((item) => [item.id, item])) } as ThreadClientState["snapshot"] };
      act(() => listeners.forEach((listener) => listener()));
    },
    connection(connection: ThreadClientState["connection"]) {
      state = { ...state, connection };
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

function contextFixture(...fixtures: ReturnType<typeof storeFixture>[]) {
  const threadRegistry = {
    get: vi.fn((threadId: string) => fixtures.find(({ store }) => store.threadId === threadId)!.store),
    retainCached: vi.fn(), releaseCached: vi.fn(),
  };
  const host = { consumeIntent: vi.fn(), close: vi.fn(), setBusy: vi.fn(), setDirty: vi.fn(), setSubtitle: vi.fn() };
  const context: WorkspacePanelContext = {
    threadId: fixtures[0]!.store.threadId,
    visible: true,
    presentation: "dock",
    chromeActionsTarget: document.createElement("div"),
    applicationStore: {} as WorkspacePanelContext["applicationStore"],
    threadRegistry: threadRegistry as unknown as WorkspacePanelContext["threadRegistry"],
    host,
  };
  return { context, host, threadRegistry };
}

function publication(id: string, value = page): ConversationItem {
  return { id, kind: "page", turnId: "turn-1", revision: 0, status: "completed", page: value };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Pages panel", () => {
  it("starts with durable browser results, paginates, and opens the selected latest revision", async () => {
    const fixture = storeFixture();
    fixture.listPages.mockResolvedValueOnce({ items: [page], nextCursor: "older" }).mockResolvedValueOnce({ items: [otherPage] });
    const { context } = contextFixture(fixture);
    render(<PagesPanel context={context} />);
    expect(await screen.findByRole("button", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("article")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more pages" }));
    expect(await screen.findByRole("button", { name: "Diagram" })).toBeInTheDocument();
    expect(fixture.listPages).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "older", limit: 50, signal: expect.any(AbortSignal) }));
    screen.getByRole("button", { name: "Dashboard" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
    expect(screen.getByText("Viewing revision 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to pages" })).toHaveFocus();
    expect(screen.queryByRole("navigation", { name: "Published pages" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to pages" }));
    expect(screen.getByRole("button", { name: "Dashboard" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Diagram" })).toBeInTheDocument();
  });

  it("preserves the anchor and browsed revision across publications, focus, hiding, and list refresh", async () => {
    const fixture = storeFixture();
    const { context } = contextFixture(fixture);
    const view = render(<PagesPanel context={context} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dashboard" }));
    fireEvent.click(screen.getByRole("button", { name: "Browse older revision" }));
    fixture.listPages.mockResolvedValue({ items: [{ ...page, revision: 3, title: "New title" }, otherPage] });
    fixture.publishItems([publication("new-revision", { ...page, revision: 3 })]);
    expect(screen.getByRole("article").getAttribute("data-refresh-key")).toContain("new-revision");
    expect(screen.getByRole("article")).toHaveAttribute("data-anchor", "2");
    expect(screen.getByText("Viewing revision 1")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    const beforeFocus = fixture.listPages.mock.calls.length;
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(fixture.listPages).toHaveBeenCalledTimes(beforeFocus + 1));
    view.rerender(<PagesPanel context={{ ...context, visible: false }} />);
    expect(screen.getByRole("article")).toHaveAttribute("data-visible", "false");
    const beforeHidden = fixture.listPages.mock.calls.length;
    fixture.publishItems([publication("another-publication"), publication("new-revision")]);
    fireEvent(window, new Event("focus"));
    expect(fixture.listPages).toHaveBeenCalledTimes(beforeHidden);
    view.rerender(<PagesPanel context={context} />);
    await waitFor(() => expect(fixture.listPages).toHaveBeenCalledTimes(beforeHidden + 1));
    expect(screen.getByText("Viewing revision 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to pages" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh pages" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh pages" })).not.toBeDisabled());
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.getByRole("button", { name: "New title" })).toBeInTheDocument();
  });

  it("invalidates an open document outside the loaded page list on publication and reconnect", async () => {
    const fixture = storeFixture();
    fixture.listPages.mockResolvedValue({ items: [otherPage], nextCursor: "older-pages" });
    const { context } = contextFixture(fixture);
    render(<PagesPanel context={{ ...context, intent: createPagesPanelIntent(page) }} />);
    await waitFor(() => expect(fixture.listPages).toHaveBeenCalledOnce());
    const document = screen.getByRole("article"), initial = document.getAttribute("data-refresh-key");
    fixture.publishItems([publication("newer-revision-outside-list", { ...page, revision: 3 })]);
    expect(document.getAttribute("data-refresh-key")).not.toBe(initial);
    expect(document.getAttribute("data-refresh-key")).toContain("newer-revision-outside-list");
    const published = document.getAttribute("data-refresh-key");
    fixture.connection("connected");
    expect(document.getAttribute("data-refresh-key")).not.toBe(published);
    expect(screen.getByRole("article")).toBe(document);
    expect(screen.getByRole("article")).toHaveAttribute("data-anchor", "2");
  });

  it("opens exact chat revisions once per intent and rejects foreign and stale intents", async () => {
    const fixture = storeFixture();
    const { context, host } = contextFixture(fixture);
    const intent = createPagesPanelIntent({ ...page, revision: 1 });
    const view = render(<PagesPanel context={{ ...context, intent }} />);
    expect(await screen.findByText("Viewing revision 1")).toBeInTheDocument();
    expect(host.consumeIntent).toHaveBeenCalledWith(intent.sequence);
    fireEvent.click(screen.getByRole("button", { name: "Back to pages" }));
    view.rerender(<PagesPanel context={{ ...context, intent: { ...intent, page: { ...intent.page } } }} />);
    expect(screen.queryByRole("article")).toBeNull();
    const foreign = createPagesPanelIntent({ ...page, threadId: "thread-other" });
    view.rerender(<PagesPanel context={{ ...context, intent: foreign }} />);
    expect(host.consumeIntent).toHaveBeenCalledWith(foreign.sequence);
    expect(screen.queryByRole("article")).toBeNull();
    const mismatched = { ...createPagesPanelIntent(page), page: { ...page, threadId: "thread-other" } };
    view.rerender(<PagesPanel context={{ ...context, intent: mismatched }} />);
    expect(screen.queryByRole("article")).toBeNull();
    view.rerender(<PagesPanel context={{ ...context, intent }} />);
    expect(screen.queryByRole("article")).toBeNull();
    const again = createPagesPanelIntent(page);
    view.rerender(<PagesPanel context={{ ...context, intent: again }} />);
    expect(screen.getByText("Viewing revision 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Browse older revision" }));
    view.rerender(<PagesPanel context={{ ...context, intent: { ...again, page: { ...again.page } } }} />);
    expect(screen.getByText("Viewing revision 1")).toBeInTheDocument();
  });

  it("leaves intent focus to the panel layout instead of stealing it from chat", async () => {
    const fixture = storeFixture();
    const { context } = contextFixture(fixture);
    const renderPanels = (intent?: unknown) => <>
      <button>Chat control</button>
      <PagesPanel context={{ ...context, intent }} />
    </>;
    const view = render(renderPanels());
    await screen.findByRole("button", { name: "Dashboard" });
    const chat = screen.getByRole("button", { name: "Chat control" });
    chat.focus();
    view.rerender(renderPanels(createPagesPanelIntent(page)));
    expect(screen.getByText("Viewing revision 2")).toBeInTheDocument();
    expect(chat).toHaveFocus();
  });

  it("clears thread state, aborts stale reads, and retains only the current thread store", async () => {
    const first = storeFixture();
    const stale = deferred<PageRevisionPage>();
    first.listPages.mockReturnValueOnce(stale.promise);
    const second = storeFixture("thread-2");
    second.listPages.mockResolvedValue({ items: [{ ...otherPage, threadId: "thread-2", title: "Second thread" }] });
    const { context, threadRegistry } = contextFixture(first, second);
    const view = render(<PagesPanel context={{ ...context, intent: createPagesPanelIntent(page) }} />);
    const options = first.listPages.mock.calls[0]![0] as { signal: AbortSignal };
    expect(screen.getByRole("article")).toBeInTheDocument();
    view.rerender(<PagesPanel context={{ ...context, threadId: "thread-2" }} />);
    expect(options.signal.aborted).toBe(true);
    expect(screen.queryByRole("article")).toBeNull();
    expect(await screen.findByRole("button", { name: "Second thread" })).toBeInTheDocument();
    await act(async () => { stale.resolve({ items: [page] }); await stale.promise; });
    expect(screen.queryByRole("button", { name: "Dashboard" })).toBeNull();
    expect(threadRegistry.releaseCached).toHaveBeenCalledWith("thread-1");
    expect(threadRegistry.retainCached).toHaveBeenLastCalledWith("thread-2");
    fireEvent.click(screen.getByRole("button", { name: "Second thread" }));
    const services = documentState.services!;
    expect(services.pageResponse?.threadId).toBe("thread-2");
    await services.createPageRenderAdmission!(otherPage.pageId, 1);
    await services.listPageRevisions!(otherPage.pageId);
    await services.getPageRevision!(otherPage.pageId, 1);
    await services.preparePageDownload!({ ...otherPage, threadId: "thread-2" });
    expect(second.createPageRenderAdmission).toHaveBeenCalledWith(otherPage.pageId, 1, undefined);
    expect(second.listPageRevisions).toHaveBeenCalledWith(otherPage.pageId, undefined);
    expect(second.getPageRevision).toHaveBeenCalledWith(otherPage.pageId, 1, undefined);
    expect(second.preparePageDownload).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-2" }), undefined);
    expect(first.createPageRenderAdmission).not.toHaveBeenCalled();
    view.unmount();
    expect(threadRegistry.releaseCached).toHaveBeenLastCalledWith("thread-2");
  });

  it("claims Back only for a visible document with no overlay above it", async () => {
    const fixture = storeFixture();
    const { context } = contextFixture(fixture);
    const view = render(<PagesPanel context={context} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dashboard" }));
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "menu"); overlay.dataset.state = "open";
    document.body.append(overlay);
    const covered = new Event(CLOSE_PAGE_EVENT, { cancelable: true });
    fireEvent(window, covered);
    expect(covered.defaultPrevented).toBe(false);
    overlay.remove();
    view.rerender(<PagesPanel context={{ ...context, visible: false }} />);
    const hidden = new Event(CLOSE_PAGE_EVENT, { cancelable: true });
    fireEvent(window, hidden);
    expect(hidden.defaultPrevented).toBe(false);
    view.rerender(<PagesPanel context={context} />);
    const shown = new Event(CLOSE_PAGE_EVENT, { cancelable: true });
    fireEvent(window, shown);
    expect(shown.defaultPrevented).toBe(true);
    expect(screen.queryByRole("article")).toBeNull();
    const browser = new Event(CLOSE_PAGE_EVENT, { cancelable: true });
    fireEvent(window, browser);
    expect(browser.defaultPrevented).toBe(false);
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh pages" })).not.toBeDisabled());
  });

  it("waits to load until visible and ignores a request completed after hiding", async () => {
    const fixture = storeFixture();
    const delayed = deferred<PageRevisionPage>();
    fixture.listPages.mockReturnValueOnce(delayed.promise);
    const { context } = contextFixture(fixture);
    const view = render(<PagesPanel context={{ ...context, visible: false }} />);
    expect(fixture.listPages).not.toHaveBeenCalled();
    view.rerender(<PagesPanel context={context} />);
    const options = fixture.listPages.mock.calls[0]![0] as { signal: AbortSignal };
    view.rerender(<PagesPanel context={{ ...context, visible: false }} />);
    expect(options.signal.aborted).toBe(true);
    await act(async () => { delayed.resolve({ items: [otherPage] }); await delayed.promise; });
    expect(screen.queryByRole("button", { name: "Diagram" })).toBeNull();
    view.rerender(<PagesPanel context={context} />);
    expect(await screen.findByRole("button", { name: "Dashboard" })).toBeInTheDocument();
  });

  it("retains paginated depth on refresh and reports a failed refresh without discarding results", async () => {
    const fixture = storeFixture();
    fixture.listPages.mockResolvedValueOnce({ items: [page], nextCursor: "older" })
      .mockResolvedValueOnce({ items: [otherPage] })
      .mockResolvedValueOnce({ items: [{ ...page, revision: 3 }], nextCursor: "older-again" })
      .mockResolvedValueOnce({ items: [otherPage] });
    const { context } = contextFixture(fixture);
    render(<PagesPanel context={context} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more pages" }));
    await screen.findByRole("button", { name: "Diagram" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh pages" }));
    await waitFor(() => expect(fixture.listPages).toHaveBeenCalledTimes(4));
    expect(screen.getByRole("button", { name: "Diagram" })).toBeInTheDocument();
    fixture.listPages.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh pages" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load published pages.");
    expect(screen.getByRole("button", { name: "Diagram" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
