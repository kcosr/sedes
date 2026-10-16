// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The router reads the address when it loads, so each case here imports it
// after setting one; this file's module registry is its own.
describe("router at startup", () => {
  it("opens an automation resource deep link without rewriting its identity", async () => {
    window.history.replaceState(null, "", "/automations/automation%2Fone?from=bookmark");
    const length = window.history.length;

    const router = await import("./router.js");

    expect(window.location.pathname).toBe("/automations/automation%2Fone");
    expect(window.location.search).toBe("?from=bookmark");
    expect(window.history.length).toBe(length);
    const { result } = renderHook(() => router.useRoute());
    expect(result.current).toEqual({ name: "automation", automationId: "automation/one", edit: false });
  });

  it("rejects the retired singleton route and parses the thread collection and create routes", async () => {
    const router = await import("./router.js");
    expect(router.parseRoute("/threads/thread-1/automation")).toEqual({ name: "home" });
    expect(router.parseRoute("/threads/thread-1/automations")).toEqual({ name: "automations", threadId: "thread-1" });
    expect(router.parseRoute("/threads/thread-1/automations/new")).toEqual({ name: "automation-create", threadId: "thread-1" });
  });

  it("leaves a deep-linked page for its fallback: nothing this document opened lies behind it", async () => {
    const router = await import("./router.js");
    const length = window.history.length;

    expect(router.historyEntryBefore("/automations/automation%2Fone")).toBeUndefined();
    router.navigateOut("/automations/automation%2Fone", () => true, "/threads/thread-1/automations");
    expect(window.location.pathname).toBe("/threads/thread-1/automations");
    expect(window.history.length).toBe(length);
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
