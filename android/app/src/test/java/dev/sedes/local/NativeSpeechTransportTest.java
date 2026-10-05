package dev.sedes.local;

import static org.junit.Assert.*;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.OkHttpClient;
import org.json.JSONObject;
import org.junit.Test;

/** Exercises the production OkHttp HTTP/WebSocket path against actual loopback sockets. */
public class NativeSpeechTransportTest {
    private static final String TOKEN = "fixture-secret";
    private static final class Recorder implements NativeSpeechTransport.SpeechListener, NativeSpeechTransport.TranscriptionListener {
        final BlockingQueue<String> events = new LinkedBlockingQueue<>();
        final BlockingQueue<NativeSpeechTransport.Failure> failures = new LinkedBlockingQueue<>();
        final ByteArrayOutputStream audio = new ByteArrayOutputStream();
        public void started(String id) { events.add("started:" + id); }
        public void ready(String id) { events.add("ready:" + id); }
        public synchronized void pcm(String id, int rate, byte[] pcm) {
            assertEquals(24000, rate); audio.write(pcm, 0, pcm.length); events.add("pcm:" + id);
        }
        public void completed(String id) { events.add("completed:" + id); }
        public void completed(String id, String text) { events.add("transcript:" + id + ":" + text); }
        public void failed(String id, NativeSpeechTransport.Failure failure) { failures.add(failure); events.add("failed:" + id + ":" + failure.code); }
        String next() throws InterruptedException {
            String event = events.poll(4, TimeUnit.SECONDS); assertNotNull("Missing transport callback", event); return event;
        }
        void quiet() throws InterruptedException { assertNull("Unexpected callback", events.poll(100, TimeUnit.MILLISECONDS)); }
    }
    /** A minimal RFC6455/HTTP peer; request headers and bytes are asserted without mocking OkHttp. */
    private static final class Peer implements Closeable {
        final ServerSocket server = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
        Socket socket;
        DataInputStream in;
        OutputStream out;
        String requestLine;
        final Map<String, String> headers = new HashMap<>();
        byte[] body;
        Peer() throws IOException { server.setSoTimeout(4000); }
        String url() { return "http://127.0.0.1:" + server.getLocalPort() + "/v1"; }
        void accept() throws IOException {
            socket = server.accept(); socket.setSoTimeout(4000);
            in = new DataInputStream(new BufferedInputStream(socket.getInputStream())); out = socket.getOutputStream();
            requestLine = line();
            for (String line = line(); !line.isEmpty(); line = line()) {
                int colon = line.indexOf(':'); headers.put(line.substring(0, colon).toLowerCase(java.util.Locale.ROOT), line.substring(colon + 1).trim());
            }
            body = new byte[Integer.parseInt(headers.getOrDefault("content-length", "0"))]; in.readFully(body);
        }
        String line() throws IOException {
            StringBuilder result = new StringBuilder();
            for (int c; (c = in.read()) != '\n';) { if (c < 0) throw new EOFException(); if (c != '\r') result.append((char) c); }
            return result.toString();
        }
        void upgrade() throws Exception {
            String accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1")
                .digest((headers.get("sec-websocket-key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes(StandardCharsets.US_ASCII)));
            raw("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
        }
        void raw(String text) throws IOException { out.write(text.getBytes(StandardCharsets.US_ASCII)); out.flush(); }
        void response(int status, String contentType, byte[] bytes) throws IOException {
            raw("HTTP/1.1 " + status + " Status\r\nContent-Type: " + contentType + "\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n");
            out.write(bytes); out.flush();
        }
        void chunked(String type) throws IOException {
            raw("HTTP/1.1 200 OK\r\nContent-Type: " + type + "\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
        }
        void chunk(byte[] bytes) throws IOException { raw(Integer.toHexString(bytes.length) + "\r\n"); out.write(bytes); raw("\r\n"); }
        void endChunks() throws IOException { raw("0\r\n\r\n"); }
        void frame(int opcode, byte[] payload) throws IOException {
            ByteArrayOutputStream frame = new ByteArrayOutputStream(); frame.write(0x80 | opcode);
            if (payload.length < 126) frame.write(payload.length);
            else if (payload.length < 65536) { frame.write(126); frame.write(payload.length >> 8); frame.write(payload.length); }
            else { frame.write(127); for (int shift = 56; shift >= 0; shift -= 8) frame.write((int) ((long) payload.length >> shift)); }
            frame.write(payload); out.write(frame.toByteArray()); out.flush();
        }
        void text(String text) throws IOException { frame(1, text.getBytes(StandardCharsets.UTF_8)); }
        void text(JSONObject value) throws IOException { text(value.toString()); }
        JSONObject json() throws Exception {
            int first = in.readUnsignedByte(), second = in.readUnsignedByte(); assertEquals(1, first & 15);
            long length = second & 127;
            if (length == 126) length = in.readUnsignedShort(); else if (length == 127) length = in.readLong();
            assertTrue("Unbounded client frame", length <= 128 * 1024);
            byte[] mask = new byte[4]; assertTrue((second & 128) != 0); in.readFully(mask);
            byte[] data = new byte[(int) length]; in.readFully(data);
            for (int i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
            return new JSONObject(new String(data, StandardCharsets.UTF_8));
        }
        void disconnected() throws IOException { assertEquals("Cancellation did not promptly close the socket", -1, in.read()); }
        void noNewConnection() throws IOException {
            server.setSoTimeout(150);
            try (Socket unexpected = server.accept()) { fail("Request was retried or redirected"); }
            catch (SocketTimeoutException expected) { /* The transport must never replay automatically. */ }
        }
        public void close() throws IOException { if (socket != null) socket.close(); server.close(); }
    }
    private static NativeSpeechTransport transport(Peer peer) {
        return new NativeSpeechTransport(config(peer.url()));
    }
    private static NativeSpeechTransport.Config config(String base) {
        return new NativeSpeechTransport.Config(base, TOKEN, "fixture-stt", "fixture-tts", "fixture-voice", 1.25);
    }
    private static JSONObject session() {
        return NativeVoiceJson.object("id", "session-1", "object", "realtime.transcription_session", "type", "transcription", "audio",
            NativeVoiceJson.object("input", NativeVoiceJson.object("format", NativeVoiceJson.object("type", "audio/pcm", "rate", 24000),
                "transcription", NativeVoiceJson.object("model", "fixture-stt"), "turn_detection", null, "noise_reduction", null)));
    }
    private static void handshake(Peer peer, Recorder recorder) throws Exception {
        peer.accept();
        assertEquals("GET /v1/realtime?intent=transcription HTTP/1.1", peer.requestLine);
        assertEquals("Bearer " + TOKEN, peer.headers.get("authorization")); assertFalse(peer.headers.containsKey("openai-beta"));
        peer.upgrade();
        JSONObject update = peer.json(); assertEquals("session.update", update.getString("type"));
        assertEquals("transcription", update.getJSONObject("session").getString("type"));
        JSONObject input = update.getJSONObject("session").getJSONObject("audio").getJSONObject("input");
        assertEquals("audio/pcm", input.getJSONObject("format").getString("type"));
        assertEquals(24000, input.getJSONObject("format").getInt("rate")); assertEquals("fixture-stt", input.getJSONObject("transcription").getString("model"));
        assertTrue(input.has("turn_detection") && input.isNull("turn_detection"));
        assertTrue(input.has("noise_reduction") && input.isNull("noise_reduction"));
        peer.text(NativeVoiceJson.object("type", "session.created", "event_id", "server-created-event", "session", session()));
        recorder.quiet();
        peer.text(NativeVoiceJson.object("type", "session.updated", "event_id", "unrelated-server-update-id", "session", session()));
        assertEquals("ready:stt", recorder.next());
    }
    private static void commit(Peer peer, NativeSpeechTransport.Transcription request) throws Exception {
        byte[] input = new byte[4800]; input[0] = 42; input[4799] = 63;
        assertTrue(request.append(input));
        JSONObject append = peer.json(); assertEquals("input_audio_buffer.append", append.getString("type"));
        assertArrayEquals(input, Base64.getDecoder().decode(append.getString("audio")));
        assertTrue(request.commit()); assertEquals("input_audio_buffer.commit", peer.json().getString("type"));
        peer.text(NativeVoiceJson.object("type", "input_audio_buffer.committed", "item_id", "item-1", "previous_item_id", null));
    }
    private static JSONObject completed(String item, String text) {
        return NativeVoiceJson.object("type", "conversation.item.input_audio_transcription.completed", "event_id", "independent-final-id",
            "item_id", item, "content_index", 0, "transcript", text, "usage", NativeVoiceJson.object("type", "duration", "seconds", .1),
            "languages", new org.json.JSONArray().put("en"), "logprobs", new org.json.JSONArray());
    }

    @Test(timeout = 10000) public void preparedNotificationChunksReachTheSpeechProvider() throws Exception {
        String markdown = "# Answer\n\nRead [the guide][ref].\n\n```\nfoo_bar * 2\n```\n\n[ref]: https://example.test/hidden";
        JSONObject envelope = NativeVoiceJson.object("sourceEventId", "formatted", "generation", 1, "voice", "speak",
            "payload", NativeVoiceJson.object("schemaVersion", 4, "notificationId", "formatted", "event", "turn.completed",
                "occurredAt", "2026-10-04T00:00:00Z", "title", "Completed", "message", "Context",
                "assistantResult", NativeVoiceJson.object("final", NativeVoiceJson.object("text", markdown))));
        String expected = "Answer\n\nRead the guide.\n\nfoo_bar * 2";
        for (boolean cleanup : new boolean[] { true, false }) {
            NativeVoiceSettings settings = NativeVoiceSettings.defaults().patch(0,
                NativeVoiceJson.object("audioMode", "response", "readNotificationContext", false, "cleanSpeechText", cleanup));
            NativeVoiceQueue.Item item = new NativeVoiceQueue.Item(envelope, settings);
            StringBuilder received = new StringBuilder();
            for (String chunk : NativeVoiceQueue.chunks(item.speech, 24)) {
                Recorder recorder = new Recorder();
                try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
                    transport.speak("tts", chunk, recorder); peer.accept();
                    assertEquals("POST /v1/audio/speech HTTP/1.1", peer.requestLine);
                    received.append(new JSONObject(new String(peer.body, StandardCharsets.UTF_8)).getString("input"));
                    peer.response(200, "audio/pcm", new byte[] { 1, 2 });
                    assertEquals("started:tts", recorder.next()); assertEquals("pcm:tts", recorder.next());
                    assertEquals("completed:tts", recorder.next());
                }
            }
            assertEquals(cleanup ? expected : markdown, received.toString());
            assertEquals(markdown, envelope.getJSONObject("payload").getJSONObject("assistantResult").getJSONObject("final").getString("text"));
        }
    }

    @Test(timeout = 10000) public void gaHandshakeCommitsExactlyOneRecordingAndCorrelatesFinal() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            NativeSpeechTransport.Transcription request = transport.transcribe("stt", 5000, recorder);
            handshake(peer, recorder); commit(peer, request);
            peer.text(NativeVoiceJson.object("type", "rate_limits.updated", "new_field", true));
            peer.text(NativeVoiceJson.object("type", "future.unrelated.event", "future", "Quoted brace [\\\" does not change nesting."));
            peer.text(completed("different-item", "must not submit"));
            peer.text(NativeVoiceJson.object("type", "conversation.item.input_audio_transcription.delta", "item_id", "item-1", "delta", "not final"));
            recorder.quiet();
            peer.text(completed("item-1", "Final transcript."));
            assertEquals("transcript:stt:Final transcript.", recorder.next());
            assertFalse(request.append(new byte[4800])); assertFalse(request.commit()); request.cancel(); recorder.quiet();
            peer.noNewConnection();
        }
    }
    @Test(timeout = 10000) public void invalidEffectiveConfigurationFailsBeforeReady() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            transport.transcribe("stt", 5000, recorder); peer.accept(); peer.upgrade(); peer.json();
            peer.text(NativeVoiceJson.object("type", "session.created", "session", session()));
            JSONObject changed = session(); changed.getJSONObject("audio").getJSONObject("input").put("turn_detection", NativeVoiceJson.object("type", "server_vad"));
            peer.text(NativeVoiceJson.object("type", "session.updated", "session", changed));
            assertEquals("failed:stt:recognition_protocol_error", recorder.next()); recorder.quiet();
        }
    }
    @Test(timeout = 10000) public void appendBeforeAcknowledgementFailsWithoutSendingAudio() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            NativeSpeechTransport.Transcription request = transport.transcribe("stt", 5000, recorder);
            peer.accept(); peer.upgrade(); peer.json();
            assertFalse(request.append(new byte[4800]));
            assertEquals("failed:stt:recognition_invalid_state", recorder.next()); peer.disconnected(); recorder.quiet();
        }
    }
    @Test(timeout = 10000) public void duplicateCommitFailsAndNeverReplaysAudio() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            NativeSpeechTransport.Transcription request = transport.transcribe("stt", 5000, recorder);
            handshake(peer, recorder); commit(peer, request);
            assertFalse(request.commit()); assertEquals("failed:stt:recognition_invalid_commit", recorder.next());
            peer.disconnected(); peer.noNewConnection(); recorder.quiet();
        }
    }
    @Test(timeout = 10000) public void cancellationClosesWebSocketBeforeUpgradeAndSuppressesCallbacks() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            NativeSpeechTransport.Transcription request = transport.transcribe("stt", 5000, recorder);
            peer.accept(); request.cancel(); peer.disconnected(); recorder.quiet(); peer.noNewConnection();
        }
    }
    @Test(timeout = 10000) public void committedCancellationSuppressesFinalAndNeverReconnects() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            NativeSpeechTransport.Transcription request = transport.transcribe("stt", 5000, recorder);
            handshake(peer, recorder); commit(peer, request); request.cancel();
            peer.disconnected(); recorder.quiet(); peer.noNewConnection();
        }
    }
    @Test(timeout = 10000) public void handshakeAndCommittedResultHaveIndependentDeadlines() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = new NativeSpeechTransport(config(peer.url()), new OkHttpClient(),
            new NativeSpeechTransport.Limits(150, 1000, 5000, NativeSpeechTransport.MAX_PCM_BYTES))) {
            transport.transcribe("stt", 1000, recorder); peer.accept();
            assertEquals("failed:stt:recognition_handshake_timeout", recorder.next()); peer.disconnected();
        }
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            NativeSpeechTransport.Transcription request = transport.transcribe("stt", 1000, recorder);
            handshake(peer, recorder); commit(peer, request);
            assertEquals("failed:stt:recognition_result_timeout", recorder.next()); peer.disconnected(); recorder.quiet();
        }
    }
    @Test(timeout = 10000) public void correlatedProviderFailureIsSafeAndReportedOnce() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            NativeSpeechTransport.Transcription request = transport.transcribe("stt", 5000, recorder);
            handshake(peer, recorder); commit(peer, request);
            JSONObject failure = NativeVoiceJson.object("type", "conversation.item.input_audio_transcription.failed", "item_id", "unrelated", "content_index", 0,
                "error", NativeVoiceJson.object("code", TOKEN, "message", TOKEN));
            peer.text(failure); recorder.quiet(); failure.put("item_id", "item-1"); peer.text(failure);
            assertEquals("failed:stt:recognition_provider_error", recorder.next());
            assertEquals(NativeSpeechTransport.Kind.PROVIDER, recorder.failures.take().kind); recorder.quiet();
        }
    }
    @Test(timeout = 10000) public void malformedAndOversizedJsonFailSafely() throws Exception {
        for (String input : new String[] { "{", "{\"type\":42}", "[".repeat(1000) + "]".repeat(1000), " ".repeat(NativeSpeechTransport.MAX_MESSAGE_CHARS + 1) }) {
            Recorder recorder = new Recorder();
            try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
                transport.transcribe("stt", 5000, recorder); handshake(peer, recorder); peer.text(input);
                String expected = input.length() > NativeSpeechTransport.MAX_MESSAGE_CHARS ? "recognition_message_limit" : "recognition_protocol_error";
                assertEquals("failed:stt:" + expected, recorder.next()); recorder.quiet();
            }
        }
    }
    @Test(timeout = 10000) public void ttsStreamsRawPartialChunksAndCompletesOnlyAtEof() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            transport.speak("tts", "Hello world", recorder); peer.accept();
            assertEquals("POST /v1/audio/speech HTTP/1.1", peer.requestLine); assertEquals("Bearer " + TOKEN, peer.headers.get("authorization"));
            JSONObject body = new JSONObject(new String(peer.body, StandardCharsets.UTF_8));
            assertEquals("Hello world", body.getString("input")); assertEquals("fixture-tts", body.getString("model"));
            assertEquals("fixture-voice", body.getString("voice")); assertEquals("pcm", body.getString("response_format"));
            assertEquals(1.25, body.getDouble("speed"), 0);
            peer.chunked("application/octet-stream"); assertEquals("started:tts", recorder.next());
            peer.chunk(new byte[] { 1, 2, 3 }); assertEquals("pcm:tts", recorder.next()); recorder.quiet();
            peer.chunk(new byte[] { 4, 5, 6 }); assertEquals("pcm:tts", recorder.next());
            peer.endChunks(); assertEquals("completed:tts", recorder.next());
            assertArrayEquals(new byte[] { 1, 2, 3, 4, 5, 6 }, recorder.audio.toByteArray()); recorder.quiet();
        }
    }
    @Test(timeout = 10000) public void httpFailureStatusesAreNeverTreatedAsSuccessfulEmptySpeech() throws Exception {
        for (int status : new int[] { 400, 401, 403, 429, 500 }) {
            Recorder recorder = new Recorder();
            try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
                transport.speak("tts", "Text", recorder); peer.accept(); peer.response(status, "application/json", TOKEN.getBytes(StandardCharsets.US_ASCII));
                assertTrue(recorder.next().startsWith("failed:tts:"));
                NativeSpeechTransport.Failure failure = recorder.failures.take(); assertEquals(status, failure.httpStatus); assertFalse(failure.code.contains(TOKEN));
                assertEquals(status == 401 || status == 403 ? NativeSpeechTransport.Kind.AUTHENTICATION :
                    status == 429 ? NativeSpeechTransport.Kind.RATE_LIMIT : NativeSpeechTransport.Kind.HTTP, failure.kind);
                recorder.quiet();
            }
        }
    }
    @Test(timeout = 10000) public void credentialsAreNeverForwardedByRedirectsForHttpOrWebSocket() throws Exception {
        for (boolean speech : new boolean[] { true, false }) {
            Recorder recorder = new Recorder();
            try (Peer peer = new Peer(); Peer destination = new Peer(); NativeSpeechTransport transport = transport(peer)) {
                if (speech) transport.speak("tts", "Text", recorder); else transport.transcribe("stt", 5000, recorder);
                peer.accept(); peer.raw("HTTP/1.1 307 Redirect\r\nLocation: " + destination.url() + "/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                assertTrue(recorder.next().startsWith("failed:")); assertEquals(307, recorder.failures.take().httpStatus);
                destination.noNewConnection(); recorder.quiet();
            }
        }
    }
    @Test(timeout = 10000) public void ttsCancellationBeforeHeadersImmediatelyAbortsHttpCall() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            NativeSpeechTransport.Request request = transport.speak("tts", "Text", recorder); peer.accept();
            request.cancel(); peer.disconnected(); recorder.quiet(); peer.noNewConnection();
        }
    }
    @Test(timeout = 10000) public void cancellationWhileStreamingAndTransportCloseFenceCallbacks() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            transport.speak("tts", "Text", recorder); peer.accept(); peer.chunked("audio/pcm");
            assertEquals("started:tts", recorder.next()); peer.chunk(new byte[] { 1, 2 }); assertEquals("pcm:tts", recorder.next());
            transport.close(); peer.disconnected(); recorder.quiet();
            transport.speak("late", "Text", recorder); assertEquals("failed:late:speech_transport_closed", recorder.next()); peer.noNewConnection();
        }
    }
    @Test(timeout = 10000) public void ttsNeverRetries503EvenWithRetryAfterZero() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            transport.speak("tts", "Text", recorder); peer.accept();
            peer.raw("HTTP/1.1 503 Unavailable\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            assertEquals("failed:tts:speech_http_error", recorder.next()); assertEquals(503, recorder.failures.take().httpStatus); peer.noNewConnection();
        }
    }
    @Test(timeout = 10000) public void unexpectedContentTypeAndEmptyOrOddPcmAreFailures() throws Exception {
        for (String type : new String[] { "application/json", "text/event-stream", "audio/mpeg" }) {
            Recorder recorder = new Recorder();
            try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
                transport.speak("tts", "Text", recorder); peer.accept(); peer.response(200, type, new byte[] { 1, 2 });
                assertEquals("failed:tts:speech_invalid_content_type", recorder.next()); recorder.quiet();
            }
        }
        for (int length : new int[] { 0, 3 }) {
            Recorder recorder = new Recorder();
            try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
                transport.speak("tts", "Text", recorder); peer.accept(); peer.response(200, "audio/pcm", new byte[length]);
                assertEquals("started:tts", recorder.next()); if (length > 0) assertEquals("pcm:tts", recorder.next());
                assertEquals("failed:tts:" + (length == 0 ? "empty_pcm_stream" : "invalid_pcm"), recorder.next()); recorder.quiet();
            }
        }
    }
    @Test(timeout = 10000) public void declaredAndStreamingPcmLimitsAreEnforcedBeforeDeliveringExcess() throws Exception {
        for (boolean declared : new boolean[] { true, false }) {
            Recorder recorder = new Recorder();
            try (Peer peer = new Peer(); NativeSpeechTransport transport = new NativeSpeechTransport(config(peer.url()), new OkHttpClient(),
                new NativeSpeechTransport.Limits(1000, 1000, 5000, 4))) {
                transport.speak("tts", "Text", recorder); peer.accept();
                if (declared) peer.raw("HTTP/1.1 200 OK\r\nContent-Type: audio/pcm\r\nContent-Length: 6\r\n\r\n");
                else {
                    peer.chunked("audio/pcm"); assertEquals("started:tts", recorder.next());
                    peer.chunk(new byte[] { 1, 2 }); assertEquals("pcm:tts", recorder.next()); peer.chunk(new byte[] { 3, 4, 5, 6 });
                }
                assertEquals("failed:tts:speech_duration_limit", recorder.next()); assertTrue(recorder.audio.size() <= 4); recorder.quiet();
            }
        }
    }
    @Test(timeout = 10000) public void httpReadTimeoutRetainsReceivedHttpStatus() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = new NativeSpeechTransport(config(peer.url()), new OkHttpClient(),
            new NativeSpeechTransport.Limits(1000, 150, 5000, 48000))) {
            transport.speak("tts", "Text", recorder); peer.accept(); peer.chunked("audio/pcm");
            assertEquals("started:tts", recorder.next()); assertEquals("failed:tts:speech_timeout", recorder.next());
            NativeSpeechTransport.Failure failure = recorder.failures.take(); assertEquals(200, failure.httpStatus); assertEquals(NativeSpeechTransport.Kind.TIMEOUT, failure.kind);
        }
    }
    @Test(timeout = 10000) public void providerErrorAndPeerCloseTerminateOnlyTheirRecording() throws Exception {
        for (boolean providerError : new boolean[] { true, false }) {
            Recorder recorder = new Recorder();
            try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
                transport.transcribe("stt", 5000, recorder); handshake(peer, recorder);
                if (providerError) peer.text(NativeVoiceJson.object("type", "error", "error", NativeVoiceJson.object("message", TOKEN, "code", TOKEN)));
                else peer.frame(8, new byte[] { 3, (byte) 232 });
                assertEquals("failed:stt:" + (providerError ? "recognition_provider_error" : "recognition_disconnected"), recorder.next());
                recorder.quiet(); peer.noNewConnection();
            }
        }
    }
    @Test(timeout = 10000) public void nonIntegralEffectiveRateAndContentIndexAreRejected() throws Exception {
        for (boolean fractionalRate : new boolean[] { true, false }) {
            Recorder recorder = new Recorder();
            try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
                NativeSpeechTransport.Transcription request = transport.transcribe("stt", 5000, recorder);
                if (fractionalRate) {
                    peer.accept(); peer.upgrade(); peer.json(); peer.text(NativeVoiceJson.object("type", "session.created", "session", session()));
                    JSONObject fractional = session(); fractional.getJSONObject("audio").getJSONObject("input").getJSONObject("format").put("rate", 24000.5);
                    peer.text(NativeVoiceJson.object("type", "session.updated", "session", fractional));
                } else {
                    handshake(peer, recorder); commit(peer, request); JSONObject result = completed("item-1", "invalid index");
                    result.put("content_index", .5); peer.text(result);
                }
                assertEquals("failed:stt:recognition_protocol_error", recorder.next()); recorder.quiet();
            }
        }
    }
    @Test(timeout = 10000) public void boundedOutboundAudioRejectsOversizedChunksAndTotalDuration() throws Exception {
        for (boolean oversizedChunk : new boolean[] { true, false }) {
            Recorder recorder = new Recorder();
            try (Peer peer = new Peer(); NativeSpeechTransport transport = new NativeSpeechTransport(config(peer.url()), new OkHttpClient(),
                new NativeSpeechTransport.Limits(1000, 1000, 5000, 4800))) {
                NativeSpeechTransport.Transcription request = transport.transcribe("stt", 5000, recorder); handshake(peer, recorder);
                if (oversizedChunk) assertFalse(request.append(new byte[NativeSpeechTransport.MAX_AUDIO_CHUNK_BYTES + 2]));
                else { assertTrue(request.append(new byte[4800])); peer.json(); assertFalse(request.append(new byte[2])); }
                assertEquals("failed:stt:" + (oversizedChunk ? "recognition_invalid_pcm" : "recognition_audio_limit"), recorder.next()); recorder.quiet();
            }
        }
    }
    @Test(timeout = 10000) public void optionalCredentialIsAbsentAndTruncatedBodyNeverCompletes() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = new NativeSpeechTransport(
            new NativeSpeechTransport.Config(peer.url(), null, "stt", "tts", "voice", 1))) {
            transport.speak("tts", "Text", recorder); peer.accept(); assertFalse(peer.headers.containsKey("authorization"));
            peer.raw("HTTP/1.1 200 OK\r\nContent-Type: audio/pcm\r\nContent-Length: 4\r\nConnection: close\r\n\r\n");
            assertEquals("started:tts", recorder.next()); peer.out.write(new byte[] { 1, 2 }); peer.out.flush();
            assertEquals("pcm:tts", recorder.next()); peer.socket.close();
            assertEquals("failed:tts:speech_network_error", recorder.next()); assertEquals(200, recorder.failures.take().httpStatus); recorder.quiet();
        }
    }
    @Test(timeout = 10000) public void websocketHandshakeStatusFailuresHaveAccurateKinds() throws Exception {
        for (int status : new int[] { 401, 429, 503 }) {
            Recorder recorder = new Recorder();
            try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
                transport.transcribe("stt", 5000, recorder); peer.accept(); peer.response(status, "application/json", new byte[0]);
                assertTrue(recorder.next().startsWith("failed:stt:"));
                NativeSpeechTransport.Failure failure = recorder.failures.take(); assertEquals(status, failure.httpStatus);
                assertEquals(status == 401 ? NativeSpeechTransport.Kind.AUTHENTICATION :
                    status == 429 ? NativeSpeechTransport.Kind.RATE_LIMIT : NativeSpeechTransport.Kind.HTTP, failure.kind);
                peer.noNewConnection(); recorder.quiet();
            }
        }
    }
    @Test(timeout = 10000) public void websocket503RetryIsConfinedToBodylessPreUpgradeGet() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            transport.transcribe("stt", 5000, recorder); peer.accept();
            String initialRequest = peer.requestLine;
            assertEquals("GET /v1/realtime?intent=transcription HTTP/1.1", initialRequest); assertEquals(0, peer.body.length);
            peer.raw("HTTP/1.1 503 Unavailable\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); peer.socket.close();
            peer.accept(); assertEquals(initialRequest, peer.requestLine); assertEquals(0, peer.body.length);
            recorder.quiet();
            peer.raw("HTTP/1.1 503 Unavailable\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            assertEquals("failed:stt:recognition_http_error", recorder.next()); assertEquals(503, recorder.failures.take().httpStatus);
            peer.noNewConnection(); recorder.quiet();
        }
    }
    @Test(timeout = 10000) public void rejected101UpgradeIsAProtocolFailure() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            transport.transcribe("stt", 5000, recorder); peer.accept();
            peer.raw("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: invalid\r\n\r\n");
            assertEquals("failed:stt:recognition_protocol_error", recorder.next());
            NativeSpeechTransport.Failure failure = recorder.failures.take();
            assertEquals(NativeSpeechTransport.Kind.PROTOCOL, failure.kind); assertEquals(101, failure.httpStatus); recorder.quiet();
        }
    }
    @Test(timeout = 10000) public void inBandFailureCodesUseOnlySafeAuthenticationRateAndQuotaMappings() throws Exception {
        for (String code : new String[] { "invalid_api_key", "rate_limit_exceeded", "insufficient_quota", "credit_balance_exhausted", TOKEN }) {
            Recorder recorder = new Recorder();
            try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
                transport.transcribe("stt", 5000, recorder); handshake(peer, recorder);
                peer.text(NativeVoiceJson.object("type", "error", "error", NativeVoiceJson.object("code", code, "message", TOKEN)));
                assertTrue(recorder.next().startsWith("failed:stt:"));
                NativeSpeechTransport.Failure failure = recorder.failures.take();
                assertEquals(code.equals("invalid_api_key") ? NativeSpeechTransport.Kind.AUTHENTICATION :
                    code.equals(TOKEN) ? NativeSpeechTransport.Kind.PROVIDER : NativeSpeechTransport.Kind.RATE_LIMIT, failure.kind);
                if (code.equals("insufficient_quota") || code.equals("credit_balance_exhausted")) assertEquals("recognition_quota_exceeded", failure.code);
                assertFalse(failure.code.contains(TOKEN)); assertEquals(0, failure.httpStatus); recorder.quiet();
            }
        }
    }
    @Test(timeout = 10000) public void duplicateAndInvalidIdsThrowWithoutEndingTheExistingRequest() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            NativeSpeechTransport.Transcription request = transport.transcribe("stt", 5000, recorder); handshake(peer, recorder);
            for (String id : new String[] { "stt", null, "", "x".repeat(257) }) {
                try { transport.speak(id, "Text", recorder); fail("Invalid or duplicate ID accepted"); }
                catch (IllegalArgumentException expected) {
                    assertEquals("stt".equals(id) ? "speech_duplicate_request_id" : "speech_invalid_request_id", expected.getMessage());
                }
                recorder.quiet();
            }
            commit(peer, request); peer.text(completed("item-1", "still active"));
            assertEquals("transcript:stt:still active", recorder.next()); recorder.quiet();
        }
    }
    @Test(timeout = 10000) public void requestLimitReportsSynchronouslyAndExistingRequestsRemainCancellable() throws Exception {
        Recorder recorder = new Recorder(); java.util.List<Socket> sockets = new java.util.ArrayList<>();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            for (int index = 0; index < 4; index++) {
                transport.speak("tts-" + index, "Text", recorder); peer.accept(); sockets.add(peer.socket);
            }
            transport.speak("excess", "Text", recorder);
            assertEquals("failed:excess:speech_request_limit", recorder.events.poll());
            assertEquals(NativeSpeechTransport.Kind.CONFIGURATION, recorder.failures.take().kind);
            transport.close(); recorder.quiet(); peer.noNewConnection();
        } finally { for (Socket socket : sockets) socket.close(); }
    }
    private static java.lang.reflect.Field field(Object target, String name) throws Exception {
        for (Class<?> type = target.getClass(); type != null; type = type.getSuperclass()) {
            try { java.lang.reflect.Field result = type.getDeclaredField(name); result.setAccessible(true); return result; }
            catch (NoSuchFieldException absent) { /* Look on the private operation superclass. */ }
        }
        throw new NoSuchFieldException(name);
    }
    private static java.lang.reflect.Method method(Class<?> type, String name, Class<?>... arguments) throws Exception {
        java.lang.reflect.Method result = type.getDeclaredMethod(name, arguments); result.setAccessible(true); return result;
    }
    private static void awaitBlockedDeadline(Thread thread) {
        long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (System.nanoTime() < until) {
            // This dedicated worker only runs the scheduled deadline. Its executor uses parking, while the
            // deadline's operation monitor is the only intrinsic lock that can put this thread in BLOCKED.
            if (thread.getState() == Thread.State.BLOCKED) return;
            Thread.yield();
        }
        fail("Deadline task did not enter the operation monitor wait");
    }
    @Test(timeout = 10000) public void anAlreadyRunningOldDeadlineCannotFailTheNextPhase() throws Exception {
        for (boolean handshakePhase : new boolean[] { true, false }) {
            Recorder recorder = new Recorder();
            try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
                // Capture the actual deadline thread, then hold its target monitor until its old timer has begun.
                // Reflection gives a deterministic interleaving without adding a timing hook to production code.
                ScheduledThreadPoolExecutor scheduler = (ScheduledThreadPoolExecutor) field(transport, "deadlines").get(transport);
                AtomicReference<Thread> deadlineThread = new AtomicReference<>();
                scheduler.setThreadFactory(work -> { Thread thread = new Thread(work, "test-speech-deadline"); thread.setDaemon(true); deadlineThread.set(thread); return thread; });
                NativeSpeechTransport.Transcription request = transport.transcribe("stt", 5000, recorder);
                if (handshakePhase) { peer.accept(); peer.upgrade(); peer.json(); }
                else { handshake(peer, recorder); assertTrue(request.append(new byte[4800])); peer.json(); }
                synchronized (request) {
                    method(request.getClass().getSuperclass(), "deadline", long.class, String.class).invoke(request, 0L,
                        handshakePhase ? "recognition_handshake_timeout" : "recognition_capture_timeout");
                    awaitBlockedDeadline(deadlineThread.get());
                    if (handshakePhase) {
                        java.lang.reflect.Method receive = method(request.getClass(), "receive", String.class);
                        receive.invoke(request, NativeVoiceJson.object("type", "session.created", "session", session()).toString());
                        receive.invoke(request, NativeVoiceJson.object("type", "session.updated", "session", session()).toString());
                    } else assertTrue(request.commit());
                }
                scheduler.submit(() -> {}).get(3, TimeUnit.SECONDS); // The stale timer has finished trying to acquire the monitor.
                if (handshakePhase) assertEquals("ready:stt", recorder.next());
                recorder.quiet();
                if (handshakePhase) commit(peer, request);
                else { assertEquals("input_audio_buffer.commit", peer.json().getString("type")); peer.text(NativeVoiceJson.object("type", "input_audio_buffer.committed", "item_id", "item-1")); }
                peer.text(completed("item-1", "next phase survived"));
                assertEquals("transcript:stt:next phase survived", recorder.next()); recorder.quiet();
            }
        }
    }
    @Test(timeout = 10000) public void closedWebSocketSendIsNetworkFailureRatherThanBackpressure() throws Exception {
        Recorder recorder = new Recorder();
        try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
            NativeSpeechTransport.Transcription request = transport.transcribe("stt", 5000, recorder); handshake(peer, recorder);
            synchronized (request) {
                okhttp3.WebSocket socket = (okhttp3.WebSocket) field(request, "socket").get(request);
                assertTrue(socket.close(1000, null)); assertFalse(request.append(new byte[4800]));
            }
            assertEquals("failed:stt:recognition_network_error", recorder.next());
            assertEquals(NativeSpeechTransport.Kind.NETWORK, recorder.failures.take().kind); recorder.quiet();
        }
    }
    @Test(timeout = 10000) public void exhaustedQuotaIsDistinctFromTransientHttp429WithoutExposingProviderMessages() throws Exception {
        for (boolean speech : new boolean[] { true, false }) {
            Recorder recorder = new Recorder();
            try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
                if (speech) transport.speak("tts", "Text", recorder); else transport.transcribe("stt", 5000, recorder);
                peer.accept();
                peer.response(429, "application/json", NativeVoiceJson.object("error", NativeVoiceJson.object(
                    "type", "insufficient_quota", "code", "credit_balance_exhausted", "message", TOKEN)).toString().getBytes(StandardCharsets.UTF_8));
                assertEquals("failed:" + (speech ? "tts:speech" : "stt:recognition") + "_quota_exceeded", recorder.next());
                NativeSpeechTransport.Failure failure = recorder.failures.take();
                assertEquals(429, failure.httpStatus); assertEquals(NativeSpeechTransport.Kind.RATE_LIMIT, failure.kind); recorder.quiet();
            }
        }
    }
    @Test(timeout = 10000) public void unreadableAndOversizedHttp429BodiesRemainBoundedRateFailures() throws Exception {
        for (String mode : new String[] { "malformed", "declared", "chunked" }) {
            Recorder recorder = new Recorder();
            try (Peer peer = new Peer(); NativeSpeechTransport transport = transport(peer)) {
                transport.speak("tts", "Text", recorder); peer.accept();
                if (mode.equals("malformed")) peer.response(429, "application/json", "{".getBytes(StandardCharsets.UTF_8));
                else if (mode.equals("declared")) peer.raw("HTTP/1.1 429 Rate Limited\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n");
                else {
                    peer.raw("HTTP/1.1 429 Rate Limited\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
                    peer.chunk(("{\"error\":{\"code\":\"credit_balance_exhausted\"}}" + " ".repeat(NativeSpeechTransport.MAX_ERROR_BODY_BYTES)).getBytes(StandardCharsets.UTF_8));
                }
                assertEquals("failed:tts:speech_rate_limited", recorder.next()); assertEquals(429, recorder.failures.take().httpStatus); recorder.quiet();
            }
        }
    }
    @Test public void invalidConfigurationNeverIncludesCredentialValuesInErrors() {
        for (String url : new String[] { "https://user:" + TOKEN + "@example.com/v1", "https://example.com/v1?secret=" + TOKEN, "file:///tmp/" + TOKEN }) {
            try { config(url); fail("Invalid URL accepted"); }
            catch (IllegalArgumentException invalid) { assertEquals("invalid_speech_base_url", invalid.getMessage()); assertNull(invalid.getCause()); }
        }
        try { new NativeSpeechTransport.Config("https://example.com/v1", TOKEN + "\r\n", "stt", "tts", "voice", 1); fail(); }
        catch (IllegalArgumentException invalid) { assertEquals("invalid_speech_credential", invalid.getMessage()); assertNull(invalid.getCause()); }
    }
}
