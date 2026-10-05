import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import type { NativeVoiceSettings } from "./native-voice-plugin.js";

/** A pin fixes explicit recording to the default; an unavailable pin must open a picker rather than fall back. */
export function voiceRecordingTarget(threads: readonly NormalizedApplicationThreadSummary[], settings: NativeVoiceSettings, visibleThreadId: string | null): NormalizedApplicationThreadSummary | undefined {
  const available = (id: string | null) => threads.find(thread => thread.id === id && thread.available &&
    (thread.inventoryState === "active" || thread.inventoryState === "settled"));
  return settings.pinDefaultVoiceThread ? available(settings.voiceThreadId) : available(visibleThreadId) ?? available(settings.voiceThreadId);
}
