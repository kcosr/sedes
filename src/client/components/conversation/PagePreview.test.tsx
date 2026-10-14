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
import type { PageRevision, PageRevisionPage } from "../../../shared/protocol/pages.js";
import { PagePreview } from "./PagePreview.js";
import { startPreviewScrollMomentum } from "../preview/inline-touch-scroll.js";
import { connectionScope, ConnectionScopeProvider } from "../../app/connection-scope.js";

const scope = connectionScope("test", window.location.origin, "test-principal");
function render(ui: React.ReactNode) {
  return renderView(ui, {
    wrapper: ({ children }) => (
      <ConnectionScopeProvider scope={scope}>{children}</ConnectionScopeProvider>
    ),
  });
}

const safety = vi.hoisted(() => ({ supports: vi.fn(), android: vi.fn() }));
vi.mock("../../app/page-safety.js", () => ({
  supportsSafePageFrames: safety.supports,
}));
vi.mock("../../app/client-platform.js", () => ({
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
function expandPage(title = "Phone") {
  fireEvent.click(
    screen.getByRole("button", { name: `Expand page: ${title}` }),
  );
}

describe("published page preview", () => {
  it("loads on visibility, preserves authored width, and accepts only its own sizing messages", async () => {
    const visible = makePreviewsVisible(false),
      api = services();
    const { container } = render(
      <PagePreview
        page={{ ...original, viewport: { width: 390 } }}
        services={api}
      />,
    );
    expect(api.createPageRenderAdmission).not.toHaveBeenCalled();
    expect(screen.queryByText("Run interactive preview")).toBeNull();
    visible(true);
    const frame = await waitForFrame(container);
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame.style.width).toBe("390px");
    expect(frame.style.height).toBe("240px");
    const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get(
      "channel",
    );
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { type: "sedes:page-size", channel, height: 310 },
        }),
      ),
    );
    expect(frame.style.height).toBe("240px");
    sendFrameMessage(frame, "sedes:page-size", { height: 310 });
    await waitFor(() => expect(frame.style.height).toBe("310px"));
  });

  it("automatically renders on Android while hand/check gates only interaction", async () => {
    safety.android.mockReturnValue(true);
    const api = services();
    const { container } = render(
      <PagePreview page={original} services={api} />,
    );
    const frame = await waitForFrame(container);
    expect(frame).toHaveAttribute("inert");
    expect(frame).toHaveAttribute("tabindex", "-1");
    const enter = screen.getByRole("button", { name: "Interact with preview" });
    expect(enter).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(enter);
    expect(frame).not.toHaveAttribute("inert");
    fireEvent.click(
      screen.getByRole("button", { name: "Done interacting with preview" }),
    );
    expect(frame).toHaveAttribute("inert");
    expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(1);
  });

  it("requires explicit interaction on both touch devices and desktop", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: coarse)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    let view = render(<PagePreview page={original} services={services()} />);
    expect(await waitForFrame(view.container)).toHaveAttribute("inert");
    view.unmount();
    vi.stubGlobal("innerWidth", 360);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    view = render(<PagePreview page={original} services={services()} />);
    expect(await waitForFrame(view.container)).toHaveAttribute("inert");
    expect(
      screen.queryByRole("button", { name: "Interact with preview" }),
    ).toBeInTheDocument();
  });

  it("activates only on the browser click after a short stationary pointer sequence", async () => {
    const { container } = render(<PagePreview page={original} services={services()} />);
    const frame = await waitForFrame(container);
    const viewport = container.querySelector(".page-frame-viewport")!;
    const pointer = (type: string, x = 20, y = 20, timeStamp = 100) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, timeStamp: { value: timeStamp } });
      fireEvent(viewport, event);
    };
    const click = () => fireEvent.click(viewport, { detail: 1 });
    pointer("pointerdown"); pointer("pointermove", 20, 50); pointer("pointerup"); click();
    expect(frame).toHaveAttribute("inert");
    pointer("pointerdown"); fireEvent.wheel(viewport); pointer("pointerup"); click();
    expect(frame).toHaveAttribute("inert");
    pointer("pointerdown"); pointer("pointercancel"); pointer("pointerup"); click();
    expect(frame).toHaveAttribute("inert");
    pointer("pointerdown"); pointer("pointerup", 20, 20, 700); click();
    expect(frame).toHaveAttribute("inert");
    pointer("pointerdown"); pointer("pointerup");
    expect(frame).toHaveAttribute("inert");
    click();
    expect(frame).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Done interacting with preview" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not activate a native fling-stopping tap when the browser suppresses its click", async () => {
    const { container } = render(<PagePreview page={original} services={services()} />);
    const frame = await waitForFrame(container);
    const viewport = container.querySelector(".page-frame-viewport")!;
    const tap = () => {
      fireEvent.pointerDown(viewport, { pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 20 });
      fireEvent.pointerUp(viewport, { pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 20 });
    };
    fireEvent.scroll(container);
    tap();
    expect(frame).toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Interact with preview" })).toHaveAttribute("aria-pressed", "false");
    // A scripted click cannot consume the abandoned pointer candidate.
    fireEvent.click(viewport);
    expect(frame).toHaveAttribute("inert");
    tap();
    fireEvent.click(viewport, { detail: 1 });
    expect(frame).not.toHaveAttribute("inert");
  });

  it("permits a stationary click through programmatic and unrelated scrolling", async () => {
    const { container } = render(<PagePreview page={original} services={services()} />);
    const frame = await waitForFrame(container);
    const viewport = container.querySelector(".page-frame-viewport")!;
    const otherScroller = document.createElement("div");
    document.body.append(otherScroller);
    fireEvent.scroll(container);
    fireEvent.scroll(otherScroller);
    fireEvent.pointerDown(viewport, { pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 20 });
    fireEvent.scroll(container);
    fireEvent.scroll(otherScroller);
    fireEvent.pointerUp(viewport, { pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 20 });
    fireEvent.click(viewport, { detail: 1 });
    expect(frame).not.toHaveAttribute("inert");
    otherScroller.remove();
  });

  it("rejects the exact custom-fling stop input even before the first animation frame", async () => {
    const { container } = render(<PagePreview page={original} services={services()} />);
    const frame = await waitForFrame(container);
    const viewport = container.querySelector<HTMLElement>(".page-frame-viewport")!;
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 41));
    const cancel = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const stop = startPreviewScrollMomentum(viewport, 1);
    const tap = () => {
      fireEvent.pointerDown(viewport, { pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 20 });
      fireEvent.pointerUp(viewport, { pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 20 });
      fireEvent.click(viewport, { detail: 1 });
    };
    tap();
    expect(cancel).toHaveBeenCalledWith(41);
    expect(frame).toHaveAttribute("inert");
    tap();
    expect(frame).not.toHaveAttribute("inert");
    stop();
  });

  it.each([
    { viewport: { width: 1440 }, percentage: "44%", canvasHeight: 1333 },
    { viewport: {}, percentage: "100%", canvasHeight: 3000 },
  ])("fits an auto-height fullscreen page to width ($percentage)", async ({ viewport, percentage, canvasHeight }) => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    render(<PagePreview page={{ ...original, viewport }} services={services()} />);
    expandPage();
    const dialog = await screen.findByRole("dialog");
    const frame = await waitForFrame(dialog);
    sendFrameMessage(frame, "sedes:page-size", { height: 3000 });
    expect(within(dialog).getByRole("button", { name: `Zoom percentage: ${percentage}` })).toBeInTheDocument();
    const canvas = dialog.querySelector<HTMLElement>(".page-frame-canvas")!;
    expect(Number.parseFloat(canvas.style.height)).toBeCloseTo(canvasHeight, -1);
    expect(Number.parseFloat(canvas.style.height)).toBeGreaterThan(400);
  });

  it("fits an explicitly authored fullscreen height to the available viewport", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    render(<PagePreview page={{ ...original, viewport: { width: 1440, height: 1000 } }} services={services()} />);
    expandPage();
    const dialog = await screen.findByRole("dialog");
    await waitForFrame(dialog);
    expect(within(dialog).getByRole("button", { name: "Zoom percentage: 34%" })).toBeInTheDocument();
    expect(dialog.querySelector<HTMLElement>(".page-frame-canvas")!.style.height).toBe("336px");
  });

  it("restores the pinned publication after closing an older fullscreen revision", async () => {
    const published = { ...original, revision: 3, title: "Published third" };
    const api = services();
    api.listPageRevisions.mockResolvedValue({ items: [published] });
    api.getPageRevision.mockImplementation(async (_id, revision) => ({ ...original, revision, title: `Version ${revision}` }));
    const { container } = render(<PagePreview page={published} services={api} />);
    await waitForFrame(container);
    expandPage(published.title);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Previous page revision" }));
    await within(dialog).findByText("2/3");
    fireEvent.click(within(dialog).getByRole("button", { name: "Previous page revision" }));
    await within(dialog).findByText("1/3");
    await waitFor(() => expect(dialog.querySelector("iframe")).toHaveAttribute("title", "Version 1 · Revision 1"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const frame = await waitForFrame(container);
    expect(frame).toHaveAttribute("title", "Published third · Revision 3");
    expect(api.createPageRenderAdmission).toHaveBeenLastCalledWith(published.pageId, 3, expect.any(AbortSignal));
    expect(screen.getByRole("group", { name: /^Published third$/ })).toHaveAttribute("data-page-revision", "3");
    expandPage(published.title);
    await screen.findByLabelText("Revision 3 of 3");
  });

  it("shows only maximize and interaction inline and keeps revision controls in the fullscreen header", async () => {
    const api = services();
    const { container } = render(<PagePreview page={original} services={api} />);
    await waitForFrame(container);
    expect(container.querySelector(".wb-media-frame-header")).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Page actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Page details|Hide page details/ })).toBeNull();
    const expand = screen.getByRole("button", { name: "Expand page: Phone" });
    expect(container.querySelector(".page-preview-controls")?.children).toHaveLength(2);
    expandPage();
    const dialog = await screen.findByRole("dialog");
    const expandedFrame = await waitForFrame(dialog);
    expect(expandedFrame).not.toHaveAttribute("inert");
    expect(expandedFrame).toHaveAttribute("tabindex", "0");
    expect(within(dialog).queryByRole("button", { name: /interact.*preview/i })).toBeNull();
    const header = dialog.querySelector(".page-preview-fullscreen-header");
    expect(header).toBeInTheDocument();
    expect(within(header as HTMLElement).getByRole("toolbar", { name: "Page actions" })).toBeInTheDocument();
    expect(within(header as HTMLElement).getByRole("button", { name: "Next page revision" })).toHaveAttribute("data-size", "icon-lg");
    expect(within(header as HTMLElement).getByRole("button", { name: "Refresh page preview" })).toHaveAttribute("data-size", "icon-lg");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next page revision" }));
    const originalButton = await within(dialog).findByRole("button", { name: "Return to published revision 1" });
    expect(originalButton).toHaveTextContent("2/2");
    expect(api.listPageRevisions).toHaveBeenCalledWith(original.pageId, expect.objectContaining({ limit: 1 }));
    fireEvent.click(originalButton);
    expect(within(dialog).getByLabelText("Revision 1 of 2")).toHaveTextContent("1/2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(expand).toHaveFocus());
    expect(screen.queryByRole("toolbar", { name: "Page actions" })).toBeNull();
  });

  it("refreshes the fullscreen document without publishing a new revision", async () => {
    const api = services();
    const { container } = render(<PagePreview page={original} services={api} />);
    await waitForFrame(container);
    expandPage();
    const dialog = await screen.findByRole("dialog");
    const frame = await waitForFrame(dialog);
    sendFrameMessage(frame, "sedes:page-size", { height: 100 });
    const admissionsBeforeRefresh = api.createPageRenderAdmission.mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh page preview" }));
    await waitFor(() => expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(admissionsBeforeRefresh + 1));
    await waitFor(() => expect(dialog.querySelector("iframe")).not.toBe(frame));
    expect(container.querySelector(".page-preview")).toHaveAttribute("data-page-revision", "1");
  });

  it("closes zoom presets before the fullscreen Radix dialog and restores focus at each Escape", async () => {
    const user = userEvent.setup();
    const { container } = render(<PagePreview page={original} services={services()} />);
    await waitForFrame(container);
    const expand = screen.getByRole("button", { name: "Expand page: Phone" });
    await user.click(expand);
    const dialog = await screen.findByRole("dialog");
    await waitForFrame(dialog);
    const controls = within(dialog).getByRole("group", { name: "Page zoom controls" });
    const percentage = within(controls).getByRole("button", { name: /Zoom percentage:/ });
    await user.click(percentage);
    const presets = within(dialog).getByRole("group", { name: "Zoom presets" });
    act(() => within(presets).getByRole("button", { name: "100%" }).focus());
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).queryByRole("group", { name: "Zoom presets" })).toBeNull();
    expect(percentage).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(expand).toHaveFocus());
  });

  it("fails closed before minting on an unsafe native host", async () => {
    safety.supports.mockResolvedValue(false);
    const api = services();
    const { container } = render(
      <PagePreview page={original} services={api} />,
    );
    await screen.findByRole("alert");
    expect(api.createPageRenderAdmission).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")).toBeNull();
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
    render(<PagePreview page={original} services={api} />);
    expandPage();
    fireEvent.click(await screen.findByRole("button", { name: "Next page revision" }));
    await screen.findByText("2/2");
    fireEvent.click(
      screen.getByRole("button", { name: "Check for a newer page revision" }),
    );
    await screen.findByText("3/3");
    expect(api.listPageRevisions).toHaveBeenCalledTimes(3);
  });

  it("loads the total on viewer open without switching the published revision", async () => {
    const api = services();
    api.listPageRevisions.mockResolvedValue({
      items: [{ ...original, revision: 4 }],
    });
    const { container } = render(
      <PagePreview page={original} services={api} />,
    );
    await waitForFrame(container);
    expect(api.listPageRevisions).not.toHaveBeenCalled();
    expandPage();
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByLabelText("Revision 1 of 4"),
    ).toHaveTextContent("1/4");
    expect((await waitForFrame(dialog)).title).toBe("Phone · Revision 1");
    expect(api.getPageRevision).not.toHaveBeenCalled();
  });

  it("hides revision controls and the separator for a single revision", async () => {
    const api = services();
    api.listPageRevisions.mockResolvedValue({ items: [original] });
    render(
      <PagePreview page={original} services={api} presentation="library" />,
    );
    await screen.findByRole("button", { name: "Refresh page preview" });
    await waitFor(() => expect(api.listPageRevisions).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("group", { name: "Page revision controls" }),
    ).toBeNull();
    expect(document.querySelector(".page-preview-header-separator")).toBeNull();
  });

  it("renders library content interactively without chat controls or a nested dialog", async () => {
    const api = services();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
    const { container } = render(
      <PagePreview
        page={{ ...original, viewport: { width: 390, height: 2000 } }}
        services={api}
        presentation="library"
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

  it("discovers additional revisions on refresh without changing the library selection", async () => {
    const api = services();
    api.listPageRevisions.mockResolvedValueOnce({ items: [original] });
    const { container } = render(
      <PagePreview page={original} services={api} presentation="library" />,
    );
    await waitForFrame(container);
    expect(screen.queryByRole("group", { name: "Page revision controls" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh page preview" }));
    expect(await screen.findByLabelText("Revision 1 of 2")).toHaveTextContent("1/2");
    expect((await waitForFrame(container)).title).toBe("Phone · Revision 1");
  });

  it("preserves explicit retry protection in the immediate-interaction library", async () => {
    const api = services();
    let view = render(
      <PagePreview page={original} services={api} presentation="library" />,
    );
    sendFrameMessage(await waitForFrame(view.container), "sedes:page-error");
    view.unmount();
    view = render(
      <PagePreview page={original} services={api} presentation="library" />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Retry preview" }));
    expect(await waitForFrame(view.container)).not.toHaveAttribute("inert");
  });

  it("ignores stale revision counts after switching library pages", async () => {
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
      <PagePreview page={original} services={api} presentation="library" />,
    );
    const oldSignal = api.listPageRevisions.mock.calls[0]?.[1]?.signal;
    const another = {
      ...original,
      pageId: "30000000-0000-4000-8000-000000000002",
      title: "Another page",
    };
    view.rerender(
      <PagePreview page={another} services={api} presentation="library" />,
    );
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => resolveNew({ items: [{ ...another, revision: 3 }] }));
    expect(screen.getByLabelText("Revision 1 of 3")).toHaveTextContent("1/3");
    await act(async () =>
      resolveOld({ items: [{ ...original, revision: 9 }] }),
    );
    expect(screen.getByLabelText("Revision 1 of 3")).toHaveTextContent("1/3");
    expect(screen.queryByText("1/9")).toBeNull();
  });

  it("aborts a viewer count request on close and reloads it on reopen", async () => {
    const api = services();
    let resolveOld!: (value: PageRevisionPage) => void;
    api.listPageRevisions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    render(<PagePreview page={original} services={api} />);
    expandPage();
    const oldSignal = api.listPageRevisions.mock.calls[0]?.[1]?.signal;
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(oldSignal?.aborted).toBe(true);
    expandPage();
    await screen.findByLabelText("Revision 1 of 2");
    await act(async () =>
      resolveOld({ items: [{ ...original, revision: 8 }] }),
    );
    expect(screen.queryByText("1/8")).toBeNull();
    expect(screen.getByLabelText("Revision 1 of 2")).toBeInTheDocument();
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
      <PagePreview page={published} services={api} presentation="library" />,
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

  it("disposes the page only for its authenticated frame error", async () => {
    const { container } = render(
      <PagePreview page={original} services={services()} />,
    );
    const frame = await waitForFrame(container);
    const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get(
      "channel",
    );
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { type: "sedes:page-error", channel },
        }),
      ),
    );
    expect(container.querySelector("iframe")).toBe(frame);
    sendFrameMessage(frame, "sedes:page-error");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Page preview unavailable.",
    );
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("retains a failed revision across remount and clears it after successful retry", async () => {
    const api = services();
    let view = render(<PagePreview page={original} services={api} />);
    sendFrameMessage(await waitForFrame(view.container), "sedes:page-error");
    view.unmount();
    view = render(<PagePreview page={original} services={api} />);
    const retry = await screen.findByRole("button", { name: "Retry preview" });
    expect(view.container.querySelector("iframe")).toBeNull();
    fireEvent.click(retry);
    sendFrameMessage(await waitForFrame(view.container), "sedes:page-size", {
      height: 100,
    });
    view.unmount();
    view = render(<PagePreview page={original} services={api} />);
    await waitForFrame(view.container);
    expect(screen.queryByRole("button", { name: "Retry preview" })).toBeNull();
  });

  it("resumes automatically after an offscreen retention expires before acknowledgement", async () => {
    vi.useFakeTimers();
    const visible = makePreviewsVisible(),
      api = services();
    const { container } = render(
      <PagePreview page={original} services={api} />,
    );
    await act(async () => {});
    expect(container.querySelector("iframe")).not.toBeNull();
    visible(false);
    act(() => vi.advanceTimersByTime(30_000));
    expect(container.querySelector("iframe")).toBeNull();
    expect(localStorage.length).toBe(0);
    visible(true);
    await act(async () => {});
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(2);
  });


  it("retains the same frame and measured dimensions during a brief scroll away", async () => {
    const visible = makePreviewsVisible(), api = services();
    const { container } = render(
      <PagePreview page={{ ...original, viewport: { width: 390 } }} services={api} />,
    );
    const frame = await waitForFrame(container);
    sendFrameMessage(frame, "sedes:page-size", { height: 510 });
    const canvas = container.querySelector<HTMLElement>(".page-frame-canvas")!;
    const canvasHeight = canvas.style.height;
    vi.useFakeTimers();
    visible(false);
    act(() => vi.advanceTimersByTime(29_999));
    expect(container.querySelector("iframe")).toBe(frame);
    visible(true);
    act(() => vi.advanceTimersByTime(30_000));
    expect(container.querySelector("iframe")).toBe(frame);
    expect(canvas.style.height).toBe(canvasHeight);
    expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(1);
    visible(false);
    act(() => vi.advanceTimersByTime(30_000));
    expect(container.querySelector("iframe")).toBeNull();
    expect(canvas.style.height).toBe(canvasHeight);
  });

  it("immediately releases retained frames when the document hides", async () => {
    const visible = makePreviewsVisible(), api = services();
    const { container } = render(<PagePreview page={original} services={api} />);
    const frame = await waitForFrame(container);
    sendFrameMessage(frame, "sedes:page-size", { height: 844 });
    visible(false);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(container.querySelector("iframe")).toBeNull();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(container.querySelector("iframe")).toBeNull();
    visible(true);
    await waitForFrame(container);
    expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(2);
  });

  it("ends touch interaction while keeping an offscreen frame alive", async () => {
    safety.android.mockReturnValue(true);
    const visible = makePreviewsVisible();
    const { container } = render(<PagePreview page={original} services={services()} />);
    const frame = await waitForFrame(container);
    fireEvent.click(screen.getByRole("button", { name: "Interact with preview" }));
    expect(frame).not.toHaveAttribute("inert");
    visible(false);
    expect(container.querySelector("iframe")).toBe(frame);
    expect(frame).toHaveAttribute("inert");
    visible(true);
    expect(frame).toHaveAttribute("inert");
  });

  it("expands during loading and uses shared zoom controls with actual CSS-pixel sizing", async () => {
    const api = services();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
    render(
      <PagePreview
        page={{ ...original, viewport: { width: 1440, height: 1000 } }}
        services={api}
      />,
    );
    expandPage();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveClass("media-preview-dialog");
    const frame = await waitForFrame(dialog);
    expect(frame).not.toHaveAttribute("inert");
    expect(within(dialog).queryByRole("button", { name: "Interact with preview" })).toBeNull();
    expect(dialog.querySelector(".page-frame-toolbar")).toBeNull();
    const controls = within(dialog).getByRole("group", {
      name: "Page zoom controls",
    });
    expect(
      within(controls).getByRole("button", { name: "Zoom percentage: 44%" }),
    ).toBeInTheDocument();
    fireEvent.click(
      within(controls).getByRole("button", { name: "Actual size (100%)" }),
    );
    expect(
      within(controls).getByRole("button", { name: "Zoom percentage: 100%" }),
    ).toBeInTheDocument();
    sendFrameMessage(frame, "sedes:page-size", { height: 1000 });
  });

  it("retains manual recovery if durable browser recovery storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    const { container } = render(
      <PagePreview page={original} services={services()} />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry preview" }),
    );
    await waitForFrame(container);
  });

  it("bounds stalled transfer separately from wrapper execution and ignores duplicate ready messages", async () => {
    vi.useFakeTimers();
    const { container } = render(
      <PagePreview page={original} services={services()} />,
    );
    await act(async () => {});
    const frame = container.querySelector("iframe")!;
    expect(frame).not.toBeNull();
    act(() => vi.advanceTimersByTime(59_999));
    expect(container.querySelector("iframe")).toBe(frame);
    sendFrameMessage(frame, "sedes:page-wrapper-ready");
    act(() => vi.advanceTimersByTime(5_000));
    sendFrameMessage(frame, "sedes:page-wrapper-ready");
    act(() => vi.advanceTimersByTime(5_000));
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Page preview unavailable.",
    );
  });

  it("does not time out after a size acknowledgement preceding wrapper-ready", async () => {
    vi.useFakeTimers();
    const { container } = render(
      <PagePreview page={original} services={services()} />,
    );
    await act(async () => {});
    const frame = container.querySelector("iframe")!;
    sendFrameMessage(frame, "sedes:page-size", { height: 100 });
    fireEvent.load(frame);
    sendFrameMessage(frame, "sedes:page-wrapper-ready");
    act(() => vi.advanceTimersByTime(65_000));
    expect(container.querySelector("iframe")).toBe(frame);
  });
  it("expires a transfer that never acknowledges its wrapper", async () => {
    vi.useFakeTimers();
    const { container } = render(
      <PagePreview page={original} services={services()} />,
    );
    await act(async () => {});
    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    act(() => vi.advanceTimersByTime(59_999));
    expect(container.querySelector("iframe")).toBe(frame);
    act(() => vi.advanceTimersByTime(1));
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Page preview unavailable.",
    );
  });

  it("retains a previous failure when a pending retry expires offscreen", async () => {
    const visible = makePreviewsVisible();
    const { container } = render(
      <PagePreview page={original} services={services()} />,
    );
    sendFrameMessage(await waitForFrame(container), "sedes:page-error");
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry preview" }),
    );
    await waitForFrame(container);
    vi.useFakeTimers();
    visible(false);
    act(() => vi.advanceTimersByTime(30_000));
    expect(container.querySelector("iframe")).toBeNull();
    vi.useRealTimers();
    visible(true);
    await screen.findByRole("button", { name: "Retry preview" });
    expect(container.querySelector("iframe")).toBeNull();
  });
});

