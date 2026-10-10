// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installThreadPanelOpenRequestListener,
  openThreadRoute,
} from "./thread-panel-navigation.js";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("thread panel navigation", () => {
  it("dispatches panel activation synchronously before changing the route", () => {
    const observed = vi.fn(() => window.location.pathname);
    const remove = installThreadPanelOpenRequestListener(window, observed);

    openThreadRoute("thread-destination");

    expect(observed).toHaveBeenCalledWith({ threadId: "thread-destination" });
    expect(observed).toHaveReturnedWith("/");
    expect(window.location.pathname).toBe("/threads/thread-destination");
    remove();
  });

  it("navigates to a turn", () => {
    openThreadRoute("thread-destination", "turn-1");
    expect(window.location.pathname).toBe("/threads/thread-destination");
    expect(window.location.hash).toBe("#turn=turn-1");
  });
});
