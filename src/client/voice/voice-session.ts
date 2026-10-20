import type { NativeVoiceStore } from "./NativeVoiceStore.js";
import type { NativeVoiceSettings } from "./native-voice-plugin.js";

/** A complete speech destination and native credential are required before enabling. */
export function canEnableVoice(settings: NativeVoiceSettings, credentialConfigured: boolean): boolean {
  return credentialConfigured && settings.speechEndpoint !== "" && settings.sttModel !== "" && settings.ttsModel !== "" && settings.ttsVoice !== "";
}
/** The playback preference follows the device, but its default thread belongs to the connected account. */
export function voiceThreadFilterWarning(settings: NativeVoiceSettings): string | null {
  return settings.audioMode !== "off" && settings.onlyVoiceThread && settings.voiceThreadId === null
    ? "Automatic playback and listening are paused. Choose a default thread in General or Voice settings for this connection or turn off Only play from default thread."
    : null;
}
/** Voice is on without a session: rewrite the refreshed native mode, never the rendered one, and skip the write once nothing needs resuming. */
export function resumeVoice(store: NativeVoiceStore): Promise<void> {
  return store.update(current => current.settings.audioMode !== "off" && current.actions.canResume ? { audioMode: current.settings.audioMode } : null);
}
/** What a native voice readiness state asks of the user. */
export function voiceReadiness(readiness: string): string {
  return ({ disconnected: "Connect to Sedes to use voice.", connecting: "Connecting to Sedes…", off: "Voice is off.", needsResume: "Resume voice from this screen to start a new session.",
    storageUnavailable: "Recording storage is unavailable. Retry the voice connection.",
    permissionRequired: "Microphone permission is required to start voice.", speechConfigurationRequired: "Configure a speech endpoint, models and voice, and add the required credential.",
    notificationsConnecting: "Connecting to Sedes notifications…", notificationsUnavailable: "Sedes notifications are unavailable. Explicit recording still works.",
    ready: "Voice is ready.", error: "Voice needs attention." } as Record<string, string>)[readiness] ?? "Voice is starting…";
}
