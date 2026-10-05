package dev.sedes.local;

import static org.junit.Assert.*;
import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;

/** The actual Android wire transport against a real local server and supervised
 * fake workers. No Android framework, microphone, speaker, or Keystore is used.
 * Run only through scripts/test-speech-transport.mjs. */
public class NativeVoiceSpeechIntegrationTest {
    private static final int WAIT_MS = 10000;
    private static final String SMOKE_PHRASE = "The quick brown fox jumps over the lazy dog.";
    private OkHttpClient client;
    private final List<NativeSpeechTransport> transports = new ArrayList<>();
    private boolean live;

    @Before public void setup() throws Exception {
        Assume.assumeTrue("Use npm run test:speech for the isolated socket lane", "1".equals(System.getenv("SEDES_SPEECH_TRANSPORT_TEST")));
        live = "1".equals(System.getenv("SEDES_SPEECH_TEST_LIVE"));
        client = new OkHttpClient.Builder().connectTimeout(5, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS)
            .callTimeout(5, TimeUnit.SECONDS).followRedirects(false).retryOnConnectionFailure(false).build();
        if (!live) control(NativeVoiceJson.object("reset", true, "transcripts", new org.json.JSONArray().put("test transcript"),
            "asrDelayMs", 0, "ttsDurationSeconds", 1));
    }

    @After public void cleanup() {
        for (NativeSpeechTransport transport : transports) transport.close();
        if (client != null) { client.connectionPool().evictAll(); client.dispatcher().executorService().shutdownNow(); }
    }

    @Test(timeout = 20000) public void localHttpStreamsExactPcmThroughTheActualTransport() throws Exception {
        localOnly();
        SpeechRecorder recorder = new SpeechRecorder();
        transport().speak("http-pcm", "Fixture voice", recorder);
        Event completed = recorder.terminal(WAIT_MS);
        assertEquals("completed", completed.type);
        assertEquals("http-pcm", completed.id);
        assertEquals(24000, recorder.sampleRate);
        assertTrue("HTTP audio arrived incrementally", recorder.chunks > 1);
        assertEquals(48000, recorder.bytes().length);
        assertEquals(env("SEDES_SPEECH_TEST_PCM_SHA256"), sha256(recorder.bytes()));
        assertEquals("Fixture voice", observations().getJSONArray("speech").getJSONObject(0).getString("text"));
        assertEquals(1, observations().getJSONArray("speech").length());
    }

    @Test(timeout = 20000) public void localReusableConnectionCommitsEachSegmentOnceAndBuffersTheNextDuringRecognition() throws Exception {
        localOnly();
        control(NativeVoiceJson.object("transcripts", new org.json.JSONArray().put("first result").put("second result"), "asrDelayMs", 500));
        NativeSpeechTransport transport = transport();
        RecognitionRecorder recorder = new RecognitionRecorder();
        NativeSpeechTransport.RecognitionSession session = transport.openRecognition("reusable", capabilities(), WAIT_MS, recorder);
        Event ready = recorder.expect("ready"); assertEquals("reusable", ready.id);
        assertTrue("The server advertises enough lifetime to assign a full segment", session.canAssign(60000));
        append(session, "first", prerecordedPcm());
        assertNull("Appending must not finalize recognition", recorder.events.poll(100, TimeUnit.MILLISECONDS));
        assertEquals(0, observations().getJSONArray("transcriptions").length());
        assertEquals(NativeSpeechTransport.SendResult.ACCEPTED, session.commit("first"));
        Event firstAck = recorder.acknowledged("first");
        append(session, "second", prerecordedPcm());
        assertEquals("Only one committed recognition job may run", NativeSpeechTransport.SendResult.WAITING, session.commit("second"));
        Event first = recorder.expect("completed");
        assertEquals("first", first.id); assertEquals("first result", first.text); assertEquals(firstAck.itemId, first.itemId);
        assertEquals(NativeSpeechTransport.SendResult.ACCEPTED, session.commit("second"));
        Event secondAck = recorder.acknowledged("second");
        Event second = recorder.expect("completed");
        assertEquals("second", second.id); assertEquals("second result", second.text); assertEquals(secondAck.itemId, second.itemId);
        assertNotEquals("Each commit has a separate server item", first.itemId, second.itemId);
        assertNull("A completed segment finalized twice", recorder.events.poll(100, TimeUnit.MILLISECONDS));
        assertTrue("Successful results preserve the reusable connection", session.canAssign(60000));
        session.cancel();
        assertEquals(NativeSpeechTransport.SendResult.ENDED, session.append("third", prerecordedPcm()));
        JSONObject observations = observations();
        assertEquals(2, observations.getJSONArray("transcriptions").length());
        for (int i = 0; i < 2; i++) {
            JSONObject audio = observations.getJSONArray("transcriptions").getJSONObject(i);
            assertEquals("The real server normalizes 24 kHz capture to worker PCM", 16000, audio.getInt("sampleRate"));
            assertEquals(32000, audio.getInt("bytes"));
            assertEquals(64, audio.getString("sha256").length());
        }
    }

