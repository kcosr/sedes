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
    interface Result { void done(boolean accepted); }
    private final OkHttpClient client = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).pingInterval(20, TimeUnit.SECONDS).build();
    private final OkHttpClient http = client.newBuilder().readTimeout(30, TimeUnit.SECONDS).callTimeout(40, TimeUnit.SECONDS).build();
    private final Listener listener;
    private volatile WebSocket socket;
    private volatile String clientId, origin;
    private volatile long generation;
    private volatile boolean ready;
    NativeVoiceAdapter(Listener listener) { this.listener = listener; }
    long generation() { return generation; }
    boolean ready() { return ready; }
    synchronized void connect(String origin) {
        close(); this.origin = NativeVoiceSettings.origin(origin);
        final long attempt = generation;
        String url = this.origin.replaceFirst("^http", "ws") + "/ws";
        socket = client.newWebSocket(new Request.Builder().url(url).build(), new WebSocketListener() {
            public void onMessage(WebSocket webSocket, String text) {
                if (attempt != generation || socket != webSocket) return;
                try {
                    if (text.length() > 2 * 1024 * 1024) throw new IllegalArgumentException("adapter_message_too_large");
                    JSONObject message = new JSONObject(text);
                    String type = message.optString("type");
                    if (type.equals("client_identity")) {
                        clientId = NativeVoiceJson.string(message, "clientId", 512);
                        send(NativeVoiceJson.object("type", "client_state_update", "acceptingTurns", false, "speechEnabled", true,
                            "listeningEnabled", false, "inTurn", false, "turnModeEnabled", false, "directTtsEnabled", true, "directSttEnabled", true));
                        send(NativeVoiceJson.object("type", "client_ping", "sentAtMs", attempt));
                    } else if (type.equals("server_pong") && message.optLong("echoedSentAtMs", -1) == attempt && clientId != null) {
                        if (!ready) { ready = true; listener.ready(attempt); }
                    } else if (ready && (type.startsWith("media_tts_") || type.startsWith("media_stt_"))) {
                        if (message.has("clientId") && !clientId.equals(message.optString("clientId"))) return;
                        listener.event(attempt, message);
                    }
                } catch (Exception error) { listener.failed(attempt, "adapter_protocol_error"); }
            }
            public void onFailure(WebSocket socket, Throwable error, Response response) { if (attempt == generation) { ready = false; listener.failed(attempt, "adapter_disconnected"); } }
            public void onClosed(WebSocket socket, int code, String reason) { if (attempt == generation) { ready = false; listener.failed(attempt, "adapter_disconnected"); } }
        });
    }
    synchronized void close() {
        generation++; ready = false; clientId = null;
        WebSocket old = socket; socket = null;
        if (old != null) { old.close(1000, "voice session ended"); old.cancel(); }
    }
    void reconnect() { if (origin != null) connect(origin); }
    boolean send(JSONObject value) { WebSocket current = socket; return current != null && current.queueSize() < 512 * 1024 && current.send(value.toString()); }
    void tts(String requestId, String text, Result result) {
        if (!ready) { result.done(false); return; }
        post("/api/media/tts", NativeVoiceJson.object("clientId", clientId, "requestId", requestId, "text", text), result);
    }
    void stopTts(String requestId) {
        if (clientId != null) post("/api/media/tts/stop", NativeVoiceJson.object("clientId", clientId, "requestId", requestId), ignored -> {});
    }
    void cancelStt(String requestId) {
        if (clientId != null) post("/api/media/stt/cancel", NativeVoiceJson.object("clientId", clientId, "requestId", requestId), ignored -> {});
    }
    private void post(String path, JSONObject body, Result result) {
        final long attempt = generation;
        Request request = new Request.Builder().url(origin + path).post(RequestBody.create(body.toString(), MediaType.get("application/json; charset=utf-8"))).build();
        http.newCall(request).enqueue(new Callback() {
            public void onFailure(Call call, IOException error) { if (attempt == generation) result.done(false); }
            public void onResponse(Call call, Response response) { try (Response closed = response) { if (attempt == generation) result.done(response.isSuccessful()); } }
        });
    }
}
