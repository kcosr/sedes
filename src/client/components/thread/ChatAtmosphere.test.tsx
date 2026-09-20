// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setChatAtmosphereEnabled } from "../../app/settings.js";
import { ChatViewVisibilityContext } from "./chat-view-visibility.js";
import { ChatAtmosphere } from "./ChatAtmosphere.js";

function stubMatchMedia(reducedMotion: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reducedMotion && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("ChatAtmosphere", () => {
  it("renders a non-interactive canvas behind visible chat", () => {
    stubMatchMedia(false);
    setChatAtmosphereEnabled(true);
    render(
      <ChatViewVisibilityContext.Provider value={true}>
        <div>
          <ChatAtmosphere />
        </div>
      </ChatViewVisibilityContext.Provider>,
    );
    const canvas = screen.getByTestId("chat-atmosphere");
    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas).toHaveAttribute("aria-hidden", "true");
  });

  it("does not render while the chat panel is hidden", () => {
    stubMatchMedia(false);
    setChatAtmosphereEnabled(true);
    render(
      <ChatViewVisibilityContext.Provider value={false}>
        <ChatAtmosphere />
      </ChatViewVisibilityContext.Provider>,
    );
    expect(screen.queryByTestId("chat-atmosphere")).toBeNull();
  });

  it("does not render under prefers-reduced-motion", () => {
    stubMatchMedia(true);
    setChatAtmosphereEnabled(true);
    render(
      <ChatViewVisibilityContext.Provider value={true}>
        <ChatAtmosphere />
      </ChatViewVisibilityContext.Provider>,
    );
    expect(screen.queryByTestId("chat-atmosphere")).toBeNull();
  });

  it("defaults off and responds to setting changes", () => {
    stubMatchMedia(false);
    render(
      <ChatViewVisibilityContext.Provider value={true}>
        <div>
          <ChatAtmosphere />
        </div>
      </ChatViewVisibilityContext.Provider>,
    );
    expect(screen.queryByTestId("chat-atmosphere")).toBeNull();

    act(() => setChatAtmosphereEnabled(true));
    expect(screen.getByTestId("chat-atmosphere")).toBeInTheDocument();

    act(() => setChatAtmosphereEnabled(false));
    expect(screen.queryByTestId("chat-atmosphere")).toBeNull();
  });
});
