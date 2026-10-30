package dev.sedes.local;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class NativeVoiceUploadPreferencesTest {
    @Test public void qualityUsesItsOwnRevisionWithoutResettingExistingVoicePreferences() {
        NativeVoiceUploadPreferences defaults = NativeVoiceUploadPreferences.defaults();
        assertEquals("original", defaults.audioQuality);
        assertEquals(0, defaults.revision);
        NativeVoicePreferences preferences = NativeVoicePreferences.defaults();
        String before = preferences.record().toString();
        for (String quality : new String[] { "original", "opus_high", "opus_low" }) {
            NativeVoiceUploadPreferences chosen = defaults.patch(0, quality);
            NativeVoiceUploadPreferences restored = NativeVoiceUploadPreferences.fromRecord(chosen.record());
            assertEquals(quality, restored.audioQuality); assertEquals(1, restored.revision);
        }
        assertEquals(before, preferences.record().toString());
        assertEquals(9, NativeVoiceSettings.RECORD_VERSION);
        assertFalse(NativeVoiceSettings.defaults().value.has("audioQuality"));
    }

    @Test public void staleWritesAndInvalidRecordsDoNotChangeTheQuality() {
        NativeVoiceUploadPreferences chosen = NativeVoiceUploadPreferences.defaults().patch(0, "opus_low");
        assertEquals("audio_quality_revision_conflict", assertThrows(IllegalStateException.class,
            () -> chosen.patch(0, "original")).getMessage());
        for (String invalid : new String[] { null, "", "opus", "low", " opus_low" })
            assertEquals("speech_audio_quality_invalid", assertThrows(IllegalArgumentException.class,
                () -> chosen.patch(1, invalid)).getMessage());
        for (JSONObject patch : new JSONObject[] { NativeVoiceJson.object("version", 2), NativeVoiceJson.object("revision", -1),
            NativeVoiceJson.object("audioQuality", "unsupported"), NativeVoiceJson.object("unknown", true) }) {
            JSONObject record = chosen.record();
            for (java.util.Iterator<String> keys = patch.keys(); keys.hasNext();) {
                String key = keys.next(); NativeVoiceJson.put(record, key, patch.opt(key));
            }
            assertThrows(IllegalArgumentException.class, () -> NativeVoiceUploadPreferences.fromRecord(record));
        }
        JSONObject missing = chosen.record(); missing.remove("audioQuality");
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceUploadPreferences.fromRecord(missing));
        assertEquals("opus_low", chosen.audioQuality);
    }
}
