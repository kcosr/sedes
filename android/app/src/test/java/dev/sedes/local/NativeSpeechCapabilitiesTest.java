package dev.sedes.local;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class NativeSpeechCapabilitiesTest {
    static JSONObject policy() {
        return NativeVoiceJson.object("max_buffer_bytes", 5760000, "max_message_bytes", 1048576, "max_output_bytes", 1048576,
            "idle_timeout_seconds", 60, "max_session_seconds", 3600);
    }
    @Test public void hardSegmentsClampToWholeHundredMillisecondFrames() throws Exception {
        assertEquals(60000, NativeSpeechCapabilities.server("model", policy()).hardSegmentMs());
        JSONObject limits = policy(); limits.put("max_buffer_bytes", 240002);
        NativeSpeechCapabilities caps = NativeSpeechCapabilities.server("model", limits);
        assertEquals(5000, caps.hardSegmentMs()); assertEquals(240000, caps.hardSegmentBytes());
        assertEquals(240002, caps.maxBufferBytes); assertEquals(60000, caps.idleTimeoutMs);
        assertEquals(limits.toString(), caps.realtime().toString());
    }
    @Test public void absentMalformedAndInsufficientServerLimitsFailClosed() throws Exception {
        for (String field : new String[] { "max_buffer_bytes", "max_message_bytes", "max_output_bytes", "idle_timeout_seconds", "max_session_seconds" }) {
            JSONObject missing = policy(); missing.remove(field);
            assertEquals("speech_server_configuration_unsupported", assertThrows(IllegalArgumentException.class,
                () -> NativeSpeechCapabilities.server("model", missing)).getMessage());
        }
        for (JSONObject patch : new JSONObject[] { NativeVoiceJson.object("max_buffer_bytes", 0), NativeVoiceJson.object("max_buffer_bytes", 239998), NativeVoiceJson.object("max_buffer_bytes", 240001),
            NativeVoiceJson.object("max_message_bytes", 8191), NativeVoiceJson.object("max_output_bytes", 524287),
            NativeVoiceJson.object("idle_timeout_seconds", 39), NativeVoiceJson.object("max_session_seconds", 0),
            NativeVoiceJson.object("max_session_seconds", "1.5"), NativeVoiceJson.object("idle_timeout_seconds", 39.9999), NativeVoiceJson.object("unknown", 1) }) {
            JSONObject invalid = policy(); for (java.util.Iterator<String> keys = patch.keys(); keys.hasNext();) { String key = keys.next(); invalid.put(key, patch.opt(key)); }
            assertThrows(IllegalArgumentException.class, () -> NativeSpeechCapabilities.server("model", invalid));
        }
    }
    @Test public void fractionalServerTimeoutsPreserveMillisecondsAndRoundDownSubMillisecondLimits() throws Exception {
        JSONObject limits = policy(); limits.put("idle_timeout_seconds", 40.25); limits.put("max_session_seconds", 600.5);
        NativeSpeechCapabilities caps = NativeSpeechCapabilities.server("model", limits);
        assertEquals(40250, caps.idleTimeoutMs); assertEquals(600500, caps.maxSessionMs);
        caps.validateTiming(60000); assertEquals(limits.toString(), caps.realtime().toString());
        limits.put("idle_timeout_seconds", 40.250999); limits.put("max_session_seconds", 600.500999);
        caps = NativeSpeechCapabilities.server("model", limits);
        assertEquals(40250, caps.idleTimeoutMs); assertEquals(600500, caps.maxSessionMs);
        limits.put("max_session_seconds", 181.099999);
        NativeSpeechCapabilities insufficient = NativeSpeechCapabilities.server("model", limits);
        assertEquals(181099, insufficient.maxSessionMs);
        assertEquals("recognition_session_timing_unsupported", assertThrows(IllegalArgumentException.class, () -> insufficient.validateTiming(60000)).getMessage());
        limits.put("max_session_seconds", 181.101);
        caps = NativeSpeechCapabilities.server("model", limits);
        assertEquals(181101, caps.maxSessionMs);
        assertEquals(181101, NativeSpeechCapabilities.server("model", caps.realtime()).maxSessionMs);
        caps.validateTiming(60000);
    }
    @Test public void hostedPolicyRecognizesOnlyExplicitBaseModelEntries() {
        assertEquals(5, NativeSpeechCapabilities.HOSTED_MODELS.size());
        for (String model : NativeSpeechCapabilities.HOSTED_MODELS) {
            NativeSpeechCapabilities caps = NativeSpeechCapabilities.hosted(model);
            assertEquals(model, caps.model); assertEquals("openai", caps.provider); assertEquals(60000, caps.hardSegmentMs());
        }
        for (String model : new String[] { "gpt-live-transcribe-2026-10-04", "custom-model", "gpt-4o-mini-tts" })
            assertEquals("speech_transcription_model_unsupported", assertThrows(IllegalArgumentException.class, () -> NativeSpeechCapabilities.hosted(model)).getMessage());
    }
    @Test public void resultBudgetReservesPreviousJobNextJobAndRenewalMargin() throws Exception {
        NativeSpeechCapabilities caps = NativeSpeechCapabilities.server("model", policy());
        assertEquals(181100, caps.minimumSessionBudgetMs(60000)); assertEquals(661100, caps.minimumSessionBudgetMs(300000));
        JSONObject shortSession = policy(); shortSession.put("max_session_seconds", 181.099);
        NativeSpeechCapabilities tooShort = NativeSpeechCapabilities.server("model", shortSession);
        assertEquals("recognition_session_timing_unsupported", assertThrows(IllegalArgumentException.class, () -> tooShort.validateTiming(60000)).getMessage());
        assertThrows(IllegalArgumentException.class, () -> caps.validateTiming(999));
    }
}
