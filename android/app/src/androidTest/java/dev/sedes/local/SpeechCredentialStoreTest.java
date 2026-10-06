package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import android.os.Handler;
import android.system.Os;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
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
    @Test public void storeInitializationRetiresAllObsoleteCiphertextWithoutTouchingCurrentSecrets() throws Exception {
        try (NativeVoiceTestContext context = new NativeVoiceTestContext()) {
            SpeechCredentialStore current = new SpeechCredentialStore(context);
            current.setCredential("server", "https://speech.example/v1", "current-device-secret");
            File retired = new File(context.getNoBackupFilesDir(), "speech-credentials");
            for (String profile : new String[] { "profile-one", "profile-two" }) {
                File directory = new File(retired, hash(profile)); assertTrue(directory.mkdirs());
                for (String suffix : new String[] { ".enc", ".enc.bak", ".enc.new" })
                    Files.write(new File(directory, "obsolete" + suffix).toPath(), new byte[] { 0, 1, 2 });
            }
            // A stale symlink must not make retirement traverse current credential storage.
            Os.symlink(directory(context).getPath(), new File(retired, "stale-link").getPath());
            SpeechCredentialStore reopened = new SpeechCredentialStore(context);
            assertFalse(retired.exists());
            assertEquals("current-device-secret", reopened.getCredential("server", "https://speech.example/v1"));
        }
    }

    @Test public void unconfiguredRuntimeRetiresOldSecretsAtStartupAndReportsFailedRetirement() throws Exception {
        for (boolean blocked : new boolean[] { false, true }) {
            try (NativeVoiceTestContext context = new NativeVoiceTestContext()) {
                File retired = new File(context.getNoBackupFilesDir(), "speech-credentials");
                File profile = new File(retired, hash("old-profile")); assertTrue(profile.mkdirs());
                Files.write(new File(profile, "old.enc").toPath(), new byte[] { 1, 2, 3 });
                int mode = Os.stat(profile.getPath()).st_mode & 0777;
                if (blocked) Os.chmod(profile.getPath(), 0500);
                Constructor<NativeVoiceRuntime> constructor = NativeVoiceRuntime.class.getDeclaredConstructor(Context.class);
                constructor.setAccessible(true); NativeVoiceRuntime runtime = constructor.newInstance(context);
                Field handlerField = NativeVoiceRuntime.class.getDeclaredField("handler"); handlerField.setAccessible(true);
                Handler owner = (Handler) handlerField.get(runtime);
                try {
                    CountDownLatch initialized = new CountDownLatch(1); owner.post(initialized::countDown);
                    assertTrue(initialized.await(10, TimeUnit.SECONDS));
                    assertTrue(runtime.snapshot().isNull("identity"));
                    assertEquals("off", runtime.snapshot().getJSONObject("settings").getString("audioMode"));
                    if (blocked) {
                        assertEquals("speech_credential_cleanup_failed", runtime.snapshot().getJSONArray("errors").getJSONObject(0).getString("code"));
                        assertTrue(new File(profile, "old.enc").exists());
                        IllegalStateException failure = assertThrows(IllegalStateException.class, () -> new SpeechCredentialStore(context));
                        assertEquals("speech_credential_cleanup_failed", failure.getMessage());
                        Os.chmod(profile.getPath(), mode);
                        new SpeechCredentialStore(context); assertFalse(retired.exists());
                    } else { assertFalse(retired.exists()); assertEquals(0, runtime.snapshot().getJSONArray("errors").length()); }
                } finally {
                    if (profile.exists()) Os.chmod(profile.getPath(), mode);
                    owner.getLooper().quitSafely();
                    Field dictationsField = NativeVoiceRuntime.class.getDeclaredField("dictations"); dictationsField.setAccessible(true);
                    ((NativeDictationStore) dictationsField.get(runtime)).close();
                }
            }
        }
    }

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
