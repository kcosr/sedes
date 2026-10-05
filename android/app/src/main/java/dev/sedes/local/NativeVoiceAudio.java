package dev.sedes.local;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioRecordingConfiguration;
import android.media.AudioRouting;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;
import java.io.File;
import java.io.RandomAccessFile;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;

/** Bounded signed-16-bit PCM output/capture. Every callback is fenced by an audio generation. */
final class NativeVoiceAudio {
    interface Listener {
        void drained(String requestId);
        void captureStarted(String requestId);
        void captured(String requestId, byte[] pcm);
        void captureEnded(String requestId);
        void failed(String requestId, String reason);
    }
    // Only instrumentation may install this package-private seam, and only in debug builds.
    interface TestSource { byte[] next(); }
    private static volatile TestSource testSource;
    static void setTestSource(TestSource source) {
        if (!BuildConfig.DEBUG) throw new IllegalStateException("test_audio_unavailable");
        testSource = source;
    }
    interface TestCuePlayer { void play(String id, NativeVoiceCue.Kind kind, int percent); }
    private static volatile TestCuePlayer testCuePlayer;
    static void setTestCuePlayer(TestCuePlayer player) {
        if (!BuildConfig.DEBUG) throw new IllegalStateException("test_audio_unavailable");
        testCuePlayer = player;
    }
    static final long MAX_STREAM_DURATION_MS = 10 * 60 * 1000L;
    // Consecutive chunks, cues and capture keep focus and a warm output path across this gap, as the reference app does.
    private static final long FOCUS_HOLD_MS = 1400, ROUTE_TIMEOUT_MS = 5000;
    private static final long MAX_SPOOL_BYTES = 256 * 1024 * 1024L;
    private static final AtomicLong FOCUS_IDS = new AtomicLong();
    static final int SAMPLE_RATE = NativeVoiceCapturePolicy.SAMPLE_RATE;
    private static final int PUMP_BYTES = 64 * 1024;
    private static boolean staleSpoolsRemoved;
    private final Context context;
    private final AudioManager manager;
    private final Listener listener;
    private final Object lock = new Object();
    private final ExecutorService playback = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private AudioTrack track;
    private CountDownLatch nextPlaybackHoldForTest, playbackHoldForTest;
    private PlaybackDrain lastPlaybackDrainForTest;
    private AudioRecord recorder;
    private Focus focus;
    private long generation, focusRelease, warmUntil;
    private String request;
    private int rate, previousMode;
    private long frames;
    private boolean capture, captureFinishing, communication;
    private File spool;
    private RandomAccessFile spoolWriter, spoolReader;
    private long spoolWritten, spoolRead;
    private boolean streamEnded;
    private int carry = -1;
    private float gain = 1f;
    private int preRoll = 512;
    /** One system focus entry. A replacement makes the earlier entry's callbacks stale. */
    private final class Focus implements AudioManager.OnAudioFocusChangeListener {
        final boolean recording;
        final String name = "sedes-voice-focus-" + FOCUS_IDS.incrementAndGet();
        AudioFocusRequest request;
        String ownerRequestId;
        boolean ducked;
        Focus(boolean recording, String ownerRequestId) { this.recording = recording; this.ownerRequestId = ownerRequestId; }
        @Override public void onAudioFocusChange(int change) { focusChanged(this, change); }
        // AudioManager derives the focus client ID from toString(); each entry needs its own.
        @Override public String toString() { return name; }
    }
    private void focusChanged(Focus entry, int change) {
        long current; String id;
        synchronized (lock) {
            if (entry != focus) return;
            if (change == AudioManager.AUDIOFOCUS_GAIN ||
                change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK && !entry.recording) {
                entry.ducked = change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK;
                if (track != null) track.setVolume(entry.ducked ? 0.35f : 1f);
                return;
            }
            if (change != AudioManager.AUDIOFOCUS_LOSS && change != AudioManager.AUDIOFOCUS_LOSS_TRANSIENT &&
                change != AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) return;
            current = generation;
            // Recognition drain after a graceful microphone stop does not own audio focus.
            if (entry.recording && (!capture || captureFinishing)) { abandonFocus(); return; }
            id = request == null ? entry.ownerRequestId : request;
            abandonFocus();
        }
        // Fenced by generation: a loss can only end the request that held this entry when it was lost.
        if (id != null) failCurrent(current, id, "audio_focus_lost");
    }
    NativeVoiceAudio(Context context, Listener listener) {
        this.context = context.getApplicationContext(); manager = context.getSystemService(AudioManager.class); this.listener = listener;
        removeStaleSpools(this.context);
    }
    private static synchronized void removeStaleSpools(Context context) {
        if (staleSpoolsRemoved) return;
        staleSpoolsRemoved = true;
        File[] files = context.getCacheDir().listFiles((directory, name) -> name.startsWith("sedes-voice-pcm-") && name.endsWith(".pcm"));
        if (files != null) for (File file : files) file.delete();
    }
    void configure(NativeVoiceSettings settings) { synchronized (lock) { gain = settings.number("ttsGain") / 100f; preRoll = settings.number("startupPreRollMs"); } }
    boolean hasPermission() { return ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED; }
    JSONArray devices() {
        JSONArray result = new JSONArray();
        if (manager != null) for (AudioDeviceInfo device : manager.getDevices(AudioManager.GET_DEVICES_INPUTS))
            result.put(NativeVoiceJson.object("id", Integer.toString(device.getId()), "label", device.getProductName().toString(), "type", device.getType()));
        return result;
    }
    void begin(String id) {
        stop(); final long current;
        synchronized (lock) { request = id; capture = false; current = generation; focusRelease++; lastPlaybackDrainForTest = null; }
        playback.execute(() -> pump(current, id));
    }
    void pcm(String id, int sampleRate, byte[] pcm) {
        pcm(id, sampleRate, pcm, null);
    }
    private void pcm(String id, int sampleRate, byte[] pcm, Float overrideGain) {
        final long current;
        String failure = null;
        synchronized (lock) {
            if (!id.equals(request) || capture) return;
            current = generation;
            // A chunk may end inside a sample; its first byte is carried into the next chunk.
            int carried = carry < 0 ? 0 : 1, length = carried + pcm.length, even = length & ~1;
            if (sampleRate < 8000 || sampleRate > 192000 || streamEnded || rate != 0 && rate != sampleRate) {
                failure = "invalid_pcm";
            } else if (spoolWritten + even > sampleRate * 2L * MAX_STREAM_DURATION_MS / 1000) {
                failure = "speech_duration_limit";
            } else if (spoolWritten + even > MAX_SPOOL_BYTES) {
                failure = "speech_storage_limit";
            } else {
                byte[] samples = carried == 0 && even == pcm.length ? pcm : new byte[even];
                if (samples != pcm && even > 0) { if (carried == 1) samples[0] = (byte) carry; System.arraycopy(pcm, 0, samples, carried, even - carried); }
                carry = length == even ? -1 : pcm.length > 0 ? pcm[pcm.length - 1] & 255 : carry;
                if (even > 0) try {
                    if (spool == null) {
                        spool = File.createTempFile("sedes-voice-pcm-", ".pcm", context.getCacheDir());
                        spoolWriter = new RandomAccessFile(spool, "rw"); spoolReader = new RandomAccessFile(spool, "r");
                        rate = sampleRate;
                    }
                    spoolWriter.write(scaled(samples, overrideGain == null ? gain : overrideGain));
                    spoolWritten += even;
                    lock.notifyAll();
                } catch (Exception error) { failure = "speech_storage_unavailable"; }
            }
        }
        if (failure != null) failCurrent(current, id, failure);
    }
    // A byte still carried at the end is half a sample and is not played.
    void end(String id) {
        synchronized (lock) { if (!id.equals(request) || capture) return; streamEnded = true; lock.notifyAll(); }
    }
    private void pump(long current, String id) {
        byte[] buffer = new byte[PUMP_BYTES];
        long deadline = SystemClock.elapsedRealtime() + MAX_STREAM_DURATION_MS + 60000;
        try {
            while (true) {
                int count, warmup = 0;
                synchronized (lock) {
                    while (current == generation && spoolRead == spoolWritten && !streamEnded) {
                        if (SystemClock.elapsedRealtime() >= deadline) throw new IllegalStateException("speech_timeout");
                        lock.wait(100);
                    }
                    if (current != generation) return;
                    if (spoolRead == spoolWritten && streamEnded) break;
                    if (track == null) {
                        // Hardware warmup only after a cold start; a consecutive track follows recent playback.
                        boolean warm = SystemClock.elapsedRealtime() < warmUntil;
                        openTrack(rate); if (!warm) warmup = preRoll * rate / 1000 * 2;
                    }
                    count = (int) Math.min(buffer.length, spoolWritten - spoolRead);
                    spoolReader.readFully(buffer, 0, count); spoolRead += count;
                }
                if (warmup > 0) {
                    byte[] silence = new byte[Math.min(PUMP_BYTES, warmup)];
                    while (warmup > 0 && current(current)) { int size = Math.min(silence.length, warmup); write(current, silence, size); warmup -= size; }
                }
                write(current, buffer, count);
                if (SystemClock.elapsedRealtime() >= deadline) throw new IllegalStateException("speech_timeout");
            }
            long drainDeadline = SystemClock.elapsedRealtime() + 15000;
            long drainFrames = primeDrain(current, drainDeadline);
            if (drainFrames < 0) return;
            while (true) {
                synchronized (lock) {
                    if (current != generation) return;
                    if (track == null) throw new IllegalStateException("empty_pcm_stream");
                    if ((track.getPlaybackHeadPosition() & 0xffffffffL) >= drainFrames) break;
                }
                if (SystemClock.elapsedRealtime() >= drainDeadline) throw new IllegalStateException("playback_drain_timeout");
                Thread.sleep(10);
            }
            synchronized (lock) {
                if (current != generation) return;
                // Preserve hardware evidence before release resets the playback head; no PCM is retained.
                if (BuildConfig.DEBUG) lastPlaybackDrainForTest = new PlaybackDrain(id, rate, frames, track.getPlaybackHeadPosition() & 0xffffffffL);
                releaseTrack(); releaseSpool(); request = null; releaseFocusLater();
            }
            listener.drained(id);
        } catch (Exception error) {
            failCurrent(current, id, code(error, "playback_failed", "speech_timeout", "audio_focus_unavailable", "empty_pcm_stream", "playback_drain_timeout"));
        }
    }
    long pendingPcmBytes() { synchronized (lock) { return spoolWritten - spoolRead; } }
    File spoolForTest() { if (!BuildConfig.DEBUG) throw new IllegalStateException("test_audio_unavailable"); synchronized (lock) { return spool; } }
    AudioTrack trackForTest() { if (!BuildConfig.DEBUG) throw new IllegalStateException("test_audio_unavailable"); synchronized (lock) { return track; } }
    static final class PlaybackDrain {
        final String requestId;
        final int sampleRate;
        final long writtenFrames, playedFrames;
        PlaybackDrain(String requestId, int sampleRate, long writtenFrames, long playedFrames) {
            this.requestId = requestId; this.sampleRate = sampleRate; this.writtenFrames = writtenFrames; this.playedFrames = playedFrames;
        }
    }
    PlaybackDrain playbackDrainForTest() { if (!BuildConfig.DEBUG) throw new IllegalStateException("test_audio_unavailable"); synchronized (lock) { return lastPlaybackDrainForTest; } }
    AudioRecord recorderForTest() { if (!BuildConfig.DEBUG) throw new IllegalStateException("test_audio_unavailable"); synchronized (lock) { return recorder; } }
    Object focusForTest() { if (!BuildConfig.DEBUG) throw new IllegalStateException("test_audio_unavailable"); synchronized (lock) { return focus; } }
    // Hold one real track before play(); signal only when its full buffer blocks drain priming.
    CountDownLatch holdNextPlaybackForTest() {
        if (!BuildConfig.DEBUG) throw new IllegalStateException("test_audio_unavailable");
        synchronized (lock) { nextPlaybackHoldForTest = new CountDownLatch(1); return nextPlaybackHoldForTest; }
    }
    private long primeDrain(long current, long deadline) throws InterruptedException {
        AudioTrack output; long target;
        synchronized (lock) {
            if (current != generation) return -1;
            if (track == null) throw new IllegalStateException("empty_pcm_stream");
            output = track; target = frames;
            if ((output.getPlaybackHeadPosition() & 0xffffffffL) >= target) return target;
        }
        // A short stream or final tail after underrun may not reach Android's start threshold.
        // Prime one full buffer, but finish at the real PCM target and discard leftover silence.
        long remaining = output.getBufferSizeInFrames() * 2L;
        if (remaining <= 0) throw new IllegalStateException("playback_format_unavailable");
        byte[] silence = new byte[(int) Math.min(PUMP_BYTES, remaining)];
        while (remaining > 0) {
            synchronized (lock) {
                if (current != generation || track != output) return -1;
                if ((output.getPlaybackHeadPosition() & 0xffffffffL) >= target) return target;
            }
            if (SystemClock.elapsedRealtime() >= deadline) throw new IllegalStateException("playback_drain_timeout");
            int count = output.write(silence, 0, (int) Math.min(silence.length, remaining), AudioTrack.WRITE_NON_BLOCKING);
            if (count < 0) throw new IllegalStateException("pcm_write_failed");
            if (count == 0) {
                if (BuildConfig.DEBUG) synchronized (lock) {
                    if (current == generation && track == output && playbackHoldForTest != null) playbackHoldForTest.countDown();
                }
                Thread.sleep(10);
            }
            else remaining -= count;
        }
        return target;
    }
    void cue(String id, NativeVoiceCue.Kind kind, int percent) {
        TestCuePlayer fixture = BuildConfig.DEBUG ? testCuePlayer : null;
        if (fixture != null) { stop(); fixture.play(id, kind, percent); return; }
        begin(id);
        pcm(id, NativeVoiceCue.SAMPLE_RATE, NativeVoiceCue.pcm(kind), percent / 100f); end(id);
    }
    void record(String id, String inputDeviceId) {
        stop();
        final long current;
        synchronized (lock) { request = id; capture = true; captureFinishing = false; current = generation; focusRelease++; }
        new Thread(() -> capture(current, id, inputDeviceId), "sedes-voice-capture").start();
    }
    /**
     * Closes physical capture without invalidating its generation. The capture worker delivers captureEnded only
     * after any in-progress captured callback has returned and the recorder is released. The recording coordinator
     * closes its own queue acceptance at the user's finish boundary and drains already accepted PCM separately.
     */
    void finishRecord(String id) {
        AudioRecord input;
        synchronized (lock) {
            if (!capture || !id.equals(request) || captureFinishing) return;
            captureFinishing = true;
            input = recorder;
            lock.notifyAll();
        }
        // Stop unblocks a native blocking read. Its expected abort is handled by the capture worker.
        if (input != null) try { input.stop(); } catch (Exception ignored) {}
    }
    private boolean acceptingCapture(long current) {
        synchronized (lock) { return current == generation && capture && !captureFinishing; }
    }
    private boolean finishingCapture(long current) {
        synchronized (lock) { return current == generation && capture && captureFinishing; }
    }
    private void capture(long current, String id, String inputDeviceId) {
        AudioRecord local = null;
        CaptureHealth health = null;
        boolean ended = false;
        String failure = null;
        try {
            if (!hasPermission()) throw new SecurityException("microphone_permission_required");
            TestSource fixture = BuildConfig.DEBUG ? testSource : null;
            if (fixture == null) {
                AudioDeviceInfo preferred = null, route = null;
                boolean bluetooth;
                synchronized (lock) {
                    if (!acceptingCapture(current)) { ended = finishingCapture(current); return; }
                    if (!requestFocus(true)) throw new IllegalStateException("audio_focus_unavailable");
                    if (inputDeviceId != null) {
                        for (AudioDeviceInfo device : manager.getDevices(AudioManager.GET_DEVICES_INPUTS))
                            if (Integer.toString(device.getId()).equals(inputDeviceId)) preferred = device;
                        if (preferred == null) throw new IllegalStateException("microphone_device_unavailable");
                    }
                    bluetooth = preferred != null && (preferred.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                        (Build.VERSION.SDK_INT >= 31 && preferred.getType() == AudioDeviceInfo.TYPE_BLE_HEADSET));
                    if (bluetooth) {
                        previousMode = manager.getMode(); manager.setMode(AudioManager.MODE_IN_COMMUNICATION); communication = true;
                        if (Build.VERSION.SDK_INT >= 31) {
                            // Communication routes are output devices: select the headset that owns the chosen input.
                            for (AudioDeviceInfo device : manager.getAvailableCommunicationDevices())
                                if (device.getType() == preferred.getType() && device.getAddress().equals(preferred.getAddress())) route = device;
                            if (route == null || !manager.setCommunicationDevice(route)) throw new IllegalStateException("microphone_route_failed");
                        }
                    }
                }
                if (bluetooth && !awaitRoute(current, route)) { ended = finishingCapture(current); return; }
                synchronized (lock) {
                    if (!acceptingCapture(current)) { ended = finishingCapture(current); return; }
                    int minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                    if (minimum <= 0) throw new IllegalStateException("microphone_format_unavailable");
                    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
                        throw new SecurityException("microphone_permission_required");
                    local = new AudioRecord(bluetooth ? MediaRecorder.AudioSource.VOICE_COMMUNICATION : MediaRecorder.AudioSource.VOICE_RECOGNITION,
                        SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum, SAMPLE_RATE / 5 * 2));
                    if (local.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("microphone_unavailable");
                    if (local.getSampleRate() != SAMPLE_RATE || local.getChannelCount() != 1 ||
                        local.getAudioFormat() != AudioFormat.ENCODING_PCM_16BIT)
                        throw new IllegalStateException("microphone_format_unavailable");
                    if (preferred != null && !local.setPreferredDevice(preferred)) throw new IllegalStateException("microphone_route_failed");
                    recorder = local;
                    health = new CaptureHealth(local, current, id, inputDeviceId);
                    health.register();
                    local.startRecording();
                    if (local.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IllegalStateException("microphone_start_failed");
                }
                if (!health.awaitInitialRoute()) { ended = finishingCapture(current); return; }
            }
            if (acceptingCapture(current)) listener.captureStarted(id);
            byte[] buffer = new byte[NativeVoiceCapturePolicy.FRAME_SAMPLES * 2];
            while (acceptingCapture(current)) {
                byte[] chunk;
                if (fixture != null) { chunk = fixture.next(); if (chunk == null) break; Thread.sleep(10); }
                else {
                    int count;
                    try { count = local.read(buffer, 0, buffer.length, AudioRecord.READ_BLOCKING); }
                    catch (RuntimeException stopped) { if (finishingCapture(current)) break; throw stopped; }
                    if (count <= 0) {
                        if (finishingCapture(current)) break;
                        throw new IllegalStateException("microphone_read_failed");
                    }
                    chunk = Arrays.copyOf(buffer, count);
                }
                if (!acceptingCapture(current)) break;
                if ((chunk.length & 1) != 0) throw new IllegalStateException("microphone_format_unavailable");
                if (chunk.length > 0) listener.captured(id, chunk);
            }
            ended = current(current);
        } catch (Exception error) {
            if (current(current)) failure = error instanceof SecurityException ? "microphone_permission_required" :
                code(error, "microphone_failed", "audio_focus_unavailable", "microphone_device_unavailable", "microphone_route_failed",
                    "microphone_silenced", "microphone_format_unavailable", "microphone_read_failed");
        }
        finally {
            if (health != null) health.close();
            synchronized (lock) {
                if (recorder == local) recorder = null;
                if (local != null) { try { local.stop(); } catch (Exception ignored) {} local.release(); }
                if (current == generation) { capture = false; captureFinishing = false; request = null; releaseCommunication(); releaseFocusLater(); }
            }
            if (current(current)) {
                if (failure != null) listener.failed(id, failure);
                else if (ended) listener.captureEnded(id);
            }
        }
    }

    /** Routing exists on every supported API; explicit silencing is observable from API 29. */
    private final class CaptureHealth implements AutoCloseable {
        final AudioRecord input;
        final long token;
        final String id, preferredId;
        final AudioRouting.OnRoutingChangedListener routing = ignored -> check();
        AudioManager.AudioRecordingCallback recording;
        int routeId = -1;
        boolean armed;
        CaptureHealth(AudioRecord input, long token, String id, String preferredId) {
            this.input = input; this.token = token; this.id = id; this.preferredId = preferredId;
        }
        void register() {
            input.addOnRoutingChangedListener(routing, main);
            if (Build.VERSION.SDK_INT >= 29) registerRecording();
        }
        @RequiresApi(29) private void registerRecording() {
            recording = new AudioManager.AudioRecordingCallback() {
                @Override public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configurations) { check(); }
            };
            input.registerAudioRecordingCallback(command -> main.post(command), recording);
        }
        boolean awaitInitialRoute() throws InterruptedException {
            long deadline = SystemClock.elapsedRealtime() + ROUTE_TIMEOUT_MS;
            while (acceptingCapture(token)) {
                AudioDeviceInfo routed = input.getRoutedDevice();
                if (routed != null) {
                    if (preferredId != null && !preferredId.equals(Integer.toString(routed.getId())))
                        throw new IllegalStateException("microphone_route_failed");
                    synchronized (lock) { routeId = routed.getId(); armed = true; }
                    if (silenced()) throw new IllegalStateException("microphone_silenced");
                    return true;
                }
                if (SystemClock.elapsedRealtime() >= deadline) throw new IllegalStateException("microphone_route_failed");
                Thread.sleep(10);
            }
            return false;
        }
        private boolean silenced() {
            if (Build.VERSION.SDK_INT < 29) return false;
            AudioRecordingConfiguration configuration = input.getActiveRecordingConfiguration();
            return configuration != null && configuration.isClientSilenced();
        }
        void check() {
            String reason = null;
            synchronized (lock) {
                if (!armed || !acceptingCapture(token) || recorder != input) return;
                AudioDeviceInfo actual = input.getRoutedDevice();
                if (actual == null || actual.getId() != routeId) reason = "microphone_device_unavailable";
                else if (silenced()) reason = "microphone_silenced";
            }
            if (reason != null) failCurrent(token, id, reason);
        }
        @Override public void close() {
            synchronized (lock) { armed = false; }
            try { input.removeOnRoutingChangedListener(routing); } catch (Exception ignored) {}
            if (Build.VERSION.SDK_INT >= 29 && recording != null)
                try { input.unregisterAudioRecordingCallback(recording); } catch (Exception ignored) {}
        }
    }
    /** Waits outside the lock for the Bluetooth voice route; false when the request was replaced meanwhile. */
    private boolean awaitRoute(long current, AudioDeviceInfo route) throws InterruptedException {
        CountDownLatch connected = new CountDownLatch(1);
        BroadcastReceiver receiver = null;
        if (Build.VERSION.SDK_INT < 31) {
            // The sticky state is current, and starting an already connected link does not rebroadcast it.
            receiver = new BroadcastReceiver() {
                @Override public void onReceive(Context ignored, Intent intent) {
                    if (intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_ERROR) == AudioManager.SCO_AUDIO_STATE_CONNECTED) connected.countDown();
                }
            };
            context.registerReceiver(receiver, new IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED), null, main);
        }
        try {
            if (receiver != null) synchronized (lock) { if (!acceptingCapture(current)) return false; manager.startBluetoothSco(); }
            long deadline = SystemClock.elapsedRealtime() + ROUTE_TIMEOUT_MS;
            while (!(Build.VERSION.SDK_INT >= 31 ? routed(route) : connected.getCount() == 0)) {
                if (!acceptingCapture(current)) return false;
                if (SystemClock.elapsedRealtime() >= deadline) throw new IllegalStateException("microphone_route_failed");
                connected.await(50, TimeUnit.MILLISECONDS);
            }
            return acceptingCapture(current);
        } finally { if (receiver != null) context.unregisterReceiver(receiver); }
    }
    // Android reports a Bluetooth SCO communication device only once its audio link is connected.
    @RequiresApi(31) private boolean routed(AudioDeviceInfo route) {
        AudioDeviceInfo active = manager.getCommunicationDevice();
        return active != null && active.getType() == route.getType() && active.getAddress().equals(route.getAddress());
    }
    private static String code(Exception error, String fallback, String... specific) {
        for (String code : specific) if (code.equals(error.getMessage())) return code;
        return fallback;
    }
    private boolean current(long value) { synchronized (lock) { return value == generation; } }
    private void openTrack(int sampleRate) {
        if (!requestFocus(false)) throw new IllegalStateException("audio_focus_unavailable");
        int minimum = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minimum <= 0) throw new IllegalStateException("playback_format_unavailable");
        track = new AudioTrack.Builder().setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()).setAudioFormat(new AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(sampleRate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(Math.max(minimum, sampleRate / 5 * 2)).setTransferMode(AudioTrack.MODE_STREAM).build();
        if (track.getState() != AudioTrack.STATE_INITIALIZED) throw new IllegalStateException("playback_unavailable");
        if (focus.ducked) track.setVolume(0.35f);
        rate = sampleRate; frames = 0;
        playbackHoldForTest = BuildConfig.DEBUG ? nextPlaybackHoldForTest : null;
        nextPlaybackHoldForTest = null;
        if (playbackHoldForTest == null) track.play();
    }
    private void write(long current, byte[] bytes, int length) {
        int offset = 0;
        while (offset < length) {
            AudioTrack output;
            synchronized (lock) { if (current != generation || track == null) return; output = track; }
            int count = output.write(bytes, offset, length - offset, AudioTrack.WRITE_BLOCKING);
            if (count <= 0) throw new IllegalStateException("pcm_write_failed");
            offset += count;
            synchronized (lock) { if (current == generation) frames += count / 2; }
        }
    }
    private static byte[] scaled(byte[] bytes, float gain) {
        if (gain == 1f) return bytes;
        byte[] result = new byte[bytes.length];
        for (int i = 0; i + 1 < bytes.length; i += 2) {
            short sample = (short) ((bytes[i] & 255) | (bytes[i + 1] << 8));
            int value = Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, Math.round(sample * gain)));
            result[i] = (byte) value; result[i + 1] = (byte) (value >> 8);
        }
        return result;
    }
    // Focus methods run under lock. A held entry of the same kind is reused across consecutive requests.
    private boolean requestFocus(boolean recording) {
        focusRelease++;
        if (focus != null && focus.recording == recording) { focus.ownerRequestId = request; return true; }
        if (manager == null) return false;
        Focus previous = focus, next = new Focus(recording, request);
        int gain = recording ? AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE : AudioManager.AUDIOFOCUS_GAIN_TRANSIENT;
        boolean granted;
        if (Build.VERSION.SDK_INT >= 26) {
            next.request = new AudioFocusRequest.Builder(gain).setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(recording ? AudioAttributes.USAGE_VOICE_COMMUNICATION : AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()).setOnAudioFocusChangeListener(next, main).build();
            granted = manager.requestAudioFocus(next.request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        } else granted = manager.requestAudioFocus(next, AudioManager.STREAM_MUSIC, gain) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        // The replacement is requested before the previous entry is abandoned, so other media never resumes in between.
        focus = granted ? next : null;
        if (previous != null) abandon(previous);
        if (!granted) abandon(next);
        return granted;
    }
    private void abandon(Focus entry) {
        if (Build.VERSION.SDK_INT >= 26) manager.abandonAudioFocusRequest(entry.request); else manager.abandonAudioFocus(entry);
    }
    private void abandonFocus() { focusRelease++; if (focus != null) { abandon(focus); focus = null; } }
    private void releaseFocusLater() {
        if (focus == null) return;
        long token = ++focusRelease;
        main.postDelayed(() -> { synchronized (lock) { if (token == focusRelease) abandonFocus(); } }, FOCUS_HOLD_MS);
    }
    private void releaseCommunication() {
        if (!communication) return;
        if (Build.VERSION.SDK_INT >= 31) manager.clearCommunicationDevice(); else manager.stopBluetoothSco();
        manager.setMode(previousMode); communication = false;
    }
    void stop() {
        synchronized (lock) {
            generation++; request = null; capture = false; captureFinishing = false;
            if (recorder != null) { try { recorder.stop(); } catch (Exception ignored) {} }
            releaseTrack(); releaseSpool(); releaseCommunication(); releaseFocusLater(); lock.notifyAll();
        }
    }
    private void releaseSpool() {
        try { if (spoolWriter != null) spoolWriter.close(); } catch (Exception ignored) {}
        try { if (spoolReader != null) spoolReader.close(); } catch (Exception ignored) {}
        spoolWriter = null; spoolReader = null;
        if (spool != null) { spool.delete(); spool = null; }
        spoolRead = 0; spoolWritten = 0; streamEnded = false; carry = -1;
    }
    private void releaseTrack() {
        if (track != null) {
            AudioTrack old = track; track = null;
            try {
                // A track that played keeps the output path warm for a consecutive one.
                if ((old.getPlaybackHeadPosition() & 0xffffffffL) > 0) warmUntil = SystemClock.elapsedRealtime() + FOCUS_HOLD_MS;
                old.pause(); old.flush();
            } catch (Exception ignored) {}
            old.release();
        }
        playbackHoldForTest = null;
        frames = 0; rate = 0;
    }
    private void failCurrent(long current, String id, String code) {
        synchronized (lock) { if (current != generation) return; stop(); }
        listener.failed(id, code);
    }
}
