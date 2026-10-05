package dev.sedes.local;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class NativeVoiceNotificationTargetTest {
    @Test public void chosenNextTargetOwnsIdleNotificationButDoesNotRedirectActiveOrSavedWork() {
        JSONObject state = idle(true, true);
        NativeVoiceJson.put(state, "nextRecordingTarget", NativeVoiceJson.object("threadId", "next", "threadTitle", "Chosen next"));
        assertEquals("next", NativeVoiceRuntimeService.notificationTarget(state).optString("threadId"));
        assertEquals("Chosen next", NativeVoiceRuntimeService.notificationTarget(state).optString("threadTitle"));
        NativeVoiceJson.put(state, "active", NativeVoiceJson.object("threadId", "notice", "threadTitle", "Notice thread"));
        NativeVoiceJson.put(state, "phase", "speaking");
        assertEquals("notice", NativeVoiceRuntimeService.notificationTarget(state).optString("threadId"));
        NativeVoiceJson.put(state, "active", null); NativeVoiceJson.put(state, "phase", "recordingRecovery");
        NativeVoiceJson.put(state, "recordingRecovery", NativeVoiceJson.object("threadId", "saved", "threadTitle", "Saved thread"));
        assertEquals("saved", NativeVoiceRuntimeService.notificationTarget(state).optString("threadId"));
        assertEquals("next", state.optJSONObject("nextRecordingTarget").optString("threadId"));
    }
    @Test public void aBlockingSavedRecordingUsesItsOwnTargetWithoutHoldingTheWakeLock() {
        JSONObject state = idle(false, false);
        NativeVoiceJson.put(state, "phase", "recordingRecovery");
        NativeVoiceJson.put(state, "recordingRecovery", NativeVoiceJson.object("threadId", "saved", "threadTitle", "Saved thread"));
        assertEquals("saved", NativeVoiceRuntimeService.notificationTarget(state).optString("threadId"));
        assertFalse(NativeVoiceRuntimeService.wakeLockNeeded(state));
        NativeVoiceJson.put(state, "phase", "idle");
        assertEquals("foreground", NativeVoiceRuntimeService.notificationTarget(state).optString("threadId"));
        NativeVoiceJson.put(state, "active", NativeVoiceJson.object("recognitionThreadId", "new", "recognitionThreadTitle", "New thread"));
        NativeVoiceJson.put(state, "phase", "listening");
        assertEquals("new", NativeVoiceRuntimeService.notificationTarget(state).optString("threadId"));
        assertTrue(NativeVoiceRuntimeService.wakeLockNeeded(state));
        NativeVoiceJson.put(state, "phase", "recognizing");
        assertTrue(NativeVoiceRuntimeService.wakeLockNeeded(state));
    }
    @Test public void anUnavailableSavedTargetDoesNotOpenTheForegroundOrAPhantomThread() {
        JSONObject state = idle(false, false);
        NativeVoiceJson.put(state, "phase", "recordingRecovery");
        NativeVoiceJson.put(state, "recordingRecovery", NativeVoiceJson.object("threadId", null, "threadTitle", null));
        JSONObject target = NativeVoiceRuntimeService.notificationTarget(state);
        assertTrue(target.isNull("threadId")); assertTrue(target.isNull("threadTitle"));
    }

    @Test public void idleNotificationUsesPinnedDefaultInsteadOfTheForegroundThread() {
        for (boolean filtered : new boolean[] { false, true }) {
            JSONObject state = idle(true, filtered);
            JSONObject target = NativeVoiceRuntimeService.notificationTarget(state);
            assertEquals("default", target.optString("threadId")); assertEquals("Default thread", target.optString("threadTitle"));
            NativeVoiceJson.put(state.optJSONObject("foreground"), "visible", false);
            assertEquals(target.toString(), NativeVoiceRuntimeService.notificationTarget(state).toString());
        }
    }

    @Test public void unpinnedIdleNotificationPrefersForegroundAndFallsBackToDefault() {
        JSONObject state = idle(false, false);
        assertEquals("foreground", NativeVoiceRuntimeService.notificationTarget(state).optString("threadId"));
        NativeVoiceJson.put(state.optJSONObject("foreground"), "visible", false);
        assertEquals("default", NativeVoiceRuntimeService.notificationTarget(state).optString("threadId"));
    }

    @Test public void aMissingPinnedDefaultCannotOpenOrStartTheForegroundThread() {
        JSONObject state = idle(true, false);
        NativeVoiceJson.put(state.optJSONObject("settings"), "voiceThreadId", null);
        JSONObject target = NativeVoiceRuntimeService.notificationTarget(state);
        assertTrue(target.isNull("threadId")); assertTrue(target.isNull("threadTitle"));
    }

    @Test public void activePlaybackAndRecordingAlwaysKeepTheirActualTargets() {
        JSONObject state = idle(true, true);
        NativeVoiceJson.put(state, "active", NativeVoiceJson.object("threadId", "notice", "threadTitle", "Notice thread",
            "recognitionThreadId", "recording", "recognitionThreadTitle", "Recording thread"));
        for (String phase : new String[] { "synthesizing", "speaking" }) {
            NativeVoiceJson.put(state, "phase", phase);
            assertEquals("notice", NativeVoiceRuntimeService.notificationTarget(state).optString("threadId"));
            assertEquals("Notice thread", NativeVoiceRuntimeService.notificationTarget(state).optString("threadTitle"));
        }
        for (String phase : new String[] { "validating", "arming", "listening", "recognizing", "submitting", "recovering" }) {
            NativeVoiceJson.put(state, "phase", phase);
            assertEquals("recording", NativeVoiceRuntimeService.notificationTarget(state).optString("threadId"));
            assertEquals("Recording thread", NativeVoiceRuntimeService.notificationTarget(state).optString("threadTitle"));
        }
    }

    private static JSONObject idle(boolean pinned, boolean filtered) {
        return NativeVoiceJson.object("phase", "idle", "active", null, "nextRecordingTarget", null,
            "foreground", NativeVoiceJson.object("visible", true, "threadId", "foreground", "threadTitle", "Foreground thread"),
            "settings", NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("pinDefaultVoiceThread", pinned,
                "onlyVoiceThread", filtered, "voiceThreadId", "default", "voiceThreadTitle", "Default thread")).value);
    }
}
