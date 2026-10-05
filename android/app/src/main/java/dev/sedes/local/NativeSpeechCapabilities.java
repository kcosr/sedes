package dev.sedes.local;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;
import org.json.JSONObject;

/** Frozen recognition policy for one exact provider/model. Picker caches never authorize recording. */
final class NativeSpeechCapabilities {
    static final Set<String> HOSTED_MODELS = Collections.unmodifiableSet(new LinkedHashSet<>(Arrays.asList(
        "gpt-live-transcribe", "gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1")));
    static final int PCM_PACKET_BYTES = 4800;
    static final int CAPTURE_FRAME_MS = 100;
    static final int UPLOAD_HOLD_BACK_MS = 1000;
    static final long MICROPHONE_ARMING_MS = 30000;
    static final long FIRST_UPLOAD_DELAY_MS = UPLOAD_HOLD_BACK_MS + CAPTURE_FRAME_MS;
    static final long SESSION_MARGIN_MS = 30000;
    final String provider, model;
    final long maxBufferBytes, maxMessageBytes, maxOutputBytes, idleTimeoutMs, maxSessionMs;
    final int hardFrames;

    private NativeSpeechCapabilities(String provider, String model, long buffer, long message, long output, long idleMs, long sessionMs) {
        this.provider = provider; this.model = model; maxBufferBytes = buffer; maxMessageBytes = message;
        maxOutputBytes = output; idleTimeoutMs = idleMs; maxSessionMs = sessionMs;
        hardFrames = (int) Math.min(600, buffer / PCM_PACKET_BYTES);
    }
    static NativeSpeechCapabilities server(String model, JSONObject realtime) {
        try {
            NativeVoiceJson.keys(realtime, "max_buffer_bytes", "max_message_bytes", "max_output_bytes", "idle_timeout_seconds", "max_session_seconds");
            long buffer = NativeVoiceJson.integer(realtime, "max_buffer_bytes", 240000, 9007199254740991L);
            long message = NativeVoiceJson.integer(realtime, "max_message_bytes", 8192, 9007199254740991L);
            long output = NativeVoiceJson.integer(realtime, "max_output_bytes", 524288, 9007199254740991L);
            long idle = timeoutMs(realtime, "idle_timeout_seconds", false);
            long session = timeoutMs(realtime, "max_session_seconds", false);
            if ((buffer & 1) != 0 || idle < 40000 || model == null || model.isEmpty()) throw new IllegalArgumentException();
            return new NativeSpeechCapabilities("server", model, buffer, message, output, idle, session);
        } catch (Exception invalid) { throw new IllegalArgumentException("speech_server_configuration_unsupported"); }
    }
    /** The server accepts fractional seconds; decimal conversion never rounds its lifetime up. */
    static long timeoutMs(JSONObject value, String key, boolean allowZero) {
        Object raw = value.opt(key);
        if (!(raw instanceof Number)) throw new IllegalArgumentException();
        double seconds = ((Number) raw).doubleValue();
        if (!Double.isFinite(seconds) || seconds < 0 || !allowZero && seconds == 0 || seconds > Integer.MAX_VALUE)
            throw new IllegalArgumentException();
        return new java.math.BigDecimal(raw.toString()).multiply(java.math.BigDecimal.valueOf(1000))
            .setScale(0, java.math.RoundingMode.FLOOR).longValueExact();
    }
    static NativeSpeechCapabilities hosted(String model) {
        if (!HOSTED_MODELS.contains(model)) throw new IllegalArgumentException("speech_transcription_model_unsupported");
        // Application policy, not a claim about an undocumented provider input-buffer limit.
        // Every enabled model is subject to the release's repeated-commit, lifetime and corpus validation gate.
        return new NativeSpeechCapabilities("openai", model, 600L * PCM_PACKET_BYTES, 1024 * 1024, 1024 * 1024, 0, 3600000);
    }
    long hardSegmentMs() { return hardFrames * (long) CAPTURE_FRAME_MS; }
    long hardSegmentBytes() { return hardFrames * (long) PCM_PACKET_BYTES; }
    long minimumSessionBudgetMs(long resultTimeoutMs) {
        // Every fresh session reserves the initial microphone route plus enough PCM for the first upload.
        // Replacements and explicit Retry use the same conservative readiness contract.
        return MICROPHONE_ARMING_MS + FIRST_UPLOAD_DELAY_MS +
            Math.max(hardSegmentMs(), resultTimeoutMs) + resultTimeoutMs + SESSION_MARGIN_MS;
    }
    void validateTiming(long resultTimeoutMs) {
        if (resultTimeoutMs < 1000 || resultTimeoutMs > 300000) throw new IllegalArgumentException("recognition_invalid_timeout");
        if (maxSessionMs < minimumSessionBudgetMs(resultTimeoutMs)) throw new IllegalArgumentException("recognition_session_timing_unsupported");
    }
    JSONObject realtime() {
        return NativeVoiceJson.object("max_buffer_bytes", maxBufferBytes, "max_message_bytes", maxMessageBytes,
            "max_output_bytes", maxOutputBytes, "idle_timeout_seconds", idleTimeoutMs / 1000.0, "max_session_seconds", maxSessionMs / 1000.0);
    }
}
