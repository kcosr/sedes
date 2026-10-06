package dev.sedes.local;

import static org.junit.Assert.*;
import org.junit.Test;

public class SpeechCredentialBindingTest {
    @Test public void bindingCanonicalizesEndpointAndIncludesExplicitSpeechPurposeAndProvider() {
        String canonical = SpeechCredentialStore.binding("server", "HTTPS://SPEECH.EXAMPLE:443/proxy/v1/");
        assertEquals("speech\nserver\nhttps://speech.example/proxy/v1", canonical);
        assertNotEquals(SpeechCredentialStore.binding("server", NativeVoiceSettings.OPENAI_ENDPOINT),
            SpeechCredentialStore.binding("openai", NativeVoiceSettings.OPENAI_ENDPOINT));
        assertThrows(IllegalArgumentException.class, () -> SpeechCredentialStore.binding("openai", "https://other.example/v1"));
        assertThrows(IllegalArgumentException.class, () -> SpeechCredentialStore.binding("unknown", "https://speech.example/v1"));
    }
    @Test public void secretsRejectHeaderInjectionAndWhitespaceWithoutAccountSpecificKeyPatterns() {
        SpeechCredentialStore.validateCredential("local:arbitrary+token/value=");
        for (String value : new String[] { "", "token\r\nAuthorization: other", "with spaces", "\tleading", "é", "x".repeat(4097) })
            assertThrows(IllegalArgumentException.class, () -> SpeechCredentialStore.validateCredential(value));
    }
}
