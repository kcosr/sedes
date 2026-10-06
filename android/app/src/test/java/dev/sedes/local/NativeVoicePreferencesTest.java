package dev.sedes.local;

import static org.junit.Assert.*;
import org.json.JSONObject;
import org.junit.Test;

public class NativeVoicePreferencesTest {
    private static final String A = NativeVoiceStore.binding("phone", "https://a.example", "a".repeat(64));
    private static final String B = NativeVoiceStore.binding("phone", "https://b.example", "a".repeat(64));
    private static final String ACCOUNT = NativeVoiceStore.binding("phone", "https://a.example", "b".repeat(64));
    private static final String PROFILE = NativeVoiceStore.binding("other-phone", "https://a.example", "a".repeat(64));

    @Test public void ordinaryPreferencesFollowDeviceWhileThreadsBelongToTheExactConnectionAfterRestart() throws Exception {
        NativeVoicePreferences prefs = NativeVoicePreferences.defaults();
        prefs = prefs.update(A, prefs.settings(A).patch(0, NativeVoiceJson.object("audioMode", "response", "autoListen", false,
            "speechProvider", "server", "speechEndpoint", "https://speech.example/v1", "sttModel", "local-stt",
            "ttsModel", "local-tts", "ttsVoice", "local-voice", "voiceThreadId", "thread-a", "voiceThreadTitle", "Private A",
            "inputDevice", NativeVoiceJson.object("type", 7, "address", "AA:BB:CC:DD:EE:FF", "name", "Headset"),
            "recognitionCues", false, "longDictationTimeoutMs", 120000, "pinDefaultVoiceThread", true, "onlyVoiceThread", true)));
        for (String other : new String[] { B, ACCOUNT, PROFILE }) {
            NativeVoiceSettings settings = prefs.settings(other);
            assertEquals("response", settings.mode()); assertFalse(settings.flag("autoListen"));
            assertEquals("https://speech.example/v1", settings.text("speechEndpoint"));
            assertEquals("local-stt", settings.text("sttModel")); assertEquals("local-tts", settings.text("ttsModel"));
            assertEquals("local-voice", settings.text("ttsVoice"));
            assertEquals(new NativeVoiceInput(7, "AA:BB:CC:DD:EE:FF", "Headset"), NativeVoiceInput.read(settings.value));
            assertFalse(settings.flag("recognitionCues")); assertEquals(120000, settings.number("longDictationTimeoutMs"));
            assertTrue(settings.flag("pinDefaultVoiceThread")); assertTrue(settings.flag("onlyVoiceThread")); assertNull(settings.text("voiceThreadId")); assertNull(settings.text("voiceThreadTitle"));
        }
        prefs = prefs.update(B, prefs.settings(B).patch(1, NativeVoiceJson.object("ttsVoice", "updated-voice", "voiceThreadId", "thread-b", "voiceThreadTitle", "Private B")));
        NativeVoicePreferences restarted = NativeVoicePreferences.fromRecord(new JSONObject(prefs.record().toString()));
        assertEquals("updated-voice", restarted.settings(A).text("ttsVoice"));
        assertEquals("thread-a", restarted.settings(A).text("voiceThreadId"));
        assertEquals("Private A", restarted.settings(A).text("voiceThreadTitle"));
        assertEquals("thread-b", restarted.settings(B).text("voiceThreadId"));
        assertEquals(2, restarted.settings(A).revision);
        assertThrows(IllegalStateException.class, () -> restarted.settings(A).patch(1, NativeVoiceJson.object("audioMode", "off")));
        assertNull(restarted.settings(ACCOUNT).text("voiceThreadId"));
        assertFalse(restarted.record().getJSONObject("preferences").has("voiceThreadId"));
    }

    @Test public void removingAProfileClearsAllItsSelectionsWithoutRemovingDevicePreferencesOrOtherProfiles() {
        NativeVoicePreferences prefs = NativeVoicePreferences.defaults();
        for (String binding : new String[] { A, B, ACCOUNT, PROFILE }) {
            NativeVoiceSettings settings = prefs.settings(binding);
            prefs = prefs.update(binding, settings.patch(settings.revision, NativeVoiceJson.object("voiceThreadId", binding,
                "voiceThreadTitle", "Scoped title", "autoListen", false)));
        }
        NativeVoicePreferences removed = NativeVoicePreferences.fromRecord(prefs.removeProfile("phone").record());
        for (String binding : new String[] { A, B, ACCOUNT }) {
            assertNull(removed.settings(binding).text("voiceThreadId")); assertNull(removed.settings(binding).text("voiceThreadTitle"));
            assertFalse(removed.settings(binding).flag("autoListen"));
        }
        assertEquals(PROFILE, removed.settings(PROFILE).text("voiceThreadId"));
        assertEquals(prefs.settings(PROFILE).revision, removed.settings(PROFILE).revision);
    }

    @Test public void recordsRejectWrongScopesMissingFieldsAndObsoleteShapesWithoutFallback() throws Exception {
        JSONObject old = NativeVoiceJson.object("version", NativeVoiceSettings.RECORD_VERSION, "revision", 1,
            "settings", NativeVoiceSettings.defaults().value);
        assertThrows(IllegalArgumentException.class, () -> NativeVoicePreferences.fromRecord(old));
        JSONObject globalThread = NativeVoicePreferences.defaults().record();
        NativeVoiceJson.put(globalThread.getJSONObject("preferences"), "voiceThreadId", "foreign-thread");
        assertThrows(IllegalArgumentException.class, () -> NativeVoicePreferences.fromRecord(globalThread));
        for (String binding : new String[] { "phone", "phone\nhttps://a.example\nunknown", "phone\nhttps://a.example/\n" + "a".repeat(64) }) {
            JSONObject invalid = NativeVoicePreferences.defaults().record();
            NativeVoiceJson.put(invalid.getJSONObject("threads"), binding, NativeVoiceJson.object("voiceThreadId", "thread", "voiceThreadTitle", null));
            assertThrows(IllegalArgumentException.class, () -> NativeVoicePreferences.fromRecord(invalid));
        }
        JSONObject missing = NativeVoicePreferences.defaults().record();
        NativeVoiceJson.put(missing.getJSONObject("threads"), A, NativeVoiceJson.object("voiceThreadId", "thread"));
        assertThrows(IllegalArgumentException.class, () -> NativeVoicePreferences.fromRecord(missing));
        JSONObject mixed = NativeVoicePreferences.defaults().record();
        NativeVoiceJson.put(mixed.getJSONObject("threads"), A, NativeVoiceJson.object("voiceThreadId", null, "voiceThreadTitle", null, "autoListen", true));
        assertThrows(IllegalArgumentException.class, () -> NativeVoicePreferences.fromRecord(mixed));
    }
}