    @Test(timeout = 20000) public void localCancelAfterCommitSuppressesLateTranscriptAndReleasesTheWorker() throws Exception {
        localOnly();
        control(NativeVoiceJson.object("asrDelayMs", 700));
        RecognitionRecorder recorder = new RecognitionRecorder();
        NativeSpeechTransport transport = transport();
        NativeSpeechTransport.RecognitionSession request = transport.openRecognition("cancel-committed", capabilities(), WAIT_MS, recorder);
        recorder.expect("ready"); append(request, "cancel-attempt", prerecordedPcm()); assertEquals(NativeSpeechTransport.SendResult.ACCEPTED, request.commit("cancel-attempt"));
        awaitTranscriptions(1);
        request.cancel(); recorder.events.clear();
        assertNull("Cancelled inference leaked a completion or failure", recorder.events.poll(900, TimeUnit.MILLISECONDS));
        assertTrue("Socket cancellation reached the worker", observations().getJSONObject("cancelled").getInt("transcription") >= 1);
        control(NativeVoiceJson.object("transcripts", new org.json.JSONArray().put("after cancel"), "asrDelayMs", 0));
        assertEquals("after cancel", recognize(transport, "after-cancel", prerecordedPcm()).text);
        assertEquals("Cancelled recognition was not resent", 2, observations().getJSONArray("transcriptions").length());
    }

    @Test(timeout = 20000) public void localHttpCancellationAndPartialFailureDoNotBecomeSuccess() throws Exception {
        localOnly();
        NativeSpeechTransport transport = transport();
        SpeechRecorder held = new SpeechRecorder();
        NativeSpeechTransport.Request request = transport.speak("cancel-http", "hold-tts", held);
        held.expect("started"); held.expect("pcm");
        request.cancel(); held.events.clear();
        assertNull("Cancelled HTTP stream emitted a terminal callback", held.events.poll(300, TimeUnit.MILLISECONDS));
        SpeechRecorder failed = new SpeechRecorder();
        transport.speak("failed-http", "fail", failed);
        Event error = failed.terminal(WAIT_MS);
        assertEquals("failed", error.type); assertNotNull(error.failure);
        assertTrue("Partial stream failure must preserve evidence of earlier bytes", failed.bytes().length > 0);
        assertTrue(error.failure.kind == NativeSpeechTransport.Kind.NETWORK || error.failure.kind == NativeSpeechTransport.Kind.TIMEOUT);
        SpeechRecorder next = new SpeechRecorder();
        transport.speak("after-http-cancel", "Fixture voice", next);
        assertEquals("completed", next.terminal(WAIT_MS).type);
        assertEquals("HTTP operations were not retried", 3, observations().getJSONArray("speech").length());
    }

