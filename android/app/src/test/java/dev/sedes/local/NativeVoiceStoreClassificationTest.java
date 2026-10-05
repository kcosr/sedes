package dev.sedes.local;

import static org.junit.Assert.*;
import java.security.InvalidKeyException;
import java.security.KeyStoreException;
import java.security.ProviderException;
import javax.crypto.AEADBadTagException;
import javax.crypto.BadPaddingException;
import javax.crypto.IllegalBlockSizeException;
import org.junit.Test;
import org.json.JSONObject;

/** Only proof of unusable ciphertext may quarantine a record; transient keystore failures must keep it. */
public class NativeVoiceStoreClassificationTest {
    @Test public void recordingOwnershipUsesAnExplicitNonNullDiscriminator() {
        JSONObject ordinary = NativeVoiceJson.object("mutationId", "mutation", "threadId", "thread",
            "request", NativeVoiceJson.object("mutationId", "mutation", "text", "words"),
            "stage", "prepared", "cancelled", false, "createdAt", 0);
        NativeVoiceStore.validateEntry(ordinary);
        JSONObject adopted = NativeVoiceJson.copy(ordinary); NativeVoiceJson.put(adopted, "recordingId", "recording");
        NativeVoiceStore.validateEntry(adopted);
        for (Object owner : new Object[] { JSONObject.NULL, "", ".", "..", "../another-recording", "recording/other", 3 }) {
            JSONObject invalid = NativeVoiceJson.copy(ordinary); NativeVoiceJson.put(invalid, "recordingId", owner);
            assertThrows(IllegalArgumentException.class, () -> NativeVoiceStore.validateEntry(invalid));
        }
    }

    @Test public void onlyAFailedAuthenticationTagIsCorruption() {
        assertTrue(NativeVoiceStore.corruption(new AEADBadTagException("tag mismatch")));
        for (Throwable transientFailure : new Throwable[] { new InvalidKeyException("keystore busy"), new IllegalBlockSizeException("keystore operation failed"),
            new ProviderException("keystore daemon"), new KeyStoreException("unavailable"), new BadPaddingException("other") })
            assertFalse(transientFailure.getClass().getSimpleName(), NativeVoiceStore.corruption(transientFailure));
    }
}
