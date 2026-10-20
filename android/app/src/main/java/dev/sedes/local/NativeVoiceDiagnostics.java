package dev.sedes.local;

import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.function.LongSupplier;
import org.json.JSONArray;
import org.json.JSONObject;

/** Device-local opt-in trace. Never persists, retains envelopes, or accepts free-form diagnostic text. */
final class NativeVoiceDiagnostics {
    static final int MAX_ENTRIES = 512;
    enum Event { RECEIVED, QUEUED, DROPPED, DEQUEUED, SYNTHESIS_STARTED, PLAYBACK_STARTED, PLAYBACK_DRAINED,
        PLAYBACK_STOPPED, INTERACTION_FINISHED, STREAM_CONNECTING, STREAM_LIVE, STREAM_LOST, POLICY_RECEIVED, DISCONNECTED }
    enum ComposerEvent { FOREGROUND_CONTEXT, RECORDING_ROUTE_SELECTED, HANDOFF_OFFERED, HANDOFF_CLAIMED,
        HANDOFF_ACCEPTED, HANDOFF_DECLINED, NATIVE_SUBMISSION_STARTED }
    private static final Set<String> KINDS = new HashSet<>(Arrays.asList("turn.progress", "turn.partial", "turn.completed", "turn.failed",
        "turn.interrupted", "thread.woke", "automation.started", "automation.failed", "approval.requested",
        "input.requested", "question.requested", "replay", "manual"));
    private static final Set<String> REASONS = new HashSet<>(Arrays.asList("duplicate", "ineligible", "empty_speech",
        "coalesced", "progress_evicted", "overflow", "settings_changed", "stopped", "skipped", "disconnected",
        "service_stopped", "notification_connection_lost", "notification_policy_changed", "invalid_notification_policy",
        "invalid_notification_frame", "record_during_playback", "audio_mode_changed", "audio_off", "speech_settings_changed",
        "speech_configuration_required", "speech_timeout", "playback_failed", "playback_drain_timeout", "empty_pcm_stream",
        "invalid_pcm", "audio_focus_lost", "audio_focus_unavailable", "stream_closed", "stream_unavailable", "voice_off", "stream_failed", "stream_rejected",
        "unauthorized", "notification_policy_missing", "stream_invalid", "stream_too_large", "connection_changed"));
    private final ArrayDeque<JSONObject> entries = new ArrayDeque<>();
    private final LongSupplier wallClock, elapsedClock;
    private boolean enabled;
    private long sequence;
    NativeVoiceDiagnostics(LongSupplier wallClock, LongSupplier elapsedClock) {
        this.wallClock = wallClock; this.elapsedClock = elapsedClock;
    }
    synchronized void enabled(boolean value) { enabled = value; }
    synchronized void clear() { entries.clear(); sequence = 0; }
    synchronized JSONObject read() {
        JSONArray copy = new JSONArray();
        for (JSONObject entry : entries) copy.put(NativeVoiceJson.copy(entry));
        return NativeVoiceJson.object("enabled", enabled, "maximumEntries", MAX_ENTRIES, "entries", copy);
    }
    /** Fixed fields only; a random recording UUID joins browser and native traces without thread identifiers. */
    void recordComposer(ComposerEvent event, String recordingId, long connectionGeneration,
        boolean nativeVisible, boolean foregroundVisible, boolean composerAvailable,
        boolean targetMatchesForeground, boolean composerSelected) {
        try {
            synchronized (this) {
                if (!enabled) return;
                JSONObject entry = NativeVoiceJson.object("sequence", ++sequence,
                    "wallTimeMilliseconds", wallClock.getAsLong(), "elapsedMilliseconds", elapsedClock.getAsLong(),
                    "event", event.name().toLowerCase(java.util.Locale.ROOT), "connectionGeneration", connectionGeneration,
                    "nativeVisible", nativeVisible, "foregroundVisible", foregroundVisible,
                    "composerAvailable", composerAvailable, "targetMatchesForeground", targetMatchesForeground,
                    "composerSelected", composerSelected);
                if (recordingId != null && recordingId.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"))
                    NativeVoiceJson.put(entry, "recordingId", recordingId);
                if (entries.size() == MAX_ENTRIES) entries.removeFirst();
                entries.addLast(entry);
            }
        } catch (RuntimeException ignored) {}
    }
    void record(Event event, String sourceEventId, String eventKind, long connectionGeneration,
        long streamGeneration, long policyGeneration, int queueCount, int queueBytes, int chunkIndex, String reason) {
        // Logging is observational even if a clock, serialization, or future sink fails.
        try {
            synchronized (this) {
                if (!enabled) return;
                JSONObject entry = NativeVoiceJson.object("sequence", ++sequence,
                    "wallTimeMilliseconds", wallClock.getAsLong(), "elapsedMilliseconds", elapsedClock.getAsLong(),
                    "event", event.name().toLowerCase(java.util.Locale.ROOT),
                    "connectionGeneration", connectionGeneration, "streamGeneration", streamGeneration,
                    "policyGeneration", policyGeneration, "queueCount", queueCount, "queueBytes", queueBytes);
                // Production sourceEventId is SHA-256(eventKey). Never export arbitrary wire identifiers (or thread IDs).
                if (sourceEventId != null && sourceEventId.matches("[a-f0-9]{64}")) NativeVoiceJson.put(entry, "sourceEventId", sourceEventId);
                if (eventKind != null && KINDS.contains(eventKind)) NativeVoiceJson.put(entry, "eventKind", eventKind);
                if (chunkIndex >= 0) NativeVoiceJson.put(entry, "chunkIndex", chunkIndex);
                if (reason != null) NativeVoiceJson.put(entry, "reason", REASONS.contains(reason) ? reason : "other");
                if (entries.size() == MAX_ENTRIES) entries.removeFirst();
                entries.addLast(entry);
            }
        } catch (RuntimeException ignored) {}
    }
}
