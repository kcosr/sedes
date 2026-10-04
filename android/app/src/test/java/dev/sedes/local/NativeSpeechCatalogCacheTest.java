package dev.sedes.local;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class NativeSpeechCatalogCacheTest {
    private static final String OWNER = "profile\nhttps://sedes.example\n" + "a".repeat(64);

    @Test public void roundTripRetainsChoicesWithoutRetainingTheCredential() {
        NativeVoiceSettings settings = NativeVoiceSettings.defaults();
        String scope = NativeSpeechCatalogCache.scope(OWNER, settings, "private-token");
        JSONObject catalog = NativeSpeechCatalog.empty("openai");
        NativeVoiceJson.put(catalog, "voices", new JSONArray().put("coral").put("alloy"));
        NativeSpeechCatalogCache cached = new NativeSpeechCatalogCache(scope, 100, catalog);
        NativeSpeechCatalogCache restored = NativeSpeechCatalogCache.fromRecord(cached.record());
        assertEquals(scope, restored.scope); assertEquals(100, restored.fetchedAt);
        assertEquals(catalog.toString(), restored.catalog.toString());
        assertFalse(cached.record().toString().contains("private-token"));
        catalog.optJSONArray("voices").put("later");
        assertEquals(2, cached.catalog.optJSONArray("voices").length());
    }

    @Test public void freshnessExpiresAfterAnHourAndRejectsClockRollback() {
        NativeSpeechCatalogCache cached = new NativeSpeechCatalogCache("b".repeat(64), 100, NativeSpeechCatalog.empty("server"));
        assertTrue(cached.fresh(100)); assertTrue(cached.fresh(100 + NativeSpeechCatalogCache.FRESH_MS - 1));
        assertFalse(cached.fresh(100 + NativeSpeechCatalogCache.FRESH_MS)); assertFalse(cached.fresh(99));
    }

    @Test public void scopeSeparatesOwnerAccountEndpointAndSynthesisModel() {
        NativeVoiceSettings settings = NativeVoiceSettings.defaults();
        String scope = NativeSpeechCatalogCache.scope(OWNER, settings, "account-a");
        for (String owner : new String[] { OWNER.replace("profile", "other"), OWNER.replace("sedes.example", "other.example"),
            OWNER.substring(0, OWNER.length() - 64) + "b".repeat(64) })
            assertNotEquals(scope, NativeSpeechCatalogCache.scope(owner, settings, "account-a"));
        assertNotEquals(scope, NativeSpeechCatalogCache.scope(OWNER, settings, "account-b"));
        assertNotEquals(scope, NativeSpeechCatalogCache.scope(OWNER, settings, null));
        for (JSONObject patch : new JSONObject[] { NativeVoiceJson.object("ttsModel", "tts-1"),
            NativeVoiceJson.object("speechProvider", "server"),
            NativeVoiceJson.object("speechProvider", "server", "speechEndpoint", "https://speech.example/v1") })
            assertNotEquals(scope, NativeSpeechCatalogCache.scope(OWNER, settings.patch(0, patch), "account-a"));
        for (JSONObject patch : new JSONObject[] { NativeVoiceJson.object("ttsVoice", "alloy"), NativeVoiceJson.object("ttsSpeed", 1.5),
            NativeVoiceJson.object("sttModel", "another-stt"), NativeVoiceJson.object("audioMode", "manual") })
            assertEquals(scope, NativeSpeechCatalogCache.scope(OWNER, settings.patch(0, patch), "account-a"));
    }

    @Test public void malformedRecordsCannotSupplyPickerOptions() {
        JSONObject good = new NativeSpeechCatalogCache("b".repeat(64), 100, NativeSpeechCatalog.empty("server")).record();
        for (JSONObject patch : new JSONObject[] { NativeVoiceJson.object("version", 2), NativeVoiceJson.object("scope", "wrong"),
            NativeVoiceJson.object("fetchedAt", -1), NativeVoiceJson.object("catalog", new JSONObject()) }) {
            JSONObject bad = NativeVoiceJson.copy(good);
            for (java.util.Iterator<String> keys = patch.keys(); keys.hasNext();) { String key = keys.next(); NativeVoiceJson.put(bad, key, patch.opt(key)); }
            assertThrows(IllegalArgumentException.class, () -> NativeSpeechCatalogCache.fromRecord(bad));
        }
        for (Object invalid : new Object[] { 42, "", " voice ", "bad\nvoice" }) {
            JSONObject bad = NativeSpeechCatalog.empty("server"); NativeVoiceJson.put(bad, "voices", new JSONArray().put(invalid));
            assertThrows(IllegalArgumentException.class, () -> new NativeSpeechCatalogCache("b".repeat(64), 100, bad));
        }
    }
}
