package dev.sedes.local;

import static org.junit.Assert.*;
import java.security.InvalidKeyException;
import java.security.KeyStoreException;
import java.security.ProviderException;
import javax.crypto.AEADBadTagException;
import javax.crypto.BadPaddingException;
import javax.crypto.IllegalBlockSizeException;
import org.junit.Test;

/** Only proof of unusable ciphertext may quarantine a record; transient keystore failures must keep it. */
public class NativeVoiceStoreClassificationTest {
    @Test public void onlyAFailedAuthenticationTagIsCorruption() {
        assertTrue(NativeVoiceStore.corruption(new AEADBadTagException("tag mismatch")));
        for (Throwable transientFailure : new Throwable[] { new InvalidKeyException("keystore busy"), new IllegalBlockSizeException("keystore operation failed"),
            new ProviderException("keystore daemon"), new KeyStoreException("unavailable"), new BadPaddingException("other") })
            assertFalse(transientFailure.getClass().getSimpleName(), NativeVoiceStore.corruption(transientFailure));
    }
}
