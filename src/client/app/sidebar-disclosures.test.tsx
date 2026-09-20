// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSidebarDisclosure, useSidebarDisclosures } from "./sidebar-disclosures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("sidebar disclosure storage", () => {
  it("restores explicit choices and isolates categories and entity IDs", () => {
    const first = renderHook(() => useSidebarDisclosure("projects", "one", true));
    act(() => first.result.current[1](false));
    first.unmount();
    const restored = renderHook(() => useSidebarDisclosure("projects", "one", true));
    expect(restored.result.current[0]).toBe(false);
    expect(renderHook(() => useSidebarDisclosure("projects", "two", true)).result.current[0]).toBe(true);
    expect(renderHook(() => useSidebarDisclosure("stacks", "one", true)).result.current[0]).toBe(true);
  });

  it("merges disclosures across mounted consumers and receives storage changes", () => {
    const first = renderHook(() => useSidebarDisclosure("projects", "one", true));
    const second = renderHook(() => useSidebarDisclosure("projects", "two", true));
    act(() => first.result.current[1](false));
    act(() => second.result.current[1](false));
    expect(JSON.parse(localStorage.getItem("sedes-sidebar-disclosures@1:projects")!)).toEqual({ one: false, two: false });
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(first.result.current[0]).toBe(true);
    expect(second.result.current[0]).toBe(true);
  });

  it("ignores invalid stored values and remains usable if writes are unavailable", () => {
    localStorage.setItem("sedes-sidebar-disclosures@1:projects", '{"one":false,"two":"false"}');
    const hook = renderHook(() => useSidebarDisclosures("projects"));
    expect(hook.result.current[0]).toEqual({ one: false });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage blocked"); });
    act(() => hook.result.current[1]({ one: true }));
    expect(hook.result.current[0]).toEqual({ one: true });
  });
});
