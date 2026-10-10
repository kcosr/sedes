import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import type { NativeVoiceState } from "./native-voice-plugin.js";

export interface VoiceRecordingTarget { threadId: string; threadTitle: string | null }

/** Explicit choice and pin lead; native retention survives an incomplete browser inventory. */
export function voiceRecordingTarget(threads: readonly NormalizedApplicationThreadSummary[], native: NativeVoiceState, visibleThreadId: string | null): VoiceRecordingTarget | undefined {
  const { settings, nextRecordingTarget, retainedVoiceTarget } = native;
  const available = (id: string | null): VoiceRecordingTarget | undefined => {
    const thread = threads.find(thread => thread.id === id && thread.available &&
      (thread.inventoryState === "active" || thread.inventoryState === "settled"));
    return thread ? { threadId: thread.id, threadTitle: thread.title.text } : undefined;
  };
  if (nextRecordingTarget) return available(nextRecordingTarget.threadId);
  if (settings.pinDefaultVoiceThread) return available(settings.voiceThreadId);
  if (retainedVoiceTarget) return { threadId: retainedVoiceTarget.threadId, threadTitle: retainedVoiceTarget.threadTitle };
  return available(visibleThreadId) ?? available(settings.voiceThreadId);
}
