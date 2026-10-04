package dev.sedes.local;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import okio.BufferedSink;
import org.json.JSONObject;

/**
 * OpenAI speech wire transport shared by Android and host JVM checks. Owns no Sedes credentials or audio hardware.
 * Listener callbacks run under their operation's cancellation fence and must be short and nonblocking. Post work to
 * the owning runtime; never synchronously close the transport or cancel another request from a callback.
 * Invalid/duplicate request IDs throw before a request starts. Closed/capacity/input failures may callback synchronously.
 */
class NativeSpeechTransport implements Closeable {
    static final int SAMPLE_RATE = 24000;
    static final int MAX_INPUT_CHARS = 4096;
    // OkHttp buffers a WebSocket message before this limit can bound JSON parsing and callback copies.
    static final int MAX_MESSAGE_CHARS = 256 * 1024;
    static final int MAX_AUDIO_CHUNK_BYTES = 64 * 1024;
    static final int MAX_ERROR_BODY_BYTES = 16 * 1024;
    static final long MAX_QUEUED_BYTES = 512 * 1024;
    static final long MAX_PCM_BYTES = SAMPLE_RATE * 2L * 10 * 60;

    interface Request { void cancel(); }
    interface Transcription extends Request {
        /** Raw 24 kHz, mono signed 16-bit little-endian PCM. Only accepted after ready and before commit. */
        boolean append(byte[] pcm);
        /** Commits once. A refused append/commit reports failure once; cancellation is silent. */
        boolean commit();
    }
    interface SpeechListener {
        void started(String requestId);
        void pcm(String requestId, int sampleRate, byte[] pcm);
        void completed(String requestId);
        void failed(String requestId, Failure failure);
    }
    interface TranscriptionListener {
        void ready(String requestId);
        void completed(String requestId, String transcript);
        void failed(String requestId, Failure failure);
    }
    enum Kind { CONFIGURATION, AUTHENTICATION, RATE_LIMIT, HTTP, NETWORK, PROTOCOL, LIMIT, TIMEOUT, PROVIDER }
    /** Safe machine diagnostics: provider bodies, exception messages and credentials never escape this boundary. */
    static final class Failure {
        final Kind kind;
        final String code;
        final int httpStatus;
        Failure(Kind kind, String code, int httpStatus) { this.kind = kind; this.code = code; this.httpStatus = httpStatus; }
    }
    static final class Config {
        final String baseUrl, bearerToken, transcriptionModel, speechModel, voice;
        final double speed;
        Config(String baseUrl, String bearerToken, String transcriptionModel, String speechModel, String voice, double speed) {
            try {
                if (baseUrl == null || baseUrl.length() > 2048) throw new IllegalArgumentException();
                URI uri = new URI(baseUrl);
                if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme())) || uri.getHost() == null ||
                    uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null || uri.getPort() > 65535)
                    throw new IllegalArgumentException();
                String normalized = HttpUrl.get(baseUrl).toString();
                while (normalized.endsWith("/")) normalized = normalized.substring(0, normalized.length() - 1);
                this.baseUrl = normalized;
            } catch (Exception invalid) { throw new IllegalArgumentException("invalid_speech_base_url"); }
            if (bearerToken != null && (bearerToken.length() > 8192 || !bearerToken.matches("[\\x21-\\x7e]*")))
                throw new IllegalArgumentException("invalid_speech_credential");
            this.bearerToken = bearerToken == null || bearerToken.isEmpty() ? null : bearerToken;
            this.transcriptionModel = configured(transcriptionModel);
            this.speechModel = configured(speechModel);
            this.voice = configured(voice);
            if (!Double.isFinite(speed) || speed < .25 || speed > 4) throw new IllegalArgumentException("invalid_speech_speed");
            this.speed = speed;
        }
        private static String configured(String value) {
            if (value == null || value.isEmpty() || value.length() > 256 || value.indexOf('\0') >= 0)
                throw new IllegalArgumentException("invalid_speech_configuration");
            return value;
        }
    }
    /** Transport limits are independent of Android settings and can be shortened in actual socket tests. */
    static final class Limits {
        final long handshakeMs, readMs, requestMs, pcmBytes;
        Limits(long handshakeMs, long readMs, long requestMs, long pcmBytes) {
            if (handshakeMs <= 0 || readMs <= 0 || requestMs <= 0 || pcmBytes <= 0 || pcmBytes > MAX_PCM_BYTES)
                throw new IllegalArgumentException("invalid_speech_limits");
            this.handshakeMs = handshakeMs; this.readMs = readMs; this.requestMs = requestMs; this.pcmBytes = pcmBytes;
        }
        static Limits defaults() { return new Limits(20000, 30000, 11 * 60 * 1000, MAX_PCM_BYTES); }
    }

    private final Config config;
    private final Limits limits;
    private final OkHttpClient websocketClient, httpClient;
    private final ScheduledThreadPoolExecutor deadlines = new ScheduledThreadPoolExecutor(1, work -> {
        Thread thread = new Thread(work, "sedes-speech-deadlines"); thread.setDaemon(true); return thread;
    });
    private final Set<Operation> operations = new HashSet<>();
    private boolean closed;

    NativeSpeechTransport(Config config) { this(config, new OkHttpClient(), Limits.defaults()); }
    NativeSpeechTransport(Config config, OkHttpClient client, Limits limits) {
        this.config = config; this.limits = limits;
        deadlines.setRemoveOnCancelPolicy(true);
        // OkHttp may repeat the bodyless upgrade GET once for HTTP 503/Retry-After: 0 before a socket is open.
        // No audio is sent before the session acknowledgement; established recordings are never reconnected/replayed.
        websocketClient = client.newBuilder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .connectTimeout(limits.handshakeMs, TimeUnit.MILLISECONDS).readTimeout(0, TimeUnit.MILLISECONDS)
            .callTimeout(0, TimeUnit.MILLISECONDS).pingInterval(20, TimeUnit.SECONDS).build();
        httpClient = websocketClient.newBuilder().readTimeout(limits.readMs, TimeUnit.MILLISECONDS)
            .callTimeout(limits.requestMs, TimeUnit.MILLISECONDS).build();
    }
    Request speak(String requestId, String text, SpeechListener listener) {
        Speech operation = new Speech(requestId, listener);
        if (!register(operation)) return operation;
        if (text == null || text.trim().isEmpty() || text.length() > MAX_INPUT_CHARS) {
            operation.fail(Kind.CONFIGURATION, "speech_invalid_input", 0); return operation;
        }
        operation.start(text); return operation;
    }
    Transcription transcribe(String requestId, long resultTimeoutMs, TranscriptionListener listener) {
        Recognition operation = new Recognition(requestId, listener, resultTimeoutMs);
        if (!register(operation)) return operation;
        if (resultTimeoutMs < 1000 || resultTimeoutMs > 300000) {
            operation.fail(Kind.CONFIGURATION, "recognition_invalid_timeout", 0); return operation;
        }
        operation.start(); return operation;
    }
    private boolean register(Operation operation) {
        String error = null;
        synchronized (this) {
            if (operation.id == null || operation.id.isEmpty() || operation.id.length() > 256)
                throw new IllegalArgumentException("speech_invalid_request_id");
            // A duplicate failure callback would share the active operation's ID and could incorrectly terminate it.
            for (Operation existing : operations) if (existing.id.equals(operation.id))
                throw new IllegalArgumentException("speech_duplicate_request_id");
            if (closed) error = "speech_transport_closed";
            else if (operations.size() >= 4) error = "speech_request_limit";
            else operations.add(operation);
        }
        if (error != null) operation.fail(Kind.CONFIGURATION, error, 0);
        return error == null;
    }
    private okhttp3.Request.Builder request(String suffix) {
        okhttp3.Request.Builder request = new okhttp3.Request.Builder().url(config.baseUrl + suffix);
        if (config.bearerToken != null) request.header("Authorization", "Bearer " + config.bearerToken);
        return request;
    }
    @Override public void close() {
        ArrayList<Operation> pending;
        synchronized (this) { closed = true; pending = new ArrayList<>(operations); }
        for (Operation operation : pending) operation.cancel();
        deadlines.shutdownNow();
    }

    private abstract class Operation implements Request {
        final String id;
        boolean ended;
        long deadlineGeneration;
        ScheduledFuture<?> deadline;
        Operation(String id) { this.id = id; }
        final synchronized void deadline(long delay, String code) {
            long scheduledGeneration = ++deadlineGeneration;
            if (deadline != null) deadline.cancel(false);
            if (!ended) deadline = deadlines.schedule(() -> {
                synchronized (Operation.this) {
                    // cancel(false) cannot stop a timer already waiting for this monitor during a phase transition.
                    if (!ended && deadlineGeneration == scheduledGeneration) fail(Kind.TIMEOUT, code, 0);
                }
            }, delay, TimeUnit.MILLISECONDS);
        }
        final synchronized boolean finish() {
            if (ended) return false;
            ended = true;
            deadlineGeneration++;
            if (deadline != null) deadline.cancel(false);
            synchronized (NativeSpeechTransport.this) { operations.remove(this); }
            return true;
        }
        @Override public final synchronized void cancel() { if (finish()) stop(); }
        final synchronized void fail(Kind kind, String code, int status) {
            if (!finish()) return;
            stop(); failed(new Failure(kind, code, status));
        }
        final void httpFailure(Response response, String prefix) {
            int status = response.code();
            if (status == 401 || status == 403) fail(Kind.AUTHENTICATION, prefix + "_authentication_failed", status);
            else if (status == 429) fail(Kind.RATE_LIMIT, prefix + (quotaError(responseError(response)) ? "_quota_exceeded" : "_rate_limited"), status);
            else fail(Kind.HTTP, prefix + "_http_error", status);
        }
        abstract void stop();
        abstract void failed(Failure failure);
    }

    private final class Speech extends Operation implements Callback {
        private final SpeechListener listener;
        private Call call;
        Speech(String id, SpeechListener listener) { super(id); this.listener = listener; }
        synchronized void start(String text) {
            if (ended) return;
            JSONObject payload = NativeVoiceJson.object("model", config.speechModel, "voice", config.voice, "input", text,
                "speed", config.speed, "response_format", "pcm");
            // isOneShot also prevents OkHttp's HTTP 503/Retry-After follow-up from replaying synthesis.
            byte[] encoded = payload.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            RequestBody body = new RequestBody() {
                @Override public MediaType contentType() { return MediaType.get("application/json"); }
                @Override public long contentLength() { return encoded.length; }
                @Override public boolean isOneShot() { return true; }
                @Override public void writeTo(BufferedSink sink) throws IOException { sink.write(encoded); }
            };
            call = httpClient.newCall(request("/audio/speech").post(body).build());
            call.enqueue(this);
        }
        @Override public void onFailure(Call call, IOException error) {
            fail(error instanceof java.io.InterruptedIOException ? Kind.TIMEOUT : Kind.NETWORK,
                error instanceof java.io.InterruptedIOException ? "speech_timeout" : "speech_network_error", 0);
        }
        @Override public void onResponse(Call call, Response response) {
            try (Response closedResponse = response) {
                if (response.code() != 200) { httpFailure(response, "speech"); return; }
                ResponseBody body = response.body();
                if (body == null || !pcmContentType(body.contentType())) { fail(Kind.PROTOCOL, "speech_invalid_content_type", 200); return; }
                if (body.contentLength() > limits.pcmBytes) { fail(Kind.LIMIT, "speech_duration_limit", 200); return; }
                synchronized (this) { if (ended) return; listener.started(id); }
                long received = 0;
                try (InputStream stream = body.byteStream()) {
                    byte[] buffer = new byte[8192];
                    for (int count; (count = stream.read(buffer)) != -1;) {
                        if (count == 0) continue;
                        received += count;
                        synchronized (this) {
                            if (ended) return;
                            if (received > limits.pcmBytes) { fail(Kind.LIMIT, "speech_duration_limit", 200); return; }
                            listener.pcm(id, SAMPLE_RATE, Arrays.copyOf(buffer, count));
                        }
                    }
                }
                synchronized (this) {
                    if (received == 0) fail(Kind.PROTOCOL, "empty_pcm_stream", 200);
                    else if ((received & 1) != 0) fail(Kind.PROTOCOL, "invalid_pcm", 200);
                    else if (finish()) listener.completed(id);
                }
            } catch (IOException error) {
                fail(error instanceof java.io.InterruptedIOException ? Kind.TIMEOUT : Kind.NETWORK,
                    error instanceof java.io.InterruptedIOException ? "speech_timeout" : "speech_network_error", response.code());
            }
        }
        @Override void stop() { if (call != null) call.cancel(); }
        @Override void failed(Failure failure) { listener.failed(id, failure); }
    }
    private static boolean pcmContentType(MediaType type) {
        return type != null && ((type.type().equals("audio") && type.subtype().equals("pcm")) ||
            (type.type().equals("application") && type.subtype().equals("octet-stream")));
    }

    private final class Recognition extends Operation implements Transcription {
        private final TranscriptionListener listener;
        private final long resultTimeoutMs;
        private WebSocket socket;
        private String sessionId, committedItemId;
        private boolean ready, committed;
        private long sentBytes;
        Recognition(String id, TranscriptionListener listener, long resultTimeoutMs) {
            super(id); this.listener = listener; this.resultTimeoutMs = resultTimeoutMs;
        }
        synchronized void start() {
            if (ended) return;
            deadline(limits.handshakeMs, "recognition_handshake_timeout");
            socket = websocketClient.newWebSocket(request("/realtime?intent=transcription").build(), new WebSocketListener() {
                @Override public void onOpen(WebSocket ws, Response response) {
                    synchronized (Recognition.this) {
                        if (ended) { ws.cancel(); return; }
                        socket = ws;
                        send(NativeVoiceJson.object("type", "session.update", "session", NativeVoiceJson.object("type", "transcription",
                            "audio", NativeVoiceJson.object("input", NativeVoiceJson.object(
                                "format", NativeVoiceJson.object("type", "audio/pcm", "rate", SAMPLE_RATE),
                                "transcription", NativeVoiceJson.object("model", config.transcriptionModel),
                                "turn_detection", null, "noise_reduction", null)))));
                    }
                }
                @Override public void onMessage(WebSocket ws, String text) { receive(text); }
                @Override public void onMessage(WebSocket ws, ByteString bytes) { fail(Kind.PROTOCOL, "recognition_unexpected_binary", 0); }
                @Override public void onClosing(WebSocket ws, int code, String reason) {
                    ws.close(1000, null); fail(Kind.NETWORK, "recognition_disconnected", 0);
                }
                @Override public void onClosed(WebSocket ws, int code, String reason) { fail(Kind.NETWORK, "recognition_disconnected", 0); }
                @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
                    if (response != null && response.code() == 101) fail(Kind.PROTOCOL, "recognition_protocol_error", 101);
                    else if (response != null) httpFailure(response, "recognition");
                    else fail(Kind.NETWORK, "recognition_network_error", 0);
                }
            });
        }
        @Override public synchronized boolean append(byte[] pcm) {
            if (ended) return false;
            if (!ready || committed) { fail(Kind.PROTOCOL, "recognition_invalid_state", 0); return false; }
            if (pcm == null || pcm.length == 0 || pcm.length > MAX_AUDIO_CHUNK_BYTES || (pcm.length & 1) != 0) {
                fail(Kind.PROTOCOL, "recognition_invalid_pcm", 0); return false;
            }
            if (sentBytes + pcm.length > limits.pcmBytes) { fail(Kind.LIMIT, "recognition_audio_limit", 0); return false; }
            if (!send(NativeVoiceJson.object("type", "input_audio_buffer.append", "audio", ByteString.of(pcm).base64()))) return false;
            sentBytes += pcm.length; return true;
        }
        @Override public synchronized boolean commit() {
            if (ended) return false;
            if (!ready || committed || sentBytes < SAMPLE_RATE / 10 * 2) {
                fail(Kind.PROTOCOL, "recognition_invalid_commit", 0); return false;
            }
            committed = true;
            deadline(resultTimeoutMs, "recognition_result_timeout");
            return send(NativeVoiceJson.object("type", "input_audio_buffer.commit"));
        }
        private boolean send(JSONObject event) {
            String text = event.toString();
            if (socket != null && socket.queueSize() + text.length() > MAX_QUEUED_BYTES) {
                fail(Kind.LIMIT, "recognition_transport_overflow", 0); return false;
            }
            if (socket == null || !socket.send(text)) { fail(Kind.NETWORK, "recognition_network_error", 0); return false; }
            return true;
        }
        private synchronized void receive(String text) {
            if (ended) return;
            if (text.length() > MAX_MESSAGE_CHARS) { fail(Kind.LIMIT, "recognition_message_limit", 0); return; }
            try {
                boundedJsonDepth(text);
                JSONObject event = new JSONObject(text);
                String type = string(event, "type", 256);
                switch (type) {
                    case "session.created": {
                        JSONObject session = event.getJSONObject("session");
                        if (!"transcription".equals(session.optString("type")) || sessionId != null) throw new IllegalArgumentException();
                        sessionId = string(session, "id", 256); break;
                    }
                    case "session.updated": {
                        JSONObject session = event.getJSONObject("session");
                        JSONObject input = session.getJSONObject("audio").getJSONObject("input");
                        JSONObject format = input.getJSONObject("format");
                        if (sessionId == null || !sessionId.equals(session.optString("id")) || !"transcription".equals(session.optString("type")) ||
                            !"audio/pcm".equals(format.optString("type")) || NativeVoiceJson.integer(format, "rate", SAMPLE_RATE, SAMPLE_RATE) != SAMPLE_RATE ||
                            !config.transcriptionModel.equals(input.getJSONObject("transcription").optString("model")) ||
                            !input.has("turn_detection") || !input.isNull("turn_detection")) throw new IllegalArgumentException();
                        if (!ready) { ready = true; deadline(limits.requestMs, "recognition_capture_timeout"); listener.ready(id); }
                        break;
                    }
                    case "input_audio_buffer.committed":
                        if (!committed || committedItemId != null) throw new IllegalArgumentException();
                        committedItemId = string(event, "item_id", 256); break;
                    case "conversation.item.input_audio_transcription.completed":
                    case "conversation.item.input_audio_transcription.failed":
                        if (!committed || committedItemId == null || !committedItemId.equals(event.optString("item_id"))) break;
                        NativeVoiceJson.integer(event, "content_index", 0, 0);
                        if (type.endsWith(".failed")) { providerFailure(event.optJSONObject("error")); break; }
                        Object transcript = event.opt("transcript");
                        if (!(transcript instanceof String) || ((String) transcript).length() > 65536) throw new IllegalArgumentException();
                        if (finish()) { stop(); listener.completed(id, (String) transcript); }
                        break;
                    case "error": providerFailure(event.optJSONObject("error")); break;
                    default: break; // Deltas, rate-limit notices and unrelated future events do not finalize this recording.
                }
            } catch (Exception invalid) { fail(Kind.PROTOCOL, "recognition_protocol_error", 0); }
        }
        private void providerFailure(JSONObject error) {
            // Only known codes affect classification. Arbitrary provider codes and messages never become diagnostics.
            String code = error == null ? "" : error.optString("code");
            if (code.equals("invalid_api_key")) fail(Kind.AUTHENTICATION, "recognition_authentication_failed", 0);
            else if (quotaError(error)) fail(Kind.RATE_LIMIT, "recognition_quota_exceeded", 0);
            else if (code.equals("rate_limit_exceeded")) fail(Kind.RATE_LIMIT, "recognition_rate_limited", 0);
            else fail(Kind.PROVIDER, "recognition_provider_error", 0);
        }
        @Override void stop() { if (socket != null) socket.cancel(); }
        @Override void failed(Failure failure) { listener.failed(id, failure); }
    }
    private static String string(JSONObject value, String key, int max) {
        Object text = value.opt(key);
        if (!(text instanceof String) || ((String) text).isEmpty() || ((String) text).length() > max) throw new IllegalArgumentException();
        return (String) text;
    }
    private static boolean quotaError(JSONObject error) {
        return error != null && ("insufficient_quota".equals(error.opt("type")) ||
            "insufficient_quota".equals(error.opt("code")) || "credit_balance_exhausted".equals(error.opt("code")));
    }
    /** Read only the bounded error needed to distinguish exhausted credits from a transient HTTP 429. */
    private static JSONObject responseError(Response response) {
        ResponseBody body = response.body();
        if (body == null || body.contentLength() > MAX_ERROR_BODY_BYTES) return null;
        try (InputStream input = body.byteStream()) {
            byte[] bytes = new byte[MAX_ERROR_BODY_BYTES + 1]; int count = 0;
            while (count < bytes.length) {
                int read = input.read(bytes, count, bytes.length - count);
                if (read < 0) break;
                count += read;
            }
            if (count > MAX_ERROR_BODY_BYTES) return null;
            String text = new String(bytes, 0, count, java.nio.charset.StandardCharsets.UTF_8);
            boundedJsonDepth(text);
            return new JSONObject(text).optJSONObject("error");
        } catch (Exception unreadable) { return null; }
    }
    /** Bound recursive parsers on Android as well as the host JSON library, including ignored event fields. */
    private static void boundedJsonDepth(String text) {
        int depth = 0; boolean quoted = false, escaped = false;
        for (int index = 0; index < text.length(); index++) {
            char value = text.charAt(index);
            if (quoted) {
                if (escaped) escaped = false;
                else if (value == '\\') escaped = true;
                else if (value == '"') quoted = false;
            } else if (value == '"') quoted = true;
            else if ((value == '{' || value == '[') && ++depth > 32) throw new IllegalArgumentException();
            else if (value == '}' || value == ']') depth--;
        }
    }
}
