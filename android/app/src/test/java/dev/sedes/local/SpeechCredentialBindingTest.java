package dev.sedes.local;

import static org.junit.Assert.*;
import org.junit.Test;

public class SpeechCredentialBindingTest {
    @Test public void bindingCanonicalizesEndpointAndIncludesExplicitSpeechPurposeAndProvider() {
        String canonical = SpeechCredentialStore.binding("profile", "server", "HTTPS://SPEECH.EXAMPLE:443/proxy/v1/");
        assertEquals("profile\nspeech\nserver\nhttps://speech.example/proxy/v1", canonical);
        assertNotEquals(canonical, SpeechCredentialStore.binding("other", "server", "https://speech.example/proxy/v1"));
        assertNotEquals(SpeechCredentialStore.binding("profile", "server", NativeVoiceSettings.OPENAI_ENDPOINT),
            SpeechCredentialStore.binding("profile", "openai", NativeVoiceSettings.OPENAI_ENDPOINT));
        assertThrows(IllegalArgumentException.class, () -> SpeechCredentialStore.binding("profile", "openai", "https://other.example/v1"));
        assertThrows(IllegalArgumentException.class, () -> SpeechCredentialStore.binding("profile\nother", "server", "https://speech.example/v1"));
    }
    @Test public void secretsRejectHeaderInjectionAndWhitespaceWithoutAccountSpecificKeyPatterns() {
        SpeechCredentialStore.validateCredential("local:arbitrary+token/value=");
        for (String value : new String[] { "", "token\r\nAuthorization: other", "with spaces", "\tleading", "é", "x".repeat(4097) })
            assertThrows(IllegalArgumentException.class, () -> SpeechCredentialStore.validateCredential(value));
    }
}
