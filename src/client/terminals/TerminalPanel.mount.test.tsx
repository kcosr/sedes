// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalResource } from "../../shared/index.js";
import type { TerminalSessionSnapshot } from "./terminal-session.js";
import type { TerminalPanelHandle } from "./TerminalPanel.js";

const fixture = vi.hoisted(() => ({
  mount: vi.fn<(container: HTMLElement) => Promise<{ columns: number; rows: number }>>(),
  dispose: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  setFontSize: vi.fn(() => ({ columns: 72, rows: 20 })),
  fit: vi.fn(() => ({ columns: 80, rows: 24 })),
  refreshMetrics: vi.fn(() => ({ columns: 80, rows: 24 })),
  emulatorResize: vi.fn(),
  sessionResize: vi.fn(),
  claimControl: vi.fn(),
  inputAvailable: false,
  sessionListeners: [] as Array<(state: TerminalSessionSnapshot) => void>,
  find: vi.fn(),
  clearSelection: vi.fn(),
  focus: vi.fn(),
  hasFocus: vi.fn(() => true),
  mobile: false,
  setCursorBlink: vi.fn(),
  resizeObservers: [] as TestResizeObserver[],
}));

vi.mock("./ghostty-emulator.js", () => ({
  GhosttyEmulator: class {
    mount = fixture.mount;
    dispose = fixture.dispose;
    onInput() { return () => undefined; }
    setController() {}
    fit = fixture.fit;
    refreshMetrics = fixture.refreshMetrics;
    resize = fixture.emulatorResize;
    setColorScheme() {}
    setCursorBlink = fixture.setCursorBlink;
    setFontSize = fixture.setFontSize;
    focus = fixture.focus;
    blur() {}
    hasFocus = fixture.hasFocus;
    transcript() { return ""; }
    find = fixture.find;
    clearSelection = fixture.clearSelection;
  },
}));

vi.mock("./terminal-session.js", () => ({
  TerminalSession: class {
    snapshot = {
      inputAvailable: fixture.inputAvailable,
      columns: 80,
      rows: 24,
    };
    connect = fixture.connect;
    close = fixture.close;
    subscribe(listener: (state: TerminalSessionSnapshot) => void) {
      const wrapped = (state: TerminalSessionSnapshot) => {
        this.snapshot = state;
        listener(state);
      };
      fixture.sessionListeners.push(wrapped);
      return () => {
        const index = fixture.sessionListeners.indexOf(wrapped);
        if (index >= 0) fixture.sessionListeners.splice(index, 1);
      };
    }
    resize = fixture.sessionResize;
    sendInput() { return true; }
    releaseControl() {}
    claimControl = fixture.claimControl;
    retryNotSentInput() {}
    discardUnconfirmedInput() {}
    retryConnection() {}
  },
}));

class TestResizeObserver {
  target?: Element;
  constructor(readonly callback: ResizeObserverCallback) {
    fixture.resizeObservers.push(this);
  }
  observe(target: Element) { this.target = target; }
  unobserve() {}
  disconnect() {}
}

