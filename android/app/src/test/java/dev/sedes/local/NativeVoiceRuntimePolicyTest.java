package dev.sedes.local;

import static org.junit.Assert.*;
import org.junit.Test;

/** Pure runtime policy: blank input, definitive rejection, reconnect backoff and user-facing failure messages. */
public class NativeVoiceRuntimePolicyTest {
    @Test public void manualTargetPrefersExplicitThenPendingBeforePinnedOrForegroundDefaults() {
        org.json.JSONObject settings = NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("pinDefaultVoiceThread", true,
            "voiceThreadId", "default", "voiceThreadTitle", "Saved default")).value;
        org.json.JSONObject foreground = NativeVoiceJson.object("visible", true, "threadId", "foreground", "threadTitle", "Open thread");
        org.json.JSONObject pending = NativeVoiceJson.object("threadId", "next", "threadTitle", "Chosen next");
        org.json.JSONObject explicit = NativeVoiceJson.object("threadId", "explicit", "threadTitle", null);
        org.json.JSONObject selected = NativeVoiceRuntime.manualTarget(explicit, pending, settings, foreground);
        assertEquals("explicit", selected.optString("threadId")); assertTrue(selected.isNull("threadTitle"));
        assertEquals("next", NativeVoiceRuntime.manualTarget(null, pending, settings, foreground).optString("threadId"));
        assertEquals("default", NativeVoiceRuntime.manualTarget(null, null, settings, foreground).optString("threadId"));
        NativeVoiceJson.put(settings, "pinDefaultVoiceThread", false);
        assertEquals("next", NativeVoiceRuntime.manualTarget(null, pending, settings, foreground).optString("threadId"));
        assertEquals("foreground", NativeVoiceRuntime.manualTarget(null, null, settings, foreground).optString("threadId"));
        NativeVoiceJson.put(foreground, "visible", false);
        assertEquals("default", NativeVoiceRuntime.manualTarget(null, null, settings, foreground).optString("threadId"));
        NativeVoiceJson.put(settings, "pinDefaultVoiceThread", true); NativeVoiceJson.put(settings, "voiceThreadId", null);
        assertEquals("explicit", NativeVoiceRuntime.manualTarget(explicit, pending, settings, foreground).optString("threadId"));
        assertEquals("next", NativeVoiceRuntime.manualTarget(null, pending, settings, foreground).optString("threadId"));
        assertTrue(NativeVoiceRuntime.manualTarget(null, null, settings, foreground).isNull("threadId"));
        assertEquals("Chosen next", pending.optString("threadTitle"));
    }
    @Test public void backgroundStartUsesOnlySavedDefaultRegardlessOfPin() {
        for (boolean pinned : new boolean[] { false, true }) {
            org.json.JSONObject settings = NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("pinDefaultVoiceThread", pinned,
                "voiceThreadId", "default", "voiceThreadTitle", "Saved default")).value;
            org.json.JSONObject target = NativeVoiceRuntime.defaultRecordingTarget(settings);
            assertEquals("default", target.optString("threadId")); assertEquals("Saved default", target.optString("threadTitle"));
            NativeVoiceJson.put(settings, "voiceThreadId", null);
            target = NativeVoiceRuntime.defaultRecordingTarget(settings);
            assertTrue(target.isNull("threadId")); assertTrue(target.isNull("threadTitle"));
        }
    }
    @Test public void fieldValidationPreservesSchemaNamesWithoutExposingExceptionText() {
        assertEquals("invalid_threadTitle", NativeVoiceRuntime.code(new NativeVoiceJson.InvalidFieldException("threadTitle")));
        assertEquals("invalid_composerMode", NativeVoiceRuntime.code(new NativeVoiceJson.InvalidFieldException("composerMode")));
        assertEquals("invalid_speechEndpoint", NativeVoiceRuntime.code(new NativeVoiceJson.InvalidFieldException("speechEndpoint", new Exception("private detail"))));
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
    @Test public void catalogOwnershipDependsOnAccountAndSelectedSpeechModel() {
        NativeVoiceSettings current = NativeVoiceSettings.defaults();
        for (org.json.JSONObject patch : new org.json.JSONObject[] {
            NativeVoiceJson.object("ttsVoice", "alloy"), NativeVoiceJson.object("ttsSpeed", 1.5) })
            assertFalse(NativeVoiceRuntime.catalogConfigurationChanged(current, current.patch(0, patch)));
        for (org.json.JSONObject patch : new org.json.JSONObject[] {
            NativeVoiceJson.object("ttsModel", "another-speech-model"),
            NativeVoiceJson.object("sttModel", "another-transcription-model"),
            NativeVoiceJson.object("speechProvider", "server"),
            NativeVoiceJson.object("speechProvider", "server", "speechEndpoint", "https://speech.example/v1") })
            assertTrue(NativeVoiceRuntime.catalogConfigurationChanged(current, current.patch(0, patch)));
    }
    @Test public void connectionFailuresDistinguishPairingFromConnectivity() {
        assertEquals("authentication_required", NativeVoiceRuntime.connectionFailure(401));
        for (int status : new int[] { 0, 403, 404, 500, 503 }) assertEquals("connection_unavailable", NativeVoiceRuntime.connectionFailure(status));
        for (String code : new String[] { "authentication_required", "connection_unavailable", "session_unavailable", "credential_storage_unavailable",
            "voice_storage_unavailable", "voice_settings_reset", "voice_journal_reset" })
            assertSpecific(code);
        assertNotEquals(NativeVoiceRuntime.message("authentication_required"), NativeVoiceRuntime.message("connection_unavailable"));
    }
    @Test public void specificAudioAndRecoveryFailuresHaveUsefulMessages() {
        for (String code : new String[] { "speech_timeout", "audio_focus_unavailable", "empty_pcm_stream", "playback_drain_timeout",
            "microphone_permission_required", "microphone_device_unavailable", "microphone_route_failed", "microphone_limit_reached",
            "input_rejected", "input_outcome_uncertain", "input_recovery_not_found", "voice_journal_capacity",
            "notification_stream_rejected", "notification_policy_unavailable", "recognition_message_limit",
            "speech_configuration_required", "speech_authentication_failed", "recognition_authentication_failed",
            "recording_changed", "recording_revision_conflict", "recording_settings_busy", "recording_recovery_required",
            "dictation_finalization_conflict", "dictation_storage_unavailable", "speech_transcription_model_unsupported",
            "speech_rate_limited", "speech_quota_exceeded", "recognition_quota_exceeded", "recognition_network_error", "microphone_format_unavailable" })
            assertSpecific(code);
        assertFalse(NativeVoiceRuntime.message("speech_quota_exceeded").contains("Try again shortly"));
        assertTrue(NativeVoiceRuntime.message("microphone_start_failed").contains("microphone_start_failed"));
        assertTrue(NativeVoiceRuntime.message("playback_unavailable").contains("playback_unavailable"));
        assertTrue(NativeVoiceRuntime.message("some_future_code").contains("some_future_code"));
    }
    @Test public void everyEmittedDictationAndRecognitionFailureHasASpecificMessage() throws Exception {
        java.util.regex.Pattern errors = java.util.regex.Pattern.compile("\"((?:dictation|recognition)_[a-z_]+)\"");
        for (String name : new String[] { "NativeDictationStore", "NativeVoiceRecording", "NativeSpeechTransport", "NativeSpeechCapabilities", "NativeSpeechCatalog" }) {
            java.nio.file.Path source = java.nio.file.Paths.get("src/main/java/dev/sedes/local/" + name + ".java");
            assertTrue("Missing production error-code source " + source, java.nio.file.Files.isRegularFile(source));
            java.util.regex.Matcher matches = errors.matcher(new String(java.nio.file.Files.readAllBytes(source), java.nio.charset.StandardCharsets.UTF_8));
            while (matches.find()) assertSpecific(matches.group(1));
        }
        assertEquals("Recording storage is full. Resolve saved recordings in their original profiles or remove an unused profile.",
            NativeVoiceRuntime.message("dictation_storage_full"));
        assertNotEquals(NativeVoiceRuntime.message("dictation_storage_full"), NativeVoiceRuntime.message("dictation_storage_capacity"));
    }
    @Test public void successfulFinishingReasonsAreNeutralAndInterruptionsHaveUsefulMessages() throws Exception {
        assertNull(NativeVoiceRuntime.recordingReason(null));
        for (String reason : new String[] { "retry", "send", "automatic" }) assertNull(NativeVoiceRuntime.recordingReason(reason));
        java.util.regex.Pattern reasons = java.util.regex.Pattern.compile("(?:cancelActive|cancelAutomatic|interruptRecording|journal\\.interrupt|journal\\.finish)\\([^;\\n]*?\"([a-z_]+)\"");
        java.util.Set<String> found = new java.util.HashSet<>();
        for (String name : new String[] { "NativeVoiceRuntime", "NativeVoiceRecording" }) {
            java.nio.file.Path source = java.nio.file.Paths.get("src/main/java/dev/sedes/local/" + name + ".java");
            java.util.regex.Matcher matches = reasons.matcher(new String(java.nio.file.Files.readAllBytes(source), java.nio.charset.StandardCharsets.UTF_8));
            while (matches.find()) found.add(matches.group(1));
        }
        found.add("audio_focus_lost");
        assertTrue(found.contains("voice_off")); assertTrue(found.contains("service_stopped")); assertTrue(found.contains("retry"));
        for (String reason : found) {
            if (java.util.Arrays.asList("retry", "send", "automatic").contains(reason)) assertNull(NativeVoiceRuntime.recordingReason(reason));
            else assertSpecific(reason);
        }
        assertSpecific("auto_listen_disabled"); assertSpecific("timeout");
    }
    private static void assertSpecific(String code) {
        String message = NativeVoiceRuntime.message(code);
        assertFalse("Generic message for " + code, message.contains("(" + code + ")"));
        assertFalse(message.isEmpty());
    }
    private static String escape(String value) {
        StringBuilder result = new StringBuilder();
        for (char c : value.toCharArray()) result.append(String.format("\\u%04x", (int) c));
        return result.toString();
    }
}
