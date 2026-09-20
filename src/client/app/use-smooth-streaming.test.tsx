// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setSmoothStreamingEnabled } from "./settings.js";
import { useSmoothStreaming } from "./use-smooth-streaming.js";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useSmoothStreaming", () => {
  it("combines the stored preference with reactive reduced motion", () => {
    let reducedMotion = false;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: reducedMotion,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: EventListener) => {
        listeners.add(listener as (event: MediaQueryListEvent) => void);
      },
      removeEventListener: (_type: string, listener: EventListener) => {
        listeners.delete(listener as (event: MediaQueryListEvent) => void);
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { result } = renderHook(() => useSmoothStreaming());
    expect(result.current).toBe(true);

    act(() => setSmoothStreamingEnabled(false));
    expect(result.current).toBe(false);
    act(() => setSmoothStreamingEnabled(true));
    expect(result.current).toBe(true);

    act(() => {
      reducedMotion = true;
      for (const listener of listeners) {
        listener({ matches: true } as MediaQueryListEvent);
      }
    });
    expect(result.current).toBe(false);

    act(() => {
      reducedMotion = false;
      for (const listener of listeners) {
        listener({ matches: false } as MediaQueryListEvent);
      }
    });
    expect(result.current).toBe(true);
  });

  it("does not subscribe while its presentation consumer is inactive", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { rerender, unmount } = renderHook(
      ({ active }) => useSmoothStreaming(active),
      { initialProps: { active: false } },
    );
    expect(addEventListener).not.toHaveBeenCalled();

    rerender({ active: true });
    expect(addEventListener).toHaveBeenCalledOnce();
    unmount();
    expect(removeEventListener).toHaveBeenCalledOnce();
  });
});
