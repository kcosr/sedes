package dev.sedes.local;

/** Projects current server titles into native target metadata and a short spoken destination. */
final class NativeVoiceTitle {
    static final int TARGET_LIMIT = 512;
    static final int SPOKEN_CODE_POINTS = 160;
    private NativeVoiceTitle() {}

    /** Matches the WebView's nativeThreadTitle: nullable, trimmed and bounded in UTF-16 units. */
    static String target(String title) {
        if (title == null) return null;
        int start = 0, end = title.length();
        while (start < end && whitespace(title.charAt(start))) start++;
        while (end > start && whitespace(title.charAt(end - 1))) end--;
        if (start == end) return null;
        if (end - start > TARGET_LIMIT) {
            end = start + TARGET_LIMIT;
            if (Character.isHighSurrogate(title.charAt(end - 1))) end--;
            while (end > start && whitespace(title.charAt(end - 1))) end--;
        }
        return title.substring(start, end);
    }

    static String announcement(String title) {
        String bounded = target(title);
        if (bounded == null) return "Replying to Untitled thread.";
        StringBuilder spoken = new StringBuilder();
        boolean space = false;
        for (int offset = 0; offset < bounded.length();) {
            int point = bounded.codePointAt(offset); offset += Character.charCount(point);
            if (whitespace(point) || Character.isISOControl(point)) { space = spoken.length() > 0; continue; }
            if (space) spoken.append(' ');
            spoken.appendCodePoint(point); space = false;
        }
        if (spoken.length() == 0) return "Replying to Untitled thread.";
        String text = spoken.toString();
        if (text.codePointCount(0, text.length()) > SPOKEN_CODE_POINTS)
            text = text.substring(0, text.offsetByCodePoints(0, SPOKEN_CODE_POINTS)).trim() + "…";
        return "Replying to " + text + ".";
    }

    private static boolean whitespace(int value) {
        return value >= 0x09 && value <= 0x0d || value == 0x20 || value == 0xa0 || value == 0x1680 ||
            value >= 0x2000 && value <= 0x200a || value == 0x2028 || value == 0x2029 || value == 0x202f ||
            value == 0x205f || value == 0x3000 || value == 0xfeff;
    }
}
