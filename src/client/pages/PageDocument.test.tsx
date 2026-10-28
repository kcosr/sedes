// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageRevision, PageRevisionPage } from "../../shared/protocol/pages.js";
import { PageDocument } from "./PageDocument.js";
import { connectionScope, ConnectionScopeProvider } from "../app/connection-scope.js";

const scope = connectionScope("test", window.location.origin, "test-principal");
function render(ui: React.ReactNode) {
  return renderView(ui, {
    wrapper: ({ children }) => (
      <ConnectionScopeProvider scope={scope}>{children}</ConnectionScopeProvider>
    ),
  });
}

const safety = vi.hoisted(() => ({ supports: vi.fn(), android: vi.fn() }));
const downloads = vi.hoisted(() => ({ browser: vi.fn(), native: vi.fn(), packaged: vi.fn() }));
vi.mock("../app/browser-download.js", () => ({ startBrowserDownload: downloads.browser }));
vi.mock("../app/packaged-download.js", () => ({
  downloadInPackagedClient: downloads.native,
  supportsPackagedDownloads: downloads.packaged,
}));
vi.mock("../app/page-safety.js", () => ({
  supportsSafePageFrames: safety.supports,
}));
vi.mock("../app/client-platform.js", () => ({
  isAndroidClient: safety.android,
}));
const original: PageRevision = {
  pageId: "30000000-0000-4000-8000-000000000001",
  threadId: "thread-1",
  revision: 1,
  title: "Phone",
  viewport: { width: 390, height: 844 },
  createdAt: "2026-10-11T10:00:00.000Z",
  sha256: "a".repeat(64),
  byteSize: 256,
};
function makePreviewsVisible(initial = true) {
  const observers = new Set<IntersectionObserverCallback>();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(readonly callback: IntersectionObserverCallback) {
        observers.add(callback);
      }
      observe() {
        this.callback(
          [{ isIntersecting: initial } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {
        observers.delete(this.callback);
      }
    },
  );
  return (visible: boolean) =>
    act(() => {
      for (const callback of observers)
        callback(
          [{ isIntersecting: visible } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
    });
}
beforeEach(() => {
  downloads.browser.mockReset();
  downloads.native.mockReset().mockResolvedValue("saved");
  downloads.packaged.mockReset().mockReturnValue(false);
  safety.supports.mockReset().mockResolvedValue(true);
  safety.android.mockReset().mockReturnValue(false);
  localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  makePreviewsVisible();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function services() {
  return {
    preparePageDownload: vi.fn(async (page: PageRevision, _signal?: AbortSignal) => ({
      url: `/api/threads/${page.threadId}/pages/${page.pageId}/revisions/${page.revision}/download`,
      serverOrigin: window.location.origin,
      suggestedFileName: `${page.title}-${page.revision}.html`,
      contentDisposition: `attachment; filename="${page.title}-${page.revision}.html"`,
      contentLength: page.byteSize + 3,
      revision: page.sha256,
    })),
    createPageRenderAdmission: vi.fn(
      async (_pageId: string, _revision: number, _signal?: AbortSignal) => ({
        url: "/page-render/token",
        expiresAt: "2026-10-11T10:10:00.000Z",
      }),
    ),
    listPageRevisions: vi.fn(
      async (
        _pageId: string,
        _options?: { limit?: number; signal?: AbortSignal },
      ): Promise<PageRevisionPage> => ({
        items: [{ ...original, revision: 2, title: "Updated phone" }],
      }),
    ),
    getPageRevision: vi.fn(
      async (_pageId: string, _revision: number, _signal?: AbortSignal) =>
        original,
    ),
  };
}
function sendFrameMessage(frame: HTMLIFrameElement, type: string, extra = {}) {
  const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get(
    "channel",
  );
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        data: { type, channel, ...extra },
      }),
    ),
  );
}
async function waitForFrame(container: HTMLElement) {
  await waitFor(() =>
    expect(container.querySelector("iframe")).toBeInTheDocument(),
  );
  return container.querySelector("iframe")!;
}
  function responseServices() {
    return {
      ...services(),
      pageResponse: {
        threadId: original.threadId,
        submit: vi.fn(async (request: import("../components/conversation/page-response-services.js").PageResponseRequest, _signal?: AbortSignal): Promise<import("../../shared/protocol/thread-input.js").DirectInputReceipt> => ({
          mutationId: request.mutationId, operationId: request.mutationId,
          threadId: original.threadId, admittedMode: "queue" as const,
          currentMode: "queue" as const, status: "queued" as const,
          queuedInputId: "queue-response",
        })),
        readReceipt: vi.fn<import("../components/conversation/page-response-services.js").PageResponseServices["readReceipt"]>(async () => ({ status: "notObserved" })),
      },
    };
  }
  function pendingSubmission(api: ReturnType<typeof responseServices>) {
    let resolve!: (receipt: import("../../shared/protocol/thread-input.js").DirectInputReceipt) => void;
    let reject!: (error: Error) => void;
    api.pageResponse.submit.mockImplementationOnce(() => new Promise((accept, fail) => { resolve = accept; reject = fail; }));
    return {
      reject: (error: Error) => reject(error),
      resolve: (overrides: Partial<import("../../shared/protocol/thread-input.js").DirectInputReceipt> = {}) => {
        const request = api.pageResponse.submit.mock.calls[0]![0];
        resolve({ mutationId: request.mutationId, operationId: request.mutationId, threadId: original.threadId,
          admittedMode: "queue", currentMode: "queue", status: "queued", queuedInputId: "queue-response", ...overrides });
      },
    };
  }
  function documentVisibility(visibility: DocumentVisibilityState) {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(visibility);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
  }
  function producer(frame: HTMLIFrameElement, read: () => string) {
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message: unknown) => {
      const request = message as { type: string; requestId: string };
      if (request.type !== "sedes:page-submit-request") return;
      queueMicrotask(() => sendFrameMessage(frame, "sedes:page-submit-response", { requestId: request.requestId, text: read() }));
    });
    sendFrameMessage(frame, "sedes:page-submit-ready");
    return post;
  }


