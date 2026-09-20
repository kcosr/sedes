// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ENVIRONMENT_PALETTE,
  DEFAULT_ENVIRONMENT_TINT_SETTINGS,
  ENVIRONMENT_COLORS_ENABLED_STORAGE_KEY,
  ENVIRONMENT_PALETTE_STORAGE_KEY,
  ENVIRONMENT_TINT_SETTINGS_STORAGE_KEY,
  environmentTintStyle,
  getEnvironmentColorsEnabled,
  getEnvironmentPalette,
  getEnvironmentTintSettings,
  installEnvironmentColors,
  resolveEnvironmentPaletteTones,
  setEnvironmentPalette,
  setEnvironmentColorsEnabled,
  setEnvironmentTintSettings,
  subscribeEnvironmentPalette,
  subscribeEnvironmentColorsEnabled,
  subscribeEnvironmentTintSettings,
} from "./environment-palette.js";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-environment-palette");
  document.documentElement.removeAttribute("data-environment-tint-intensity");
  document.documentElement.removeAttribute("data-environment-tint-fade-in");
  document.documentElement.removeAttribute("data-environment-tint-coverage");
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
});

describe("environment palette preference", () => {
  it("stores and announces the default-on environment colors preference", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeEnvironmentColorsEnabled((enabled) =>
      seen.push(enabled),
    );

    expect(getEnvironmentColorsEnabled()).toBe(true);
    localStorage.setItem(ENVIRONMENT_COLORS_ENABLED_STORAGE_KEY, "invalid");
    expect(getEnvironmentColorsEnabled()).toBe(true);

    setEnvironmentColorsEnabled(false);
    expect(getEnvironmentColorsEnabled()).toBe(false);
    expect(localStorage.getItem(ENVIRONMENT_COLORS_ENABLED_STORAGE_KEY)).toBe(
      "false",
    );
    expect(seen).toEqual([false]);

    setEnvironmentColorsEnabled(true);
    expect(getEnvironmentColorsEnabled()).toBe(true);
    expect(seen).toEqual([false, true]);
    unsubscribe();
  });

  it("follows environment color preference writes from another window", () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeEnvironmentColorsEnabled((enabled) =>
      seen.push(enabled),
    );

    localStorage.setItem(ENVIRONMENT_COLORS_ENABLED_STORAGE_KEY, "false");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: ENVIRONMENT_COLORS_ENABLED_STORAGE_KEY,
      }),
    );

    expect(seen).toEqual([false]);
    unsubscribe();
  });

  it("defaults invalid or absent browser state to Gem and balanced tint settings", () => {
    expect(getEnvironmentPalette()).toBe(DEFAULT_ENVIRONMENT_PALETTE);
    expect(getEnvironmentTintSettings()).toEqual(
      DEFAULT_ENVIRONMENT_TINT_SETTINGS,
    );
    localStorage.setItem(ENVIRONMENT_PALETTE_STORAGE_KEY, "unknown");
    localStorage.setItem(
      ENVIRONMENT_TINT_SETTINGS_STORAGE_KEY,
      JSON.stringify({ intensity: 31, fadeIn: 6, coverage: 68 }),
    );
    expect(getEnvironmentPalette()).toBe("gem");
    expect(getEnvironmentTintSettings()).toEqual({
      intensity: 15,
      fadeIn: 6,
      coverage: 68,
    });
  });

  it("applies and announces same-window changes", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeEnvironmentPalette((palette) =>
      seen.push(palette),
    );

    setEnvironmentPalette("mineral");

    expect(getEnvironmentPalette()).toBe("mineral");
    expect(document.documentElement.dataset.environmentPalette).toBe("mineral");
    expect(seen).toEqual(["mineral"]);
    unsubscribe();
  });

  it("applies and announces same-window tint changes", () => {
    const seen: Array<{
      intensity: number;
      fadeIn: number;
      coverage: number;
    }> = [];
    const unsubscribe = subscribeEnvironmentTintSettings((settings) =>
      seen.push(settings),
    );

    setEnvironmentTintSettings({ intensity: 24, fadeIn: 7, coverage: 81 });

    expect(getEnvironmentTintSettings()).toEqual({
      intensity: 24,
      fadeIn: 7,
      coverage: 81,
    });
    expect(document.documentElement.dataset.environmentTintIntensity).toBe(
      "24",
    );
    expect(document.documentElement.dataset.environmentTintFadeIn).toBe("7");
    expect(document.documentElement.dataset.environmentTintCoverage).toBe("81");
    expect(
      document.documentElement.style.getPropertyValue(
        "--environment-row-start-opacity",
      ),
    ).toBe("0.24");
    expect(
      document.documentElement.style.getPropertyValue(
        "--environment-row-tail-opacity",
      ),
    ).toBe("0.08");
    expect(
      document.documentElement.style.getPropertyValue(
        "--environment-sidebar-start-opacity",
      ),
    ).toBe("0.216");
    expect(
      document.documentElement.style.getPropertyValue(
        "--environment-gradient-head-stop",
      ),
    ).toBe("7%");
    expect(
      document.documentElement.style.getPropertyValue(
        "--environment-row-tail-stop",
      ),
    ).toBe("54%");
    expect(
      document.documentElement.style.getPropertyValue(
        "--environment-row-clear-stop",
      ),
    ).toBe("81%");
    expect(seen).toEqual([{ intensity: 24, fadeIn: 7, coverage: 81 }]);
    unsubscribe();
  });

  it("accepts the expanded coverage floor and rejects values below it", () => {
    setEnvironmentTintSettings({ intensity: 10, fadeIn: 4, coverage: 20 });

    expect(getEnvironmentTintSettings()).toEqual({
      intensity: 10,
      fadeIn: 4,
      coverage: 20,
    });
    expect(
      document.documentElement.style.getPropertyValue(
        "--environment-row-tail-stop",
      ),
    ).toBe("13.333%");
    expect(
      document.documentElement.style.getPropertyValue(
        "--environment-row-clear-stop",
      ),
    ).toBe("20%");
    expect(() =>
      setEnvironmentTintSettings({ intensity: 10, fadeIn: 4, coverage: 19 }),
    ).toThrow(RangeError);
  });

  it("projects a palette tone into reusable tint custom properties", () => {
    const tone = resolveEnvironmentPaletteTones(
      ["environment-1", "environment-2"],
      "gem",
    ).get("environment-1")!;
    expect(environmentTintStyle(tone)).toEqual({
      "--environment-hue": tone.hue,
      "--environment-chroma": tone.chroma,
    });
  });

  it("installs stored color preferences and follows cross-window writes", () => {
    localStorage.setItem(ENVIRONMENT_PALETTE_STORAGE_KEY, "cool");
    localStorage.setItem(
      ENVIRONMENT_TINT_SETTINGS_STORAGE_KEY,
      JSON.stringify({ intensity: 11, fadeIn: 3, coverage: 58 }),
    );
    const cleanup = installEnvironmentColors();
    expect(document.documentElement.dataset.environmentPalette).toBe("cool");
    expect(document.documentElement.dataset.environmentTintIntensity).toBe(
      "11",
    );
    expect(document.documentElement.dataset.environmentTintFadeIn).toBe("3");
    expect(document.documentElement.dataset.environmentTintCoverage).toBe("58");

    localStorage.setItem(ENVIRONMENT_PALETTE_STORAGE_KEY, "balanced");
    localStorage.setItem(
      ENVIRONMENT_TINT_SETTINGS_STORAGE_KEY,
      JSON.stringify({ intensity: 19, fadeIn: 9, coverage: 72 }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(document.documentElement.dataset.environmentPalette).toBe(
      "balanced",
    );
    expect(document.documentElement.dataset.environmentTintIntensity).toBe(
      "19",
    );
    expect(document.documentElement.dataset.environmentTintFadeIn).toBe("9");
    expect(document.documentElement.dataset.environmentTintCoverage).toBe("72");

    cleanup();
  });

  it("distributes the complete environment set evenly without collisions", () => {
    const environmentIds = [
      "019196f7-a0a8-7bc4-a89b-8cf013978405",
      "019196f7-a0a8-7bc4-a89b-8cf013978406",
      "1e04945f-5921-4f22-9328-7ee83c36cbf4",
      "3d8e153a-1361-4e7e-b1ab-ee1ad5be9d12",
      "904af3c4-0389-4e5e-8edf-e0f97fa80b3e",
      "a0e3f358-a20e-4d82-b678-2d0e5a4e6d49",
      "dfad52fd-8895-4aa7-a71f-55b99ab2218f",
    ];
    const tones = resolveEnvironmentPaletteTones(environmentIds, "spectrum");
    const hues = [...tones.values()]
      .map(({ hue }) => hue)
      .sort((left, right) => left - right);
    const gaps = hues.map((hue, index) => {
      const nextHue = hues[(index + 1) % hues.length]!;
      return (nextHue - hue + 360) % 360;
    });

    expect(tones.size).toBe(environmentIds.length);
    expect(new Set(hues).size).toBe(environmentIds.length);
    for (const gap of gaps) expect(gap).toBeCloseTo(360 / 7, 5);
    expect(localStorage.length).toBe(0);
  });

  it("is stable across bootstrap order and duplicate IDs", () => {
    const first = resolveEnvironmentPaletteTones(
      ["environment-charlie", "environment-alpha", "environment-bravo"],
      "gem",
    );
    const reordered = resolveEnvironmentPaletteTones(
      [
        "environment-bravo",
        "environment-alpha",
        "environment-charlie",
        "environment-alpha",
      ],
      "gem",
    );

    expect(Object.fromEntries(reordered)).toEqual(Object.fromEntries(first));
  });

  it("keeps deterministic ranks while palette style changes", () => {
    const environmentIds = ["environment-alpha", "environment-bravo"];
    const firstGem = resolveEnvironmentPaletteTones(
      environmentIds,
      "gem",
    ).get("environment-alpha")!;
    const secondGem = resolveEnvironmentPaletteTones(
      [...environmentIds].reverse(),
      "gem",
    ).get("environment-alpha")!;
    const balanced = resolveEnvironmentPaletteTones(
      environmentIds,
      "balanced",
    ).get("environment-alpha")!;

    expect(secondGem).toEqual(firstGem);
    expect(balanced.hue).not.toBe(firstGem.hue);
    expect(balanced.chroma).not.toBe(firstGem.chroma);
  });
});