const { TerminalPanel } = await import("./TerminalPanel.js");
const { setAppearance } = await import("../app/appearance.js");
const { setTerminalPreferences } = await import("../app/settings.js");

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: query === "(pointer: coarse)" || query === "(max-width: 720px), (pointer: coarse)"
      ? fixture.mobile
      : query === "(pointer: fine)" && !fixture.mobile,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
  fixture.mount.mockReset();
  fixture.dispose.mockReset();
  fixture.connect.mockReset();
  fixture.close.mockReset();
  fixture.setFontSize.mockClear();
  fixture.fit.mockReset().mockReturnValue({ columns: 80, rows: 24 });
  fixture.refreshMetrics.mockReset().mockReturnValue({ columns: 80, rows: 24 });
  fixture.emulatorResize.mockReset();
  fixture.sessionResize.mockReset();
  fixture.claimControl.mockReset();
  fixture.inputAvailable = false;
  fixture.sessionListeners.length = 0;
  fixture.find.mockReset();
  fixture.clearSelection.mockReset();
  fixture.focus.mockReset();
  fixture.hasFocus.mockReset().mockReturnValue(true);
  fixture.mobile = false;
  fixture.resizeObservers.length = 0;
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TerminalPanel renderer lifecycle", () => {
  it("retains autofocus until the browser accepts focus after connection setup", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    fixture.hasFocus.mockReturnValueOnce(false).mockReturnValue(true);
    render(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    act(() => fixture.sessionListeners[0]?.(readySnapshot));
    await waitFor(() => expect(fixture.focus).toHaveBeenCalledTimes(2));
  });

  it("does not discard pending autofocus after an unsuccessful imperative attempt", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    const ref = createRef<TerminalPanelHandle>();
    render(<TerminalPanel ref={ref} terminal={terminal} producerId="producer" api={api} visible />);
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    act(() => fixture.sessionListeners[0]?.(readySnapshot));
    fixture.hasFocus.mockReturnValueOnce(false).mockReturnValue(true);
    expect(ref.current?.focus()).toBe(false);
    await waitFor(() => expect(fixture.focus).toHaveBeenCalledTimes(2));
  });

  it("waits for the closing roster animation before focusing new terminal input", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    const view = render(
      <TerminalPanel terminal={terminal} producerId="producer" api={api} visible />,
    );
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "closed");
    view.container.append(dialog);
    act(() => fixture.sessionListeners[0]?.(readySnapshot));
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    expect(fixture.focus).not.toHaveBeenCalled();
    dialog.remove();
    await waitFor(() => expect(fixture.focus).toHaveBeenCalledOnce());
  });

  it("autofocuses desktop input once after replay and controller readiness", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    render(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    expect(fixture.focus).not.toHaveBeenCalled();
    act(() => fixture.sessionListeners[0]?.({ ...readySnapshot, caughtUp: false }));
    expect(fixture.focus).not.toHaveBeenCalled();
    act(() => fixture.sessionListeners[0]?.({ ...readySnapshot, inputAvailable: false }));
    expect(fixture.focus).not.toHaveBeenCalled();
    act(() => fixture.sessionListeners[0]?.(readySnapshot));
    await waitFor(() => expect(fixture.focus).toHaveBeenCalledOnce());
    act(() => fixture.sessionListeners[0]?.({ ...readySnapshot, appliedSeq: 10 }));
    act(() => fixture.sessionListeners[0]?.({ ...readySnapshot, connection: "reconnecting", caughtUp: false }));
    act(() => fixture.sessionListeners[0]?.(readySnapshot));
    await new Promise((resolve) => window.setTimeout(resolve, 40));
    expect(fixture.focus).toHaveBeenCalledOnce();
  });

  it("autofocuses again when reopening the panel or selecting a different terminal", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    const view = render(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    act(() => fixture.sessionListeners[0]?.(readySnapshot));
    await waitFor(() => expect(fixture.focus).toHaveBeenCalledOnce());
    view.rerender(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible={false} />);
    view.rerender(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledTimes(2));
    act(() => fixture.sessionListeners[0]?.(readySnapshot));
    await waitFor(() => expect(fixture.focus).toHaveBeenCalledTimes(2));
    view.rerender(<TerminalPanel terminal={{ ...terminal, terminalId: "another-terminal" }} producerId="producer" api={api} visible />);
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledTimes(3));
    act(() => fixture.sessionListeners[0]?.(readySnapshot));
    await waitFor(() => expect(fixture.focus).toHaveBeenCalledTimes(3));
  });

  it.each(["mobile", "interaction", "dialog", "search"])(
    "does not autofocus when blocked by %s", async (reason) => {
      fixture.mobile = reason === "mobile";
      fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
      const ref = createRef<TerminalPanelHandle>();
      const view = render(<TerminalPanel ref={ref} terminal={terminal} producerId="producer" api={api} visible />);
      await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
      if (reason === "interaction") fireEvent.pointerDown(document.body);
      if (reason === "dialog") {
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        view.container.append(dialog);
      }
      if (reason === "search") act(() => ref.current?.openSearch());
      act(() => fixture.sessionListeners[0]?.(readySnapshot));
      await new Promise((resolve) => window.setTimeout(resolve, 40));
      expect(fixture.focus).not.toHaveBeenCalled();
      if (reason !== "interaction") expect(ref.current?.focus()).toBe(false);
    },
  );

  it("retains the emulator and session while the workspace loses foreground ownership", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    const ref = createRef<TerminalPanelHandle>();
    const content = (active: boolean) => <TerminalPanel ref={ref} terminal={terminal} producerId="producer" api={api} visible active={active} />;
    const view = render(content(true));
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledTimes(1));
    const mountedHost = fixture.mount.mock.calls[0]![0];
    view.rerender(content(false));
    expect(ref.current?.focus()).toBe(false);
    expect(fixture.dispose).not.toHaveBeenCalled();
    expect(fixture.close).not.toHaveBeenCalled();
    view.rerender(content(true));
    expect(fixture.mount).toHaveBeenCalledTimes(1);
    expect(fixture.connect).toHaveBeenCalledTimes(1);
    expect(mountedHost.isConnected).toBe(true);
  });

  it("connects only after Ghostty Web is mounted", async () => {
    let resolveMount!: (size: { columns: number; rows: number }) => void;
    fixture.mount.mockReturnValue(new Promise((resolve) => { resolveMount = resolve; }));
    render(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);

    expect(fixture.connect).not.toHaveBeenCalled();
    resolveMount({ columns: 80, rows: 24 });
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
  });

  it("does not create a session when the panel closes during async mount", async () => {
    let resolveMount!: (size: { columns: number; rows: number }) => void;
    fixture.mount.mockReturnValue(new Promise((resolve) => { resolveMount = resolve; }));
    const view = render(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);
    view.unmount();
    resolveMount({ columns: 80, rows: 24 });
    await Promise.resolve();
    await Promise.resolve();

    expect(fixture.connect).not.toHaveBeenCalled();
    expect(fixture.dispose).toHaveBeenCalled();
  });

  it("uses a fresh renderer host for each terminal identity", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    const view = render(
      <TerminalPanel terminal={terminal} producerId="producer" api={api} visible />,
    );
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    const firstHost = fixture.mount.mock.calls[0]![0];

    view.rerender(
      <TerminalPanel
        terminal={{
          ...terminal,
          terminalId: "00000000-0000-4000-8000-000000000020",
          incarnationId: "00000000-0000-4000-8000-000000000021",
        }}
        producerId="producer"
        api={api}
        visible
      />,
    );

    await waitFor(() => expect(fixture.connect).toHaveBeenCalledTimes(2));
    const secondHost = fixture.mount.mock.calls[1]![0];
    expect(secondHost).not.toBe(firstHost);
    expect(firstHost.isConnected).toBe(false);
    expect(secondHost.isConnected).toBe(true);
  });

  it("keeps the latest display name when a mounted session reports lifecycle changes", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    const onResourceChange = vi.fn();
    const view = render(
      <TerminalPanel
        terminal={terminal}
        producerId="producer"
        api={api}
        visible
        onResourceChange={onResourceChange}
      />,
    );
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());

    view.rerender(
      <TerminalPanel
        terminal={{
          ...terminal,
          displayName: "Renamed terminal",
          lifecycleRevision: 2,
        }}
        producerId="producer"
        api={api}
        visible
        onResourceChange={onResourceChange}
      />,
    );
    act(() => fixture.sessionListeners[0]?.(readySnapshot));
    expect(onResourceChange).not.toHaveBeenCalled();
    act(() =>
      fixture.sessionListeners[0]?.({
        ...readySnapshot,
        lifecycle: "exited",
        lifecycleRevision: 3,
      }),
    );

    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(onResourceChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        displayName: "Renamed terminal",
        lifecycle: "exited",
        lifecycleRevision: 3,
      }),
    );
  });

  it("keeps restored output hidden until the session is caught up", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    const { container } = render(
      <TerminalPanel terminal={terminal} producerId="producer" api={api} visible />,
    );
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    const host = container.querySelector(".terminal-panel-emulator");
    expect(host).toHaveAttribute("data-restored", "false");

    act(() => fixture.sessionListeners[0]?.(readySnapshot));
    expect(host).toHaveAttribute("data-restored", "true");
  });

  it("refits after the first controller paint when mount-time metrics were stale", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    fixture.fit
      .mockReturnValueOnce({ columns: 80, rows: 24 })
      .mockReturnValue({ columns: 132, rows: 37 });
    render(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());

    act(() => fixture.sessionListeners[0]?.(readySnapshot));
    expect(fixture.sessionResize).toHaveBeenCalledWith(80, 24);
    expect(animationFrames).toHaveLength(2);

    act(() => animationFrames.shift()?.(performance.now()));
    expect(fixture.fit).toHaveBeenCalledTimes(2);
    expect(fixture.sessionResize).toHaveBeenLastCalledWith(132, 37);
  });

  it("settles keyboard resize animations without replacing the focused terminal", async () => {
    fixture.mobile = true;
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    fixture.sessionResize.mockReturnValue(true);
    const { container } = render(
      <TerminalPanel terminal={terminal} producerId="producer" api={api} visible />,
    );
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    try {
      act(() => fixture.sessionListeners[0]?.(readySnapshot));
      await act(() => vi.advanceTimersByTimeAsync(300));
      fixture.sessionResize.mockClear();
      const host = container.querySelector(".terminal-panel-emulator")!;
      const observer = fixture.resizeObservers.find(({ target }) => target === host)!;
      const input = document.createElement("textarea");
      host.append(input);
      input.focus();
      for (let rows = 23; rows >= 8; rows -= 1) {
        fixture.fit.mockReturnValue({ columns: 80, rows });
        act(() => observer.callback([], observer));
        await act(() => vi.advanceTimersByTimeAsync(16));
      }
      expect(fixture.sessionResize).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(fixture.sessionResize).toHaveBeenCalledExactlyOnceWith(80, 8);
      expect(input).toHaveFocus();
      expect(fixture.connect).toHaveBeenCalledOnce();
      expect(fixture.close).not.toHaveBeenCalled();
      expect(fixture.dispose).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fits desktop pane resizes immediately", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    fixture.sessionResize.mockReturnValue(true);
    const { container } = render(
      <TerminalPanel terminal={terminal} producerId="producer" api={api} visible />,
    );
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    act(() => fixture.sessionListeners[0]?.(readySnapshot));
    fixture.sessionResize.mockClear();
    fixture.fit.mockReturnValue({ columns: 120, rows: 30 });
    const host = container.querySelector(".terminal-panel-emulator")!;
    const observer = fixture.resizeObservers.find(({ target }) => target === host)!;

    act(() => observer.callback([], observer));

    expect(fixture.sessionResize).toHaveBeenCalledExactlyOnceWith(120, 30);
    expect(fixture.connect).toHaveBeenCalledOnce();
  });

  it("takes control on a visible observer attach before publishing its size", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    render(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());

    act(() => fixture.sessionListeners[0]?.({
      ...readySnapshot,
      role: "observer",
      inputAvailable: false,
    }));
    expect(fixture.claimControl).toHaveBeenCalledOnce();
    expect(fixture.sessionResize).not.toHaveBeenCalled();

    act(() => fixture.sessionListeners[0]?.(readySnapshot));
    expect(fixture.sessionResize).toHaveBeenCalledWith(80, 24);
  });

  it("retakes control when an observing page returns to the foreground", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    render(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());

    act(() => fixture.sessionListeners[0]?.(readySnapshot));
    act(() => fixture.sessionListeners[0]?.({
      ...readySnapshot,
      role: "observer",
      inputAvailable: false,
    }));
    fixture.claimControl.mockClear();

    act(() => window.dispatchEvent(new Event("pageshow")));

    expect(fixture.claimControl).toHaveBeenCalledOnce();
  });

  it.each([
    ["desktop Escape", false],
    ["mobile Back Escape", true],
  ])("consumes %s before panel-level dismissal", async (_label, mobile) => {
    fixture.mobile = mobile;
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    const ref = createRef<TerminalPanelHandle>();
    render(
      <TerminalPanel
        ref={ref}
        terminal={terminal}
        producerId="producer"
        api={api}
        visible
      />,
    );
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    act(() => ref.current?.openSearch());
    const searchInput = screen.getByRole("searchbox", {
      name: "Search terminal text",
    });
    const panelDismissal = vi.fn();
    document.addEventListener("keydown", panelDismissal);

    fireEvent.keyDown(mobile ? document : searchInput, { key: "Escape" });

    expect(panelDismissal).not.toHaveBeenCalled();
    expect(screen.queryByRole("search", { name: "Search terminal" })).toBeNull();
    await waitFor(() => expect(fixture.focus).toHaveBeenCalled());
    document.removeEventListener("keydown", panelDismissal);
  });

  it("reports terminal match counts and disables navigation for no match", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    fixture.find
      .mockReturnValueOnce({ found: false, index: 0, total: 0 })
      .mockReturnValueOnce({ found: true, index: 2, total: 3 });
    const ref = createRef<TerminalPanelHandle>();
    const { container } = render(
      <TerminalPanel
        ref={ref}
        terminal={terminal}
        producerId="producer"
        api={api}
        visible
      />,
    );
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    act(() => ref.current?.openSearch());
    const input = screen.getByRole("searchbox", { name: "Search terminal text" });

    fireEvent.change(input, { target: { value: "missing" } });
    expect(container.querySelector(".thread-find-count")).toHaveTextContent(
      "0 of 0",
    );
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();

    fireEvent.change(input, { target: { value: "found" } });
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next match" })).toBeEnabled();
  });

  it("retains short live-search input while clearing stale selection and results", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    fixture.find.mockReturnValue({ found: true, index: 1, total: 2 });
    const ref = createRef<TerminalPanelHandle>();
    const { container } = render(
      <TerminalPanel
        ref={ref}
        terminal={terminal}
        producerId="producer"
        api={api}
        visible
      />,
    );
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    act(() => ref.current?.openSearch());
    const input = screen.getByRole("searchbox", { name: "Search terminal text" });

    fireEvent.change(input, { target: { value: "α β γ" } });
    expect(fixture.find).toHaveBeenLastCalledWith("α β γ", 1);
    expect(container.querySelector(".thread-find-count")).toHaveTextContent("1 of 2");

    fireEvent.change(input, { target: { value: " α β " } });
    expect(input).toHaveValue(" α β ");
    expect(fixture.find).toHaveBeenCalledTimes(1);
    expect(fixture.clearSelection).toHaveBeenCalledOnce();
    expect(container.querySelector(".thread-find-count")).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(fixture.find).toHaveBeenCalledTimes(1);
  });

  it("remounts and replays through a fresh Ghostty terminal when the theme changes", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    render(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());

    act(() => setAppearance("dark"));
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledTimes(2));
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.dispose).toHaveBeenCalled();
  });

  it("updates cursor blinking without reconnecting the terminal", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    render(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    act(() => setTerminalPreferences({ cursorBlink: false, fontSize: 13, scrollback: 8_000 }));
    expect(fixture.setCursorBlink).toHaveBeenLastCalledWith(false);
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.dispose).not.toHaveBeenCalled();
  });

  it("applies terminal font-size changes without reconnecting", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    render(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());

    act(() => setTerminalPreferences({ cursorBlink: true, fontSize: 18, scrollback: 8_000 }));

    await waitFor(() => expect(fixture.setFontSize).toHaveBeenCalledWith(18));
    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.close).not.toHaveBeenCalled();
  });

  it("applies the latest font size when preferences change during async mount", async () => {
    let resolveMount!: (size: { columns: number; rows: number }) => void;
    fixture.mount.mockReturnValue(new Promise((resolve) => { resolveMount = resolve; }));
    render(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);

    act(() => setTerminalPreferences({ cursorBlink: true, fontSize: 19, scrollback: 8_000 }));
    expect(fixture.setFontSize).not.toHaveBeenCalled();
    resolveMount({ columns: 80, rows: 24 });

    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());
    expect(fixture.setFontSize).toHaveBeenCalledOnce();
    expect(fixture.setFontSize).toHaveBeenCalledWith(19);
  });

  it("restores canonical geometry after observer font changes", async () => {
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    render(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());

    act(() => setTerminalPreferences({ cursorBlink: true, fontSize: 18, scrollback: 8_000 }));

    await waitFor(() => expect(fixture.setFontSize).toHaveBeenCalledWith(18));
    expect(fixture.emulatorResize).toHaveBeenCalledWith(80, 24);
    expect(fixture.sessionResize).not.toHaveBeenCalled();
  });

  it("sends fitted geometry after controller font changes", async () => {
    fixture.inputAvailable = true;
    fixture.mount.mockResolvedValue({ columns: 80, rows: 24 });
    render(<TerminalPanel terminal={terminal} producerId="producer" api={api} visible />);
    await waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());

    act(() => setTerminalPreferences({ cursorBlink: true, fontSize: 18, scrollback: 8_000 }));

    await waitFor(() => expect(fixture.setFontSize).toHaveBeenCalledWith(18));
    expect(fixture.sessionResize).toHaveBeenCalledWith(72, 20);
    expect(fixture.emulatorResize).not.toHaveBeenCalled();
  });
});

