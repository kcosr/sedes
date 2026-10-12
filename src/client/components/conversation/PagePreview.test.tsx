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

beforeEach(() => {
  safety.supports.mockReset().mockResolvedValue(true);
  safety.android.mockReset().mockReturnValue(false);
  localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
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

function makePreviewsVisible() {
  const observers = new Set<IntersectionObserverCallback>();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(readonly callback: IntersectionObserverCallback) { observers.add(callback); }
    observe() { this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    disconnect() { observers.delete(this.callback); }
  });
  return (visible: boolean) => act(() => {
    for (const callback of observers)
      callback([{ isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
}

function sendFrameMessage(frame: HTMLIFrameElement, type: string, extra = {}) {
  const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("channel");
  act(() => window.dispatchEvent(new MessageEvent("message", {
    source: frame.contentWindow,
    data: { type, channel, ...extra },
  })));
}

describe("published page preview", () => {
  it("requires admission, retains the authored viewport, and trusts only its frame's size messages", async () => {
    const api = services();
    const { container } = render(
      <PagePreview
        page={{ ...original, viewport: { width: 390 } }}
        services={api}
      />,
    );
    expect(api.createPageRenderAdmission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run interactive preview" }));
    await waitFor(() =>
      expect(container.querySelector("iframe")).toBeInTheDocument(),
    );
    const iframe = container.querySelector("iframe")!;
    expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(iframe.style.width).toBe("390px");
    expect(iframe.style.height).toBe("240px");
    const url = new URL(iframe.src);
    const channel = new URLSearchParams(url.hash.slice(1)).get("channel");
    const received = new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { type: "sedes:page-size", channel, height: 310 },
    });
    expect(received.source).toBe(iframe.contentWindow);
    expect(channel).toBeTruthy();
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          data: { type: "sedes:page-size", channel, height: 310 },
        }),
      ),
    );
    expect(iframe.style.height).toBe("240px");
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: iframe.contentWindow,
          data: { type: "sedes:page-size", channel, height: 310 },
        }),
      );
    });
    await waitFor(() => expect(iframe.style.height).toBe("310px"));
  });

  it("keeps revision navigation local to each occurrence and returns to its pinned version", async () => {
    const api = services();
    const second = { ...original, revision: 2, title: "Updated phone" };
    const { container } = render(
      <>
        <PagePreview page={original} services={api} />
        <PagePreview page={second} services={api} />
      </>,
    );
    const cards = container.querySelectorAll<HTMLElement>(".page-preview");
    fireEvent.click(
      within(cards[1]!).getByRole("button", { name: "Previous page revision" }),
    );
    await waitFor(() =>
      expect(
        within(cards[1]!).getByText("Published here as revision 2"),
      ).toBeInTheDocument(),
    );
    expect(within(cards[0]!).getByText("Revision 1")).toBeInTheDocument();
    expect(api.listPageRevisions).toHaveBeenCalledWith(
      original.pageId,
      expect.objectContaining({ limit: 1 }),
    );
    expect(api.getPageRevision).toHaveBeenCalledWith(
      original.pageId,
      1,
      expect.any(AbortSignal),
    );
    fireEvent.click(
      within(cards[1]!).getByRole("button", { name: "Original" }),
    );
    expect(within(cards[1]!).getByText("Revision 2")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("Revision 1")).toBeInTheDocument();
  });

  it("fails closed before minting a document URL on an unsafe native host", async () => {
    safety.supports.mockResolvedValue(false);
    const api = services();
    const { container } = render(
      <PagePreview page={original} services={api} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run interactive preview" }));
    await screen.findByRole("alert");
    expect(api.createPageRenderAdmission).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("checks the server again after reaching a previously latest revision", async () => {
    const api = services();
    const second = { ...original, revision: 2, title: "Updated phone" };
    const third = { ...original, revision: 3, title: "Newest phone" };
    api.listPageRevisions
      .mockResolvedValueOnce({ items: [second] })
      .mockResolvedValueOnce({ items: [third] });
    render(<PagePreview page={original} services={api} />);
    fireEvent.click(screen.getByRole("button", { name: "Next page revision" }));
    await screen.findByText("Revision 2");
    const check = screen.getByRole("button", {
      name: "Check for a newer page revision",
    });
    expect(check).toBeEnabled();
    fireEvent.click(check);
    await screen.findByText("Revision 3");
    expect(
      screen.getByText("Published here as revision 1"),
    ).toBeInTheDocument();
    expect(api.listPageRevisions).toHaveBeenCalledTimes(2);
  });

  it("disposes the page only for an authenticated outer-frame error", async () => {
    const { container } = render(
      <PagePreview page={original} services={services()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run interactive preview" }));
    await waitFor(() =>
      expect(container.querySelector("iframe")).toBeInTheDocument(),
    );
    const frame = container.querySelector("iframe")!;
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
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { type: "sedes:page-error", channel },
        }),
      ),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Page preview unavailable.",
    );
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("preserves an early size acknowledgment when wrapper-ready arrives later", async () => {
    vi.useFakeTimers();
    const { container } = render(
      <PagePreview page={original} services={services()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run interactive preview" }));
    await act(async () => {});
    expect(container.querySelector("iframe")).toBeInTheDocument();
    const frame = container.querySelector("iframe")!;
    act(() => vi.advanceTimersByTime(15_000));
    expect(container.querySelector("iframe")).toBe(frame);
    const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get(
      "channel",
    );
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          data: { type: "sedes:page-size", channel, height: 100 },
        }),
      ),
    );
    fireEvent.load(frame);
    act(() => window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      data: { type: "sedes:page-wrapper-ready", channel },
    })));
    act(() => vi.advanceTimersByTime(15_000));
    expect(container.querySelector("iframe")).toBe(frame);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("requires an explicit Android activation even for a visible preview", async () => {
    makePreviewsVisible();
    safety.android.mockReturnValue(true);
    const api = services();
    const { container } = render(<PagePreview page={original} services={api} />);
    await act(async () => {});
    expect(api.createPageRenderAdmission).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run interactive preview" }));
    await waitFor(() => expect(container.querySelector("iframe")).toBeInTheDocument());
    expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(1);
  });

  it("remembers a failed revision and restores its failure when a manual retry is cancelled", async () => {
    makePreviewsVisible();
    const api = services();
    let view = render(<PagePreview page={original} services={api} />);
    await waitFor(() => expect(view.container.querySelector("iframe")).toBeInTheDocument());
    sendFrameMessage(view.container.querySelector("iframe")!, "sedes:page-error");
    view.unmount();
    view = render(<PagePreview page={original} services={api} />);
    await waitFor(() => expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", { name: "Run interactive preview" });
    expect(view.container.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run interactive preview" }));
    await waitFor(() => expect(view.container.querySelector("iframe")).toBeInTheDocument());
    view.unmount();
    view = render(<PagePreview page={original} services={api} />);
    await screen.findByRole("button", { name: "Run interactive preview" });
    await waitFor(() => expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(4));
    expect(view.container.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run interactive preview" }));
    await waitFor(() => expect(view.container.querySelector("iframe")).toBeInTheDocument());
    sendFrameMessage(view.container.querySelector("iframe")!, "sedes:page-size", { height: 100 });
    view.unmount();
    view = render(<PagePreview page={original} services={api} />);
    await waitFor(() => expect(view.container.querySelector("iframe")).toBeInTheDocument());
    expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(6);
  });

  it("automatically resumes after scrolling away before the size acknowledgement", async () => {
    const setVisible = makePreviewsVisible();
    const api = services();
    const { container } = render(<PagePreview page={original} services={api} />);
    await waitFor(() => expect(container.querySelector("iframe")).toBeInTheDocument());
    setVisible(false);
    await waitFor(() => expect(container.querySelector("iframe")).toBeNull());
    expect(localStorage.length).toBe(0);
    setVisible(true);
    await waitFor(() => expect(container.querySelector("iframe")).toBeInTheDocument());
    expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(2);
  });

  it("opens the expanded preview during initial loading without requiring a manual retry", async () => {
    makePreviewsVisible();
    const api = services();
    const { container } = render(<PagePreview page={original} services={api} />);
    await waitFor(() => expect(container.querySelector("iframe")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Expand page: Phone" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.querySelector("iframe")).toBeInTheDocument());
    expect(container.querySelector("iframe")).toBeNull();
    expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(2);
    sendFrameMessage(dialog.querySelector("iframe")!, "sedes:page-size", { height: 100 });
    expect(localStorage.length).toBe(0);
  });

  it("requires a manual start when browser recovery storage is unavailable", async () => {
    makePreviewsVisible();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    const api = services();
    const { container } = render(<PagePreview page={original} services={api} />);
    await screen.findByRole("button", { name: "Run interactive preview" });
    await waitFor(() => expect(api.createPageRenderAdmission).toHaveBeenCalledTimes(1));
    expect(container.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Run interactive preview" }));
    await waitFor(() => expect(container.querySelector("iframe")).toBeInTheDocument());
  });

  it("bounds a stalled transport separately from wrapper execution", async () => {
    vi.useFakeTimers();
    const { container } = render(<PagePreview page={original} services={services()} />);
    fireEvent.click(screen.getByRole("button", { name: "Run interactive preview" }));
    await act(async () => {});
    expect(container.querySelector("iframe")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(59_999));
    expect(container.querySelector("iframe")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Page preview unavailable.");
  });

  it("times out ten seconds after trusted wrapper-ready without extending for duplicates", async () => {
    vi.useFakeTimers();
    const { container } = render(<PagePreview page={original} services={services()} />);
    fireEvent.click(screen.getByRole("button", { name: "Run interactive preview" }));
    await act(async () => {});
    const frame = container.querySelector("iframe")!;
    const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("channel");
    act(() => window.dispatchEvent(new MessageEvent("message", {
      source: window,
      data: { type: "sedes:page-wrapper-ready", channel },
    })));
    act(() => vi.advanceTimersByTime(20_000));
    expect(container.querySelector("iframe")).toBe(frame);
    sendFrameMessage(frame, "sedes:page-wrapper-ready");
    act(() => vi.advanceTimersByTime(5_000));
    sendFrameMessage(frame, "sedes:page-wrapper-ready");
    act(() => vi.advanceTimersByTime(5_000));
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Page preview unavailable.");
    expect(localStorage.length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
    await act(async () => {});
    expect(container.querySelector("iframe")).toBeInTheDocument();
  });
});
