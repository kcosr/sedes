package dev.sedes.local;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class NativeVoiceNotificationTargetTest {
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
        return NativeVoiceJson.object("phase", "idle", "active", null,
            "foreground", NativeVoiceJson.object("visible", true, "threadId", "foreground", "threadTitle", "Foreground thread"),
            "settings", NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("pinDefaultVoiceThread", pinned,
                "onlyVoiceThread", filtered, "voiceThreadId", "default", "voiceThreadTitle", "Default thread")).value);
    }
}
