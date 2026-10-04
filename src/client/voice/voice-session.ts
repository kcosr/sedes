import type { NativeVoiceStore } from "./NativeVoiceStore.js";
import type { NativeVoiceSettings } from "./native-voice-plugin.js";

/** Native saves the mode before it refuses to start a session without an adapter URL, so voice turns on from Off only once one is saved. */
export function canEnableVoice(settings: NativeVoiceSettings): boolean {
  return settings.adapterUrl !== "";
}
/** Voice is on without a session: rewrite the refreshed native mode, never the rendered one, and skip the write once nothing needs resuming. */
export function resumeVoice(store: NativeVoiceStore): Promise<void> {
  return store.update(current => current.settings.audioMode !== "off" && current.actions.canResume ? { audioMode: current.settings.audioMode } : null);
}