describe("page responses", () => {
  function responseServices() {
    return {
      ...services(),
      pageResponse: {
        threadId: original.threadId,
        submit: vi.fn(async (request: import("./page-response-services.js").PageResponseRequest, _signal?: AbortSignal): Promise<import("../../../shared/protocol/thread-input.js").DirectInputReceipt> => ({
          mutationId: request.mutationId, operationId: request.mutationId,
          threadId: original.threadId, admittedMode: "queue" as const,
          currentMode: "queue" as const, status: "queued" as const,
          queuedInputId: "queue-response",
        })),
        readReceipt: vi.fn<import("./page-response-services.js").PageResponseServices["readReceipt"]>(async () => ({ status: "notObserved" })),
      },
    };
  }
  function pendingSubmission(api: ReturnType<typeof responseServices>) {
    let resolve!: (receipt: import("../../../shared/protocol/thread-input.js").DirectInputReceipt) => void;
    let reject!: (error: Error) => void;
    api.pageResponse.submit.mockImplementationOnce(() => new Promise((accept, fail) => { resolve = accept; reject = fail; }));
    return {
      reject: (error: Error) => reject(error),
      resolve: (overrides: Partial<import("../../../shared/protocol/thread-input.js").DirectInputReceipt> = {}) => {
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

  it("captures only from host Send, preserves exact text and captures anew for each deliberate send", async () => {
    const api = responseServices();
    const { container } = render(<PagePreview page={original} services={api} />);
    const frame = await waitForFrame(container);
    let text = "  Plan:\n  * keep **literal** text\n";
    const read = vi.fn(() => text);
    const post = producer(frame, read);
    expect(api.pageResponse.submit).not.toHaveBeenCalled();
    sendFrameMessage(frame, "sedes:page-submit-response", { requestId: "unsolicited", text: "injected" });
    expect(api.pageResponse.submit).not.toHaveBeenCalled();
    const send = screen.getByRole("button", { name: "Send page response" });
    fireEvent.click(send);
    fireEvent.click(send);
    await screen.findByText("Response queued.");
    expect(read).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    const first = api.pageResponse.submit.mock.calls[0]![0];
    expect(first).toEqual({ mutationId: expect.any(String), text, pageResponse: { pageId: original.pageId, revision: 1 }, runningPolicy: { mode: "queue" } });
    expect(frame).toBe(container.querySelector("iframe"));
    text = "Changed controls";
    fireEvent.click(send);
    await waitFor(() => expect(api.pageResponse.submit).toHaveBeenCalledTimes(2));
    const second = api.pageResponse.submit.mock.calls[1]![0];
    expect(second.text).toBe(text);
    expect(second.mutationId).not.toBe(first.mutationId);
  });

  it("looks up a lost receipt and replays the identical request without recapturing edited controls", async () => {
    const api = responseServices();
    api.pageResponse.submit.mockRejectedValueOnce(new TypeError("network lost"));
    const { container } = render(<PagePreview page={original} services={api} />);
    let text = "captured once";
    const read = vi.fn(() => text);
    producer(await waitForFrame(container), read);
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    const retry = await screen.findByRole("button", { name: "Retry page response" });
    const first = api.pageResponse.submit.mock.calls[0]![0];
    text = "edited after lost response";
    fireEvent.click(retry);
    await screen.findByText("Response queued.");
    expect(api.pageResponse.readReceipt).toHaveBeenCalledWith(first.mutationId, expect.any(AbortSignal));
    expect(api.pageResponse.submit.mock.calls[1]![0]).toBe(first);
    expect(first.text).toBe("captured once");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("uses a found receipt without repeating admission or capture", async () => {
    const api = responseServices();
    api.pageResponse.submit.mockRejectedValueOnce(new TypeError("network lost"));
    api.pageResponse.readReceipt.mockImplementation(async mutationId => ({ status: "found", receipt: {
      mutationId, operationId: mutationId, threadId: original.threadId,
      admittedMode: "submit", currentMode: "submit", status: "accepted",
    } }));
    const { container } = render(<PagePreview page={original} services={api} />);
    const read = vi.fn(() => "response");
    producer(await waitForFrame(container), read);
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry page response" }));
    await screen.findByText("Response sent.");
    expect(api.pageResponse.submit).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not expose Send for a fork's source page or preview without response services", async () => {
    const api = responseServices();
    api.pageResponse.threadId = "fork-thread";
    const first = render(<PagePreview page={original} services={api} />);
    producer(await waitForFrame(first.container), () => "response");
    expect(screen.queryByRole("button", { name: "Send page response" })).toBeNull();
    first.unmount();
    const second = render(<PagePreview page={original} services={services()} />);
    producer(await waitForFrame(second.container), () => "response");
    expect(screen.queryByRole("button", { name: "Send page response" })).toBeNull();
  });

  it("rejects unavailable delivery before capture", async () => {
    const api = responseServices();
    const { container } = render(<PagePreview page={original} services={{ ...api, pageResponse: { ...api.pageResponse, unavailableReason: "Reconcile the uncertain input." } }} />);
    const read = vi.fn(() => "response");
    producer(await waitForFrame(container), read);
    expect(screen.getByRole("button", { name: "Send page response" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    expect(read).not.toHaveBeenCalled();
    expect(api.pageResponse.submit).not.toHaveBeenCalled();
  });

  it("drops a pending captured response when refreshing its document", async () => {
    const api = responseServices();
    api.pageResponse.submit.mockRejectedValueOnce(new TypeError("network lost"));
    const { container } = render(<PagePreview page={original} services={api} presentation="library" />);
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

  it("keeps recovery-required delivery bound to the existing receipt until explicitly reconciled", async () => {
    const api = responseServices();
    api.pageResponse.submit.mockImplementationOnce(async request => ({
      mutationId: request.mutationId, operationId: request.mutationId, threadId: original.threadId,
      admittedMode: "queue", currentMode: "queue", status: "recovery_required", queuedInputId: "queue-response",
    } as import("../../../shared/protocol/thread-input.js").DirectInputReceipt));
    api.pageResponse.readReceipt.mockImplementation(async mutationId => ({ status: "found", receipt: {
      mutationId, operationId: mutationId, threadId: original.threadId,
      admittedMode: "queue", currentMode: "submit", status: "accepted",
    } }));
    const { container } = render(<PagePreview page={original} services={api} />);
    const read = vi.fn(() => "response");
    producer(await waitForFrame(container), read);
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    await screen.findByText(/Use Reconcile in pending inputs/);
    fireEvent.click(screen.getByRole("button", { name: "Retry page response" }));
    await screen.findByText("Response sent.");
    expect(api.pageResponse.submit).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("invalidates an outstanding capture when connection scope changes", async () => {
    const api = responseServices();
    const view = renderView(<ConnectionScopeProvider scope={scope}><PagePreview page={original} services={api} /></ConnectionScopeProvider>);
    const frame = await waitForFrame(view.container);
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    sendFrameMessage(frame, "sedes:page-submit-ready");
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    const capturedRequest = post.mock.calls[0]![0] as { requestId: string };
    view.rerender(<ConnectionScopeProvider scope={connectionScope("other", window.location.origin, "other-principal")}><PagePreview page={original} services={api} /></ConnectionScopeProvider>);
    sendFrameMessage(frame, "sedes:page-submit-response", { requestId: capturedRequest.requestId, text: "old scope" });
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBe(frame));
    await act(async () => {});
    expect(api.pageResponse.submit).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Retry page response" })).toBeNull();
  });

  it("lets an admission finish after automatic frame release and labels an idle submit receipt accurately", async () => {
    const api = responseServices(), submission = pendingSubmission(api);
    const { container } = render(<PagePreview page={original} services={api} />);
    const read = vi.fn(() => "captured response");
    const frame = await waitForFrame(container);
    producer(frame, read);
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    await waitFor(() => expect(api.pageResponse.submit).toHaveBeenCalledTimes(1));
    const signal = api.pageResponse.submit.mock.calls[0]![1]!;
    documentVisibility("hidden");
    expect(container.querySelector("iframe")).toBeNull();
    expect(signal.aborted).toBe(false);
    expect(screen.getByRole("button", { name: "Send page response" })).toBeDisabled();
    await act(async () => submission.resolve({ admittedMode: "submit", currentMode: "submit", status: "queued" }));
    expect(screen.getByText("Response submitted.")).toHaveAttribute("role", "status");
    expect(screen.queryByText("Response queued.")).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
  });

  it("retains a lost admission's exact request and retries without a capture frame", async () => {
    const api = responseServices(), submission = pendingSubmission(api);
    const visible = makePreviewsVisible();
    const { container } = render(<PagePreview page={original} services={api} />);
    const read = vi.fn(() => "capture before release");
    producer(await waitForFrame(container), read);
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    await waitFor(() => expect(api.pageResponse.submit).toHaveBeenCalledTimes(1));
    const [request, signal] = api.pageResponse.submit.mock.calls[0]!;
    visible(false);
    documentVisibility("hidden");
    documentVisibility("visible");
    expect(container.querySelector("iframe")).toBeNull();
    expect(signal!.aborted).toBe(false);
    await act(async () => submission.reject(new TypeError("network lost")));
    fireEvent.click(screen.getByRole("button", { name: "Retry page response" }));
    await screen.findByText("Response queued.");
    expect(api.pageResponse.readReceipt).toHaveBeenCalledWith(request.mutationId, expect.any(AbortSignal));
    expect(api.pageResponse.submit.mock.calls[1]![0]).toBe(request);
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("shares admission and receipt retry across inline and expanded frames", async () => {
    const api = responseServices(), submission = pendingSubmission(api);
    api.pageResponse.readReceipt.mockImplementation(async mutationId => ({ status: "found", receipt: {
      mutationId, operationId: mutationId, threadId: original.threadId,
      admittedMode: "submit", currentMode: "submit", status: "accepted",
    } }));
    const { container } = render(<PagePreview page={original} services={api} />);
    const firstRead = vi.fn(() => "inline response");
    producer(await waitForFrame(container), firstRead);
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    await waitFor(() => expect(api.pageResponse.submit).toHaveBeenCalledTimes(1));
    const [request, signal] = api.pageResponse.submit.mock.calls[0]!;
    expandPage();
    const dialog = screen.getByRole("dialog");
    const expandedRead = vi.fn(() => "expanded response must not replace capture");
    producer(await waitForFrame(dialog), expandedRead);
    const send = within(dialog).getByRole("button", { name: "Send page response" });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(signal!.aborted).toBe(false);
    await act(async () => submission.reject(new TypeError("network lost")));
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry page response" }));
    await within(dialog).findByText("Response sent.");
    expect(api.pageResponse.readReceipt).toHaveBeenCalledWith(request.mutationId, expect.any(AbortSignal));
    expect(api.pageResponse.submit).toHaveBeenCalledTimes(1);
    expect(firstRead).toHaveBeenCalledTimes(1);
    expect(expandedRead).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.getByText("Response sent.")).toBeInTheDocument();
  });

  it("invalidates only the unfinished capture when expanding into a new document", async () => {
    const api = responseServices();
    const { container } = render(<PagePreview page={original} services={api} />);
    const frame = await waitForFrame(container);
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    sendFrameMessage(frame, "sedes:page-submit-ready");
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    const request = post.mock.calls[0]![0] as { requestId: string };
    expandPage();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Send page response" })).toBeDisabled();
    sendFrameMessage(frame, "sedes:page-submit-response", { requestId: request.requestId, text: "old capture" });
    await within(dialog).findByText("Page changed before its response was captured.");
    expect(api.pageResponse.submit).not.toHaveBeenCalled();
    const read = vi.fn(() => "expanded capture");
    producer(await waitForFrame(dialog), read);
    fireEvent.click(within(dialog).getByRole("button", { name: "Send page response" }));
    await within(dialog).findByText("Response queued.");
    expect(api.pageResponse.submit).toHaveBeenCalledTimes(1);
    expect(api.pageResponse.submit.mock.calls[0]![0].text).toBe("expanded capture");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not cancel a started admission when the entire preview unmounts", async () => {
    const api = responseServices(), submission = pendingSubmission(api);
    const view = render(<PagePreview page={original} services={api} />);
    producer(await waitForFrame(view.container), () => "admission outlives preview");
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    await waitFor(() => expect(api.pageResponse.submit).toHaveBeenCalledTimes(1));
    const signal = api.pageResponse.submit.mock.calls[0]![1]!;
    view.unmount();
    expect(signal.aborted).toBe(false);
    await act(async () => submission.resolve());
    expect(signal.aborted).toBe(false);
  });

  it("installs the handshake and submission bridge before a detached frame acquires its Window", async () => {
    const contentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow")!.get!;
    let attached = false;
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockImplementation(function(this: HTMLIFrameElement) {
      return attached ? contentWindow.call(this) : null;
    });
    const api = responseServices();
    const { container } = render(<PagePreview page={{ ...original, viewport: { width: 390 } }} services={api} />);
    const frame = await waitForFrame(container);
    expect(frame.contentWindow).toBeNull();
    attached = true;
    sendFrameMessage(frame, "sedes:page-size", { height: 320 });
    expect(frame.style.height).toBe("320px");
    producer(frame, () => "attached response");
    fireEvent.click(screen.getByRole("button", { name: "Send page response" }));
    await screen.findByText("Response queued.");
    expect(api.pageResponse.submit).toHaveBeenCalledTimes(1);
  });

  it("still times out a detached frame that never acquires a Window", async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(null);
    const { container } = render(<PagePreview page={original} services={services()} />);
    await act(async () => {});
    expect(container.querySelector("iframe")).not.toBeNull();
    act(() => vi.advanceTimersByTime(60_000));
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Page preview unavailable.");
  });
});
