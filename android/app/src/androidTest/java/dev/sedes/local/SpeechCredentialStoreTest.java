package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
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
    @Test public void encryptedSpeechSecretsSurviveRestartAndSedesProfileDeletionButRemainProviderEndpointAndPurposeBound() throws Exception {
        NativeVoiceTestContext context = new NativeVoiceTestContext();
        String profile = UUID.randomUUID().toString();
        String endpoint = NativeVoiceSettings.OPENAI_ENDPOINT, token = "speech-test-" + UUID.randomUUID();
        SpeechCredentialStore store = new SpeechCredentialStore(context);
        ClientCredentialStore client = new ClientCredentialStore(context);
        try {
            store.setCredential("openai", endpoint, token);
            assertEquals(token, new SpeechCredentialStore(context).getCredential("openai", "HTTPS://API.OPENAI.COM:443/v1/"));
            assertNull(store.getCredential("server", endpoint));
            assertNull(store.getCredential("server", "https://speech.example/v1"));
            client.setCredential(profile, "https://api.openai.com", "sedes-only-0123456789abcdef");
            File[] files = directory(context).listFiles((parent, name) -> name.endsWith(".enc"));
            assertNotNull(files); assertEquals(1, files.length);
            assertFalse(new String(Files.readAllBytes(files[0].toPath()), StandardCharsets.UTF_8).contains(token));
            ClientCredentialsPlugin.removeProfileCredentials(context, profile, new NativeVoiceStore(context)::removeProfile);
            assertEquals(token, store.getCredential("openai", endpoint));
            assertNull(client.getCredential(profile, "https://api.openai.com"));
            store.removeCredential("openai", endpoint);
            assertNull(store.getCredential("openai", endpoint));
        } finally { context.close(); }
    }
    @Test public void movingCiphertextToAnotherEndpointCannotDecryptAndInterruptedWritesRecover() throws Exception {
        NativeVoiceTestContext context = new NativeVoiceTestContext();
        String endpoint = "https://speech.example/v1";
        SpeechCredentialStore store = new SpeechCredentialStore(context);
        try {
            store.setCredential("server", endpoint, "private-test-token");
            File original = new File(directory(context), hash(SpeechCredentialStore.binding("server", endpoint)) + ".enc");
            File backup = new File(original.getPath() + ".bak");
            assertTrue(original.renameTo(backup));
            assertEquals("private-test-token", store.getCredential("server", endpoint));
            String wrongEndpoint = "https://speech.example/other/v1";
            File moved = new File(directory(context), hash(SpeechCredentialStore.binding("server", wrongEndpoint)) + ".enc");
            Files.copy(original.toPath(), moved.toPath());
            assertThrows(Exception.class, () -> store.getCredential("server", wrongEndpoint));
            store.removeCredential("server", endpoint);
            assertNull(store.getCredential("server", endpoint));
        } finally { context.close(); }
    }
    private static File directory(Context context) {
        return new File(context.getNoBackupFilesDir(), "device-speech-credentials");
    }
    private static String hash(String text) throws Exception {
        byte[] bytes = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
}
