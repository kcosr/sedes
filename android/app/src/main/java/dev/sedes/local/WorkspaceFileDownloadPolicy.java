package dev.sedes.local;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.function.Function;
import java.util.regex.Pattern;

final class WorkspaceFileDownloadPolicy {

    private static final Pattern DOWNLOAD_PATH = Pattern.compile(
        "^/api/workspaces/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/files/download$"
    );

    static final long MAXIMUM_FILE_BYTES = 1024L * 1024L * 1024L;
    static final int STREAM_BUFFER_BYTES = 64 * 1024;
    static final int CONNECT_TIMEOUT_MILLISECONDS = 15_000;
    static final int READ_INACTIVITY_TIMEOUT_MILLISECONDS = 30_000;

    private WorkspaceFileDownloadPolicy() {}

    static URI validatedDownloadUri(String serverOrigin, String requestUrl) {
        try {
            URI origin = new URI(requiredText(serverOrigin, 2048, "download_server_origin_invalid"));
            // A valid 4 KiB UTF-8 workspace path may expand to roughly three
            // times that size when percent-encoded into the query string.
            URI request = new URI(requiredText(requestUrl, 16_384, "download_url_invalid"));
            if (!isHttp(origin) || origin.getHost() == null || origin.getRawUserInfo() != null ||
                origin.getRawQuery() != null || origin.getRawFragment() != null ||
                !(origin.getRawPath() == null || origin.getRawPath().isEmpty() || "/".equals(origin.getRawPath()))) {
                throw new IllegalArgumentException("download_server_origin_invalid");
            }
            if (!isHttp(request) || request.getHost() == null || request.getRawUserInfo() != null ||
                request.getRawFragment() != null || request.getRawPath() == null ||
                !DOWNLOAD_PATH.matcher(request.getRawPath()).matches()) {
                throw new IllegalArgumentException("download_url_invalid");
            }
            if (!sameOrigin(origin, request)) throw new IllegalArgumentException("download_origin_mismatch");
            return request;
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("download_url_invalid", error);
        }
    }

    static long validatedByteSize(Object value) {
        if (!(value instanceof Number)) {
            throw new IllegalArgumentException("download_byte_size_invalid");
        }
        Number number = (Number) value;
        double numericValue = number.doubleValue();
        long integralValue = number.longValue();
        if (
            !Double.isFinite(numericValue) ||
            numericValue != integralValue ||
            integralValue < 0 ||
            integralValue > MAXIMUM_FILE_BYTES
        ) {
            throw new IllegalArgumentException("download_byte_size_invalid");
        }
        return integralValue;
    }

    static String validatedRevision(String value) {
        return requiredText(value, 160, "download_revision_invalid");
    }

    static String validatedContentDisposition(String value) {
        String disposition = requiredText(value, 2048, "download_content_disposition_invalid");
        if (!disposition.regionMatches(true, 0, "attachment;", 0, "attachment;".length())) {
            throw new IllegalArgumentException("download_content_disposition_invalid");
        }
        return disposition;
    }

    static String safeFileName(String value) {
        String candidate = requiredText(value, 512, "download_file_name_invalid").trim();
        candidate = candidate.replaceAll("[\\p{Cntrl}\\\\/:*?\"<>|]", "_");
        candidate = candidate.replaceAll("^[. ]+", "");
        candidate = candidate.replaceAll("[. ]+$", "");
        if (candidate.isEmpty() || !candidate.matches(".*[\\p{L}\\p{N}].*")) candidate = "download";
        if (candidate.codePointCount(0, candidate.length()) > 128) {
            int extensionStart = candidate.lastIndexOf('.');
            String extension = extensionStart > 0 ? candidate.substring(extensionStart) : "";
            int extensionLength = extension.codePointCount(0, extension.length());
            if (extensionLength >= 128) extension = "";
            int stemLength = 128 - extension.codePointCount(0, extension.length());
            candidate = candidate.substring(0, candidate.offsetByCodePoints(0, stemLength)) + extension;
            candidate = candidate.replaceAll("[. ]+$", "");
        }
        return candidate.isEmpty() ? "download" : candidate;
    }

    // The document type is a local save hint, independent of the server's
    // intentionally generic binary transport and its exact response checks.
    static String documentMimeType(String fileName, Function<String, String> lookup) {
        int separator = fileName.lastIndexOf('.');
        if (separator < 0 || separator == fileName.length() - 1) return "application/octet-stream";
        String extension = fileName.substring(separator + 1).toLowerCase(Locale.ROOT);
        String mimeType = lookup.apply(extension);
        return mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType;
    }

    static void validateResponse(
        int status,
        long contentLength,
        String contentType,
        String contentDisposition,
        String revision,
        long expectedByteSize,
        String expectedContentDisposition,
        String expectedRevision
    ) {
        if (status != 200) throw new IllegalArgumentException("download_http_status_invalid");
        if (contentLength != expectedByteSize || contentLength < 0 || contentLength > MAXIMUM_FILE_BYTES) {
            throw new IllegalArgumentException("download_content_length_mismatch");
        }
        if (!"application/octet-stream".equals(contentType)) {
            throw new IllegalArgumentException("download_content_type_invalid");
        }
        if (!expectedContentDisposition.equals(contentDisposition)) {
            throw new IllegalArgumentException("download_content_disposition_mismatch");
        }
        if (!expectedRevision.equals(revision)) {
            throw new IllegalArgumentException("download_revision_mismatch");
        }
    }

    static String recognizedFailureCode(Exception error) {
        String code = error.getMessage();
        if (
            "download_http_status_invalid".equals(code) ||
            "download_content_length_mismatch".equals(code) ||
            "download_content_type_invalid".equals(code) ||
            "download_content_disposition_mismatch".equals(code) ||
            "download_revision_mismatch".equals(code) ||
            "workspace_file_download_destination_unavailable".equals(code) ||
            "workspace_file_download_byte_size_exceeded".equals(code) ||
            "workspace_file_download_byte_size_mismatch".equals(code)
        ) {
            return code;
        }
        return "workspace_file_download_failed";
    }

    private static String requiredText(String value, int maximumLength, String errorCode) {
        if (value == null || value.isEmpty() || value.length() > maximumLength || containsControl(value)) {
            throw new IllegalArgumentException(errorCode);
        }
        return value;
    }

    private static boolean containsControl(String value) {
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (character <= 0x1f || character == 0x7f) return true;
        }
        return false;
    }

    private static boolean isHttp(URI uri) {
        return "http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme());
    }

    private static boolean sameOrigin(URI left, URI right) {
        return left.getScheme().equalsIgnoreCase(right.getScheme()) &&
            left.getHost().equalsIgnoreCase(right.getHost()) && effectivePort(left) == effectivePort(right);
    }

    private static int effectivePort(URI uri) {
        if (uri.getPort() >= 0) return uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }
}
