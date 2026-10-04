package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class SpeechCredentialStoreTest {
    @Test public void encryptedSpeechSecretsSurviveRecreationAndRemainBoundToProfileProviderEndpointAndPurpose() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String profile = UUID.randomUUID().toString(), other = UUID.randomUUID().toString();
        String endpoint = NativeVoiceSettings.OPENAI_ENDPOINT, token = "speech-test-" + UUID.randomUUID();
        SpeechCredentialStore store = new SpeechCredentialStore(context);
        ClientCredentialStore client = new ClientCredentialStore(context);
        try {
            store.setCredential(profile, "openai", endpoint, token);
            assertEquals(token, new SpeechCredentialStore(context).getCredential(profile, "openai", "HTTPS://API.OPENAI.COM:443/v1/"));
            assertNull(store.getCredential(other, "openai", endpoint));
            assertNull(store.getCredential(profile, "server", endpoint));
            assertNull(store.getCredential(profile, "server", "https://speech.example/v1"));
            client.setCredential(profile, "https://api.openai.com", "sedes-only-0123456789abcdef");
            File[] files = directory(context, profile).listFiles((parent, name) -> name.endsWith(".enc"));
            assertNotNull(files); assertEquals(1, files.length);
            assertFalse(new String(Files.readAllBytes(files[0].toPath()), StandardCharsets.UTF_8).contains(token));
            store.removeProfileCredentials(profile);
            assertNull(store.getCredential(profile, "openai", endpoint));
            assertEquals("sedes-only-0123456789abcdef", client.getCredential(profile, "https://api.openai.com"));
        } finally { store.removeProfileCredentials(profile); store.removeProfileCredentials(other); client.removeProfileCredentials(profile); }
    }
    @Test public void movingCiphertextToAnotherEndpointCannotDecryptAndInterruptedWritesRecover() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String profile = UUID.randomUUID().toString(), endpoint = "https://speech.example/v1";
        SpeechCredentialStore store = new SpeechCredentialStore(context);
        try {
            store.setCredential(profile, "server", endpoint, "private-test-token");
            File original = new File(directory(context, profile), hash(SpeechCredentialStore.binding(profile, "server", endpoint)) + ".enc");
            File backup = new File(original.getPath() + ".bak");
            assertTrue(original.renameTo(backup));
            assertEquals("private-test-token", store.getCredential(profile, "server", endpoint));
            String wrongEndpoint = "https://speech.example/other/v1";
            File moved = new File(directory(context, profile), hash(SpeechCredentialStore.binding(profile, "server", wrongEndpoint)) + ".enc");
            Files.copy(original.toPath(), moved.toPath());
            assertThrows(Exception.class, () -> store.getCredential(profile, "server", wrongEndpoint));
            store.removeCredential(profile, "server", endpoint);
            assertNull(store.getCredential(profile, "server", endpoint));
        } finally { store.removeProfileCredentials(profile); }
    }
    private static File directory(Context context, String profile) throws Exception {
        return new File(new File(context.getNoBackupFilesDir(), "speech-credentials"), hash(profile));
    }
    private static String hash(String text) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
}
