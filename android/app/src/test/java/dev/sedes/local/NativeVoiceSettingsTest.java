package dev.sedes.local;

import static org.junit.Assert.*;
import org.junit.Test;

public class NativeVoiceSettingsTest {
    @Test public void startsOffAndPatchesByRevision() {
        NativeVoiceSettings defaults = NativeVoiceSettings.defaults();
        assertEquals("off", defaults.mode()); assertEquals(5000, defaults.number("adapterTextLimit"));
        NativeVoiceSettings next = defaults.patch(0, NativeVoiceJson.object("audioMode", "response", "adapterUrl", "https://EXAMPLE.com:443/"));
        assertEquals(1, next.revision); assertEquals("https://example.com", next.text("adapterUrl"));
        assertThrows(IllegalStateException.class, () -> next.patch(0, NativeVoiceJson.object("autoListen", false)));
        assertEquals(next.value.toString(), NativeVoiceSettings.fromRecord(next.record()).value.toString());
    }
    @Test public void rejectsUnknownFieldsAndWrongScalarTypes() {
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("enabled", true)));
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("autoListen", "true")));
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("cueGain", 1.5)));
    }
    @Test public void originsCannotCarryCredentialsOrArbitraryPaths() {
        for (String value : new String[] { "https://user:pass@example.com", "https://example.com/api", "https://example.com?token=x", "https://example.com/#x", "ftp://example.com" })
            assertThrows(IllegalArgumentException.class, () -> NativeVoiceSettings.origin(value));
        assertEquals("http://[::1]:4784", NativeVoiceSettings.origin("http://[::1]:4784/"));
    }
    @Test public void adapterUrlsPreserveProxyPathsThroughSettingsAndPersistence() {
        String[][] urls = {
            { "https://assistant/agent-voice-adapter", "https://assistant/agent-voice-adapter" },
            { "HTTPS://ASSISTANT:443/agent-voice-adapter///", "https://assistant/agent-voice-adapter" },
            { "http://[::1]:8080/Voice/adapter%20service/", "http://[::1]:8080/Voice/adapter%20service" },
            { "http://EXAMPLE.com:80/", "http://example.com" },
        };
        for (String[] url : urls) {
            NativeVoiceSettings settings = NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("adapterUrl", url[0]));
            assertEquals(url[1], settings.text("adapterUrl"));
            assertEquals(url[1], NativeVoiceSettings.fromRecord(settings.record()).text("adapterUrl"));
            assertEquals(url[1], NativeVoiceSettings.adapterBaseUrl(settings.text("adapterUrl")));
        }
    }
    @Test public void adapterUrlsRejectCredentialsQueriesFragmentsAndInvalidHttpUrls() {
        for (String url : new String[] { "https://user:pass@assistant/adapter", "https://assistant/adapter?token=x",
            "https://assistant/adapter#x", "wss://assistant/adapter", "ftp://assistant/adapter", "/adapter",
            "https:///adapter", "https://assistant:65536/adapter", "https://assistant/bad path" }) {
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("adapterUrl", url)));
            assertEquals("invalid_adapterUrl", error.getMessage());
        }
    }
}
