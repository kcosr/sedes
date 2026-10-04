// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeVoiceStore } from "./NativeVoiceStore.js";
import { fakeVoicePlugin, VOICE_CONNECTION } from "./native-voice-test-fixture.js";
import { useShowVoiceBarWhenOff } from "./voice-bar-preference.js";

const storeFor = (connection = VOICE_CONNECTION) => new NativeVoiceStore(fakeVoicePlugin().asPlugin, connection, () => undefined);
const key = `sedes-voice-bar-when-off:${JSON.stringify([VOICE_CONNECTION.profileId, VOICE_CONNECTION.serverOrigin, VOICE_CONNECTION.identity])}`;
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  // A cleared store reaches the module as another tab's clear would.
  act(() => { window.dispatchEvent(new StorageEvent("storage", { key: null })); });
});

describe("show voice bar when off", () => {
  it("defaults off, persists per binding and updates every reader at once", () => {
    const store = storeFor();
    const settings = renderHook(() => useShowVoiceBarWhenOff(store));
    const card = renderHook(() => useShowVoiceBarWhenOff(storeFor()));
    const other = renderHook(() => useShowVoiceBarWhenOff(storeFor({ ...VOICE_CONNECTION, profileId: "other" })));
    expect(settings.result.current[0]).toBe(false);
    act(() => settings.result.current[1](true));
    expect(card.result.current[0]).toBe(true);
    expect(other.result.current[0]).toBe(false);
    expect(localStorage.getItem(key)).toBe("true");
    act(() => card.result.current[1](false));
    expect(settings.result.current[0]).toBe(false);
    expect(localStorage.getItem(key)).toBeNull();
  });
  it("follows a change made in another tab", () => {
    const { result } = renderHook(() => useShowVoiceBarWhenOff(storeFor()));
    localStorage.setItem(key, "true");
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key, newValue: "true" })); });
    expect(result.current[0]).toBe(true);
  });
  it("reads as off when storage is unavailable and keeps a refused write for this session", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    const { result } = renderHook(() => useShowVoiceBarWhenOff(storeFor()));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});
