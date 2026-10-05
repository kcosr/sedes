package dev.sedes.local;

import static org.junit.Assert.*;
import org.junit.Test;

public class NativeVoiceSettingsTest {
    private static final String BINDING = NativeVoiceStore.binding("test", "https://sedes.example", "a".repeat(64));
    private static org.json.JSONObject record(NativeVoiceSettings settings) {
        return NativeVoicePreferences.defaults().update(BINDING, settings).record();
    }
    private static NativeVoiceSettings restore(org.json.JSONObject record) {
        return NativeVoicePreferences.fromRecord(record).settings(BINDING);
    }
    @Test public void longDictationTimeoutIsAWholeMinuteSettingWithNoOldRecordFallback() {
        NativeVoiceSettings defaults = NativeVoiceSettings.defaults();
        assertEquals(3600000, defaults.number("longDictationTimeoutMs"));
        assertEquals(6, NativeVoiceSettings.RECORD_VERSION);
        for (int duration : new int[] { 60000, 3600000, 86400000 }) {
            NativeVoiceSettings configured = defaults.patch(0, NativeVoiceJson.object("longDictationTimeoutMs", duration));
            assertEquals(duration, restore(record(configured)).number("longDictationTimeoutMs"));
        }
        for (Object invalid : new Object[] { 0, 59999, 60001, 86460000, 60000.5, "3600000" })
            assertThrows(IllegalArgumentException.class, () -> defaults.patch(0, NativeVoiceJson.object("longDictationTimeoutMs", invalid)));
        org.json.JSONObject old = record(defaults); NativeVoiceJson.put(old, "settingsVersion", 5);
        assertThrows(IllegalArgumentException.class, () -> restore(old));
        org.json.JSONObject missing = record(defaults); missing.optJSONObject("preferences").remove("longDictationTimeoutMs");
        assertThrows(IllegalArgumentException.class, () -> restore(missing));
    }
    @Test public void keepListeningDefaultIsFalseAndStrictlyPersisted() {
        NativeVoiceSettings defaults = NativeVoiceSettings.defaults();
        assertFalse(defaults.flag("keepListeningByDefault"));
        NativeVoiceSettings held = defaults.patch(0, NativeVoiceJson.object("keepListeningByDefault", true));
        assertTrue(restore(record(held)).flag("keepListeningByDefault"));
        assertTrue(defaults.speechConfigurationEquals(held));
        for (Object invalid : new Object[] { "true", 1, org.json.JSONObject.NULL })
            assertThrows(IllegalArgumentException.class, () -> defaults.patch(0, NativeVoiceJson.object("keepListeningByDefault", invalid)));
        org.json.JSONObject missing = record(held); missing.optJSONObject("preferences").remove("keepListeningByDefault");
        assertThrows(IllegalArgumentException.class, () -> restore(missing));
    }
    @Test public void speechCleanupDefaultsOnAndPersistsAsAStrictBoolean() {
        NativeVoiceSettings defaults = NativeVoiceSettings.defaults();
        assertTrue(defaults.flag("cleanSpeechText"));
        NativeVoiceSettings raw = defaults.patch(0, NativeVoiceJson.object("cleanSpeechText", false));
        assertFalse(restore(record(raw)).flag("cleanSpeechText"));
        assertTrue(defaults.speechConfigurationEquals(raw));
        assertThrows(IllegalArgumentException.class, () -> defaults.patch(0, NativeVoiceJson.object("cleanSpeechText", "false")));
        org.json.JSONObject missing = record(defaults); missing.optJSONObject("preferences").remove("cleanSpeechText");
        assertThrows(IllegalArgumentException.class, () -> restore(missing));
        NativeVoiceJson.put(missing, "version", 3);
        assertThrows(IllegalArgumentException.class, () -> restore(missing));
    }
    @Test public void startsOffAndPatchesByRevision() {
        NativeVoiceSettings defaults = NativeVoiceSettings.defaults();
        assertEquals("off", defaults.mode()); assertEquals(4096, defaults.number("speechTextLimit"));
        assertFalse(defaults.flag("pinDefaultVoiceThread"));
        NativeVoiceSettings next = defaults.patch(0, NativeVoiceJson.object("audioMode", "response", "speechProvider", "server", "speechEndpoint", "https://EXAMPLE.com:443/"));
        assertEquals(1, next.revision); assertEquals("https://example.com", next.text("speechEndpoint"));
        assertThrows(IllegalStateException.class, () -> next.patch(0, NativeVoiceJson.object("autoListen", false)));
        NativeVoiceSettings restored = restore(record(next));
        for (String field : NativeVoiceSettings.FIELDS) assertEquals(field, next.value.opt(field), restored.value.opt(field));
    }
    @Test public void storedRecordsValidateStrictlyAgainstTheirExplicitSchemaVersion() {
        org.json.JSONObject record = record(NativeVoiceSettings.defaults());
        assertEquals(NativeVoiceSettings.RECORD_VERSION, record.optInt("settingsVersion"));
        org.json.JSONObject older = NativeVoiceJson.copy(record); NativeVoiceJson.put(older, "version", 2);
        older.optJSONObject("preferences").remove("pinDefaultVoiceThread");
        assertThrows(IllegalArgumentException.class, () -> restore(older));
        org.json.JSONObject newer = NativeVoiceJson.copy(record); NativeVoiceJson.put(newer, "settingsVersion", NativeVoiceSettings.RECORD_VERSION + 1);
        assertThrows(IllegalArgumentException.class, () -> restore(newer));
        org.json.JSONObject missing = NativeVoiceJson.copy(record); missing.optJSONObject("preferences").remove("recognitionResultTimeoutMs");
        assertThrows(IllegalArgumentException.class, () -> restore(missing));
        org.json.JSONObject extra = NativeVoiceJson.copy(record); NativeVoiceJson.put(extra.optJSONObject("preferences"), "removedField", true);
        assertThrows(IllegalArgumentException.class, () -> restore(extra));
    }
    @Test public void rejectsUnknownFieldsAndWrongScalarTypes() {
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("enabled", true)));
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("autoListen", "true")));
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("cueGain", 1.5)));
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("pinDefaultVoiceThread", "true")));
    }
    @Test public void pinningTheDefaultPersistsSeparatelyFromAutomaticPlaybackFiltering() {
        NativeVoiceSettings pinned = NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("pinDefaultVoiceThread", true));
        NativeVoiceSettings restored = restore(record(pinned));
        assertTrue(restored.flag("pinDefaultVoiceThread")); assertFalse(restored.flag("onlyVoiceThread"));
        assertTrue(restored.patch(1, NativeVoiceJson.object("onlyVoiceThread", true)).flag("pinDefaultVoiceThread"));
        org.json.JSONObject missing = record(restored); missing.optJSONObject("preferences").remove("pinDefaultVoiceThread");
        assertThrows(IllegalArgumentException.class, () -> restore(missing));
    }
    @Test public void originsCannotCarryCredentialsOrArbitraryPaths() {
        for (String value : new String[] { "https://user:pass@example.com", "https://example.com/api", "https://example.com?token=x", "https://example.com/#x", "ftp://example.com" })
            assertThrows(IllegalArgumentException.class, () -> NativeVoiceSettings.origin(value));
        assertEquals("http://[::1]:4784", NativeVoiceSettings.origin("http://[::1]:4784/"));
    }
    @Test public void speechEndpointsPreserveProxyPathsThroughSettingsAndPersistence() {
        String[][] urls = {
            { "https://assistant/speech/v1", "https://assistant/speech/v1" },
            { "HTTPS://ASSISTANT:443/speech/v1///", "https://assistant/speech/v1" },
            { "http://[::1]:8080/Voice/adapter%20service/", "http://[::1]:8080/Voice/adapter%20service" },
            { "http://EXAMPLE.com:80/", "http://example.com" },
        };
        for (String[] url : urls) {
            NativeVoiceSettings settings = NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("speechProvider", "server", "speechEndpoint", url[0]));
            assertEquals(url[1], settings.text("speechEndpoint"));
            assertEquals(url[1], restore(record(settings)).text("speechEndpoint"));
            assertEquals(url[1], NativeVoiceSettings.speechBaseUrl(settings.text("speechEndpoint")));
        }
    }
    @Test public void speechEndpointsRejectCredentialsQueriesFragmentsAndInvalidHttpUrls() {
        for (String url : new String[] { "https://user:pass@assistant/adapter", "https://assistant/adapter?token=x",
            "https://assistant/adapter#x", "wss://assistant/adapter", "ftp://assistant/adapter", "/adapter",
            "https:///adapter", "https://assistant:65536/adapter", "https://assistant/bad path" }) {
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("speechProvider", "server", "speechEndpoint", url)));
            assertEquals("invalid_speechEndpoint", error.getMessage());
        }
    }
    @Test public void separatesProviderPresetAndCredentialReadinessWithoutConstrainingAccountModelIds() {
        NativeVoiceSettings settings = NativeVoiceSettings.defaults();
        assertEquals("openai", settings.text("speechProvider"));
        assertEquals("gpt-live-transcribe", settings.text("sttModel"));
        assertFalse(settings.configured(false)); assertTrue(settings.configured(true));
        assertThrows(IllegalArgumentException.class, () -> settings.patch(0, NativeVoiceJson.object("speechEndpoint", "https://proxy.test/v1")));
        NativeVoiceSettings custom = settings.patch(0, NativeVoiceJson.object("speechProvider", "server", "speechEndpoint", "https://speech.test/v1",
            "sttModel", "my-recognition-model", "ttsModel", "my-speech-model", "ttsVoice", "my-voice", "ttsSpeed", 1.25));
        assertFalse(custom.configured(false)); assertTrue(custom.configured(true)); assertEquals(1.25, custom.decimal("ttsSpeed"), 0.001);
        assertFalse(custom.patch(1, NativeVoiceJson.object("sttModel", "")).configured(true));
        assertFalse(custom.patch(1, NativeVoiceJson.object("speechEndpoint", "")).configured(true));
        assertThrows(IllegalArgumentException.class, () -> settings.patch(0, NativeVoiceJson.object("sttModel", "bad\nmodel\nid")));
        assertThrows(IllegalArgumentException.class, () -> settings.patch(0, NativeVoiceJson.object("ttsSpeed", 0.24)));
        assertThrows(IllegalArgumentException.class, () -> settings.patch(0, NativeVoiceJson.object("ttsSpeed", 4.01)));
        assertThrows(IllegalArgumentException.class, () -> settings.patch(0, NativeVoiceJson.object("speechTextLimit", 4097)));
        assertThrows(IllegalArgumentException.class, () -> settings.patch(0, NativeVoiceJson.object("recognitionResultTimeoutMs", 999)));
    }
    @Test public void oldAdapterContractIsRejectedInsteadOfAcceptedAsAnAlias() {
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("adapterUrl", "https://old.test")));
        org.json.JSONObject record = record(NativeVoiceSettings.defaults()); NativeVoiceJson.put(record, "settingsVersion", 1);
        assertThrows(IllegalArgumentException.class, () -> restore(record));
    }

}
