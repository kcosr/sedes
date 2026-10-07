// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The router reads the address when it loads, so each case here imports it
// after setting one; this file's module registry is its own.
describe("router at startup", () => {
  it("opens the old automation dialog address as the automation page, in place", async () => {
    window.history.replaceState(null, "", "/threads/thread%2Fone/automation?from=bookmark");
    const length = window.history.length;

    const router = await import("./router.js");

    expect(window.location.pathname).toBe("/automations/thread%2Fone");
    expect(window.location.search).toBe("?from=bookmark");
    expect(window.history.length).toBe(length);
    const { result } = renderHook(() => router.useRoute());
    expect(result.current).toEqual({ name: "automation", threadId: "thread/one", edit: false });
  });

  it("goes back where the user came from, or to the fallback on a deep link", async () => {
    const router = await import("./router.js");
    const length = window.history.length;

    // Nothing this document opened lies behind the deep-linked page.
    router.navigateBack("/automations");
    expect(window.location.pathname).toBe("/automations");
    expect(window.history.length).toBe(length);

    router.navigate("/threads/thread-1");
    router.navigate("/automations/thread-1");
    router.navigateBack("/automations");
    await vi.waitFor(() => expect(window.location.pathname).toBe("/threads/thread-1"));
    expect(window.history.length).toBe(length + 2);
  });
});
