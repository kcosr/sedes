import type { NormalizedApplicationThreadSummary } from "../../shared/protocol/application.js";
import type { NativeVoiceState } from "./native-voice-plugin.js";

export interface VoiceRecordingTarget {
  threadId: string;
  threadTitle: string | null;
  source: "explicit" | "pinned" | "visible" | "retained" | "default";
}

/** Explicit choice and pin lead; browsing follows the visible thread before native retention. */
export function voiceRecordingTarget(threads: readonly NormalizedApplicationThreadSummary[], native: NativeVoiceState, visibleThreadId: string | null): VoiceRecordingTarget | undefined {
  const { settings, nextRecordingTarget, retainedVoiceTarget } = native;
  const available = (id: string | null, source: VoiceRecordingTarget["source"]): VoiceRecordingTarget | undefined => {
    const thread = threads.find(thread => thread.id === id && thread.available &&
      (thread.inventoryState === "active" || thread.inventoryState === "settled"));
    return thread ? { threadId: thread.id, threadTitle: thread.title.text, source } : undefined;
  };
  if (nextRecordingTarget) return available(nextRecordingTarget.threadId, "explicit");
  if (settings.pinDefaultVoiceThread) return available(settings.voiceThreadId, "pinned");
  if (visibleThreadId !== null) return available(visibleThreadId, "visible");
  if (retainedVoiceTarget) {
    const thread = threads.find(thread => thread.id === retainedVoiceTarget.threadId);
    return { threadId: retainedVoiceTarget.threadId, threadTitle: thread ? thread.title.text : retainedVoiceTarget.threadTitle, source: "retained" };
  }
  return available(settings.voiceThreadId, "default");
}
