package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.UUID;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ClientCredentialStoreTest {
    @Test public void credentialsSurviveStoreRecreationAndStayBoundToProfileAndOrigin() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String profileId = UUID.randomUUID().toString();
        String origin = "https://server.example";
        String credential = "sedes_test_0123456789abcdef";
        ClientCredentialStore store = new ClientCredentialStore(context);
        try {
            store.setCredential(profileId, origin, credential);
            assertEquals(credential, new ClientCredentialStore(context).getCredential(profileId, origin));
            assertEquals(credential, store.getCredential(profileId, origin + ":443/"));
            assertNull(store.getCredential(profileId, "https://other.example"));
            assertNull(store.getCredential(UUID.randomUUID().toString(), origin));
            store.removeCredential(profileId, origin);
            assertNull(store.getCredential(profileId, origin));
        } finally { store.removeCredential(profileId, origin); }
    }
    @Test public void interruptedWriteRestoresTheBackupInsteadOfLosingTheCredential() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String profileId = UUID.randomUUID().toString();
        String origin = "https://server.example";
        String credential = "restored-" + UUID.randomUUID().toString().replace("-", "");
        ClientCredentialStore store = new ClientCredentialStore(context);
        try {
            store.setCredential(profileId, origin, credential);
            File[] records = profileDirectory(context, profileId).listFiles((directory, name) -> name.endsWith(".enc"));
            assertNotNull(records); assertEquals(1, records.length);
            // AtomicFile keeps the previous record as a backup while a write is in progress.
            File base = records[0], backup = new File(base.getPath() + ".bak");
            assertTrue(base.renameTo(backup)); assertFalse(base.exists());
            assertEquals(credential, new ClientCredentialStore(context).getCredential(profileId, origin));
            assertEquals(credential, store.getCredential(profileId, origin));
        } finally { store.removeProfileCredentials(profileId); }
    }
    /** The store's private layout: credentials/sha256(profile)/sha256(binding).enc. */
    private static File profileDirectory(Context context, String profileId) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(profileId.getBytes(StandardCharsets.UTF_8));
        StringBuilder name = new StringBuilder();
        for (byte value : hash) name.append(String.format(Locale.ROOT, "%02x", value & 255));
        return new File(new File(context.getNoBackupFilesDir(), "credentials"), name.toString());
    }
    @Test public void credentialsRejectNonOriginUrlsAndHeaderInjection() throws Exception {
        ClientCredentialStore store = new ClientCredentialStore(InstrumentationRegistry.getInstrumentation().getTargetContext());
        assertThrows(IllegalArgumentException.class, () -> store.setCredential("test", "https://user@host", "0123456789abcdef"));
        assertThrows(IllegalArgumentException.class, () -> store.setCredential("test", "https://host/path", "0123456789abcdef"));
        assertThrows(IllegalArgumentException.class, () -> store.setCredential("test", "https://host", "0123456789abcdef\r\nInjected: true"));
    }
}
