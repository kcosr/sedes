package dev.sedes.local;

import java.io.IOException;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONObject;

/** Independently connected direct-media client. There is deliberately no Sedes credential here. */
final class NativeVoiceAdapter {
    interface Listener { void ready(long generation); void event(long generation, JSONObject event); void failed(long generation, String code); }
    /** HTTP status of a media request, or 0 when it was not sent or no response arrived. */
    interface Result { void done(int status); }
    // The adapter sends each provider audio chunk whole. Kokoro emits one pipeline segment of at most 510 phonemes
    // (about 45 s, 2.9 MB of base64 at 24 kHz); ElevenLabs streams small frames. This leaves about 3x headroom and
    // bounds the parse/decode copies made after OkHttp has buffered a message.
    static final int MAX_MESSAGE_CHARS = 8 * 1024 * 1024;
    private final OkHttpClient client = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build();
    private final OkHttpClient http = client.newBuilder().readTimeout(30, TimeUnit.SECONDS).callTimeout(40, TimeUnit.SECONDS).build();
    private final Listener listener;
    // Guarded by this. Each socket owns its identity and readiness; replaced connections cannot change the current one.
    private Connection connection;
    private String baseUrl;
    private volatile long generation;
    private final class Connection extends WebSocketListener {
        final long attempt;
        WebSocket socket;
        String clientId;
        boolean ready, ended;
        Connection(long attempt) { this.attempt = attempt; }
        @Override public void onMessage(WebSocket webSocket, String text) {
            JSONObject event = null; boolean becameReady = false;
            try {
                if (text.length() > MAX_MESSAGE_CHARS) { end("adapter_message_too_large"); return; }
                JSONObject message = new JSONObject(text);
                String type = message.optString("type");
                synchronized (NativeVoiceAdapter.this) {
                    if (connection != this || ended) return;
                    if (type.equals("client_identity")) {
                        clientId = NativeVoiceJson.string(message, "clientId", 512);
                        send(webSocket, NativeVoiceJson.object("type", "client_state_update", "acceptingTurns", false, "speechEnabled", true,
                            "listeningEnabled", false, "inTurn", false, "turnModeEnabled", false, "directTtsEnabled", true, "directSttEnabled", true));
                        send(webSocket, NativeVoiceJson.object("type", "client_ping", "sentAtMs", attempt));
                    } else if (type.equals("server_pong") && message.optLong("echoedSentAtMs", -1) == attempt && clientId != null) {
                        becameReady = !ready; ready = true;
                    } else if (ready && (type.startsWith("media_tts_") || type.startsWith("media_stt_"))) {
                        if (message.has("clientId") && !clientId.equals(message.optString("clientId"))) return;
                        event = message;
                    }
                }
            } catch (Exception error) { end("adapter_protocol_error"); return; }
            // OkHttp delivers one socket's messages serially, so these posts keep adapter order.
            if (becameReady) listener.ready(attempt); else if (event != null) listener.event(attempt, event);
        }
        // Reply to a peer Close at once instead of waiting for a missed pong.
        @Override public void onClosing(WebSocket webSocket, int code, String reason) { webSocket.close(1000, null); end("adapter_disconnected"); }
        @Override public void onClosed(WebSocket webSocket, int code, String reason) { end("adapter_disconnected"); }
        @Override public void onFailure(WebSocket webSocket, Throwable error, Response response) { end("adapter_disconnected"); }
        private void end(String code) {
            synchronized (NativeVoiceAdapter.this) { if (connection != this || ended) return; ended = true; ready = false; }
            listener.failed(attempt, code);
        }
    }
    NativeVoiceAdapter(Listener listener) { this.listener = listener; }
    long generation() { return generation; }
    synchronized boolean ready() { return connection != null && connection.ready; }
    synchronized void connect(String baseUrl) {
        close(); this.baseUrl = NativeVoiceSettings.adapterBaseUrl(baseUrl);
        Connection next = new Connection(generation); connection = next;
        next.socket = client.newWebSocket(new Request.Builder().url(this.baseUrl.replaceFirst("^http", "ws") + "/ws").build(), next);
    }
    synchronized void close() {
        generation++;
        Connection old = connection; connection = null;
        if (old != null) { old.ended = true; old.ready = false; old.socket.close(1000, "voice session ended"); old.socket.cancel(); }
    }
    synchronized void reconnect() { if (baseUrl != null) connect(baseUrl); }
    /** Sends only on the current handshaken socket. */
    boolean send(JSONObject value) {
        WebSocket socket;
        synchronized (this) { if (connection == null || !connection.ready) return false; socket = connection.socket; }
        return send(socket, value);
    }
    private static boolean send(WebSocket socket, JSONObject value) { return socket.queueSize() < 512 * 1024 && socket.send(value.toString()); }
    void tts(String requestId, String text, Result result) {
        String id;
        synchronized (this) { id = connection != null && connection.ready ? connection.clientId : null; }
        if (id == null) { result.done(0); return; }
        post("/api/media/tts", NativeVoiceJson.object("clientId", id, "requestId", requestId, "text", text), result);
    }
    void stopTts(String requestId) {
        String id = clientId();
        if (id != null) post("/api/media/tts/stop", NativeVoiceJson.object("clientId", id, "requestId", requestId), ignored -> {});
    }
    void cancelStt(String requestId) {
        String id = clientId();
        if (id != null) post("/api/media/stt/cancel", NativeVoiceJson.object("clientId", id, "requestId", requestId), ignored -> {});
    }
    private synchronized String clientId() { return connection == null ? null : connection.clientId; }
    private void post(String path, JSONObject body, Result result) {
        final long attempt; final String base;
        synchronized (this) { attempt = generation; base = baseUrl; }
        Request request = new Request.Builder().url(base + path).post(RequestBody.create(body.toString(), MediaType.get("application/json; charset=utf-8"))).build();
        http.newCall(request).enqueue(new Callback() {
            public void onFailure(Call call, IOException error) { if (attempt == generation) result.done(0); }
            public void onResponse(Call call, Response response) { try (Response closed = response) { if (attempt == generation) result.done(response.code()); } }
        });
    }
}
