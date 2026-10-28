import { describe, expect, it } from "vitest";
import { ELECTRON_LOCAL_CONNECTION_PROFILE_ID } from "../app/electron-connections.js";
import { nativeVoiceStateSchema } from "./native-voice-plugin.js";
import { desktopVoiceSettings, electronVoiceDefaults, ElectronVoicePreferences, emptyElectronVoiceState, type VoicePreferenceStorage } from "./electron-voice-state.js";

const binding = { profileId: "profile-a", serverOrigin: "https://sedes.test", identity: "a".repeat(64) };
function storageFixture() {
  const entries = new Map<string, string>();
  const storage: VoicePreferenceStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); } };
  return { entries, storage };
}

describe("desktop voice preferences", () => {
  it("starts disconnected with voice off, no recovery and an unconfigured direct speech server", () => {
    const state = nativeVoiceStateSchema.parse(emptyElectronVoiceState());
    expect(state).toMatchObject({ ready: false, readiness: "disconnected", phase: "off", active: null,
      recordingRecovery: null, recovery: [], clientConnectionToken: null,
      settings: { audioMode: "off", speechProvider: "server", speechEndpoint: "", headsetControls: false,
        announceRecordingThread: false, startupPreRollMs: 0, inputDevice: null } });
    expect(Object.values(state.actions).filter(value => value === true)).toEqual([]);
    const modified = electronVoiceDefaults(); modified.audioMode = "speak";
    expect(electronVoiceDefaults().audioMode).toBe("off");
  });

  it("persists device preferences while isolating default threads by profile, server and authenticated identity", () => {
    const { storage, entries } = storageFixture();
    const preferences = new ElectronVoicePreferences(storage);
    preferences.save(binding, { ...preferences.get(binding), audioMode: "input", voiceThreadId: "thread-a", voiceThreadTitle: "Thread A",
      inputDevice: { platform: "electron", deviceId: "usb-mic", name: "USB microphone" } });
    const otherIdentity = { ...binding, identity: "b".repeat(64) };
    preferences.save(otherIdentity, { ...preferences.get(otherIdentity), voiceThreadId: "thread-b", voiceThreadTitle: "Thread B" });
    const loaded = new ElectronVoicePreferences(storage);
    expect(loaded.reset).toBe(false);
    expect(loaded.revision).toBe(2);
    expect(loaded.get(binding)).toMatchObject({ audioMode: "input", voiceThreadId: "thread-a", voiceThreadTitle: "Thread A",
      inputDevice: { platform: "electron", deviceId: "usb-mic", name: "USB microphone" } });
    expect(loaded.get(otherIdentity).voiceThreadId).toBe("thread-b");
    for (const scope of [{ ...binding, profileId: "other-profile" }, { ...binding, serverOrigin: "https://other.test" }, { ...binding, identity: "c".repeat(64) }]) {
      expect(loaded.get(scope)).toMatchObject({ audioMode: "input", voiceThreadId: null, voiceThreadTitle: null });
    }
    expect(loaded.get().voiceThreadId).toBeNull();
    const record = JSON.parse([...entries.values()][0]!);
    expect(Object.keys(record).sort()).toEqual(["revision", "selections", "settings", "version"]);
    expect(record.settings.voiceThreadId).toBeNull();
    expect(record.settings.voiceThreadTitle).toBeNull();
    expect(record.selections).toHaveLength(2);
  });

  it("retains Managed Local's default thread across ephemeral port changes without crossing identities", () => {
    const { storage } = storageFixture();
    const local = { ...binding, profileId: ELECTRON_LOCAL_CONNECTION_PROFILE_ID, serverOrigin: "http://127.0.0.1:41001" };
    const preferences = new ElectronVoicePreferences(storage);
    preferences.save(local, { ...preferences.get(local), voiceThreadId: "local-thread", voiceThreadTitle: "Local" });
    const loaded = new ElectronVoicePreferences(storage);
    expect(loaded.get({ ...local, serverOrigin: "http://127.0.0.1:42002" }).voiceThreadId).toBe("local-thread");
    expect(loaded.get({ ...local, identity: "b".repeat(64) }).voiceThreadId).toBeNull();
  });

  it("returns detached preferences and leaves current state unchanged when persistence fails", () => {
    const { storage } = storageFixture();
    const preferences = new ElectronVoicePreferences(storage);
    const original = { ...preferences.get(binding), inputDevice: { platform: "electron" as const, deviceId: "usb", name: "Microphone" } };
    preferences.save(binding, original);
    original.inputDevice.name = "Changed after save";
    const retrieved = preferences.get(binding);
    if (retrieved.inputDevice) retrieved.inputDevice.name = "Changed after get";
    expect(preferences.get(binding).inputDevice?.name).toBe("Microphone");
    storage.setItem = () => { throw new Error("Storage full"); };
    expect(() => preferences.save(binding, { ...preferences.get(binding), audioMode: "speak" })).toThrow("Storage full");
    expect(preferences.revision).toBe(1);
    expect(preferences.get(binding).audioMode).toBe("off");
  });

  it("rejects Android settings, hosted providers and secret or recovery fields instead of accepting alternate contracts", () => {
    const defaults = electronVoiceDefaults();
    for (const patch of [{ speechProvider: "openai" }, { headsetControls: true }, { announceRecordingThread: true }, { startupPreRollMs: 512 },
      { inputDevice: { type: 11, address: null, name: "Android microphone" } }, { credential: "private" }, { transcript: "private" },
      { recovery: [] }, { inputDeviceId: "old-id" }, { recognitionEndSilenceMs: 30_001 }, { cueGain: 201 }]) {
      expect(() => desktopVoiceSettings({ ...defaults, ...patch })).toThrow();
    }
    expect(desktopVoiceSettings({ ...defaults, inputDevice: { platform: "electron", deviceId: "usb", name: "Microphone" } }).inputDevice)
      .toEqual({ platform: "electron", deviceId: "usb", name: "Microphone" });
  });

  it("normalizes direct endpoints and rejects credential-bearing URLs and malformed model IDs", () => {
    const defaults = electronVoiceDefaults();
    expect(desktopVoiceSettings({ ...defaults, speechEndpoint: "https://SPEECH.test/v1///" }).speechEndpoint).toBe("https://speech.test/v1");
    expect(desktopVoiceSettings({ ...defaults, speechEndpoint: "http://192.168.1.10:8080/v1" }).speechEndpoint).toBe("http://192.168.1.10:8080/v1");
    for (const speechEndpoint of ["file:///v1", "ws://speech.test/v1", "https://user:secret@speech.test/v1", "https://speech.test/v1?token=secret", "https://speech.test/v1#token", "not a URL",
      "http://speech.test:8000", "https://speech.test/v2", " https://speech.test/v1", "https://speech.test/v1 ", "https://speech.test/\nv1",
      "https://speech.test/\u007fv1", "https://speech.test\\v1", "https://speech.test/v1?", "https://speech.test/v1#",
      "https://speech.test/a/../v1", "https://speech.test/a/%2e%2e/v1", "https://speech.test/a%2fb/v1", "https://speech.test/a%5cb/v1",
      `https://speech.test/${"a".repeat(2048)}/v1`])
      expect(() => desktopVoiceSettings({ ...defaults, speechEndpoint })).toThrow();
    expect(desktopVoiceSettings({ ...defaults, speechEndpoint: "https://speech.test/services/speech/v1/" }).speechEndpoint).toBe("https://speech.test/services/speech/v1");
    for (const model of [" model", "model ", "model\nsecret", "model\u007f"]) {
      expect(() => desktopVoiceSettings({ ...defaults, sttModel: model })).toThrow();
      expect(() => desktopVoiceSettings({ ...defaults, ttsModel: model })).toThrow();
      expect(() => desktopVoiceSettings({ ...defaults, ttsVoice: model })).toThrow();
    }
  });

  it("resets invalid or obsolete persisted records without restoring any recording or pending input", () => {
    const { storage, entries } = storageFixture();
    const preferences = new ElectronVoicePreferences(storage);
    preferences.save(binding, { ...preferences.get(binding), audioMode: "speak" });
    const [key, raw] = [...entries.entries()][0]!;
    const valid = JSON.parse(raw);
    for (const invalid of ["not JSON", JSON.stringify({ ...valid, version: 0 }), JSON.stringify({ ...valid, recording: { text: "private" } }),
      JSON.stringify({ ...valid, settings: { ...valid.settings, speechProvider: "openai" } })]) {
      entries.set(key, invalid);
      const loaded = new ElectronVoicePreferences(storage);
      expect(loaded.reset).toBe(true);
      expect(loaded.revision).toBe(0);
      expect(loaded.get(binding)).toEqual(electronVoiceDefaults());
    }
  });
});
