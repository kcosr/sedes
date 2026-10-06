import type { NativeVoiceStore } from "./NativeVoiceStore.js";
import type { NativeVoiceSettings } from "./native-voice-plugin.js";

/** A complete speech destination and native credential are required before enabling. */
export function canEnableVoice(settings: NativeVoiceSettings, credentialConfigured: boolean): boolean {
  return credentialConfigured && settings.speechEndpoint !== "" && settings.sttModel !== "" && settings.ttsModel !== "" && settings.ttsVoice !== "";
}
/** The playback preference follows the device, but its default thread belongs to the connected account. */
export function voiceThreadFilterWarning(settings: NativeVoiceSettings): string | null {
  return settings.audioMode !== "off" && settings.onlyVoiceThread && settings.voiceThreadId === null
    ? "Automatic playback and listening are paused. Choose a default voice thread for this connection or turn off Only play from default voice thread."
    : null;
}
/** Voice is on without a session: rewrite the refreshed native mode, never the rendered one, and skip the write once nothing needs resuming. */
export function resumeVoice(store: NativeVoiceStore): Promise<void> {
  return store.update(current => current.settings.audioMode !== "off" && current.actions.canResume ? { audioMode: current.settings.audioMode } : null);
}
