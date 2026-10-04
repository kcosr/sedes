package dev.sedes.local;

import static org.junit.Assert.*;
import org.junit.Test;

/** Pure runtime policy: blank input, definitive rejection, reconnect backoff and user-facing failure messages. */
public class NativeVoiceRuntimePolicyTest {
    @Test public void fieldValidationPreservesSchemaNamesWithoutExposingExceptionText() {
        assertEquals("invalid_threadTitle", NativeVoiceRuntime.code(new NativeVoiceJson.InvalidFieldException("threadTitle")));
        assertEquals("invalid_composerMode", NativeVoiceRuntime.code(new NativeVoiceJson.InvalidFieldException("composerMode")));
        assertEquals("invalid_adapterUrl", NativeVoiceRuntime.code(new NativeVoiceJson.InvalidFieldException("adapterUrl", new Exception("private detail"))));
        assertEquals("connection_changed", NativeVoiceRuntime.code(new IllegalStateException("connection_changed")));
        for (Exception error : new Exception[] { new IllegalArgumentException("invalid_threadTitle"),
            new Exception("privateTitle"), new Exception("/private/path: permission denied"), new Exception(),
            new NativeVoiceJson.InvalidFieldException("threadTitle: private detail"),
            new NativeVoiceJson.InvalidFieldException(new String(new char[80]).replace('\0', 'x')) })
            assertEquals("voice_action_failed", NativeVoiceRuntime.code(error));
    }
    @Test public void blankMatchesEcmaScriptTrim() {
        for (String blank : new String[] { "", " ", "\t\n\u000b\f\r", " ", " ", "   ", "  ",
            " ", " ", "　", "﻿", "  　﻿ " })
            assertTrue("Expected blank: " + escape(blank), NativeVoiceRuntime.blank(blank));
        // Zero-width space, Mongolian vowel separator and next line are not ECMAScript whitespace.
        for (String text : new String[] { "a", " a ", "​", "᠎", "\u0085", "　x" })
            assertFalse("Expected text: " + escape(text), NativeVoiceRuntime.blank(text));
    }
    @Test public void onlyCompletedAdmissionRejectionsAreDefinitive() {
        for (int status : new int[] { 400, 403, 404, 409, 410, 413, 422 }) assertTrue(status + "", NativeVoiceRuntime.definitiveRejection(status, ""));
        for (int status : new int[] { 0, 200, 202, 401, 408, 429, 500, 502, 503 }) assertFalse(status + "", NativeVoiceRuntime.definitiveRejection(status, ""));
        assertTrue("Conflicts and invalid transitions are definitive", NativeVoiceRuntime.definitiveRejection(409, "conflict"));
        assertTrue(NativeVoiceRuntime.definitiveRejection(400, "invalid_transition"));
        assertFalse("CSRF rejection is refreshed and retried", NativeVoiceRuntime.definitiveRejection(403, "csrf_token_invalid"));
        assertFalse("A resolvable pending thread operation keeps the input", NativeVoiceRuntime.definitiveRejection(409, "operation_outcome_uncertain"));
    }
    @Test public void backoffDoublesToABoundedDelay() {
        long[] expected = { 2000, 2000, 4000, 8000, 16000, 32000, 60000, 60000 };
        for (int failures = 0; failures < expected.length; failures++) assertEquals(expected[failures], NativeVoiceRuntime.backoff(failures));
        assertEquals(60000, NativeVoiceRuntime.backoff(Integer.MAX_VALUE));
    }
    @Test public void connectionFailuresDistinguishPairingFromConnectivity() {
        assertEquals("authentication_required", NativeVoiceRuntime.connectionFailure(401));
        for (int status : new int[] { 0, 403, 404, 500, 503 }) assertEquals("connection_unavailable", NativeVoiceRuntime.connectionFailure(status));
        for (String code : new String[] { "authentication_required", "connection_unavailable", "session_unavailable", "credential_storage_unavailable",
            "voice_storage_unavailable", "voice_settings_reset", "voice_origin_reset", "voice_journal_reset" })
            assertSpecific(code);
        assertNotEquals(NativeVoiceRuntime.message("authentication_required"), NativeVoiceRuntime.message("connection_unavailable"));
    }
    @Test public void specificAudioAndRecoveryFailuresHaveUsefulMessages() {
        for (String code : new String[] { "speech_timeout", "audio_focus_unavailable", "empty_pcm_stream", "playback_drain_timeout",
            "microphone_permission_required", "microphone_device_unavailable", "microphone_route_failed", "microphone_limit_reached",
            "input_rejected", "input_outcome_uncertain", "input_recovery_not_found", "voice_journal_capacity",
            "notification_stream_rejected", "notification_policy_unavailable", "adapter_message_too_large" })
            assertSpecific(code);
        assertTrue(NativeVoiceRuntime.message("microphone_start_failed").contains("microphone_start_failed"));
        assertTrue(NativeVoiceRuntime.message("playback_unavailable").contains("playback_unavailable"));
        assertTrue(NativeVoiceRuntime.message("some_future_code").contains("some_future_code"));
    }
    private static void assertSpecific(String code) {
        String message = NativeVoiceRuntime.message(code);
        assertFalse("Generic message for " + code, message.contains(code));
        assertFalse(message.isEmpty());
    }
    private static String escape(String value) {
        StringBuilder result = new StringBuilder();
        for (char c : value.toCharArray()) result.append(String.format("\\u%04x", (int) c));
        return result.toString();
    }
}