    @Test(timeout = 20000) public void localAuthenticationIsRequiredOnBothHttpAndWebSocket() throws Exception {
        localOnly();
        NativeSpeechTransport invalid = transport(env("SEDES_SPEECH_TEST_ENDPOINT"), "deliberately-invalid-fixture-token");
        SpeechRecorder speech = new SpeechRecorder();
        invalid.speak("unauthorized-http", "Fixture voice", speech);
        Event http = speech.terminal(WAIT_MS);
        assertEquals("failed", http.type); assertEquals(NativeSpeechTransport.Kind.AUTHENTICATION, http.failure.kind);
        assertEquals(401, http.failure.httpStatus);
        RecognitionRecorder stt = new RecognitionRecorder();
        invalid.openRecognition("unauthorized-ws", capabilities(), WAIT_MS, stt);
        Event ws = stt.expect("failed");
        assertEquals(NativeSpeechTransport.Kind.AUTHENTICATION, ws.failure.kind); assertEquals(401, ws.failure.httpStatus);
        assertEquals(0, observations().getJSONArray("speech").length());
        assertEquals(0, observations().getJSONArray("transcriptions").length());
    }

    @Test(timeout = 20000) public void localProviderReplacementClosesOldWorkAndDoesNotReplayIt() throws Exception {
        localOnly();
        control(NativeVoiceJson.object("asrDelayMs", 700));
        NativeSpeechTransport old = transport();
        RecognitionRecorder abandoned = new RecognitionRecorder();
        NativeSpeechTransport.RecognitionSession pending = old.openRecognition("old-provider", capabilities(), WAIT_MS, abandoned);
        abandoned.expect("ready"); append(pending, "old-attempt", prerecordedPcm()); assertEquals(NativeSpeechTransport.SendResult.ACCEPTED, pending.commit("old-attempt")); awaitTranscriptions(1);
        old.close(); abandoned.events.clear();
        NativeSpeechTransport replacement = transport(env("SEDES_SPEECH_TEST_REPLACEMENT_ENDPOINT"), env("SEDES_SPEECH_TEST_REPLACEMENT_TOKEN"));
        assertEquals("test transcript", recognize(replacement, "new-provider", prerecordedPcm()).text);
        assertNull("The old provider delivered into the replacement session", abandoned.events.poll(900, TimeUnit.MILLISECONDS));
        assertEquals("The old request was never replayed", 1, observations().getJSONArray("transcriptions").length());
    }

    @Test(timeout = 90000) public void liveOneBoundedSpeechAndRealtimeTranscriptionRoundTrip() throws Exception {
        Assume.assumeTrue("Live OpenAI is a separate explicitly gated lane", live);
        assertEquals("https://api.openai.com/v1", env("SEDES_SPEECH_TEST_ENDPOINT"));
        NativeSpeechTransport transport = transport();
        SpeechRecorder speech = new SpeechRecorder();
        transport.speak("live-speech", SMOKE_PHRASE, speech);
        Event generated = speech.terminal(40000);
        assertEquals("Live speech" + (generated.failure == null ? "" : ": " + generated.failure.code + " HTTP " + generated.failure.httpStatus), "completed", generated.type);
        byte[] prerecorded = speech.bytes();
        assertTrue("Smoke audio must be nonempty and at most ten seconds", prerecorded.length >= 4800 && prerecorded.length <= 480000);
        RecognitionRecorder recognized = new RecognitionRecorder();
        NativeSpeechTransport.RecognitionSession transcription = transport.openRecognition("live-transcription", capabilities(), 30000, recognized);
        recognized.expect("ready");
        append(transcription, "live-attempt", prerecorded); assertEquals(NativeSpeechTransport.SendResult.ACCEPTED, transcription.commit("live-attempt"));
        Event result = recognized.expect("completed", 35000);
        String text = result.text.toLowerCase(java.util.Locale.ROOT);
        int recognizedWords = 0;
        for (String word : new String[] { "quick", "brown", "fox", "jumps", "lazy", "dog" }) if (text.contains(word)) recognizedWords++;
        assertTrue("Realtime transcription did not recognize the fixed smoke phrase", recognizedWords >= 4);
        System.out.println("SPEECH_SMOKE speechRequests=1 transcriptionSessions=1 sampleRate=24000 pcmBytes=" + prerecorded.length + " completed=true");
    }

