package dev.sedes.local;

/** Incremental SSE framing. The enclosing Reader performs incremental UTF-8 decoding. */
final class NativeVoiceSse {
    interface Listener { void frame(String event, String data); }
    static final String LIVE = "application-live";
    static final String EARLY_SESSION = "voice_early_session", EARLY_REPLY = "voice_early_reply";
    private final Listener listener;
    private final StringBuilder line = new StringBuilder(), data = new StringBuilder();
    private String event = "message";
    private boolean first = true, afterCr, oversized;
    NativeVoiceSse(Listener listener) { this.listener = listener; }
    void accept(char[] chars, int count) {
        for (int i = 0; i < count; i++) {
            char c = chars[i];
            if (first) { first = false; if (c == '\ufeff') continue; }
            if (c == '\n' && afterCr) { afterCr = false; continue; }
            afterCr = false;
            if (c == '\r' || c == '\n') { consumeLine(); afterCr = c == '\r'; }
            else if (line.length() < 1024 * 1024) line.append(c);
            else oversized = true;
        }
    }
    private void consumeLine() {
        String value = line.toString(); line.setLength(0);
        if (value.isEmpty()) {
            // application-live marks the end of the inventory handshake; transient frames queued during it precede it.
            boolean early = event.equals(EARLY_SESSION) || event.equals(EARLY_REPLY);
            if (oversized && early) throw new IllegalArgumentException("invalid_notification_frame");
            if (!oversized && data.length() > 0 && (early || event.equals("notification") || event.equals("notification_policy") || event.equals(LIVE))) {
                data.setLength(data.length() - 1); listener.frame(event, data.toString());
            }
            data.setLength(0); event = "message"; oversized = false; return;
        }
        if (value.charAt(0) == ':') return;
        int colon = value.indexOf(':');
        String field = colon < 0 ? value : value.substring(0, colon);
        String content = colon < 0 ? "" : value.substring(colon + 1);
        if (content.startsWith(" ")) content = content.substring(1);
        if (field.equals("event")) event = content;
        else if (field.equals("data")) {
            if (data.length() + content.length() > 1024 * 1024) oversized = true;
            else data.append(content).append('\n');
        }
        // Inventory IDs and retry hints never become voice replay state.
    }
}
