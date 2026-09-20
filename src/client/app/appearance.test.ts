// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAppearance,
  getResolvedAppearance,
  installAppearance,
  setAppearance,
  subscribeResolvedAppearance,
} from "./appearance";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("appearance lifecycle", () => {
  it("applies the preference and tears down the system listener", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: true,
        media: "(prefers-color-scheme: dark)",
        onchange: null,
        addEventListener,
        removeEventListener,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });

    const cleanup = installAppearance();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(addEventListener).toHaveBeenCalledOnce();

    setAppearance("light");
    expect(getAppearance()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");

    cleanup();
    expect(removeEventListener).toHaveBeenCalledWith(
      "change",
      addEventListener.mock.calls[0]?.[1],
    );
  });

  it("notifies live resolved-theme consumers", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    const seen: string[] = [];
    const unsubscribe = subscribeResolvedAppearance((value) =>
      seen.push(value),
    );
    expect(getResolvedAppearance()).toBe("light");
    setAppearance("dark");
    setAppearance("light");
    expect(seen).toEqual(["dark", "light"]);
    unsubscribe();
  });
});