const api = {
  createTerminalAdmission: vi.fn(),
  terminalWebSocketUrl: vi.fn(),
};

const readySnapshot: TerminalSessionSnapshot = {
  connection: "ready",
  role: "controller",
  controlRequestPending: false,
  controllerEpoch: 1,
  lifecycle: "running",
  lifecycleRevision: 1,
  rows: 24,
  columns: 80,
  appliedSeq: 0,
  caughtUp: true,
  inputAvailable: true,
  retryInputAvailable: false,
  queuedInputCount: 0,
  queuedInputBytes: 0,
  inputQueueOverflowed: false,
};

const terminal: TerminalResource = {
  terminationEffect: "end_process",
  terminalId: "00000000-0000-4000-8000-000000000010",
  threadId: "00000000-0000-4000-8000-000000000011",
  workspaceId: "00000000-0000-4000-8000-000000000012",
  environmentId: "local",
  environmentLabel: "Local",
  incarnationId: "00000000-0000-4000-8000-000000000013",
  displayName: "Terminal",
  shellProfile: null,
  initialCwd: "/workspace",
  lifecycle: "running",
  lifecycleRevision: 1,
  rows: 24,
  columns: 80,
  initialRows: 24,
  initialColumns: 80,
  historyFloorSeq: 0,
  headSeq: 0,
  exitCode: null,
  exitSignal: null,
  publicReason: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  startedAt: "2026-08-27T00:00:00.000Z",
  exitedAt: null,
  updatedAt: "2026-08-27T00:00:00.000Z",
};
