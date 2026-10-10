package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

/** Hardware-path smoke checks; no deterministic input source is installed here. */
public class NativeVoiceAudioTest {
    @Test public void allRecognitionCuesDrainThroughAudioTrack() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        MainActivity activity = (MainActivity) InstrumentationRegistry.getInstrumentation().startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        NativeVoiceAudio.setTestCuePlayer(null);
        try {
            for (NativeVoiceCue.Kind kind : NativeVoiceCue.Kind.values()) {
                CountDownLatch drained = new CountDownLatch(1); AtomicReference<String> failure = new AtomicReference<>();
                NativeVoiceAudio audio = new NativeVoiceAudio(context, new Listener() {
                    @Override public void drained(String id) { drained.countDown(); }
                    @Override public void failed(String id, String reason) { failure.set(reason); drained.countDown(); }
                });
                try {
                    audio.configure(NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("startupPreRollMs", 0, "ttsGain", 0)));
                    audio.cue("hardware-cue-" + kind, kind, 100);
                    assertTrue("Cue did not drain: " + kind, drained.await(15, TimeUnit.SECONDS));
                    assertNull(failure.get()); assertNull(audio.spoolForTest());
                } finally { audio.stop(); }
            }
        } finally { InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish); }
    }
    @Test public void realAudioRecordStartsReadsAndStops() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        grant(context, "android.permission.RECORD_AUDIO");
        MainActivity activity = (MainActivity) InstrumentationRegistry.getInstrumentation().startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        CountDownLatch started = new CountDownLatch(1), read = new CountDownLatch(1);
        AtomicReference<String> failure = new AtomicReference<>(); AtomicInteger bytes = new AtomicInteger();
        NativeVoiceAudio.setTestSource(null);
        NativeVoiceAudio audio = new NativeVoiceAudio(context, new Listener() {
            @Override public void captureStarted(String id) { started.countDown(); }
            @Override public void captured(String id, byte[] pcm) { bytes.addAndGet(pcm.length); read.countDown(); }
            @Override public void failed(String id, String reason) { failure.set(reason); started.countDown(); read.countDown(); }
        });
        try {
            audio.record("hardware-record", null);
            assertTrue("AudioRecord did not start", started.await(15, TimeUnit.SECONDS));
            assertTrue("AudioRecord did not deliver PCM", read.await(10, TimeUnit.SECONDS));
            assertNull(failure.get()); assertTrue(bytes.get() > 0);
            android.media.AudioRecord recorder = audio.recorderForTest(); assertNotNull(recorder);
            assertEquals(24000, recorder.getSampleRate()); assertEquals(1, recorder.getChannelCount());
            assertEquals(android.media.AudioFormat.ENCODING_PCM_16BIT, recorder.getAudioFormat());
            audio.stop();
            int stoppedBytes = bytes.get(); SystemClock.sleep(250); assertEquals(stoppedBytes, bytes.get());
        } finally { audio.stop(); InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish); }
    }
    @Test public void gracefulCaptureFinishWaitsForTheAcceptedCallback() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        grant(context, "android.permission.RECORD_AUDIO");
        CountDownLatch accepted = new CountDownLatch(1), release = new CountDownLatch(1), ended = new CountDownLatch(1);
        AtomicReference<String> failure = new AtomicReference<>();
        AtomicInteger callbacks = new AtomicInteger(), completions = new AtomicInteger();
        NativeVoiceAudio.setTestSource(() -> new byte[4800]);
        NativeVoiceAudio audio = new NativeVoiceAudio(context, new Listener() {
            @Override public void captured(String id, byte[] pcm) {
                callbacks.incrementAndGet(); accepted.countDown();
                try { if (!release.await(5, TimeUnit.SECONDS)) failure.set("callback_release_timeout"); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); failure.set("interrupted"); }
            }
            @Override public void captureEnded(String id) { completions.incrementAndGet(); ended.countDown(); }
            @Override public void failed(String id, String reason) { failure.set(reason); ended.countDown(); }
        });
        try {
            audio.record("graceful-capture", null);
            assertTrue(accepted.await(5, TimeUnit.SECONDS));
            audio.finishRecord("stale-id");
            audio.finishRecord("graceful-capture");
            audio.finishRecord("graceful-capture");
            assertFalse("Capture ended before its accepted callback returned", ended.await(100, TimeUnit.MILLISECONDS));
            release.countDown();
            assertTrue(ended.await(5, TimeUnit.SECONDS));
            assertNull(failure.get()); assertEquals(1, callbacks.get()); assertEquals(1, completions.get());
        } finally { release.countDown(); audio.stop(); NativeVoiceAudio.setTestSource(null); }
    }
    @Test public void cancelledCaptureCannotPublishAnEndIntoItsReplacement() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        grant(context, "android.permission.RECORD_AUDIO");
        CountDownLatch accepted = new CountDownLatch(1), release = new CountDownLatch(1), returned = new CountDownLatch(1);
        BlockingQueue<String> ended = new LinkedBlockingQueue<>();
        AtomicReference<String> failure = new AtomicReference<>();
        NativeVoiceAudio.setTestSource(() -> new byte[4800]);
        NativeVoiceAudio audio = new NativeVoiceAudio(context, new Listener() {
            @Override public void captured(String id, byte[] pcm) {
                accepted.countDown();
                try { if (!release.await(5, TimeUnit.SECONDS)) failure.set("callback_release_timeout"); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); failure.set("interrupted"); }
                finally { returned.countDown(); }
            }
            @Override public void captureEnded(String id) { ended.add(id); }
            @Override public void failed(String id, String reason) { failure.set(reason); ended.add(id); }
        });
        try {
            audio.record("cancelled-capture", null);
            assertTrue(accepted.await(5, TimeUnit.SECONDS));
            audio.stop(); release.countDown();
            assertTrue(returned.await(5, TimeUnit.SECONDS));
            NativeVoiceAudio.setTestSource(() -> null);
            audio.record("replacement-capture", null);
            assertEquals("replacement-capture", ended.poll(5, TimeUnit.SECONDS));
            assertNull(ended.poll(100, TimeUnit.MILLISECONDS)); assertNull(failure.get());
        } finally { release.countDown(); audio.stop(); NativeVoiceAudio.setTestSource(null); }
    }
    @Test public void realAudioTrackDrainsBeforeCompletion() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        MainActivity activity = (MainActivity) InstrumentationRegistry.getInstrumentation().startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        CountDownLatch drained = new CountDownLatch(1); AtomicReference<String> failure = new AtomicReference<>();
        NativeVoiceAudio audio = new NativeVoiceAudio(context, new Listener() {
            @Override public void drained(String id) { drained.countDown(); }
            @Override public void failed(String id, String reason) { failure.set(reason); drained.countDown(); }
        });
        try {
            audio.configure(NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("startupPreRollMs", 0)));
            CountDownLatch primingBlocked = audio.holdNextPlaybackForTest();
            audio.begin("hardware-playback");
            audio.pcm("hardware-playback", 24000, new byte[24000 * 2 / 5]);
            java.io.File spool = audio.spoolForTest(); assertNotNull(spool); audio.end("hardware-playback");
            AudioTrack track = awaitTrack(audio);
            assertTrue("Stopped AudioTrack did not block drain", primingBlocked.await(5, TimeUnit.SECONDS));
            assertEquals(AudioTrack.PLAYSTATE_STOPPED, track.getPlayState());
            assertEquals(0L, track.getPlaybackHeadPosition() & 0xffffffffL);
            assertFalse("A stopped AudioTrack completed before playing its PCM", drained.await(150, TimeUnit.MILLISECONDS));
            assertTrue("Pending playback lost its spool", spool.exists());
            track.play();
            assertTrue(drained.await(15, TimeUnit.SECONDS)); assertNull(failure.get());
            assertPlaybackDrained(audio, "hardware-playback", 24000 / 5);
            assertEquals(AudioTrack.STATE_UNINITIALIZED, track.getState());
            assertFalse("Drained speech left private PCM behind", spool.exists());
        } finally { audio.stop(); InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish); }
    }
    @Test public void shortPcmStreamsDrainWithoutStartupPreRoll() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        MainActivity activity = (MainActivity) InstrumentationRegistry.getInstrumentation().startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        PlaybackProbe probe = new PlaybackProbe();
        NativeVoiceAudio audio = new NativeVoiceAudio(context, probe);
        try {
            audio.configure(NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("startupPreRollMs", 0)));
            for (int durationMs : new int[] { 20, 140 }) {
                String request = "short-pcm-" + durationMs;
                audio.begin(request);
                audio.pcm(request, 24000, new byte[24000 * 2 * durationMs / 1000]);
                File spool = audio.spoolForTest(); assertNotNull(spool);
                audio.end(request);
                probe.await(request);
                assertPlaybackDrained(audio, request, 24000 * durationMs / 1000);
                assertFalse("Short PCM left private audio behind", spool.exists());
                assertNull(audio.spoolForTest()); assertTrue(probe.completed.isEmpty());
            }
        } finally { audio.stop(); InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish); }
    }
    @Test public void shortFinalTailDrainsAfterAudioTrackUnderrun() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        MainActivity activity = (MainActivity) InstrumentationRegistry.getInstrumentation().startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        PlaybackProbe probe = new PlaybackProbe();
        NativeVoiceAudio audio = new NativeVoiceAudio(context, probe);
        try {
            audio.configure(NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("startupPreRollMs", 0)));
            audio.begin("underrun-tail");
            audio.pcm("underrun-tail", 24000, new byte[24000]);
            File spool = audio.spoolForTest(); assertNotNull(spool);
            AudioTrack track = awaitTrack(audio);
            awaitPlayedFrames(track, 12000);
            // Model a provider gap after the first half-second has completely played.
            SystemClock.sleep(250);
            assertTrue("Fixture did not cause an AudioTrack underrun", track.getUnderrunCount() > 0);
            assertTrue("An unfinished stream reported completion", probe.completed.isEmpty());
            audio.pcm("underrun-tail", 24000, new byte[24000 * 2 / 50]);
            audio.end("underrun-tail");
            probe.await("underrun-tail");
            assertFalse(spool.exists()); assertNull(audio.spoolForTest()); assertTrue(probe.completed.isEmpty());
        } finally { audio.stop(); InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish); }
    }
    @Test public void stoppingAStalledTailDoesNotCompleteOrBlockTheNextStream() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        MainActivity activity = (MainActivity) InstrumentationRegistry.getInstrumentation().startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        PlaybackProbe probe = new PlaybackProbe();
        NativeVoiceAudio audio = new NativeVoiceAudio(context, probe);
        try {
            audio.configure(NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("startupPreRollMs", 0)));
            CountDownLatch primingBlocked = audio.holdNextPlaybackForTest();
            audio.begin("cancelled-tail");
            audio.pcm("cancelled-tail", 24000, new byte[24000 * 2 / 50]);
            AudioTrack track = awaitTrack(audio);
            File oldSpool = audio.spoolForTest(); assertNotNull(oldSpool);
            audio.end("cancelled-tail");
            assertTrue("Held AudioTrack never blocked drain priming", primingBlocked.await(5, TimeUnit.SECONDS));
            assertEquals(AudioTrack.PLAYSTATE_STOPPED, track.getPlayState());
            assertEquals(0L, track.getPlaybackHeadPosition() & 0xffffffffL);
            assertEquals("Held AudioTrack buffer was not full", 0,
                track.write(new byte[2], 0, 2, AudioTrack.WRITE_NON_BLOCKING));
            assertTrue(probe.completed.isEmpty()); assertNull(probe.failure.get());
            assertTrue("Undrained real PCM must not create completion evidence", audio.playbackDrainsForTest().isEmpty());
            audio.stop(); assertFalse(oldSpool.exists());
            assertEquals(AudioTrack.STATE_UNINITIALIZED, track.getState());
            audio.begin("replacement-short-pcm");
            audio.pcm("replacement-short-pcm", 24000, new byte[24000 * 2 / 50]);
            File nextSpool = audio.spoolForTest(); assertNotNull(nextSpool);
            audio.end("cancelled-tail");
            audio.end("replacement-short-pcm");
            probe.await("replacement-short-pcm");
            assertFalse(nextSpool.exists()); assertNull(audio.spoolForTest());
            assertTrue("Cancelled stream produced a late callback", probe.completed.isEmpty());
            // Both pumps share one executor, so successor completion proves the cancelled pump has exited.
            java.util.List<NativeVoiceAudio.PlaybackDrain> drains = audio.playbackDrainsForTest();
            assertEquals("Only the replacement may report physically drained PCM", 1, drains.size());
            assertEquals("replacement-short-pcm", drains.get(0).requestId);
            assertPlaybackDrained(audio, "replacement-short-pcm", 24000 / 50);
        } finally { audio.stop(); InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish); }
    }
    @Test public void oddChunksCarrySplitSamplesAndEmptyStreamsReportTheirCode() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        MainActivity activity = (MainActivity) InstrumentationRegistry.getInstrumentation().startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        PlaybackProbe probe = new PlaybackProbe();
        NativeVoiceAudio audio = new NativeVoiceAudio(context, probe);
        try {
            audio.configure(NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("startupPreRollMs", 0)));
            audio.begin("odd-chunks");
            audio.pcm("odd-chunks", 24000, new byte[4801]); audio.pcm("odd-chunks", 24000, new byte[0]);
            audio.pcm("odd-chunks", 24000, new byte[4799]); audio.pcm("odd-chunks", 24000, new byte[3]);
            File spool = audio.spoolForTest(); assertNotNull(spool);
            assertEquals("Only whole samples were spooled", 9602, spool.length());
            audio.end("odd-chunks");
            probe.await("odd-chunks");
            audio.begin("empty-stream"); audio.end("empty-stream");
            assertEquals("empty-stream", probe.completed.poll(5, TimeUnit.SECONDS));
            assertEquals("empty_pcm_stream", probe.failure.getAndSet(null));
        } finally { audio.stop(); InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish); }
    }
    @Test public void playbackDrainHistoryPreservesCompletedRequestsAcrossStartsAndBoundsItsSnapshots() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        MainActivity activity = (MainActivity) InstrumentationRegistry.getInstrumentation().startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        PlaybackProbe probe = new PlaybackProbe();
        NativeVoiceAudio audio = new NativeVoiceAudio(context, probe);
        try {
            audio.configure(NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("startupPreRollMs", 0)));
            java.util.List<NativeVoiceAudio.PlaybackDrain> firstSnapshot = null;
            for (int index = 0; index < 34; index++) {
                String request = "history-" + index;
                audio.begin(request);
                assertNull("Beginning a request still clears the last-record accessor", audio.playbackDrainForTest());
                audio.pcm(request, 24000, new byte[24000 * 2 / 50]); audio.end(request);
                probe.await(request); assertPlaybackDrained(audio, request, 24000 / 50);
                if (index == 0) firstSnapshot = audio.playbackDrainsForTest();
            }
            assertNotNull(firstSnapshot); assertEquals(1, firstSnapshot.size());
            assertEquals("Snapshots are independent of later drains and eviction", "history-0", firstSnapshot.get(0).requestId);
            java.util.List<NativeVoiceAudio.PlaybackDrain> history = audio.playbackDrainsForTest();
            assertEquals(32, history.size());
            for (int index = 0; index < history.size(); index++) {
                NativeVoiceAudio.PlaybackDrain drain = history.get(index);
                assertEquals("history-" + (index + 2), drain.requestId); assertEquals(24000, drain.sampleRate);
                assertEquals(24000 / 50, drain.writtenFrames); assertTrue(drain.playedFrames >= drain.writtenFrames);
            }
            history.clear(); assertEquals("Mutating a snapshot cannot clear recorded evidence", 32, audio.playbackDrainsForTest().size());
        } finally { audio.stop(); InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish); }
    }
    @Test public void consecutivePlaybackHoldsOneFocusEntryUntilTheDelayedRelease() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        MainActivity activity = (MainActivity) InstrumentationRegistry.getInstrumentation().startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        PlaybackProbe probe = new PlaybackProbe();
        NativeVoiceAudio audio = new NativeVoiceAudio(context, probe);
        try {
            audio.configure(NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("startupPreRollMs", 0)));
            audio.begin("first-chunk"); audio.pcm("first-chunk", 24000, new byte[24000 * 2 / 10]); audio.end("first-chunk");
            probe.await("first-chunk");
            Object held = audio.focusForTest(); assertNotNull("Focus was abandoned between consecutive chunks", held);
            audio.begin("second-chunk"); audio.pcm("second-chunk", 24000, new byte[24000 * 2 / 10]); audio.end("second-chunk");
            probe.await("second-chunk");
            assertSame("A consecutive chunk replaced its focus entry", held, audio.focusForTest());
            SystemClock.sleep(2500);
            assertNull("Idle focus outlived its delayed release", audio.focusForTest());
        } finally { audio.stop(); InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish); }
    }
    @Test public void heldFocusLossReportsTheLastRequestAfterDrainOrStop() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        MainActivity activity = (MainActivity) InstrumentationRegistry.getInstrumentation().startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        PlaybackProbe probe = new PlaybackProbe();
        NativeVoiceAudio audio = new NativeVoiceAudio(context, probe);
        try {
            audio.configure(NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("startupPreRollMs", 0)));
            for (boolean stopped : new boolean[] { false, true }) {
                audio.begin("first-owner"); audio.pcm("first-owner", 24000, new byte[4800]); audio.end("first-owner");
                probe.await("first-owner");
                AudioManager.OnAudioFocusChangeListener held = (AudioManager.OnAudioFocusChangeListener) audio.focusForTest();
                assertNotNull(held);
                audio.begin("last-owner"); audio.pcm("last-owner", 24000, new byte[4800]);
                if (stopped) { awaitTrack(audio); audio.stop(); }
                else { audio.end("last-owner"); probe.await("last-owner"); }
                assertSame(held, audio.focusForTest());
                held.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT);
                assertEquals("last-owner", probe.completed.poll(5, TimeUnit.SECONDS));
                assertEquals("audio_focus_lost", probe.failure.getAndSet(null));
                assertNull(audio.focusForTest());
                held.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS);
                assertTrue("A duplicate loss must be ignored", probe.completed.isEmpty());
                audio.begin("new-owner"); audio.pcm("new-owner", 24000, new byte[4800]); audio.end("new-owner");
                probe.await("new-owner");
                Object replacement = audio.focusForTest(); assertNotNull(replacement); assertNotSame(held, replacement);
                held.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS);
                assertSame(replacement, audio.focusForTest()); assertTrue(probe.completed.isEmpty()); assertNull(probe.failure.get());
            }
        } finally { audio.stop(); InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish); }
    }
    @Test public void fastLongSpeechUsesBoundedDiskAndStopRemovesOnlyItsSpool() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        MainActivity activity = (MainActivity) InstrumentationRegistry.getInstrumentation().startActivitySync(
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        AtomicReference<String> failure = new AtomicReference<>();
        NativeVoiceAudio audio = new NativeVoiceAudio(context, new Listener() {
            @Override public void failed(String id, String reason) { failure.set(reason); }
        });
        NativeVoiceAudio other = null;
        try {
            audio.configure(NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("startupPreRollMs", 0)));
            byte[] chunk = new byte[64 * 1024];
            audio.begin("fast-long-speech");
            for (int i = 0; i < 48; i++) audio.pcm("fast-long-speech", 24000, chunk);
            java.io.File spool = audio.spoolForTest(); assertNotNull(spool);
            assertTrue("Burst was not buffered beyond the old two-MiB limit", audio.pendingPcmBytes() > 2 * 1024 * 1024);
            assertEquals(3 * 1024 * 1024, spool.length()); assertNull(failure.get());
            other = new NativeVoiceAudio(context, new Listener());
            assertTrue("Constructing a second owner deleted live audio", spool.exists());
            audio.stop(); assertFalse(spool.exists()); assertEquals(0, audio.pendingPcmBytes());
            audio.begin("bounded-duration");
            for (int i = 0; i < 150; i++) audio.pcm("bounded-duration", 8000, chunk);
            assertEquals("speech_duration_limit", failure.get()); assertNull(audio.spoolForTest());
        } finally {
            audio.stop(); if (other != null) other.stop();
            InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish);
        }
    }
    static void grant(Context context, String permission) throws Exception {
        try (ParcelFileDescriptor.AutoCloseInputStream input = new ParcelFileDescriptor.AutoCloseInputStream(InstrumentationRegistry.getInstrumentation().getUiAutomation()
            .executeShellCommand("pm grant " + context.getPackageName() + " " + permission))) { while (input.read() != -1) {} }
    }
    private static AudioTrack awaitTrack(NativeVoiceAudio audio) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 5000;
        AudioTrack track;
        while ((track = audio.trackForTest()) == null && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(10);
        assertNotNull("AudioTrack did not open", track);
        return track;
    }
    private static void assertPlaybackDrained(NativeVoiceAudio audio, String request, long expectedFrames) {
        // AudioTrack's frame clock is the drain authority; short buffered playback need not match a wall-clock fraction.
        NativeVoiceAudio.PlaybackDrain drain = audio.playbackDrainForTest();
        assertNotNull("No hardware drain evidence was captured", drain);
        assertEquals(request, drain.requestId); assertEquals(24000, drain.sampleRate);
        assertEquals("Supplied PCM was not fully written to AudioTrack", expectedFrames, drain.writtenFrames);
        assertTrue("AudioTrack completed before consuming all supplied frames: " + drain.playedFrames + " < " + expectedFrames,
            drain.playedFrames >= expectedFrames);
    }
    private static void awaitPlayedFrames(AudioTrack track, long frames) {
        long deadline = SystemClock.elapsedRealtime() + 5000;
        while ((track.getPlaybackHeadPosition() & 0xffffffffL) < frames && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(10);
        assertTrue("Fixture PCM did not finish playing", (track.getPlaybackHeadPosition() & 0xffffffffL) >= frames);
    }
    private static final class PlaybackProbe extends Listener {
        final BlockingQueue<String> completed = new LinkedBlockingQueue<>();
        final AtomicReference<String> failure = new AtomicReference<>();
        @Override public void drained(String id) { completed.add(id); }
        @Override public void failed(String id, String reason) { failure.set(reason); completed.add(id); }
        void await(String id) throws Exception {
            assertEquals("AudioTrack did not drain the expected request", id, completed.poll(5, TimeUnit.SECONDS));
            assertNull(failure.get());
        }
    }
    static class Listener implements NativeVoiceAudio.Listener {
        public void drained(String requestId) {}
        public void captureStarted(String requestId) {}
        public void captured(String requestId, byte[] pcm) {}
        public void captureEnded(String requestId) {}
        public void failed(String requestId, String reason) {}
    }
}
