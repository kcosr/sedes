// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesTouchDensity, useTouchDensity } from "./use-touch-density.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTouchDensity", () => {
  it("follows the density switch query", () => {
    let listener: (() => void) | undefined;
    const media = {
      matches: false,
      addEventListener: vi.fn((_: string, callback: () => void) => {
        listener = callback;
      }),
      removeEventListener: vi.fn(),
    };
    const matchMedia = vi.fn().mockReturnValue(media);
    vi.stubGlobal("matchMedia", matchMedia);
    const { result } = renderHook(() => useTouchDensity());
    expect(result.current).toBe(false);
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 819px), (pointer: coarse)");
    act(() => {
      media.matches = true;
      listener?.();
    });
    expect(result.current).toBe(true);
  });

  it("reads as pointer density without matchMedia", () => {
    const { result } = renderHook(() => useTouchDensity());
    expect(result.current).toBe(false);
    expect(matchesTouchDensity()).toBe(false);
  });
});
