package dev.sedes.local;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class WorkspaceFileDownloadIntentTest {

    @Test
    public void createsTypedDocumentsUsingAndroidMimeMappings() {
        assertDocument("app-debug.apk", "application/vnd.android.package-archive");
        assertDocument("app debug (1).APK", "application/vnd.android.package-archive");
        assertDocument("report final.pdf", "application/pdf");
        assertDocument("photo.jpg", "image/jpeg");
        assertDocument("README", "application/octet-stream");
        assertDocument("file.sedesunknownextension", "application/octet-stream");
    }

    private static void assertDocument(String name, String mimeType) {
        Intent intent = WorkspaceFileDownloadPlugin.createDocumentIntent(name);
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, intent.getAction());
        assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE));
        assertEquals(mimeType, intent.getType());
        assertEquals(name, intent.getStringExtra(Intent.EXTRA_TITLE));
    }
}
