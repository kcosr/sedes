package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.Intent;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;

/** Hardware-path smoke checks; no deterministic input source is installed here. */
public class NativeVoiceAudioTest {
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
    static class Listener implements NativeVoiceAudio.Listener {
        public void drained(String requestId) {}
        public void captureStarted(String requestId) {}
        public void captured(String requestId, byte[] pcm) {}
        public void captureEnded(String requestId) {}
        public void failed(String requestId, String reason) {}
    }
}
