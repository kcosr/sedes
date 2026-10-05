package dev.sedes.local;

import android.content.Context;
import android.content.ContextWrapper;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.util.UUID;

/** Each fixture has a separate installation so device-owned settings and credentials cannot leak between tests. */
final class NativeVoiceTestContext extends ContextWrapper implements AutoCloseable {
    private final File directory;
    NativeVoiceTestContext() {
        super(InstrumentationRegistry.getInstrumentation().getTargetContext());
        directory = new File(super.getNoBackupFilesDir(), "voice-installation-test-" + UUID.randomUUID());
        if (!directory.mkdirs()) throw new IllegalStateException("test_directory_unavailable");
    }
    @Override public Context getApplicationContext() { return this; }
    @Override public File getNoBackupFilesDir() { return directory; }
    @Override public void close() { delete(directory); }
    private static void delete(File target) {
        File[] children = target.listFiles();
        if (children != null) for (File child : children) delete(child);
        if (target.exists() && !target.delete()) throw new IllegalStateException("test_directory_cleanup_failed");
    }
}
