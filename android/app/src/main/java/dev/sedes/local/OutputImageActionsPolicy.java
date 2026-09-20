package dev.sedes.local;

import java.nio.charset.StandardCharsets;
import java.util.Locale;

final class OutputImageActionsPolicy {

    static final int MAXIMUM_IMAGE_BYTES = 16 * 1024 * 1024;
    static final int MAXIMUM_BASE64_CHARACTERS = ((MAXIMUM_IMAGE_BYTES + 2) / 3) * 4;

    private OutputImageActionsPolicy() {}

    static String extensionForMimeType(String mimeType) {
        return switch (mimeType) {
            case "image/png" -> ".png";
            case "image/jpeg" -> ".jpg";
            case "image/gif" -> ".gif";
            case "image/webp" -> ".webp";
            default -> throw new IllegalArgumentException("unsupported_mime_type");
        };
    }

    static String normalizedFileName(String proposedName, String mimeType) {
        String extension = extensionForMimeType(mimeType);
        String candidate = proposedName == null ? "" : proposedName.trim();
        candidate = candidate.replaceAll("[\\p{Cntrl}\\\\/:*?\"<>|]", "_");
        candidate = candidate.replaceAll("^[. ]+", "");
        candidate = candidate.replaceAll("[. ]+$", "");
        if (candidate.isEmpty() || !candidate.matches(".*[\\p{L}\\p{N}].*")) candidate = "generated-image";
        if (candidate.length() > 96) candidate = candidate.substring(0, 96);

        String lower = candidate.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".webp")) {
            int dot = candidate.lastIndexOf('.');
            candidate = candidate.substring(0, dot);
        }
        if (candidate.isEmpty()) candidate = "generated-image";
        return candidate + extension;
    }

    static void validateImageBytes(byte[] bytes, String mimeType) {
        if (bytes == null) throw new IllegalArgumentException("image_byte_size_invalid");
        validateImageHeader(bytes, bytes.length, mimeType);
    }

    static void validateImageHeader(byte[] header, int byteSize, String mimeType) {
        if (header == null || byteSize <= 0 || byteSize > MAXIMUM_IMAGE_BYTES) {
            throw new IllegalArgumentException("image_byte_size_invalid");
        }
        boolean valid = switch (mimeType) {
            case "image/png" -> startsWith(header, new byte[] {
                (byte) 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
            });
            case "image/jpeg" -> header.length >= 3 &&
                unsigned(header[0]) == 0xff && unsigned(header[1]) == 0xd8 && unsigned(header[2]) == 0xff;
            case "image/gif" -> startsWith(header, "GIF87a".getBytes(StandardCharsets.US_ASCII)) ||
                startsWith(header, "GIF89a".getBytes(StandardCharsets.US_ASCII));
            case "image/webp" -> header.length >= 12 &&
                startsWith(header, "RIFF".getBytes(StandardCharsets.US_ASCII)) &&
                header[8] == 'W' && header[9] == 'E' && header[10] == 'B' && header[11] == 'P';
            default -> false;
        };
        if (!valid) throw new IllegalArgumentException("image_signature_invalid");
    }

    static boolean isCanonicalSha256(String value) {
        if (value == null || value.length() != 64) return false;
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) {
                return false;
            }
        }
        return true;
    }

    private static boolean startsWith(byte[] bytes, byte[] expected) {
        if (bytes.length < expected.length) return false;
        for (int index = 0; index < expected.length; index += 1) {
            if (bytes[index] != expected[index]) return false;
        }
        return true;
    }

    private static int unsigned(byte value) {
        return value & 0xff;
    }
}
