import type { NativeVoiceInput, NativeVoiceInputDevice } from "./native-voice-plugin.js";

export function inputPreference(device: NativeVoiceInputDevice): NativeVoiceInput {
  return "platform" in device
    ? { platform: "electron", deviceId: device.id, name: device.label }
    : { type: device.type, address: device.address, name: device.label };
}
/** Mirrors platform identity resolution: missing and ambiguous preferences never become System default. */
export function selectedInputDevice(preferred: NativeVoiceInput | null, devices: readonly NativeVoiceInputDevice[]): NativeVoiceInputDevice | undefined {
  if (!preferred) return undefined;
  const matches = "platform" in preferred
    ? devices.filter(device => "platform" in device && device.id === preferred.deviceId)
    : devices.filter(device => !("platform" in device) && device.type === preferred.type &&
      (preferred.address !== null ? device.address === preferred.address : device.label === preferred.name));
  return matches.length === 1 ? matches[0] : undefined;
}
