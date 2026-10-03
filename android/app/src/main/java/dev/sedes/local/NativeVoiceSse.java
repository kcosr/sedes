package dev.sedes.local;

/** Incremental SSE framing. The enclosing Reader performs incremental UTF-8 decoding. */
final class NativeVoiceSse {
    interface Listener { void frame(String event, String data); }
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
            if (!oversized && data.length() > 0 && (event.equals("notification") || event.equals("notification_policy"))) {
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
