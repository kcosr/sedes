import { z } from "zod";
import { getDiagnosticCategoryEnabled, subscribeDiagnosticCategoryEnabled } from "../app/settings.js";
import { hasNativeVoice, nativeVoice } from "./native-voice-plugin.js";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const entrySchema = z.object({
  sequence: counter,
  wallTimeMilliseconds: counter,
  elapsedMilliseconds: counter,
  event: z.enum(["received", "queued", "dropped", "dequeued", "synthesis_started", "playback_started", "playback_drained",
    "playback_stopped", "interaction_finished", "stream_connecting", "stream_live", "stream_lost", "policy_received", "disconnected"]),
  sourceEventId: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  eventKind: z.enum(["turn.progress", "turn.completed", "turn.failed", "turn.interrupted", "thread.woke",
    "automation.started", "automation.failed", "approval.requested", "input.requested", "question.requested", "replay", "manual"]).optional(),
  connectionGeneration: counter,
  streamGeneration: counter,
  policyGeneration: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  queueCount: counter.max(64),
  queueBytes: counter.max(256 * 1024),
  chunkIndex: counter.optional(),
  reason: z.enum(["duplicate", "ineligible", "empty_speech", "coalesced", "progress_evicted", "overflow", "settings_changed",
    "stopped", "skipped", "disconnected", "service_stopped", "notification_connection_lost", "notification_policy_changed",
    "invalid_notification_policy", "invalid_notification_frame", "record_during_playback", "audio_mode_changed", "audio_off",
    "speech_settings_changed", "speech_configuration_required", "speech_timeout", "playback_failed", "playback_drain_timeout",
    "empty_pcm_stream", "invalid_pcm", "audio_focus_lost", "audio_focus_unavailable", "stream_closed", "stream_unavailable", "voice_off", "stream_failed",
    "stream_rejected", "unauthorized", "notification_policy_missing", "stream_invalid", "stream_too_large", "connection_changed", "other"]).optional(),
});
// Strip unrecognized bridge fields; never copy arbitrary native snapshots or error text into diagnostics.
export const nativeVoiceDiagnosticsSchema = z.object({
  enabled: z.boolean(), maximumEntries: z.literal(512), entries: z.array(entrySchema).max(512),
});
export type NativeVoiceDiagnosticsExport = z.infer<typeof nativeVoiceDiagnosticsSchema> | { status: "unavailable" };

/** Device-wide opt-in follows the existing local setting, independently of authenticated voice-store lifetime. */
export function installNativeVoiceDiagnostics(): () => void {
  if (!hasNativeVoice()) return () => {};
  const synchronize = () => {
    try {
      void nativeVoice.setDiagnosticsEnabled({ enabled: getDiagnosticCategoryEnabled("voice") }).catch(() => {});
    } catch { /* Diagnostics must never interrupt application startup or settings changes. */ }
  };
  synchronize();
  return subscribeDiagnosticCategoryEnabled("voice", synchronize);
}

export async function readNativeVoiceDiagnostics(): Promise<NativeVoiceDiagnosticsExport | undefined> {
  if (!hasNativeVoice()) return undefined;
  try { return nativeVoiceDiagnosticsSchema.parse(await nativeVoice.readDiagnostics()); }
  catch { return { status: "unavailable" }; }
}

export async function clearNativeVoiceDiagnostics(): Promise<void> {
  if (hasNativeVoice()) await nativeVoice.clearDiagnostics();
}
