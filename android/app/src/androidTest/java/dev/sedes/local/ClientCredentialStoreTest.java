package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
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
    @Test public void credentialsRejectNonOriginUrlsAndHeaderInjection() throws Exception {
        ClientCredentialStore store = new ClientCredentialStore(InstrumentationRegistry.getInstrumentation().getTargetContext());
        assertThrows(IllegalArgumentException.class, () -> store.setCredential("test", "https://user@host", "0123456789abcdef"));
        assertThrows(IllegalArgumentException.class, () -> store.setCredential("test", "https://host/path", "0123456789abcdef"));
        assertThrows(IllegalArgumentException.class, () -> store.setCredential("test", "https://host", "0123456789abcdef\r\nInjected: true"));
    }
}
