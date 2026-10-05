package dev.sedes.local;

import static org.junit.Assert.*;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.util.Arrays;
import java.util.Base64;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Real OkHttp sockets, coordinator, and encrypted recording files; only microphone samples and server inference are fixtures. */
public class NativeSpeechNetworkRecoveryTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private static final String BINDING = "profile\nhttps://sedes.example\n" + "a".repeat(64);
    private static final int WAIT_MS = 5000;

    @Test(timeout = 30000) public void adoptedCaptureKeepsPcmAndReconnectsAfterRealSocketReset() throws Exception {
        for (boolean committed : new boolean[] {false, true}) {
            File directory = temporary.newFolder(committed ? "committed" : "open-buffer");
            KeyGenerator generator = KeyGenerator.getInstance("AES"); generator.init(256); SecretKey key = generator.generateKey();
            try (NativeSpeechTransportTest.Peer peer = new NativeSpeechTransportTest.Peer();
                    NativeDictationStore store = new NativeDictationStore(directory, () -> key, new NativeDictationStore.Disk(), NativeDictationStore.Limits.defaults());
                    NativeSpeechTransport transport = new NativeSpeechTransport(new NativeSpeechTransport.Config(peer.url(), "fixture-secret",
                        "fixture-stt", "fixture-tts", "fixture-voice", 1), () -> TimeUnit.NANOSECONDS.toMillis(System.nanoTime()))) {
                NativeSpeechCapabilities caps = NativeSpeechCapabilities.server("fixture-stt", NativeVoiceJson.object(
                    "max_buffer_bytes", 240000, "max_message_bytes", 1048576, "max_output_bytes", 1048576,
                    "idle_timeout_seconds", 60, "max_session_seconds", 3600));
                NativeDictationStore.Journal journal = store.create(BINDING, "recording", "thread", "Thread", configuration(peer.url()));
                Recorder result = new Recorder(); AtomicInteger connections = new AtomicInteger();
                BlockingQueue<NativeSpeechTransport.Failure> failures = new LinkedBlockingQueue<>();
                Timing timing = new Timing();
                NativeVoiceRecording recording = new NativeVoiceRecording("recording", journal, (id, listener) -> {
                    connections.incrementAndGet();
                    return transport.openRecognition(id, caps, 15000, new NativeSpeechTransport.RecognitionListener() {
                        public void ready(String connection, long deadline) { listener.ready(connection, deadline); }
                        public void committed(String connection, String attempt, String item) { listener.committed(connection, attempt, item); }
                        public void completed(String connection, String attempt, String item, String text) { listener.completed(connection, attempt, item, text); }
                        public void failed(String connection, String attempt, NativeSpeechTransport.Failure failure) {
                            failures.add(failure); listener.failed(connection, attempt, failure);
                        }
                    });
                }, result, caps.hardSegmentMs(), 15000, timing);
                try {
                    recording.start(); configure(peer); await(result.ready, "initial recognition session");
                    CountDownLatch adopted = new CountDownLatch(1); AtomicReference<String> adoptionError = new AtomicReference<>();
                    recording.setKeepListening(true, error -> { adoptionError.set(error); adopted.countDown(); });
                    await(adopted, "durable adoption"); assertNull(adoptionError.get());
                    byte[] beforeLoss = pcm((committed ? 50 : 25) * 2400, 2200);
                    feed(recording, beforeLoss); flush(journal);
                    if (committed) {
                        assertArrayEquals(beforeLoss, readCommittedAudio(peer));
                        acknowledge(peer, "before-loss", null); flush(journal);
                    } else assertArrayEquals(Arrays.copyOf(beforeLoss, 15 * 4800), readAudio(peer, 15 * 4800));
                    peer.socket.setSoLinger(true, 0); peer.socket.close();
                    NativeSpeechTransport.Failure failure = failures.poll(WAIT_MS, TimeUnit.MILLISECONDS);
                    assertNotNull("Socket reset was not reported", failure);
                    assertEquals(NativeSpeechTransport.Kind.NETWORK, failure.kind); assertTrue(failure.retryable());
                    assertEquals(Boolean.TRUE, result.reconnecting.poll(WAIT_MS, TimeUnit.MILLISECONDS));
                    assertNull("A transient failure stopped the recording", result.error.get());
                    byte[] duringLoss = pcm(20 * 2400, 3200);
                    feed(recording, duringLoss);
                    awaitValue(() -> journal.load().acceptedSamples == (beforeLoss.length + duringLoss.length) / 2, "PCM spool drain while reconnecting");
                    assertEquals("PCM accepted while reconnecting must remain in the spool",
                        (beforeLoss.length + duringLoss.length) / 2, journal.load().acceptedSamples);
                    assertTrue(journal.load().adopted); assertFalse(journal.load().captureIncomplete);
                    configure(peer); // The coordinator opens a replacement on the same endpoint after its bounded delay.
                    assertEquals(Boolean.FALSE, result.reconnecting.poll(WAIT_MS, TimeUnit.MILLISECONDS));
                    if (committed) {
                        assertArrayEquals("Uncertain committed audio is retried without truncation", beforeLoss, readCommittedAudio(peer));
                        acknowledge(peer, "after-loss", null); complete(peer, "after-loss", "first segment");
                        awaitValue(() -> journal.load().completedSamples == beforeLoss.length / 2, "durable recovered result");
                    }
                    recording.beginFinish(NativeVoiceRecording.FinishReason.SEND); recording.finish(NativeVoiceRecording.FinishReason.SEND);
                    byte[] expected = committed ? duringLoss : concatenate(beforeLoss, duringLoss);
                    assertArrayEquals("All samples captured during the outage survive recovery", expected, readCommittedAudio(peer));
                    acknowledge(peer, "last", committed ? "after-loss" : null); complete(peer, "last", "captured through outage");
                    await(result.completed, "final retained samples");
                    assertNull(result.error.get()); assertTrue(result.maySubmit);
                    assertEquals(committed ? "first segment captured through outage" : "captured through outage", result.text);
                    assertEquals("Only the socket restarts; microphone ownership stays with the recording", 1, result.readyCount.get());
                    assertEquals(2, connections.get()); assertTrue(journal.load().complete());
                    assertEquals((beforeLoss.length + duringLoss.length) / 2, journal.load().completedSamples);
                } finally { recording.discard(); flush(journal); timing.close(); }
            }
        }
    }

    private static JSONObject configuration(String endpoint) {
        JSONObject config = new JSONObject();
        NativeVoiceSettings settings = NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("speechProvider", "server",
            "speechEndpoint", endpoint, "sttModel", "fixture-stt"));
        for (String field : new String[] {"speechProvider", "speechEndpoint", "sttModel", "inputDeviceId", "recognitionStartTimeoutMs",
                "recognitionCompletionTimeoutMs", "recognitionEndSilenceMs", "recognitionResultTimeoutMs", "longDictationTimeoutMs",
                "recognizeStopCommand", "recognitionCues", "cueGain", "followComposerMode"})
            NativeVoiceJson.put(config, field, settings.value.opt(field));
        return config;
    }
    private static void configure(NativeSpeechTransportTest.Peer peer) throws Exception {
        peer.accept(); assertEquals("GET /v1/realtime?intent=transcription HTTP/1.1", peer.requestLine); peer.upgrade();
        JSONObject update = peer.json(); assertEquals("session.update", update.getString("type"));
        JSONObject session = update.getJSONObject("session"); session.put("id", "session-fixture");
        peer.text(NativeVoiceJson.object("type", "session.created", "session", session));
        peer.text(NativeVoiceJson.object("type", "session.updated", "session", session));
    }
    private static byte[] readAudio(NativeSpeechTransportTest.Peer peer, int bytes) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        while (output.size() < bytes) {
            JSONObject event = peer.json(); assertEquals("input_audio_buffer.append", event.getString("type"));
            output.write(Base64.getDecoder().decode(event.getString("audio")));
        }
        assertEquals(bytes, output.size()); return output.toByteArray();
    }
    private static byte[] readCommittedAudio(NativeSpeechTransportTest.Peer peer) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        while (true) {
            JSONObject event = peer.json();
            if (event.getString("type").equals("input_audio_buffer.commit")) return output.toByteArray();
            assertEquals("input_audio_buffer.append", event.getString("type")); output.write(Base64.getDecoder().decode(event.getString("audio")));
        }
    }
    private static void acknowledge(NativeSpeechTransportTest.Peer peer, String item, String previous) throws Exception {
        peer.text(NativeVoiceJson.object("type", "input_audio_buffer.committed", "item_id", item, "previous_item_id", previous));
    }
    private static void complete(NativeSpeechTransportTest.Peer peer, String item, String text) throws Exception {
        peer.text(NativeVoiceJson.object("type", "conversation.item.input_audio_transcription.completed", "item_id", item,
            "content_index", 0, "transcript", text));
    }
    private static void feed(NativeVoiceRecording recording, byte[] pcm) {
        for (int offset = 0; offset < pcm.length; offset += 4800)
            assertTrue("Capture stopped accepting PCM", recording.accept(Arrays.copyOfRange(pcm, offset, Math.min(pcm.length, offset + 4800))));
    }
    private static byte[] pcm(int samples, int value) {
        byte[] pcm = new byte[samples * 2];
        for (int offset = 0; offset < pcm.length; offset += 2) { pcm[offset] = (byte) value; pcm[offset + 1] = (byte) (value >> 8); }
        return pcm;
    }
    private static byte[] concatenate(byte[] first, byte[] second) {
        byte[] all = Arrays.copyOf(first, first.length + second.length); System.arraycopy(second, 0, all, first.length, second.length); return all;
    }
    private static void flush(NativeDictationStore.Journal journal) throws Exception {
        CountDownLatch complete = new CountDownLatch(1); journal.executor().execute(complete::countDown); await(complete, "journal worker");
    }
    private static void await(CountDownLatch latch, String what) throws Exception { assertTrue("Timed out waiting for " + what, latch.await(WAIT_MS, TimeUnit.MILLISECONDS)); }
    private interface Condition { boolean get() throws Exception; }
    private static void awaitValue(Condition condition, String what) throws Exception {
        long end = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(WAIT_MS);
        while (!condition.get()) { if (System.nanoTime() >= end) fail("Timed out waiting for " + what); Thread.sleep(10); }
    }
    private static final class Recorder implements NativeVoiceRecording.Listener {
        final CountDownLatch ready = new CountDownLatch(1), completed = new CountDownLatch(1);
        final AtomicInteger readyCount = new AtomicInteger(); final AtomicReference<String> error = new AtomicReference<>();
        final BlockingQueue<Boolean> reconnecting = new LinkedBlockingQueue<>();
        volatile String text; volatile boolean maySubmit;
        public void ready(String id) { assertEquals("recording", id); readyCount.incrementAndGet(); ready.countDown(); }
        public void changed(String id, boolean value) { reconnecting.add(value); }
        public void completed(String id, String text, boolean maySubmit) { this.text = text; this.maySubmit = maySubmit; completed.countDown(); }
        public void failed(String id, String code, boolean retained) { error.set(code); }
        public void journalChanged(String id, NativeDictationStore.Recording value) {}
    }
    private static final class Timing implements NativeVoiceRecording.Timing {
        final ScheduledThreadPoolExecutor timer = new ScheduledThreadPoolExecutor(1);
        Timing() { timer.setRemoveOnCancelPolicy(true); }
        public long nowMs() { return TimeUnit.NANOSECONDS.toMillis(System.nanoTime()); }
        public NativeVoiceRecording.Timer after(long delay, Runnable action) {
            java.util.concurrent.ScheduledFuture<?> pending = timer.schedule(action, delay, TimeUnit.MILLISECONDS); return () -> pending.cancel(false);
        }
        public void close() { timer.shutdownNow(); }
    }
}
