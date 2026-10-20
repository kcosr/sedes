// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ native: false, name: "web" }));
const nativeApp = vi.hoisted(() => {
  const handle = { remove: vi.fn(async () => undefined) };
  let listener: ((state: { isActive: boolean }) => void) | undefined;
  return {
    handle,
    emit: (isActive: boolean) => listener?.({ isActive }),
    addListener: vi.fn(
      async (_event: string, next: (state: { isActive: boolean }) => void) => {
        listener = next;
        return handle;
      },
    ),
  };
});

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => platform.name,
  },
}));
vi.mock("@capacitor/app", () => ({
  App: { addListener: nativeApp.addListener },
}));

import { subscribePageHide } from "./page-hide.js";

const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("subscribePageHide", () => {
  beforeEach(() => {
    platform.native = false;
    platform.name = "web";
    nativeApp.addListener.mockClear();
    nativeApp.handle.remove.mockClear();
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("reports hidden documents and page unloads until unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePageHide(listener);

    setVisibility("visible");
    expect(listener).not.toHaveBeenCalled();
    setVisibility("hidden");
    expect(listener).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("pagehide"));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(nativeApp.addListener).not.toHaveBeenCalled();

    unsubscribe();
    setVisibility("hidden");
    window.dispatchEvent(new Event("pagehide"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("reports the Android app leaving the foreground", async () => {
    platform.native = true;
    platform.name = "android";
    const listener = vi.fn();
    const unsubscribe = subscribePageHide(listener);
    await vi.waitFor(() =>
      expect(nativeApp.addListener).toHaveBeenCalledWith(
        "appStateChange",
        expect.any(Function),
      ),
    );

    nativeApp.emit(true);
    expect(listener).not.toHaveBeenCalled();
    nativeApp.emit(false);
    expect(listener).toHaveBeenCalledOnce();

    await Promise.resolve();
    unsubscribe();
    expect(nativeApp.handle.remove).toHaveBeenCalledOnce();
  });
});
