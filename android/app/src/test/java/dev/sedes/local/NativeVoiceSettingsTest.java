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
}