describe("Pages document", () => {
  it("opens the exact published revision and returns to that anchor after browsing", async () => {
    const api = services(), back = vi.fn();
    api.listPageRevisions.mockResolvedValue({ items: [{ ...original, revision: 3, title: "Third" }] });
    api.getPageRevision.mockImplementation(async (_id, revision) => ({ ...original, revision }));
    const { container } = render(<PageDocument page={original} services={api} visible onBack={back} />);
    const frame = await waitForFrame(container);
    await screen.findByLabelText("Revision 1 of 3");
    expect(frame.title).toBe("Phone · Revision 1");
    expect(api.getPageRevision).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Next page revision" }));
    await screen.findByText("2/3");
    fireEvent.click(screen.getByRole("button", { name: "Return to published revision 1" }));
    await screen.findByLabelText("Revision 1 of 3");
    await waitFor(() => expect(container.querySelector("iframe")?.title).toBe("Phone · Revision 1"));
    fireEvent.click(screen.getByRole("button", { name: "Back to Pages" }));
    expect(back).toHaveBeenCalledOnce();
  });

  it("loads the newest revision automatically and uses it for downloads", async () => {
    const api = services();
    api.listPageRevisions.mockResolvedValue({ items: [original] });
    const ui = (revisionRefreshKey: string) => <PageDocument page={original} services={api} visible onBack={() => {}} revisionRefreshKey={revisionRefreshKey} />;
    const view = render(ui("first"));
    const frame = await waitForFrame(view.container);
    expect(screen.getByRole("button", { name: "Lock page revision" })).toHaveAttribute("aria-pressed", "false");
    const newest = { ...original, revision: 3, title: "Newest phone" };
    api.listPageRevisions.mockResolvedValue({ items: [newest] });
    view.rerender(ui("third"));
    await screen.findByText("3/3");
    await waitFor(() => expect(view.container.querySelector("iframe")?.title).toBe("Newest phone · Revision 3"));
    expect(view.container.querySelector("iframe")).not.toBe(frame);
    expect(api.createPageRenderAdmission).toHaveBeenLastCalledWith(original.pageId, 3, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Download HTML" }));
    await waitFor(() => expect(api.preparePageDownload).toHaveBeenCalledWith(newest, expect.any(AbortSignal)));
  });

  it("holds the locked revision and zoom while announcing new revisions, then catches up on unlock", async () => {
    const api = services();
    api.listPageRevisions.mockResolvedValue({ items: [original] });
    const ui = (revisionRefreshKey: string) => <PageDocument page={original} services={api} visible onBack={() => {}} revisionRefreshKey={revisionRefreshKey} />;
    const view = render(ui("first"));
    const frame = await waitForFrame(view.container);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("button", { name: "Zoom percentage: 125%" })).toBeInTheDocument();
    const lock = screen.getByRole("button", { name: "Lock page revision" });
    expect(screen.getByRole("button", { name: "Refresh page preview" }).previousElementSibling).toBe(lock);
    fireEvent.click(lock);
    expect(screen.getByRole("button", { name: "Lock page revision" })).toHaveAttribute("aria-pressed", "true");
    api.listPageRevisions.mockResolvedValue({ items: [{ ...original, revision: 3 }] });
    view.rerender(ui("third"));
    await screen.findByLabelText("Revision 1 of 3");
    expect(screen.getByLabelText("Revision 1 of 3")).toHaveTextContent("1/3");
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(screen.getByRole("button", { name: "Zoom percentage: 125%" })).toBeInTheDocument();
    expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(1);
    api.listPageRevisions.mockResolvedValue({ items: [{ ...original, revision: 5, title: "Latest on unlock" }] });
    fireEvent.click(screen.getByRole("button", { name: "Lock page revision" }));
    await screen.findByText("5/5");
    await waitFor(() => expect(view.container.querySelector("iframe")?.title).toBe("Latest on unlock · Revision 5"));
    expect(screen.getByRole("button", { name: "Lock page revision" })).toHaveAttribute("aria-pressed", "false");
  });

  it("follows a new publication after deliberately browsing an older revision", async () => {
    const api = services(), published = { ...original, revision: 3 };
    api.listPageRevisions.mockResolvedValue({ items: [published] });
    api.getPageRevision.mockImplementation(async (_id, revision) => ({ ...original, revision }));
    const ui = (revisionRefreshKey: string) => <PageDocument page={published} services={api} visible onBack={() => {}} revisionRefreshKey={revisionRefreshKey} />;
    const view = render(ui("third"));
    await screen.findByLabelText("Revision 3 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Previous page revision" }));
    await screen.findByText("2/3");
    api.listPageRevisions.mockResolvedValue({ items: [{ ...original, revision: 4 }] });
    view.rerender(ui("fourth"));
    await screen.findByText("4/4");
  });

  it("preserves a live historical document when notifications rediscover the same revision", async () => {
    const api = services();
    const ui = (revisionRefreshKey: string) => <PageDocument page={original} services={api} visible onBack={() => {}} revisionRefreshKey={revisionRefreshKey} />;
    const view = render(ui("first"));
    await screen.findByLabelText("Revision 1 of 2");
    const frame = await waitForFrame(view.container);
    view.rerender(ui("unrelated-publication"));
    await waitFor(() => expect(api.listPageRevisions).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Revision 1 of 2")).toBeInTheDocument();
    expect(view.container.querySelector("iframe")).toBe(frame);
    expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(1);
  });

  it("ignores superseded automatic revision reads even when they finish last", async () => {
    const api = services();
    api.listPageRevisions.mockResolvedValue({ items: [original] });
    const ui = (revisionRefreshKey: string) => <PageDocument page={original} services={api} visible onBack={() => {}} revisionRefreshKey={revisionRefreshKey} />;
    const view = render(ui("first"));
    await waitForFrame(view.container);
    const stale = deferredDownload<PageRevisionPage>();
    api.listPageRevisions.mockReturnValueOnce(stale.promise);
    view.rerender(ui("second"));
    const staleSignal = api.listPageRevisions.mock.calls.at(-1)![1]!.signal!;
    api.listPageRevisions.mockResolvedValue({ items: [{ ...original, revision: 4 }] });
    view.rerender(ui("fourth"));
    expect(staleSignal.aborted).toBe(true);
    await screen.findByText("4/4");
    await act(async () => stale.resolve({ items: [{ ...original, revision: 2 }] }));
    expect(screen.getByText("4/4")).toBeInTheDocument();
  });

  it("honors a lock set while an automatic revision read is pending", async () => {
    const api = services();
    api.listPageRevisions.mockResolvedValue({ items: [original] });
    const ui = (revisionRefreshKey: string) => <PageDocument page={original} services={api} visible onBack={() => {}} revisionRefreshKey={revisionRefreshKey} />;
    const view = render(ui("first"));
    const frame = await waitForFrame(view.container);
    const pending = deferredDownload<PageRevisionPage>();
    api.listPageRevisions.mockReturnValueOnce(pending.promise);
    view.rerender(ui("second"));
    fireEvent.click(screen.getByRole("button", { name: "Lock page revision" }));
    await act(async () => pending.resolve({ items: [{ ...original, revision: 2 }] }));
    expect(screen.getByLabelText("Revision 1 of 2")).toBeInTheDocument();
    expect(view.container.querySelector("iframe")).toBe(frame);
  });

  it("retains the displayed document after a failed update and retries on focus", async () => {
    const api = services();
    api.listPageRevisions.mockResolvedValue({ items: [original] });
    const ui = (revisionRefreshKey: string) => <PageDocument page={original} services={api} visible onBack={() => {}} revisionRefreshKey={revisionRefreshKey} />;
    const view = render(ui("first"));
    const frame = await waitForFrame(view.container);
    api.listPageRevisions.mockRejectedValueOnce(new Error("offline"));
    view.rerender(ui("second"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load page revisions.");
    expect(view.container.querySelector("iframe")).toBe(frame);
    api.listPageRevisions.mockResolvedValue({ items: [{ ...original, revision: 2 }] });
    fireEvent(window, new Event("focus"));
    await screen.findByText("2/2");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("follows a publication received before the initial revision read finishes", async () => {
    const api = services(), initial = deferredDownload<PageRevisionPage>();
    api.listPageRevisions.mockReturnValueOnce(initial.promise);
    const ui = (revisionRefreshKey: string) => <PageDocument page={original} services={api} visible onBack={() => {}} revisionRefreshKey={revisionRefreshKey} publishedRevision={revisionRefreshKey === "first" ? 1 : 3} />;
    const view = render(ui("first"));
    const firstSignal = api.listPageRevisions.mock.calls[0]![1]!.signal!;
    api.listPageRevisions.mockResolvedValue({ items: [{ ...original, revision: 3 }] });
    view.rerender(ui("third"));
    expect(firstSignal.aborted).toBe(true);
    await screen.findByText("3/3");
    await act(async () => initial.resolve({ items: [original] }));
    expect(screen.getByText("3/3")).toBeInTheDocument();
  });

  it.each(["reconnect", "focus", "other publication", "older history"])("keeps the exact opening anchor when %s happens during the initial read", async (change) => {
    const api = services(), initial = deferredDownload<PageRevisionPage>();
    const anchor = { ...original, revision: 2 }, newest = { ...original, revision: 5 };
    api.listPageRevisions.mockReturnValueOnce(initial.promise).mockResolvedValue({ items: [newest] });
    const ui = (key = "initial", publishedRevision = 2) => <PageDocument page={anchor} services={api} visible onBack={() => {}} revisionRefreshKey={key} publishedRevision={publishedRevision} />;
    const view = render(ui());
    if (change === "reconnect") view.rerender(ui("connected"));
    else if (change === "focus") fireEvent(window, new Event("focus"));
    else if (change === "older history") view.rerender(ui("initial", 1));
    else view.rerender(ui());
    await act(async () => initial.resolve({ items: [newest] }));
    await screen.findByLabelText("Revision 2 of 5");
    await waitFor(() => expect(view.container.querySelector("iframe")?.title).toBe("Phone · Revision 2"));
  });

  it("allows Next immediately after focus while the background read is pending", async () => {
    const api = services();
    const { container } = render(<PageDocument page={original} services={api} visible onBack={() => {}} />);
    await screen.findByLabelText("Revision 1 of 2");
    const background = deferredDownload<PageRevisionPage>();
    api.listPageRevisions.mockReturnValueOnce(background.promise);
    fireEvent(window, new Event("focus"));
    const next = screen.getByRole("button", { name: "Next page revision" });
    expect(next).toBeEnabled();
    fireEvent.click(next);
    await screen.findByText("2/2");
    await act(async () => background.resolve({ items: [{ ...original, revision: 2 }] }));
    expect(screen.getByText("2/2")).toBeInTheDocument();
    await waitFor(() => expect(container.querySelector("iframe")?.title).toBe("Updated phone · Revision 2"));
  });

  it.each(["publication", "reconnect"])("keeps locked manual navigation in flight through a %s check", async (change) => {
    const api = services(), anchor = { ...original, revision: 3 };
    api.listPageRevisions.mockResolvedValue({ items: [anchor] });
    const ui = (revisionRefreshKey = "initial", publishedRevision = 3) => <PageDocument page={anchor} services={api} visible onBack={() => {}} revisionRefreshKey={revisionRefreshKey} publishedRevision={publishedRevision} />;
    const view = render(ui());
    await screen.findByLabelText("Revision 3 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Lock page revision" }));
    const navigation = deferredDownload<PageRevision>();
    api.getPageRevision.mockReturnValueOnce(navigation.promise);
    fireEvent.click(screen.getByRole("button", { name: "Previous page revision" }));
    await waitFor(() => expect(api.getPageRevision).toHaveBeenCalledOnce());
    const signal = api.getPageRevision.mock.calls[0]![2]!;
    if (change === "publication") {
      api.listPageRevisions.mockResolvedValue({ items: [{ ...original, revision: 4 }] });
      view.rerender(ui("initial", 4));
      await screen.findByLabelText("Revision 3 of 4");
    } else view.rerender(ui("connected"));
    expect(signal.aborted).toBe(false);
    await act(async () => navigation.resolve({ ...original, revision: 2 }));
    await screen.findByText(change === "publication" ? "2/4" : "2/3");
  });

  it("clears a failed unlock catch-up when the user navigates manually", async () => {
    const api = services(), anchor = { ...original, revision: 3 };
    api.listPageRevisions.mockResolvedValue({ items: [anchor] });
    api.getPageRevision.mockResolvedValue({ ...original, revision: 2 });
    render(<PageDocument page={anchor} services={api} visible onBack={() => {}} />);
    await screen.findByLabelText("Revision 3 of 3");
    fireEvent.click(screen.getByRole("button", { name: "Lock page revision" }));
    api.listPageRevisions.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Lock page revision" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Previous page revision" }));
    await screen.findByText("2/3");
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(api.listPageRevisions).toHaveBeenCalledTimes(4));
    expect(screen.getByText("2/3")).toBeInTheDocument();
  });

  it.each([false, true])("rechecks missed updates when shown while locked=%s", async (locked) => {
    const api = services();
    api.listPageRevisions.mockResolvedValue({ items: [original] });
    const ui = (visible: boolean, revisionRefreshKey = "first") => <PageDocument page={original} services={api} visible={visible} onBack={() => {}} revisionRefreshKey={revisionRefreshKey} />;
    const view = render(ui(true));
    await waitForFrame(view.container);
    if (locked) fireEvent.click(screen.getByRole("button", { name: "Lock page revision" }));
    view.rerender(ui(false));
    const beforeHidden = api.listPageRevisions.mock.calls.length;
    api.listPageRevisions.mockResolvedValue({ items: [{ ...original, revision: 3 }] });
    view.rerender(ui(false, "third"));
    expect(api.listPageRevisions).toHaveBeenCalledTimes(beforeHidden);
    view.rerender(ui(true, "third"));
    await screen.findByText(locked ? "1/3" : "3/3");
    expect(screen.getByRole("button", { name: "Lock page revision" })).toHaveAttribute("aria-pressed", String(locked));
  });

  it("keeps the same frame while its available width changes", async () => {
    const api = services();
    let width = 640, resize!: ResizeObserverCallback;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    const { container } = render(<PageDocument page={{ ...original, viewport: { width: 1440, height: 1000 } }} services={api} visible onBack={() => {}} />);
    const frame = await waitForFrame(container);
    sendFrameMessage(frame, "sedes:page-size", { height: 1000 });
    expect(screen.getByRole("button", { name: "Zoom percentage: 44%" })).toBeInTheDocument();
    width = 1440;
    act(() => resize([], {} as ResizeObserver));
    expect(screen.getByRole("button", { name: "Zoom percentage: 100%" })).toBeInTheDocument();
    expect(container.querySelector("iframe")).toBe(frame);
    expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(1);
  });

  it("releases hidden frames immediately and reopens the selected revision with its zoom", async () => {
    const api = services();
    const ui = (visible: boolean) => <PageDocument page={original} services={api} visible={visible} onBack={() => {}} />;
    const view = render(ui(true));
    await screen.findByLabelText("Revision 1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Next page revision" }));
    await screen.findByText("2/2");
    const first = await waitForFrame(view.container);
    sendFrameMessage(first, "sedes:page-size", { height: 844 });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    view.rerender(ui(false));
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("button", { name: "Zoom percentage: 125%" })).toBeInTheDocument();
    view.rerender(ui(true));
    const second = await waitForFrame(view.container);
    expect(second).not.toBe(first);
    expect(second.title).toBe("Updated phone · Revision 2");
    expect(screen.getByRole("button", { name: "Zoom percentage: 125%" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Return to published revision 1" })).toHaveTextContent("2/2");
  });

  it("does not mint admission or query revisions until the document is visible", async () => {
    const api = services();
    const view = render(<PageDocument page={original} services={api} visible={false} onBack={() => {}} />);
    await act(async () => {});
    expect(api.createPageRenderAdmission).not.toHaveBeenCalled();
    expect(api.listPageRevisions).not.toHaveBeenCalled();
    expect(view.container.querySelector("iframe")).toBeNull();
    view.rerender(<PageDocument page={original} services={api} visible onBack={() => {}} />);
    await waitForFrame(view.container);
  });

  it("aborts revision reads on hiding and ignores their late results after reopening", async () => {
    const api = services();
    let resolveOld!: (value: PageRevisionPage) => void;
    api.listPageRevisions.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const ui = (visible: boolean) => <PageDocument page={original} services={api} visible={visible} onBack={() => {}} />;
    const view = render(ui(true));
    const oldSignal = api.listPageRevisions.mock.calls[0]![1]!.signal;
    view.rerender(ui(false));
    expect(oldSignal?.aborted).toBe(true);
    view.rerender(ui(true));
    await screen.findByLabelText("Revision 1 of 2");
    await act(async () => resolveOld({ items: [{ ...original, revision: 8 }] }));
    expect(screen.queryByText("1/8")).toBeNull();
    expect(screen.getByLabelText("Revision 1 of 2")).toBeInTheDocument();
  });

  it("closes zoom presets on Escape and returns focus to their trigger", async () => {
    const user = userEvent.setup();
    const { container } = render(<PageDocument page={original} services={services()} visible onBack={() => {}} />);
    await waitForFrame(container);
    const percentage = screen.getByRole("button", { name: /Zoom percentage:/ });
    await user.click(percentage);
    const presets = screen.getByRole("group", { name: "Zoom presets" });
    act(() => within(presets).getByRole("button", { name: "100%" }).focus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Zoom presets" })).toBeNull();
    expect(percentage).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renews admission after a retained frame acquires a replacement browsing context", async () => {
    const api = services();
    const { container } = render(<PageDocument page={original} services={api} visible onBack={() => {}} />);
    const frame = await waitForFrame(container);
    sendFrameMessage(frame, "sedes:page-size", { height: 844 });
    fireEvent.load(frame);
    vi.spyOn(frame, "contentWindow", "get").mockReturnValue(window);
    fireEvent.load(frame);
    await waitFor(() => expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(container.querySelector("iframe")).not.toBe(frame));
    expect(await waitForFrame(container)).toHaveAttribute("title", "Phone · Revision 1");
  });
  it("keeps a return to the published revision when a pending navigation resolves late", async () => {
    const api = services();
    const published = { ...original, revision: 3 };
    api.listPageRevisions.mockResolvedValue({ items: [published] });
    let resolvePending!: (value: PageRevision) => void;
    api.getPageRevision
      .mockResolvedValueOnce({ ...original, revision: 2 })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePending = resolve;
          }),
      );
    render(
      <PageDocument visible onBack={() => {}} page={published} services={api} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Previous page revision" }),
    );
    await screen.findByText("2/3");
    fireEvent.click(
      screen.getByRole("button", { name: "Previous page revision" }),
    );
    await waitFor(() => expect(api.getPageRevision).toHaveBeenCalledTimes(2));
    const signal = api.getPageRevision.mock.calls[1]?.[2];
    fireEvent.click(
      screen.getByRole("button", { name: "Return to published revision 3" }),
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => resolvePending(original));
    expect(screen.getByLabelText("Revision 3 of 3")).toHaveTextContent("3/3");
  });

  it("hides revision controls and the separator for a single revision", async () => {
    const api = services();
    api.listPageRevisions.mockResolvedValue({ items: [original] });
    render(
      <PageDocument visible onBack={() => {}} page={original} services={api} />,
    );
    await screen.findByRole("button", { name: "Refresh page preview" });
    await waitFor(() => expect(api.listPageRevisions).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("group", { name: "Page revision controls" }),
    ).toBeNull();
    expect(document.querySelector(".page-preview-header-separator")).toBeNull();
  });

  it("checks the server again after reaching a previously latest revision", async () => {
    const api = services();
    api.listPageRevisions
      .mockResolvedValueOnce({
        items: [{ ...original, revision: 2, title: "Updated phone" }],
      })
      .mockResolvedValueOnce({
        items: [{ ...original, revision: 2, title: "Updated phone" }],
      })
      .mockResolvedValueOnce({
        items: [{ ...original, revision: 3, title: "Newest phone" }],
      });
    render(<PageDocument visible onBack={() => {}} page={original} services={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Next page revision" }));
    await screen.findByText("2/2");
    fireEvent.click(
      screen.getByRole("button", { name: "Check for a newer page revision" }),
    );
    await screen.findByText("3/3");
    expect(api.listPageRevisions).toHaveBeenCalledTimes(3);
  });

  it.each([
    { viewport: { width: 1440 }, percentage: "44%", canvasHeight: 1333 },
    { viewport: {}, percentage: "100%", canvasHeight: 3000 },
  ])("fits an auto-height document page to width ($percentage)", async ({ viewport, percentage, canvasHeight }) => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    render(<PageDocument visible onBack={() => {}} page={{ ...original, viewport }} services={services()} />);
    const dialog = document.querySelector<HTMLElement>(".page-document")!;
    const frame = await waitForFrame(dialog);
    sendFrameMessage(frame, "sedes:page-size", { height: 3000 });
    expect(within(dialog).getByRole("button", { name: `Zoom percentage: ${percentage}` })).toBeInTheDocument();
    const canvas = dialog.querySelector<HTMLElement>(".page-frame-canvas")!;
    expect(Number.parseFloat(canvas.style.height)).toBeCloseTo(canvasHeight, -1);
    expect(Number.parseFloat(canvas.style.height)).toBeGreaterThan(400);
  });

  it("preserves an explicitly authored height while fitting the panel width", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    render(<PageDocument visible onBack={() => {}} page={{ ...original, viewport: { width: 1440, height: 1000 } }} services={services()} />);
    const dialog = document.querySelector<HTMLElement>(".page-document")!;
    await waitForFrame(dialog);
    expect(within(dialog).getByRole("button", { name: "Zoom percentage: 44%" })).toBeInTheDocument();
    expect(dialog.querySelector<HTMLElement>(".page-frame-canvas")!.style.height).toBe("444.4444444444444px");
  });

  it("refreshes the document document without publishing a new revision", async () => {
    const api = services();
    const { container } = render(<PageDocument visible onBack={() => {}} page={original} services={api} />);
    await waitForFrame(container);
    const dialog = document.querySelector<HTMLElement>(".page-document")!;
    const frame = await waitForFrame(dialog);
    sendFrameMessage(frame, "sedes:page-size", { height: 100 });
    const admissionsBeforeRefresh = api.createPageRenderAdmission.mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh page preview" }));
    await waitFor(() => expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(admissionsBeforeRefresh + 1));
    await waitFor(() => expect(dialog.querySelector("iframe")).not.toBe(frame));
    expect(container.querySelector(".page-document")).toHaveAttribute("data-page-revision", "1");
  });

  it("renders panel content interactively without chat controls or a nested dialog", async () => {
    const api = services();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
    const { container } = render(
      <PageDocument visible onBack={() => {}}
        page={{ ...original, viewport: { width: 390, height: 2000 } }}
        services={api}

      />,
    );
    const frame = await waitForFrame(container);
    expect(frame).not.toHaveAttribute("inert");
    expect(frame.style.height).toBe("2000px");
    expect(frame.style.transform).toBe("scale(1)");
    expect(
      screen.queryByRole("button", { name: /interact.*preview|Expand page:/i }),
    ).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("group", { name: "Page zoom controls" }),
    ).toBeInTheDocument();
  });

  it("loads a newly discovered revision on refresh while unlocked", async () => {
    const api = services();
    api.listPageRevisions.mockResolvedValueOnce({ items: [original] });
    const { container } = render(
      <PageDocument visible onBack={() => {}} page={original} services={api} />,
    );
    await waitForFrame(container);
    expect(screen.queryByRole("group", { name: "Page revision controls" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh page preview" }));
    await screen.findByText("2/2");
    await waitFor(() => expect(container.querySelector("iframe")?.title).toBe("Updated phone · Revision 2"));
  });

  it("preserves explicit retry protection in the immediate-interaction panel", async () => {
    const api = services();
    let view = render(
      <PageDocument visible onBack={() => {}} page={original} services={api} />,
    );
    sendFrameMessage(await waitForFrame(view.container), "sedes:page-error");
    view.unmount();
    view = render(
      <PageDocument visible onBack={() => {}} page={original} services={api} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Retry preview" }));
    expect(await waitForFrame(view.container)).not.toHaveAttribute("inert");
  });

  it("ignores stale revision counts after switching panel pages", async () => {
    const api = services();
    let resolveOld!: (value: PageRevisionPage) => void;
    let resolveNew!: (value: PageRevisionPage) => void;
    api.listPageRevisions
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNew = resolve;
          }),
      );
    const view = render(
      <PageDocument visible onBack={() => {}} page={original} services={api} />,
    );
    const oldSignal = api.listPageRevisions.mock.calls[0]?.[1]?.signal;
    fireEvent.click(screen.getByRole("button", { name: "Lock page revision" }));
    const another = {
      ...original,
      pageId: "30000000-0000-4000-8000-000000000002",
      title: "Another page",
    };
    view.rerender(
      <PageDocument visible onBack={() => {}} page={another} services={api} />,
    );
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Lock page revision" })).toHaveAttribute("aria-pressed", "false");
    await act(async () => resolveNew({ items: [{ ...another, revision: 3 }] }));
    expect(screen.getByLabelText("Revision 1 of 3")).toHaveTextContent("1/3");
    await act(async () =>
      resolveOld({ items: [{ ...original, revision: 9 }] }),
    );
    expect(screen.getByLabelText("Revision 1 of 3")).toHaveTextContent("1/3");
    expect(screen.queryByText("1/9")).toBeNull();
  });
});