    private void localOnly() { Assume.assumeFalse("Local conformance case", live); }
    private NativeSpeechTransport transport() { return transport(env("SEDES_SPEECH_TEST_ENDPOINT"), env("SEDES_SPEECH_TEST_TOKEN")); }
    private NativeSpeechTransport transport(String endpoint, String token) {
        NativeSpeechTransport transport = new NativeSpeechTransport(new NativeSpeechTransport.Config(endpoint, token,
            env("SEDES_SPEECH_TEST_STT_MODEL"), env("SEDES_SPEECH_TEST_TTS_MODEL"), env("SEDES_SPEECH_TEST_VOICE"), 1), client,
            new NativeSpeechTransport.Limits(live ? 15000 : 5000, live ? 30000 : 5000, live ? 45000 : 15000, 480000),
            () -> TimeUnit.NANOSECONDS.toMillis(System.nanoTime()));
        transports.add(transport); return transport;
    }
    private Event recognize(NativeSpeechTransport transport, String id, byte[] pcm) throws Exception {
        RecognitionRecorder recorder = new RecognitionRecorder();
        NativeSpeechTransport.RecognitionSession request = transport.openRecognition(id, capabilities(), WAIT_MS, recorder);
        recorder.expect("ready"); append(request, id + "-attempt", pcm);
        assertEquals(NativeSpeechTransport.SendResult.ACCEPTED, request.commit(id + "-attempt"));
        Event completed = recorder.expect("completed"); request.cancel(); return completed;
    }
    private NativeSpeechCapabilities capabilities() throws Exception {
        if (live) return NativeSpeechCapabilities.hosted(env("SEDES_SPEECH_TEST_STT_MODEL"));
        Request request = new Request.Builder().url(env("SEDES_SPEECH_TEST_ENDPOINT") + "/audio/capabilities")
            .header("Authorization", "Bearer " + env("SEDES_SPEECH_TEST_TOKEN")).build();
        try (Response response = client.newCall(request).execute()) {
            assertEquals("Fresh server capabilities status", 200, response.code()); assertNotNull(response.body());
            JSONObject catalog = NativeSpeechCatalog.server(new JSONObject(response.body().string()), env("SEDES_SPEECH_TEST_TTS_MODEL"));
            return NativeSpeechCatalog.serverCapabilities(catalog, env("SEDES_SPEECH_TEST_STT_MODEL"));
        }
    }
    private static void append(NativeSpeechTransport.RecognitionSession request, String attemptId, byte[] pcm) {
        for (int offset = 0; offset < pcm.length; offset += 4800)
            assertEquals("PCM append was rejected", NativeSpeechTransport.SendResult.ACCEPTED,
                request.append(attemptId, Arrays.copyOfRange(pcm, offset, Math.min(pcm.length, offset + 4800))));
    }
    /** A prerecorded deterministic mono PCM fixture; no host or Android audio device is opened. */
    private static byte[] prerecordedPcm() {
        byte[] pcm = new byte[48000];
        for (int i = 0; i < 24000; i++) { int sample = (int) Math.round(4000 * Math.sin(2 * Math.PI * 440 * i / 24000)); pcm[i * 2] = (byte) sample; pcm[i * 2 + 1] = (byte) (sample >> 8); }
        return pcm;
    }
    private JSONObject observations() throws Exception { return control(null); }
    private JSONObject control(JSONObject body) throws Exception {
        Request.Builder request = new Request.Builder().url(env("SEDES_SPEECH_TEST_CONTROL_URL")).header("Authorization", "Bearer " + env("SEDES_SPEECH_TEST_TOKEN"));
        if (body != null) request.post(RequestBody.create(body.toString(), MediaType.get("application/json")));
        try (Response response = client.newCall(request.build()).execute()) {
            assertEquals("Fixture control status", 200, response.code());
            assertNotNull(response.body()); return new JSONObject(response.body().string());
        }
    }
    private void awaitTranscriptions(int count) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        do { if (observations().getJSONArray("transcriptions").length() >= count) return; Thread.sleep(20); } while (System.nanoTime() < deadline);
        fail("Worker did not observe the committed audio");
    }
    private static String env(String name) { String value = System.getenv(name); if (value == null || value.isEmpty()) throw new IllegalStateException("Missing speech test configuration: " + name); return value; }
    private static String sha256(byte[] bytes) throws Exception {
        StringBuilder hash = new StringBuilder(); for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) hash.append(String.format("%02x", value & 255)); return hash.toString();
    }
    private static class Event {
        final String type, id, itemId, text; final NativeSpeechTransport.Failure failure;
        Event(String type, String id, String text, NativeSpeechTransport.Failure failure) { this(type, id, null, text, failure); }
        Event(String type, String id, String itemId, String text, NativeSpeechTransport.Failure failure) {
            this.type = type; this.id = id; this.itemId = itemId; this.text = text; this.failure = failure;
        }
    }
    private static class Recorder {
        final BlockingQueue<Event> events = new LinkedBlockingQueue<>();
        void add(String type, String id) { events.add(new Event(type, id, null, null)); }
        Event expect(String type) throws Exception { return expect(type, WAIT_MS); }
        Event expect(String type, long timeout) throws Exception {
            Event event = events.poll(timeout, TimeUnit.MILLISECONDS); assertNotNull("No transport callback for " + type, event);
            assertEquals("Unexpected callback" + (event.failure == null ? "" : ": " + event.failure.code), type, event.type); return event;
        }
    }
    private static final class RecognitionRecorder extends Recorder implements NativeSpeechTransport.RecognitionListener {
        final BlockingQueue<Event> acknowledgements = new LinkedBlockingQueue<>();
        public void ready(String connectionId, long deadlineMs) { add("ready", connectionId); }
        public void committed(String connectionId, String attemptId, String itemId) {
            acknowledgements.add(new Event("committed", attemptId, itemId, null, null));
        }
        public void completed(String connectionId, String attemptId, String itemId, String text) {
            events.add(new Event("completed", attemptId, itemId, text, null));
        }
        public void failed(String connectionId, String attemptId, NativeSpeechTransport.Failure failure) {
            events.add(new Event("failed", attemptId, null, failure));
        }
        Event acknowledged(String attemptId) throws Exception {
            Event event = acknowledgements.poll(WAIT_MS, TimeUnit.MILLISECONDS);
            assertNotNull("No commit acknowledgement", event); assertEquals(attemptId, event.id);
            assertNotNull(event.itemId); return event;
        }
    }
    private static final class SpeechRecorder extends Recorder implements NativeSpeechTransport.SpeechListener {
        final ByteArrayOutputStream audio = new ByteArrayOutputStream(); int sampleRate, chunks;
        public void started(String id) { add("started", id); }
        public synchronized void pcm(String id, int rate, byte[] pcm) { sampleRate = rate; chunks++; audio.write(pcm, 0, pcm.length); add("pcm", id); }
        public void completed(String id) { add("completed", id); }
        public void failed(String id, NativeSpeechTransport.Failure failure) { events.add(new Event("failed", id, null, failure)); }
        synchronized byte[] bytes() { return audio.toByteArray(); }
        Event terminal(long timeout) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout);
            while (System.nanoTime() < deadline) {
                Event event = events.poll(Math.max(1, TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())), TimeUnit.MILLISECONDS);
                assertNotNull("No terminal HTTP speech callback", event);
                if (event.type.equals("completed") || event.type.equals("failed")) return event;
            }
            throw new AssertionError("No terminal HTTP speech callback");
        }
    }
}
