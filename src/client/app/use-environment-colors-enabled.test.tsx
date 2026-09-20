// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setEnvironmentColorsEnabled } from "./environment-palette.js";
import { useEnvironmentColorsEnabled } from "./use-environment-colors-enabled.js";

afterEach(() => {
  localStorage.clear();
});

describe("useEnvironmentColorsEnabled", () => {
  it("reacts to same-window preference changes", () => {
    const { result } = renderHook(() => useEnvironmentColorsEnabled());
    expect(result.current).toBe(true);

    act(() => setEnvironmentColorsEnabled(false));
    expect(result.current).toBe(false);

    act(() => setEnvironmentColorsEnabled(true));
    expect(result.current).toBe(true);
  });
});
