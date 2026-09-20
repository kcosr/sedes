package dev.sedes.local;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.util.Locale;
import org.junit.Test;

public final class WorkspaceFileDownloadPolicyTest {

    private static final String WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    @Test
    public void permitsOnlyTheExactSedesDownloadRouteOnTheSavedOrigin() {
        assertEquals(
            "https://sedes.example/api/workspaces/" + WORKSPACE_ID +
                "/files/download?rootId=r&path=a%2Fb&expectedRevision=v1",
            WorkspaceFileDownloadPolicy.validatedDownloadUri(
                "https://sedes.example",
                "https://sedes.example/api/workspaces/" + WORKSPACE_ID +
                    "/files/download?rootId=r&path=a%2Fb&expectedRevision=v1"
            ).toString()
        );
        assertEquals(
            "https://sedes.example:443/api/workspaces/" + WORKSPACE_ID + "/files/download",
            WorkspaceFileDownloadPolicy.validatedDownloadUri(
                "https://sedes.example",
                "https://sedes.example:443/api/workspaces/" + WORKSPACE_ID + "/files/download"
            ).toString()
        );
        assertEquals(
            "http://192.168.50.72:4783/api/workspaces/" + WORKSPACE_ID + "/files/download",
            WorkspaceFileDownloadPolicy.validatedDownloadUri(
                "http://192.168.50.72:4783",
                "http://192.168.50.72:4783/api/workspaces/" + WORKSPACE_ID + "/files/download"
            ).toString()
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> WorkspaceFileDownloadPolicy.validatedDownloadUri(
                "https://sedes.example",
                "https://attacker.example/api/workspaces/" + WORKSPACE_ID + "/files/download?rootId=r"
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> WorkspaceFileDownloadPolicy.validatedDownloadUri(
                "https://sedes.example",
                "https://sedes.example/api/threads/t/output-artifacts/a/content"
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> WorkspaceFileDownloadPolicy.validatedDownloadUri(
                "https://user:secret@sedes.example",
                "https://sedes.example/api/workspaces/w/files/download"
            )
        );
    }

    @Test
    public void rejectsSchemePortRelativeAndTraversalVariants() {
        assertFailureCode(
            "download_origin_mismatch",
            () -> WorkspaceFileDownloadPolicy.validatedDownloadUri(
                "https://sedes.example",
                "http://sedes.example/api/workspaces/" + WORKSPACE_ID + "/files/download"
            )
        );
        assertFailureCode(
            "download_origin_mismatch",
            () -> WorkspaceFileDownloadPolicy.validatedDownloadUri(
                "https://sedes.example:8443",
                "https://sedes.example:9443/api/workspaces/" + WORKSPACE_ID + "/files/download"
            )
        );
        assertFailureCode(
            "download_url_invalid",
            () -> WorkspaceFileDownloadPolicy.validatedDownloadUri(
                "https://sedes.example",
                "/api/workspaces/" + WORKSPACE_ID + "/files/download"
            )
        );
        assertFailureCode(
            "download_url_invalid",
            () -> WorkspaceFileDownloadPolicy.validatedDownloadUri(
                "https://sedes.example",
                "https://sedes.example/api/workspaces/" + WORKSPACE_ID + "/../files/download"
            )
        );
        assertFailureCode(
            "download_url_invalid",
            () -> WorkspaceFileDownloadPolicy.validatedDownloadUri(
                "https://sedes.example",
                "https://sedes.example/api/workspaces/%2e%2e/files/download"
            )
        );
    }

    @Test
    public void sanitizesPickerNamesWithoutChangingTheServerHeaderAuthority() {
        assertEquals("_report final.bin", WorkspaceFileDownloadPolicy.safeFileName("../report final.bin"));
        assertEquals("a_b_c.txt", WorkspaceFileDownloadPolicy.safeFileName("a/b:c.txt"));
        assertEquals("download", WorkspaceFileDownloadPolicy.safeFileName("..."));
        assertEquals("a".repeat(124) + ".apk", WorkspaceFileDownloadPolicy.safeFileName("a".repeat(200) + ".apk"));
        assertEquals("😀".repeat(123) + "a.apk", WorkspaceFileDownloadPolicy.safeFileName("😀".repeat(123) + "a".repeat(10) + ".apk"));
    }

    @Test
    public void looksUpTheFinalExtensionWithoutUrlParsing() {
        assertEquals("application/vnd.android.package-archive", WorkspaceFileDownloadPolicy.documentMimeType(
            "app debug (1).APK", extension -> {
                assertEquals("apk", extension);
                return "application/vnd.android.package-archive";
            }
        ));
        assertEquals("application/gzip", WorkspaceFileDownloadPolicy.documentMimeType(
            "archive.tar.gz", extension -> {
                assertEquals("gz", extension);
                return "application/gzip";
            }
        ));
        Locale original = Locale.getDefault();
        try {
            Locale.setDefault(Locale.forLanguageTag("tr-TR"));
            assertEquals("image/gif", WorkspaceFileDownloadPolicy.documentMimeType(
                "image.GIF", extension -> {
                    assertEquals("gif", extension);
                    return "image/gif";
                }
            ));
        } finally {
            Locale.setDefault(original);
        }
    }

    @Test
    public void keepsUnknownAndMissingExtensionsGeneric() {
        assertEquals("application/octet-stream", WorkspaceFileDownloadPolicy.documentMimeType("file.unknown", extension -> null));
        assertEquals("application/octet-stream", WorkspaceFileDownloadPolicy.documentMimeType("file.unknown", extension -> ""));
        for (String name : new String[] { "README", "file." }) {
            assertEquals("application/octet-stream", WorkspaceFileDownloadPolicy.documentMimeType(name, extension -> {
                throw new AssertionError("An absent extension must not be looked up");
            }));
        }
    }

    @Test
    public void enforcesTheOneGibibyteLimitAndExactResponseMetadata() {
        assertEquals(
            99_491L,
            WorkspaceFileDownloadPolicy.validatedByteSize(Integer.valueOf(99_491))
        );
        assertEquals(
            WorkspaceFileDownloadPolicy.MAXIMUM_FILE_BYTES,
            WorkspaceFileDownloadPolicy.validatedByteSize(
                Long.valueOf(WorkspaceFileDownloadPolicy.MAXIMUM_FILE_BYTES)
            )
        );
        assertFailureCode(
            "download_byte_size_invalid",
            () -> WorkspaceFileDownloadPolicy.validatedByteSize(Double.valueOf(42.5))
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> WorkspaceFileDownloadPolicy.validatedByteSize(WorkspaceFileDownloadPolicy.MAXIMUM_FILE_BYTES + 1)
        );
        WorkspaceFileDownloadPolicy.validateResponse(
            200,
            42,
            "application/octet-stream",
            "attachment; filename=\"report.bin\"",
            "v1",
            42,
            "attachment; filename=\"report.bin\"",
            "v1"
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> WorkspaceFileDownloadPolicy.validateResponse(
                302,
                42,
                "application/octet-stream",
                "attachment; filename=\"report.bin\"",
                "v1",
                42,
                "attachment; filename=\"report.bin\"",
                "v1"
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> WorkspaceFileDownloadPolicy.validateResponse(
                200,
                41,
                "application/octet-stream",
                "attachment; filename=\"report.bin\"",
                "v1",
                42,
                "attachment; filename=\"report.bin\"",
                "v1"
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> WorkspaceFileDownloadPolicy.validateResponse(
                200,
                42,
                "application/octet-stream",
                "attachment; filename=\"other.bin\"",
                "v1",
                42,
                "attachment; filename=\"report.bin\"",
                "v1"
            )
        );
        assertFailureCode(
            "download_content_type_invalid",
            () -> WorkspaceFileDownloadPolicy.validateResponse(
                200,
                42,
                "text/plain",
                "attachment; filename=\"report.bin\"",
                "v1",
                42,
                "attachment; filename=\"report.bin\"",
                "v1"
            )
        );
        assertFailureCode(
            "download_revision_mismatch",
            () -> WorkspaceFileDownloadPolicy.validateResponse(
                200,
                42,
                "application/octet-stream",
                "attachment; filename=\"report.bin\"",
                "v2",
                42,
                "attachment; filename=\"report.bin\"",
                "v1"
            )
        );
    }

    @Test
    public void exposesOnlyRecognizedFailureCodes() {
        assertEquals(
            "download_revision_mismatch",
            WorkspaceFileDownloadPolicy.recognizedFailureCode(
                new IllegalArgumentException("download_revision_mismatch")
            )
        );
        assertEquals(
            "workspace_file_download_failed",
            WorkspaceFileDownloadPolicy.recognizedFailureCode(new IOExceptionForTest("secret provider detail"))
        );
    }

    private static void assertFailureCode(String expected, ThrowingRunnable operation) {
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class, operation::run);
        assertEquals(expected, error.getMessage());
    }

    @FunctionalInterface
    private interface ThrowingRunnable {
        void run();
    }

    private static final class IOExceptionForTest extends Exception {
        private IOExceptionForTest(String message) {
            super(message);
        }
    }
}
