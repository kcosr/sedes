import { act } from "react";
import { getTerminalPreferences, setTerminalPreferences } from "../app/settings.js";
// @vitest-environment jsdom

import { useContext, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedThreadSnapshot } from "../../shared/index.js";
import type { BoundedValue } from "../../shared/index.js";
import type { ApiClient } from "../api/ApiClient.js";
import type { ThreadClientStore } from "../stores/ThreadClientStore.js";
import {
  CODEX_TUI_PALETTES,
  type CodexTuiRenderer,
} from "./codex-tui-renderer.js";
import { setAppearance } from "../app/appearance.js";
import { setMobileHistorySeekControl } from "../app/settings.js";
import type { CodexTuiTransport } from "./codex-tui-transport.js";
import { CodexTuiThreadPresentation } from "./codex-tui.js";
import type { ChatHistoryEntry } from "../components/thread/ChatHistoryRail.js";
import { ChatViewVisibilityContext } from "../components/thread/chat-view-visibility.js";
import { CodexTuiTerminalControlContext } from "./codex-tui.js";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CodexTuiThreadPresentation", () => {
  it("defines distinct light and dark Ghostty palettes", () => {
    expect(CODEX_TUI_PALETTES.light.background).toBe("#f7f7f8");
    expect(CODEX_TUI_PALETTES.light.foreground).toBe("#24272d");
    expect(CODEX_TUI_PALETTES.dark.background).toBe("#111318");
    expect(CODEX_TUI_PALETTES.dark.foreground).toBe("#e5e7eb");
  });
  it("fails closed for unavailable, unknown, mismatched, and historical states", () => {
    const { rerender } = renderPresentation(snapshot("unavailable"));
    expect(screen.queryByRole("group", { name: "Thread view" })).toBeNull();

    rerender(element(snapshot("available", { revision: 2 })));
    expect(screen.queryByRole("group", { name: "Thread view" })).toBeNull();

    rerender(element(snapshot("available"), { historicalFocus: true }));
    expect(screen.queryByRole("group", { name: "Thread view" })).toBeNull();
    expect(screen.getByTestId("chat-content")).toBeVisible();
  });

  it("decodes both closed exit-status variants from bounded provider state", () => {
    const { rerender } = renderPresentation(
      snapshot("available", {
        lifecycle: "exited",
        exitStatus: { kind: "code", code: 7 },
      }),
    );
    expect(screen.getByRole("group", { name: "Thread view" })).toBeVisible();
    rerender(
      element(
        snapshot("available", {
          lifecycle: "exited",
          exitStatus: { kind: "signal", signal: "SIGTERM" },
        }),
      ),
    );
    expect(screen.getByRole("group", { name: "Thread view" })).toBeVisible();
  });

  it("starts with null arguments and retains the mounted Chat subtree", async () => {
    const perform = vi.fn(async () => ({ status: "accepted" as const }));
    renderPresentation(snapshot("available", { lifecycle: "stopped" }), {
      perform,
    });
    const chat = screen.getByTestId("chat-content");
    const tui = screen.getByRole("button", { name: "TUI" });

    fireEvent.click(tui);
    expect(chat).toBeInTheDocument();
    expect(screen.getByTestId("chat-thread-panel")).toHaveAttribute("hidden");
    expect(screen.getByText("Launching TUI…")).toBeVisible();
    await waitFor(() => expect(perform).toHaveBeenCalledTimes(1));
    expect(perform).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "perform_provider_feature",
        actionId: "start",
        arguments: null,
        expectedFeatureRevision: 1,
      }),
    );
    expect(
      window.sessionStorage.getItem("sedes.codex-tui.view.v1:thread-1"),
    ).toBe("tui");
  });

  it("docks an interaction panel above a still-available Chat, TUI, and composer", () => {
    window.sessionStorage.setItem("sedes.codex-tui.view.v1:thread-1", "tui");
    renderPresentation(snapshot("available", { lifecycle: "running" }), {
      rendererFactory: () => fakeRenderer().value,
      transportFactory: () => fakeTransport().value,
      takeover: <div data-testid="test-takeover">Action required</div>,
    });

    const content = screen.getByTestId("thread-presentation-content");
    expect(content).not.toHaveAttribute("inert");
    expect(content).not.toHaveAttribute("aria-hidden");
    expect(content).toContainElement(screen.getByTestId("chat-thread-panel"));
    expect(content).toContainElement(screen.getByTestId("codex-tui-panel"));
    expect(content).toContainElement(screen.getByTestId("composer-content"));
    const viewport = screen.getByTestId("thread-presentation-viewport");
    expect(viewport).toContainElement(screen.getByTestId("chat-thread-panel"));
    expect(viewport).toContainElement(screen.getByTestId("codex-tui-panel"));
    expect(viewport).not.toContainElement(
      screen.getByTestId("composer-content"),
    );
    // The panel docks inside the column, immediately ahead of the composer, so
    // it shares the thread's vertical space instead of covering its controls.
    const takeover = screen.getByTestId("test-takeover");
    expect(content).toContainElement(takeover);
    expect(
      takeover.compareDocumentPosition(screen.getByTestId("composer-content")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("docks Chat status between the transcript viewport and all composer UI", () => {
    renderPresentation(snapshot("available", { lifecycle: "running" }), {
      status: <div data-testid="test-status">Current agent item</div>,
      takeover: <div data-testid="test-takeover">Action required</div>,
    });

    const content = screen.getByTestId("thread-presentation-content");
    const viewport = screen.getByTestId("thread-presentation-viewport");
    const status = screen.getByTestId("test-status");
    const takeover = screen.getByTestId("test-takeover");
    const composer = screen.getByTestId("composer-content");
    expect(status.parentElement).toBe(content);
    expect(viewport.compareDocumentPosition(status)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(status.compareDocumentPosition(takeover)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(takeover.compareDocumentPosition(composer)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("keeps a failed Start visible inside TUI with recovery actions", async () => {
    renderPresentation(snapshot("available", { lifecycle: "stopped" }), {
      perform: vi.fn(async () => {
        throw new Error("Remote PTY launch failed.");
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "TUI" }));
    expect(await screen.findByText("TUI failed to start")).toBeVisible();
    expect(screen.getByText("Remote PTY launch failed.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Return to Chat" }),
    ).toBeVisible();
  });

  it("offers explicit recovery when a remembered TUI viewer is stopped", async () => {
    window.sessionStorage.setItem("sedes.codex-tui.view.v1:thread-1", "tui");
    const perform = vi.fn(async () => ({ status: "accepted" as const }));
    renderPresentation(snapshot("available", { lifecycle: "stopped" }), {
      perform,
    });

    expect(screen.getByText("TUI is stopped")).toBeVisible();
    expect(perform).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Return to Chat" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Start TUI" }));
    await waitFor(() => expect(perform).toHaveBeenCalledTimes(1));
    expect(perform).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "start", arguments: null }),
    );
  });

  it("temporarily forces historical focus to Chat without replacing remembered TUI", () => {
    window.sessionStorage.setItem("sedes.codex-tui.view.v1:thread-1", "tui");
    const value = snapshot("available", { lifecycle: "running" });
    const { rerender } = renderPresentation(value, {
      historicalFocus: true,
      rendererFactory: () => fakeRenderer().value,
      transportFactory: () => fakeTransport().value,
    });
    expect(screen.getByTestId("chat-thread-panel")).toBeVisible();
    expect(
      window.sessionStorage.getItem("sedes.codex-tui.view.v1:thread-1"),
    ).toBe("tui");

    rerender(
      element(value, {
        rendererFactory: () => fakeRenderer().value,
        transportFactory: () => fakeTransport().value,
      }),
    );
    expect(screen.getByRole("button", { name: "TUI" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("persists Chat when exact feature availability is lost", async () => {
    window.sessionStorage.setItem("sedes.codex-tui.view.v1:thread-1", "tui");
    const { rerender } = renderPresentation(
      snapshot("available", { lifecycle: "running" }),
      {
        rendererFactory: () => fakeRenderer().value,
        transportFactory: () => fakeTransport().value,
      },
    );
    expect(screen.getByRole("button", { name: "TUI" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    rerender(element(snapshot("unavailable")));
    await waitFor(() =>
      expect(
        window.sessionStorage.getItem("sedes.codex-tui.view.v1:thread-1"),
      ).toBe("chat"),
    );
    expect(screen.queryByRole("group", { name: "Thread view" })).toBeNull();
    expect(screen.getByTestId("chat-thread-panel")).toBeVisible();
  });

  it("preserves and restores remembered TUI through a transient revision mismatch", () => {
    window.sessionStorage.setItem("sedes.codex-tui.view.v1:thread-1", "tui");
    const rendererFactory = () => fakeRenderer().value;
    const transportFactory = () => fakeTransport().value;
    const { rerender } = renderPresentation(
      snapshot("available", { lifecycle: "running" }),
      { rendererFactory, transportFactory },
    );
    expect(screen.getByRole("button", { name: "TUI" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    rerender(
      element(snapshot("available", { revision: 2, lifecycle: "running" }), {
        rendererFactory,
        transportFactory,
      }),
    );
    expect(screen.queryByRole("group", { name: "Thread view" })).toBeNull();
    expect(screen.getByTestId("chat-thread-panel")).toBeVisible();
    expect(
      window.sessionStorage.getItem("sedes.codex-tui.view.v1:thread-1"),
    ).toBe("tui");

    rerender(
      element(snapshot("available", { lifecycle: "running" }), {
        rendererFactory,
        transportFactory,
      }),
    );
    expect(screen.getByRole("button", { name: "TUI" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("codex-tui-panel")).toBeVisible();
  });

  it("keeps a coherent read-only TUI attached while withholding mutations", () => {
    window.sessionStorage.setItem("sedes.codex-tui.view.v1:thread-1", "tui");
    const renderer = fakeRenderer();
    const transport = fakeTransport();
    const perform = vi.fn();
    const rendererFactory = () => renderer.value;
    const transportFactory = () => transport.value;
    const { rerender } = renderPresentation(
      snapshot("available", { lifecycle: "running" }),
      {
        perform,
        rendererFactory,
        transportFactory,
      },
    );

    rerender(
      element(snapshot("read_only", { lifecycle: "running" }), {
        perform,
        rendererFactory,
        transportFactory,
      }),
    );

    expect(screen.getByRole("button", { name: "TUI" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("codex-tui-panel")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop TUI" })).toBeNull();
    expect(
      window.sessionStorage.getItem("sedes.codex-tui.view.v1:thread-1"),
    ).toBe("tui");
    expect(perform).not.toHaveBeenCalled();
    expect(renderer.value.dispose).not.toHaveBeenCalled();
    expect(transport.value.close).not.toHaveBeenCalled();
  });

  it("shows the bounded unavailable reason for a stopped read-only TUI", () => {
    window.sessionStorage.setItem("sedes.codex-tui.view.v1:thread-1", "tui");
    renderPresentation(snapshot("read_only", { lifecycle: "stopped" }));

    expect(screen.getByText("TUI is stopped")).toBeVisible();
    expect(screen.getByText("Unavailable")).toBeVisible();
    expect(
      screen.queryByText("Select TUI to launch the managed terminal."),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Start TUI" })).toBeNull();
  });

  it("supports directional and boundary keyboard selection", () => {
    renderPresentation(snapshot("available", { lifecycle: "stopped" }), {
      perform: vi.fn(() => new Promise(() => undefined)),
    });
    const chat = screen.getByRole("button", { name: "Chat" });
    chat.focus();
    fireEvent.keyDown(chat, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "TUI" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "TUI" }), {
      key: "Home",
    });
    expect(chat).toHaveAttribute("aria-pressed", "true");
    expect(chat).toHaveFocus();
  });

  it("keeps one renderer and transport mounted across Chat/TUI switches", async () => {
    const renderer = fakeRenderer();
    const transport = fakeTransport();
    const rendererFactory = vi.fn(() => renderer.value);
    const transportFactory = vi.fn((observer) => {
      transport.setObserver(observer);
      return transport.value;
    });
    renderPresentation(snapshot("available", { lifecycle: "running" }), {
      rendererFactory,
      transportFactory,
    });

    fireEvent.click(screen.getByRole("button", { name: "TUI" }));
    await waitFor(() => expect(rendererFactory).toHaveBeenCalledTimes(1));
    act(() => setTerminalPreferences({ ...getTerminalPreferences(), cursorBlink: false }));
    expect(renderer.value.setCursorBlink).toHaveBeenLastCalledWith(false);
    expect(rendererFactory).toHaveBeenCalledTimes(1);

    expect(transport.value.connect).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("region", { name: "Codex terminal" }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.getByTestId("codex-tui-panel")).toHaveAttribute("hidden");
    expect(renderer.value.dispose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "TUI" }));
    expect(rendererFactory).toHaveBeenCalledTimes(1);
    expect(transport.value.connect).toHaveBeenCalledTimes(1);
    expect(renderer.value.focus).toHaveBeenCalled();
    expect(screen.queryByLabelText("Terminal font size")).toBeNull();
    expect(screen.queryByLabelText("Terminal scrollback lines")).toBeNull();
  });

  it("returns from TUI to Chat before delivering a history seek", () => {
    window.sessionStorage.setItem("sedes.codex-tui.view.v1:thread-1", "tui");
    const onSelect = vi.fn();
    const historyEntries: readonly ChatHistoryEntry[] = [
      {
        itemId: "user-1",
        turnId: "turn-1",
        userPreview: "Earlier question",
        assistantPreview: "Earlier answer",
        responseState: "available",
      },
      {
        itemId: "user-2",
        turnId: "turn-2",
        userPreview: "Latest question",
        assistantPreview: "Latest answer",
        responseState: "available",
      },
    ];
    renderPresentation(snapshot("available", { lifecycle: "running" }), {
      rendererFactory: () => fakeRenderer().value,
      transportFactory: () => fakeTransport().value,
      mobileHistory: {
        entries: historyEntries,
        activeItemId: "user-2",
        onBeginInteraction: () => "user-2",
        assistantLabel: "Codex",
        onSelect,
      },
    });
    expect(screen.getByTestId("chat-thread-panel")).toHaveAttribute("hidden");

    const scanner = screen.getByRole("button", {
      name: "Tap to jump to the latest user message; hold to scrub conversation history",
    });
    fireEvent.click(scanner, { detail: 0 });
    fireEvent.keyDown(scanner, { key: "ArrowUp" });
    fireEvent.click(scanner, { detail: 0 });

    expect(screen.getByTestId("chat-thread-panel")).toBeVisible();
    expect(onSelect).toHaveBeenCalledWith("user-1");
    expect(
      window.sessionStorage.getItem("sedes.codex-tui.view.v1:thread-1"),
    ).toBe("chat");
  });

  it("removes the mobile history control and hit target when disabled", async () => {
    const mobileHistory = {
      entries: [
        {
          itemId: "user-1",
          turnId: "turn-1",
          userPreview: "Earlier question",
          assistantPreview: "Earlier answer",
          responseState: "available" as const,
        },
      ],
      activeItemId: "user-1",
      onBeginInteraction: () => "user-1",
      assistantLabel: "Codex",
      onSelect: vi.fn(),
    };
    renderPresentation(snapshot("available"), { mobileHistory });
    expect(
      screen.getByRole("button", {
        name: "Tap to jump to the latest user message; hold to scrub conversation history",
      }),
    ).toBeInTheDocument();

    setMobileHistorySeekControl(false);

    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "Tap to jump to the latest user message; hold to scrub conversation history",
        }),
      ).toBeNull(),
    );
    expect(
      document.querySelector(".mobile-chat-history-thumbstick"),
    ).toBeNull();
  });

  it("does not autofocus the terminal when switching to TUI on mobile", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(max-width: 720px), (pointer: coarse)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    const renderer = fakeRenderer();
    const transport = fakeTransport();
    renderPresentation(snapshot("available", { lifecycle: "running" }), {
      rendererFactory: () => renderer.value,
      transportFactory: (observer) => {
        transport.setObserver(observer);
        return transport.value;
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "TUI" }));
    await waitFor(() => expect(renderer.value.mount).toHaveBeenCalled());
    expect(renderer.value.focus).not.toHaveBeenCalled();

    // Switching away and back still keeps the soft keyboard closed.
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click(screen.getByRole("button", { name: "TUI" }));
    expect(renderer.value.focus).not.toHaveBeenCalled();
  });

  it("activates terminal control in the TUI view and routes sendKey to the transport", async () => {
    const transport = fakeTransport();
    const renderer = fakeRenderer();
    renderPresentation(snapshot("available", { lifecycle: "running" }), {
      rendererFactory: () => renderer.value,
      transportFactory: (observer) => {
        transport.setObserver(observer);
        return transport.value;
      },
    });

    expect(screen.getByTestId("terminal-control-state")).toHaveTextContent(
      "inactive",
    );
    expect(screen.getByTestId("terminal-input-availability")).toHaveTextContent(
      "unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "TUI" }));
    await waitFor(() =>
      expect(screen.getByTestId("terminal-control-state")).toHaveTextContent(
        "active",
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("terminal-input-availability"),
      ).toHaveTextContent("available"),
    );
    fireEvent.click(screen.getByTestId("terminal-control-send"));
    expect(transport.value.input).toHaveBeenCalledWith("\u0003");
    fireEvent.click(screen.getByTestId("terminal-control-focus"));
    expect(renderer.value.focus).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("terminal-control-blur"));
    expect(renderer.value.blur).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.getByTestId("terminal-control-state")).toHaveTextContent(
      "inactive",
    );
  });

  it("keeps the composer mounted and visible across Chat/TUI switches", async () => {
    const renderer = fakeRenderer();
    renderPresentation(snapshot("available", { lifecycle: "running" }), {
      rendererFactory: () => renderer.value,
      transportFactory: () => fakeTransport().value,
    });

    const composer = screen.getByTestId("composer-content");
    expect(composer).toBeVisible();
    expect(screen.getByTestId("chat-view-visibility")).toHaveTextContent(
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "TUI" }));
    await waitFor(() => expect(renderer.value.mount).toHaveBeenCalled());
    expect(screen.getByTestId("chat-thread-panel")).toHaveAttribute("hidden");
    expect(composer).toBeInTheDocument();
    expect(composer).toBeVisible();
    expect(screen.getByTestId("chat-view-visibility")).toHaveTextContent(
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(composer).toBeInTheDocument();
    expect(composer).toBeVisible();
    expect(screen.getByTestId("chat-view-visibility")).toHaveTextContent(
      "true",
    );
  });

  it("keeps a selected TUI mounted but inactive while its outer panel is hidden", async () => {
    window.sessionStorage.setItem("sedes.codex-tui.view.v1:thread-1", "tui");
    const renderer = fakeRenderer();
    const transport = fakeTransport();
    const view = renderPresentation(
      snapshot("available", { lifecycle: "running" }),
      {
        visible: false,
        rendererFactory: () => renderer.value,
        transportFactory: (observer) => {
          transport.setObserver(observer);
          return transport.value;
        },
      },
    );

    await waitFor(() => expect(renderer.value.mount).toHaveBeenCalled());
    expect(renderer.value.focus).not.toHaveBeenCalled();
    expect(screen.getByTestId("terminal-control-state")).toHaveTextContent(
      "inactive",
    );
    expect(screen.getByTestId("terminal-input-availability")).toHaveTextContent(
      "unavailable",
    );
    expect(screen.getByTestId("chat-view-visibility")).toHaveTextContent(
      "false",
    );
    fireEvent.click(screen.getByTestId("terminal-control-send"));
    fireEvent.click(screen.getByTestId("terminal-control-focus"));
    expect(transport.value.input).not.toHaveBeenCalled();
    expect(renderer.value.focus).not.toHaveBeenCalled();

    view.rerender(
      element(snapshot("available", { lifecycle: "running" }), {
        visible: true,
        rendererFactory: () => renderer.value,
        transportFactory: (observer) => {
          transport.setObserver(observer);
          return transport.value;
        },
      }),
    );
    await waitFor(() => expect(renderer.value.focus).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("terminal-control-state")).toHaveTextContent(
      "active",
    );
  });

  it("applies light and dark app themes to the mounted Ghostty renderer", async () => {
    document.documentElement.dataset.theme = "light";
    const renderer = fakeRenderer();
    const transport = fakeTransport();
    renderPresentation(snapshot("available", { lifecycle: "running" }), {
      rendererFactory: () => renderer.value,
      transportFactory: () => transport.value,
    });
    fireEvent.click(screen.getByRole("button", { name: "TUI" }));
    await waitFor(() => expect(renderer.value.mount).toHaveBeenCalled());

    setAppearance("dark");
    await waitFor(() =>
      expect(renderer.value.setTheme).toHaveBeenCalledWith("dark"),
    );
    setAppearance("light");
    await waitFor(() =>
      expect(renderer.value.setTheme).toHaveBeenCalledWith("light"),
    );
    expect(transport.value.connect).toHaveBeenCalledTimes(1);
    expect(renderer.value.dispose).not.toHaveBeenCalled();
  });

  it("uses compact icon actions to refit and stop immediately", async () => {
    const perform = vi.fn(async (_input: unknown) => ({
      status: "accepted" as const,
    }));
    const renderer = fakeRenderer();
    const transport = fakeTransport();
    renderPresentation(snapshot("available", { lifecycle: "running" }), {
      perform,
      rendererFactory: () => renderer.value,
      transportFactory: (observer) => {
        transport.setObserver(observer);
        return transport.value;
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "TUI" }));
    await waitFor(() => expect(renderer.value.mount).toHaveBeenCalled());

    const refit = screen.getByRole("button", { name: "Refit terminal" });
    const stop = screen.getByRole("button", { name: "Stop TUI" });
    expect(refit.textContent).toBe("");
    expect(stop.textContent).toBe("");
    expect(refit.querySelector("svg")).not.toBeNull();
    expect(stop.querySelector("svg")).not.toBeNull();

    const refitsBeforeClick = vi.mocked(transport.value.requestRefit).mock.calls
      .length;
    fireEvent.click(refit);
    await waitFor(() =>
      expect(transport.value.requestRefit).toHaveBeenCalledTimes(
        refitsBeforeClick + 1,
      ),
    );
    fireEvent.click(stop);
    await waitFor(() => expect(perform).toHaveBeenCalledTimes(1));
    expect(perform).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "stop",
        arguments: null,
      }),
    );
    expect(perform.mock.calls[0]![0]).not.toHaveProperty("confirmed");
  });
});

function renderPresentation(
  value: NormalizedThreadSnapshot,
  options: Options = {},
) {
  return render(element(value, options));
}

function ChatVisibilityProbe() {
  const visible = useContext(ChatViewVisibilityContext);
  return <div data-testid="chat-view-visibility">{String(visible)}</div>;
}

function TerminalControlProbe() {
  const control = useContext(CodexTuiTerminalControlContext);
  return (
    <>
      <div data-testid="terminal-control-state">
        {control?.active ? "active" : "inactive"}
      </div>
      <div data-testid="terminal-input-availability">
        {control?.inputAvailable ? "available" : "unavailable"}
      </div>
      <button
        data-testid="terminal-control-send"
        onClick={() => control?.sendKey("\u0003")}
      />
      <button
        data-testid="terminal-control-focus"
        onClick={() => control?.focusTerminal()}
      />
      <button
        data-testid="terminal-control-blur"
        onClick={() => control?.blurTerminal()}
      />
    </>
  );
}

interface Options {
  readonly visible?: boolean;
  readonly historicalFocus?: boolean;
  readonly perform?: ReturnType<typeof vi.fn>;
  readonly rendererFactory?: () => CodexTuiRenderer;
  readonly transportFactory?: Parameters<
    typeof CodexTuiThreadPresentation
  >[0]["transportFactory"];
  readonly takeover?: ReactNode;
  readonly status?: ReactNode;
  readonly mobileHistory?: Parameters<
    typeof CodexTuiThreadPresentation
  >[0]["mobileHistory"];
}

function element(value: NormalizedThreadSnapshot, options: Options = {}) {
  return (
    <CodexTuiThreadPresentation
      threadId="thread-1"
      visible={options.visible ?? true}
      snapshot={value}
      store={
        { perform: options.perform ?? vi.fn() } as unknown as ThreadClientStore
      }
      api={{} as ApiClient}
      historicalFocus={options.historicalFocus ?? false}
      chat={
        <>
          <div data-testid="chat-content">Chat content</div>
          <ChatVisibilityProbe />
        </>
      }
      composer={
        <>
          <div data-testid="composer-content">Composer</div>
          <TerminalControlProbe />
        </>
      }
      status={options.status}
      takeover={options.takeover}
      mobileHistory={options.mobileHistory}
      {...(options.rendererFactory
        ? { rendererFactory: options.rendererFactory }
        : {})}
      {...(options.transportFactory
        ? { transportFactory: options.transportFactory }
        : {})}
    />
  );
}

function snapshot(
  availability: "available" | "read_only" | "unavailable",
  input: {
    readonly revision?: number;
    readonly lifecycle?: "stopped" | "running" | "exited";
    readonly exitStatus?:
      | { readonly kind: "code"; readonly code: number }
      | { readonly kind: "signal"; readonly signal: string };
  } = {},
): NormalizedThreadSnapshot {
  const stateRevision = input.revision ?? 1;
  const lifecycle = input.lifecycle ?? "stopped";
  return {
    capabilities: {
      providerFeatures: [
        {
          ref: { featureId: "codex.tui", schemaVersion: 1 },
          revision: 1,
          label: { text: "TUI" },
          availability,
          ...(availability === "available"
            ? {}
            : { unavailableReason: { text: "Unavailable" } }),
          operations: [
            {
              actionId: "start",
              label: { text: "Start TUI" },
              effects: {
                application: "write",
                modelUsage: "none",
                external: "none",
              },
              confirmation: "none",
              execution: "durable",
            },
            {
              actionId: "stop",
              label: { text: "Stop TUI" },
              effects: {
                application: "write",
                modelUsage: "none",
                external: "none",
              },
              confirmation: "none",
              execution: "durable",
            },
          ],
          presentationSlots: [],
        },
      ],
    },
    providerFeatures: [
      {
        ref: { featureId: "codex.tui", schemaVersion: 1 },
        revision: stateRevision,
        state: boundedValue({
          lifecycle,
          resourceGeneration: lifecycle === "stopped" ? null : 9,
          streamAvailable: lifecycle === "running",
          ...(input.exitStatus ? { exitStatus: input.exitStatus } : {}),
        }),
      },
    ],
  } as unknown as NormalizedThreadSnapshot;
}

function boundedValue(value: unknown): BoundedValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") return { text: value };
  if (Array.isArray(value)) {
    return { kind: "array", values: value.map(boundedValue) };
  }
  return {
    kind: "object",
    entries: Object.entries(value as Record<string, unknown>).map(
      ([key, entry]) => ({
        key: { text: key },
        value: boundedValue(entry),
      }),
    ),
  };
}

function fakeRenderer() {
  const value: CodexTuiRenderer = {
    mount: vi.fn(async () => ({ cols: 80, rows: 24 })),
    write: vi.fn(),
    fit: vi.fn(() => ({ cols: 80, rows: 24 })),
    focus: vi.fn(),
    blur: vi.fn(),
    hasFocus: vi.fn(() => false),
    setTheme: vi.fn(),
    setCursorBlink: vi.fn(),
    onInput: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
  };
  return { value };
}

function fakeTransport() {
  let observer:
    Parameters<NonNullable<Options["transportFactory"]>>[0] | undefined;
  const value: CodexTuiTransport = {
    connect: vi.fn(() => {
      observer?.onState("ready");
      observer?.onReady({ cols: 80, rows: 24 });
    }),
    input: vi.fn(() => true),
    resize: vi.fn(),
    requestRefit: vi.fn(),
    close: vi.fn(),
  };
  return { value, setObserver: (next: typeof observer) => (observer = next) };
}
