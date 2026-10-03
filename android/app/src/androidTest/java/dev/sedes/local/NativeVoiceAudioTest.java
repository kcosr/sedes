package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.Intent;
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
            assertNull(failure.get()); assertTrue(bytes.get() > 0); audio.stop();
            int stoppedBytes = bytes.get(); SystemClock.sleep(250); assertEquals(stoppedBytes, bytes.get());
        } finally { audio.stop(); InstrumentationRegistry.getInstrumentation().runOnMainSync(activity::finish); }
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
            long began = SystemClock.elapsedRealtime(); audio.begin("hardware-playback");
            audio.pcm("hardware-playback", 24000, new byte[24000 * 2 / 5]);
            java.io.File spool = audio.spoolForTest(); assertNotNull(spool); audio.end("hardware-playback");
            assertTrue(drained.await(15, TimeUnit.SECONDS)); assertNull(failure.get());
            assertTrue("Drained callback preceded the supplied PCM duration", SystemClock.elapsedRealtime() - began >= 150);
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
                long began = SystemClock.elapsedRealtime();
                audio.begin(request);
                audio.pcm(request, 24000, new byte[24000 * 2 * durationMs / 1000]);
                File spool = audio.spoolForTest(); assertNotNull(spool);
                audio.end(request);
                probe.await(request);
                assertTrue("Drained before the short PCM played", SystemClock.elapsedRealtime() - began >= durationMs * 3 / 4);
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
            audio.begin("cancelled-tail");
            audio.pcm("cancelled-tail", 24000, new byte[24000]);
            AudioTrack track = awaitTrack(audio);
            awaitPlayedFrames(track, 12000);
            track.pause();
            audio.pcm("cancelled-tail", 24000, new byte[24000 * 2 / 50]);
            File oldSpool = audio.spoolForTest(); assertNotNull(oldSpool);
            audio.end("cancelled-tail");
            // The paused sink cannot consume this tail or finish a full-buffer prime.
            SystemClock.sleep(100);
            assertTrue(probe.completed.isEmpty()); assertNull(probe.failure.get());
            audio.stop(); assertFalse(oldSpool.exists());
            audio.begin("replacement-short-pcm");
            audio.pcm("replacement-short-pcm", 24000, new byte[24000 * 2 / 50]);
            File nextSpool = audio.spoolForTest(); assertNotNull(nextSpool);
            audio.end("cancelled-tail");
            audio.end("replacement-short-pcm");
            probe.await("replacement-short-pcm");
            assertFalse(nextSpool.exists()); assertNull(audio.spoolForTest());
            assertNull("Cancelled stream produced a late callback", probe.completed.poll(250, TimeUnit.MILLISECONDS));
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
