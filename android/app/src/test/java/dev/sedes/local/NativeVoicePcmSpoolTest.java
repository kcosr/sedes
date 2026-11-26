package dev.sedes.local;

import static org.junit.Assert.*;
import java.io.File;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class NativeVoicePcmSpoolTest {
    @Rule public TemporaryFolder cache = new TemporaryFolder();

    @Test public void independentRatesSamplesAndDrainOffsetsSurviveInterleavedDownloads() throws Exception {
        try (NativeVoicePcmSpool active = new NativeVoicePcmSpool("active", cache.getRoot());
             NativeVoicePcmSpool staged = new NativeVoicePcmSpool("next", cache.getRoot())) {
            active.append(24000, new byte[] {1, 2, 3}, 1f);
            staged.append(48000, new byte[] {9}, 1f);
            assertNull(staged.file());
            staged.append(48000, new byte[0], 1f);
            staged.append(48000, new byte[] {8, 7, 6}, 1f);
            File stagedFile = staged.file(); assertTrue(stagedFile.exists());
            active.append(24000, new byte[] {4, 5}, 1f);
            active.end(); staged.end();
            byte[] buffer = new byte[4];
            assertEquals(4, active.read(buffer));
            assertArrayEquals(new byte[] {1, 2, 3, 4}, buffer);
            assertThrows(IllegalArgumentException.class, () -> active.append(24000, new byte[2], 1f));
            assertEquals(0, active.available());
            assertEquals(48000, staged.sampleRate());
            assertEquals(4, staged.available());
            active.close(); assertTrue(stagedFile.exists());
            assertEquals(4, staged.read(buffer));
            assertArrayEquals(new byte[] {9, 8, 7, 6}, buffer);
        }
        assertEquals(0, cache.getRoot().list().length);
    }

    @Test public void malformedStagedRateAndStorageLimitsDoNotConsumeAnotherRequest() throws Exception {
        try (NativeVoicePcmSpool active = new NativeVoicePcmSpool("active", cache.getRoot());
             NativeVoicePcmSpool staged = new NativeVoicePcmSpool("prefetched", cache.getRoot())) {
            active.append(48000, new byte[] {32, 0}, .5f);
            staged.append(8000, new byte[2], 1f);
            assertThrows(IllegalArgumentException.class, () -> staged.append(16000, new byte[2], 1f));
            int limit = (int) (8000 * 2 * NativeVoicePcmSpool.MAX_DURATION_MS / 1000);
            assertThrows(IllegalArgumentException.class, () -> staged.append(8000, new byte[limit], 1f));
            File discarded = staged.file();
            staged.close();
            assertFalse(discarded.exists());
            assertThrows(IllegalArgumentException.class, () -> staged.append(8000, new byte[2], 1f));
            byte[] output = new byte[2];
            assertEquals(2, active.read(output));
            assertArrayEquals(new byte[] {16, 0}, output);
        }
    }
}
