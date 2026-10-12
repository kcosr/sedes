// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageRevision } from "../../../shared/protocol/pages.js";
import { PagePreview } from "./PagePreview.js";

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
    createPageRenderAdmission: vi.fn(async () => ({
      url: "/page-render/token",
      expiresAt: "2026-10-11T10:10:00.000Z",
    })),
    listPageRevisions: vi.fn(async () => ({
      items: [{ ...original, revision: 2, title: "Updated phone" }],
    })),
    getPageRevision: vi.fn(async () => original),
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

  it("activates only for a short stationary tap, never a drag, scroll, wheel or canceled gesture", async () => {
    const { container } = render(<PagePreview page={original} services={services()} />);
    const frame = await waitForFrame(container);
    const viewport = container.querySelector(".page-frame-viewport")!;
    const pointer = (type: string, x = 20, y = 20, timeStamp = 100) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
      Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, timeStamp: { value: timeStamp } });
      fireEvent(viewport, event);
    };
    pointer("pointerdown"); pointer("pointermove", 20, 50); pointer("pointerup");
    expect(frame).toHaveAttribute("inert");
    pointer("pointerdown"); fireEvent.scroll(window); pointer("pointerup");
    expect(frame).toHaveAttribute("inert");
    pointer("pointerdown"); fireEvent.wheel(viewport); pointer("pointerup");
    expect(frame).toHaveAttribute("inert");
    pointer("pointerdown"); pointer("pointercancel"); pointer("pointerup");
    expect(frame).toHaveAttribute("inert");
    pointer("pointerdown"); pointer("pointerup", 20, 20, 700);
    expect(frame).toHaveAttribute("inert");
    pointer("pointerdown"); pointer("pointerup");
    expect(frame).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Done interacting with preview" })).toHaveAttribute("aria-pressed", "true");
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
    const header = dialog.querySelector(".page-preview-fullscreen-header");
    expect(header).toBeInTheDocument();
    expect(within(header as HTMLElement).getByRole("toolbar", { name: "Page actions" })).toBeInTheDocument();
    expect(within(header as HTMLElement).getByRole("button", { name: "Next page revision" })).toHaveAttribute("data-size", "icon-lg");
    expect(within(header as HTMLElement).getByRole("button", { name: "Refresh page preview" })).toHaveAttribute("data-size", "icon-lg");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next page revision" }));
    const originalButton = await within(dialog).findByRole("button", { name: "Return to published revision 1" });
    expect(originalButton).toHaveTextContent("v2");
    expect(api.listPageRevisions).toHaveBeenCalledWith(original.pageId, expect.objectContaining({ limit: 1 }));
    fireEvent.click(originalButton);
    expect(within(dialog).getByLabelText("Revision 1")).toHaveTextContent("v1");
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
        items: [{ ...original, revision: 3, title: "Newest phone" }],
      });
    render(<PagePreview page={original} services={api} />);
    expandPage();
    fireEvent.click(screen.getByRole("button", { name: "Next page revision" }));
    await screen.findByText("v2");
    fireEvent.click(
      screen.getByRole("button", { name: "Check for a newer page revision" }),
    );
    await screen.findByText("v3");
    expect(api.listPageRevisions).toHaveBeenCalledTimes(2);
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
    expect(frame).toHaveAttribute("inert");
    fireEvent.click(within(dialog).getByRole("button", { name: "Interact with preview" }));
    expect(frame).not.toHaveAttribute("inert");
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
