// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useShowVoiceBarWhenOff } from "./voice-bar-preference.js";

const key = "sedes-device-voice-bar-when-off";
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  // A cleared store reaches the module as another tab's clear would.
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key: null })); });
});

describe("show voice bar when off", () => {
  it("defaults off, persists across mounts and updates every device reader at once", () => {
    const settings = renderHook(() => useShowVoiceBarWhenOff());
    const card = renderHook(() => useShowVoiceBarWhenOff());
    expect(settings.result.current[0]).toBe(false);
    act(() => settings.result.current[1](true));
    expect(card.result.current[0]).toBe(true);
    settings.unmount();
    const reconnected = renderHook(() => useShowVoiceBarWhenOff());
    expect(reconnected.result.current[0]).toBe(true);
    expect(localStorage.getItem(key)).toBe("true");
    act(() => card.result.current[1](false));
    expect(reconnected.result.current[0]).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();
  });
  it("follows a change made in another tab", () => {
    const { result } = renderHook(() => useShowVoiceBarWhenOff());
    localStorage.setItem(key, "true");
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key, newValue: "true" })); });
    expect(result.current[0]).toBe(true);
  });
  it("reads as off when storage is unavailable and keeps a refused write for this session", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    const { result } = renderHook(() => useShowVoiceBarWhenOff());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});
