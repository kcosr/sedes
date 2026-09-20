// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installThreadPanelOpenRequestListener,
  openThreadRoute,
  pointerPanelPresentation,
} from "./thread-panel-navigation.js";

afterEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("thread panel navigation", () => {
  it("dispatches panel activation synchronously before changing the route", () => {
    const observed = vi.fn(() => window.location.pathname);
    const remove = installThreadPanelOpenRequestListener(window, observed);

    openThreadRoute("thread-destination", "single");

    expect(observed).toHaveBeenCalledWith({
      threadId: "thread-destination",
      presentation: "single",
    });
    expect(observed).toHaveReturnedWith("/");
    expect(window.location.pathname).toBe("/threads/thread-destination");
    remove();
  });

  it("resolves pointer presentation from the stored preference and Shift", () => {
    localStorage.setItem("sedes-panel-presentation", "single");
    expect(pointerPanelPresentation({ shiftKey: false })).toBe("single");
    expect(pointerPanelPresentation({ shiftKey: true })).toBe("split");
  });
});
