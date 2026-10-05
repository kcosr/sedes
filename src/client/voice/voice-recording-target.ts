import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import type { NativeVoiceState } from "./native-voice-plugin.js";

/** An explicit next target leads; otherwise the pin/visible-thread policy supplies the initial choice. */
export function voiceRecordingTarget(threads: readonly NormalizedApplicationThreadSummary[], native: NativeVoiceState, visibleThreadId: string | null): NormalizedApplicationThreadSummary | undefined {
  const { settings, nextRecordingTarget } = native;
  const available = (id: string | null) => threads.find(thread => thread.id === id && thread.available &&
    (thread.inventoryState === "active" || thread.inventoryState === "settled"));
  if (nextRecordingTarget) return available(nextRecordingTarget.threadId);
  return settings.pinDefaultVoiceThread ? available(settings.voiceThreadId) : available(visibleThreadId) ?? available(settings.voiceThreadId);
}