describe("Pages document responses", () => {
  it("switches during a captured send without cancelling it or reusing its status for the new revision", async () => {
    const api = responseServices(), submission = pendingSubmission(api);
    api.listPageRevisions.mockResolvedValue({ items: [original] });
    const ui = (revisionRefreshKey: string) => <PageDocument page={original} services={api} visible onBack={() => {}} revisionRefreshKey={revisionRefreshKey} />;
    const view = render(ui("first"));
    producer(await waitForFrame(view.container), () => "captured from revision one");
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    await waitFor(() => expect(api.pageResponse.submit).toHaveBeenCalledOnce());
    const [request, signal] = api.pageResponse.submit.mock.calls[0]!;
    expect(request.pageResponse.revision).toBe(1);
    api.listPageRevisions.mockResolvedValue({ items: [{ ...original, revision: 3 }] });
    view.rerender(ui("third"));
    await screen.findByText("3/3");
    expect(signal?.aborted).toBe(false);
    await act(async () => submission.resolve());
    expect(screen.queryByText("Response queued.")).toBeNull();
    await waitFor(() => expect(view.container.querySelector("iframe")?.title).toBe("Phone · Revision 3"));
    producer(await waitForFrame(view.container), () => "captured from revision three");
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    await screen.findByText("Response queued.");
    expect(api.pageResponse.submit.mock.calls[1]![0]).toMatchObject({ text: "captured from revision three", pageResponse: { revision: 3 } });
  });

  it("retains a captured send and its exact retry while the panel is hidden", async () => {
    const api = responseServices(), submission = pendingSubmission(api);
    const ui = (visible: boolean) => <PageDocument page={original} services={api} visible={visible} onBack={() => {}} />;
    const view = render(ui(true));
    const frame = await waitForFrame(view.container), read = vi.fn(() => "captured in Pages");
    sendFrameMessage(frame, "sedes:page-size", { height: 844 });
    producer(frame, read);
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    await waitFor(() => expect(api.pageResponse.submit).toHaveBeenCalledTimes(1));
    const [request, signal] = api.pageResponse.submit.mock.calls[0]!;
    view.rerender(ui(false));
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(signal?.aborted).toBe(false);
    await act(async () => submission.reject(new TypeError("network lost")));
    view.rerender(ui(true));
    const freshRead = vi.fn(() => "fresh controls must not replace captured text");
    producer(await waitForFrame(view.container), freshRead);
    fireEvent.click(screen.getByRole("button", { name: "Retry page response" }));
    await screen.findByText("Response queued.");
    expect(api.pageResponse.readReceipt).toHaveBeenCalledWith(request.mutationId, expect.any(AbortSignal));
    expect(api.pageResponse.submit.mock.calls[1]![0]).toBe(request);
    expect(read).toHaveBeenCalledTimes(1);
    expect(freshRead).not.toHaveBeenCalled();
  });

  it("invalidates an unfinished frame capture when hidden but can capture from the reopened document", async () => {
    const api = responseServices();
    const ui = (visible: boolean) => <PageDocument page={original} services={api} visible={visible} onBack={() => {}} />;
    const view = render(ui(true));
    const frame = await waitForFrame(view.container);
    sendFrameMessage(frame, "sedes:page-size", { height: 844 });
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    sendFrameMessage(frame, "sedes:page-submit-ready");
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    const request = post.mock.calls[0]![0] as { requestId: string };
    view.rerender(ui(false));
    sendFrameMessage(frame, "sedes:page-submit-response", { requestId: request.requestId, text: "old capture" });
    await act(async () => {});
    view.rerender(ui(true));
    await screen.findByText("Page changed before its response was captured.");
    expect(api.pageResponse.submit).not.toHaveBeenCalled();
    producer(await waitForFrame(view.container), () => "reopened capture");
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    await screen.findByText("Response queued.");
    expect(api.pageResponse.submit.mock.calls[0]![0].text).toBe("reopened capture");
  });
  it("drops a pending captured response when refreshing its document", async () => {
    const api = responseServices();
    api.pageResponse.submit.mockRejectedValueOnce(new TypeError("network lost"));
    const { container } = render(<PageDocument visible onBack={() => {}} page={original} services={api} />);
    const oldFrame = await waitForFrame(container);
    producer(oldFrame, () => "old response");
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    await screen.findByRole("button", { name: "Retry page response" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh page preview" }));
    await waitFor(() => expect(container.querySelector("iframe")).not.toBe(oldFrame));
    producer(await waitForFrame(container), () => "new response");
    expect(screen.queryByRole("button", { name: "Retry page response" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    await screen.findByText("Response queued.");
    expect(api.pageResponse.submit.mock.calls[1]![0].text).toBe("new response");
    expect(api.pageResponse.readReceipt).not.toHaveBeenCalled();
  });
});

describe("saved page HTML downloads", () => {
  it.each([false, true])("keeps a captured download across automatic revision changes (native=%s)", async (native) => {
    const api = services();
    api.listPageRevisions.mockResolvedValue({ items: [original] });
    downloads.packaged.mockReturnValue(native);
    const prepared = await api.preparePageDownload(original);
    api.preparePageDownload.mockClear();
    const pending = deferredDownload<typeof prepared>();
    api.preparePageDownload.mockReturnValueOnce(pending.promise);
    const ui = (publishedRevision: number) => <PageDocument page={original} services={api} visible onBack={() => {}} publishedRevision={publishedRevision} />;
    const view = render(ui(1));
    await waitForFrame(view.container);
    fireEvent.click(screen.getByRole("button", { name: "Download HTML" }));
    const signal = api.preparePageDownload.mock.calls[0]![1]!;
    api.listPageRevisions.mockResolvedValue({ items: [{ ...original, revision: 3 }] });
    view.rerender(ui(3));
    await screen.findByText("3/3");
    expect(signal.aborted).toBe(false);
    await act(async () => pending.resolve(prepared));
    if (native) {
      await screen.findByText("HTML saved.");
      expect(downloads.native).toHaveBeenCalledWith(expect.objectContaining({ url: prepared.url, expectedRevision: original.sha256 }));
    } else {
      await screen.findByText("Download started.");
      expect(downloads.browser).toHaveBeenCalledWith(expect.objectContaining({ url: prepared.url }));
    }
    expect(api.preparePageDownload.mock.calls[0]![0]).toBe(original);
  });

  it.each(["revision", "connection", "unmount"])("aborts pending downloads and suppresses stale completion after %s", async (change) => {
    const api = services();
    const prepared = await api.preparePageDownload(original);
    api.preparePageDownload.mockClear();
    const pending = deferredDownload<typeof prepared>();
    api.preparePageDownload.mockReturnValue(pending.promise);
    const ui = (nextScope = scope) => <ConnectionScopeProvider scope={nextScope}>
      <PageDocument page={original} services={api} visible onBack={() => {}} />
    </ConnectionScopeProvider>;
    const view = renderView(ui());
    await screen.findByLabelText("Revision 1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Download HTML" }));
    const signal = api.preparePageDownload.mock.calls[0]![1]!;
    if (change === "revision") {
      fireEvent.click(screen.getByRole("button", { name: "Next page revision" }));
      await screen.findByText("2/2");
    } else if (change === "connection") view.rerender(ui(connectionScope("other", window.location.origin, "another-principal")));
    else view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(prepared));
    expect(downloads.browser).not.toHaveBeenCalled();
    expect(downloads.native).not.toHaveBeenCalled();
    expect(screen.queryByText("Download started.")).toBeNull();
  });

  it("cancels an open native picker when its document is closed and ignores a late result", async () => {
    downloads.packaged.mockReturnValue(true);
    const pending = deferredDownload<string>();
    downloads.native.mockReturnValue(pending.promise);
    const view = render(<PageDocument page={original} services={services()} visible onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Download HTML" }));
    await waitFor(() => expect(downloads.native).toHaveBeenCalledTimes(1));
    const signal = downloads.native.mock.calls[0]![0].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve("saved"));
    expect(screen.queryByText("HTML saved.")).toBeNull();
  });

  it("keeps a deliberate download and its status while the panel is hidden", async () => {
    downloads.packaged.mockReturnValue(true);
    const pending = deferredDownload<string>(), api = services();
    downloads.native.mockReturnValue(pending.promise);
    const ui = (visible: boolean) => <PageDocument page={original} services={api} visible={visible} onBack={() => {}} />;
    const view = render(ui(true));
    fireEvent.click(screen.getByRole("button", { name: "Download HTML" }));
    await waitFor(() => expect(downloads.native).toHaveBeenCalledTimes(1));
    const signal = downloads.native.mock.calls[0]![0].signal as AbortSignal;
    view.rerender(ui(false));
    expect(signal.aborted).toBe(false);
    await act(async () => pending.resolve("saved"));
    view.rerender(ui(true));
    expect(screen.getByText("HTML saved.")).toBeInTheDocument();
  });
  it("downloads the selected older revision even when safe rendering is unavailable", async () => {
    safety.supports.mockResolvedValue(false);
    const api = services();
    const published = { ...original, revision: 2, title: "New phone" };
    render(<PageDocument visible onBack={() => {}} page={published} services={api} />);
    const dialog = document.querySelector<HTMLElement>(".page-document")!;
    await within(dialog).findByText("Page preview unavailable.");
    await within(dialog).findByLabelText("Revision 2 of 2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Previous page revision" }));
    await within(dialog).findByText("1/2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Download HTML" }));
    await within(dialog).findByText("Download started.");
    expect(api.preparePageDownload).toHaveBeenCalledWith(original, expect.any(AbortSignal));
    expect(downloads.browser).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining("/revisions/1/download"), signal: expect.any(AbortSignal) }));
    expect(downloads.native).not.toHaveBeenCalled();
  });

  it("disables duplicates during preflight and displays browser GET failures independently of preview errors", async () => {
    const api = services();
    const prepared = await api.preparePageDownload(original);
    api.preparePageDownload.mockClear();
    const pending = deferredDownload<typeof prepared>();
    api.preparePageDownload.mockReturnValue(pending.promise);
    render(<PageDocument visible onBack={() => {}} page={original} services={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Download HTML" }));
    expect(screen.getByRole("button", { name: "Preparing HTML download" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Preparing HTML download" }));
    expect(api.preparePageDownload).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(prepared));
    expect(screen.getByRole("button", { name: "HTML download started" })).toBeDisabled();
    act(() => downloads.browser.mock.calls[0]![0].onFailure("This page is no longer available."));
    expect(screen.getByRole("alert")).toHaveTextContent("This page is no longer available.");
    expect(screen.getByRole("button", { name: "Download HTML" })).toBeEnabled();
  });

  it.each(["saved", "cancelled"])("uses the native picker and handles %s without starting browser navigation", async (result) => {
    downloads.packaged.mockReturnValue(true);
    downloads.native.mockResolvedValue(result);
    const api = services();
    render(<PageDocument visible onBack={() => {}} page={original} services={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Download HTML" }));
    await waitFor(() => expect(downloads.native).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Download HTML" })).toBeEnabled());
    expect(downloads.native).toHaveBeenCalledWith(expect.objectContaining({
      suggestedFileName: "Phone-1.html", expectedRevision: original.sha256,
      expectedContentLength: original.byteSize + 3, signal: expect.any(AbortSignal),
    }));
    expect(screen.queryByText("HTML saved.")).toBe(result === "saved" ? screen.getByText("HTML saved.") : null);
    expect(downloads.browser).not.toHaveBeenCalled();
    expect(screen.queryByText("Download started.")).toBeNull();
  });

  it("shows a preflight error and lets the user retry", async () => {
    const api = services();
    api.preparePageDownload.mockRejectedValueOnce(new Error("This page could not be prepared for download."));
    render(<PageDocument visible onBack={() => {}} page={original} services={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Download HTML" }));
    await screen.findByText("This page could not be prepared for download.");
    expect(screen.getByRole("button", { name: "Download HTML" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Download HTML" }));
    await screen.findByText("Download started.");
    expect(screen.queryByText("This page could not be prepared for download.")).toBeNull();
  });
});

function deferredDownload<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
