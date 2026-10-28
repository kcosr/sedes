import { describe, expect, it } from "vitest";
import { inputPreference, selectedInputDevice } from "./native-voice-input.js";

describe("persistent microphone identity", () => {
  const headset = { id: "42", type: 7, address: "AA:BB:CC:DD:EE:FF", label: "Headset" };
  it("matches the current device by address after IDs and names change", () => {
    const preferred = inputPreference(headset);
    const reconnected = { ...headset, id: "99", label: "New headset name" };
    expect(selectedInputDevice(preferred, [reconnected])).toEqual(reconnected);
    expect(selectedInputDevice(preferred, [{ ...headset, address: "11:22:33:44:55:66" }])).toBeUndefined();
    expect(selectedInputDevice(preferred, [{ ...headset, address: null }])).toBeUndefined();
    expect(selectedInputDevice(preferred, [{ ...headset, type: 15 }])).toBeUndefined();
    expect(selectedInputDevice(preferred, [headset, { ...headset, id: "99" }])).toBeUndefined();
    expect(selectedInputDevice(preferred, [])).toBeUndefined();
  });
  it("falls back only to a unique name of the same device type when no stable address exists", () => {
    const preferred = inputPreference({ ...headset, address: null });
    expect(selectedInputDevice(preferred, [headset])).toEqual(headset);
    expect(selectedInputDevice(preferred, [headset, { ...headset, id: "99", address: null }])).toBeUndefined();
    expect(selectedInputDevice(preferred, [{ ...headset, type: 15 }])).toBeUndefined();
    expect(selectedInputDevice(null, [headset])).toBeUndefined();
  });
});


describe("desktop microphone identity", () => {
  const microphone = { platform: "electron" as const, id: "desktop-microphone", label: "USB microphone" };
  it("uses the exact browser device ID and permits distinct microphones with identical labels", () => {
    const preferred = inputPreference(microphone);
    expect(preferred).toEqual({ platform: "electron", deviceId: "desktop-microphone", name: "USB microphone" });
    const renamed = { ...microphone, label: "Renamed microphone" };
    expect(selectedInputDevice(preferred, [renamed, { ...microphone, id: "other-microphone" }])).toEqual(renamed);
    expect(selectedInputDevice(preferred, [{ ...microphone, id: "other-microphone" }])).toBeUndefined();
    expect(selectedInputDevice(preferred, [microphone, microphone])).toBeUndefined();
  });
  it("never substitutes Android devices or same-name desktop devices for a missing preference", () => {
    const android = { id: microphone.id, type: 11, address: null, label: microphone.label };
    expect(selectedInputDevice(inputPreference(microphone), [android])).toBeUndefined();
    expect(selectedInputDevice(inputPreference(android), [microphone])).toBeUndefined();
  });
});
