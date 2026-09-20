package dev.sedes.local;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import org.junit.Test;

public final class OutputImageActionsPolicyTest {

    @Test
    public void normalizesFileNamesToTheCanonicalMimeExtension() {
        assertEquals("chart.png", OutputImageActionsPolicy.normalizedFileName("chart.jpeg", "image/png"));
        assertEquals("generated-image.jpg", OutputImageActionsPolicy.normalizedFileName("../", "image/jpeg"));
        assertEquals("a_b_c.webp", OutputImageActionsPolicy.normalizedFileName("a/b:c.gif", "image/webp"));
    }

    @Test
    public void acceptsOnlyTheClosedRasterSignatures() {
        OutputImageActionsPolicy.validateImageBytes(
            new byte[] { (byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a },
            "image/png"
        );
        OutputImageActionsPolicy.validateImageBytes(
            new byte[] { (byte) 0xff, (byte) 0xd8, (byte) 0xff },
            "image/jpeg"
        );
        OutputImageActionsPolicy.validateImageBytes("GIF89a".getBytes(StandardCharsets.US_ASCII), "image/gif");
        OutputImageActionsPolicy.validateImageBytes(
            new byte[] { 'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'E', 'B', 'P' },
            "image/webp"
        );

        assertThrows(
            IllegalArgumentException.class,
            () -> OutputImageActionsPolicy.validateImageBytes(new byte[] { 1, 2, 3 }, "image/png")
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> OutputImageActionsPolicy.validateImageBytes(new byte[] { (byte) 0xff, (byte) 0xd8, (byte) 0xff }, "image/tiff")
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> OutputImageActionsPolicy.validateImageHeader(
                new byte[] { (byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a },
                OutputImageActionsPolicy.MAXIMUM_IMAGE_BYTES + 1,
                "image/png"
            )
        );
    }

    @Test
    public void requiresCanonicalLowercaseSha256() {
        assertTrue(OutputImageActionsPolicy.isCanonicalSha256("a".repeat(64)));
        assertFalse(OutputImageActionsPolicy.isCanonicalSha256("A".repeat(64)));
        assertFalse(OutputImageActionsPolicy.isCanonicalSha256("a".repeat(63)));
    }
}
