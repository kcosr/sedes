package dev.sedes.local;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioTrack;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import androidx.core.content.ContextCompat;
import java.io.File;
import java.io.RandomAccessFile;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

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
    private static final long MAX_SPOOL_BYTES = 256 * 1024 * 1024L;
    private static final int SAMPLE_RATE = 16000, PUMP_BYTES = 64 * 1024, MAX_CAPTURE = 16 * 1024 * 1024;
    private static boolean staleSpoolsRemoved;
    private final Context context;
    private final AudioManager manager;
    private final Listener listener;
    private final Object lock = new Object();
    private final ExecutorService playback = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private AudioTrack track;
    private AudioRecord recorder;
    private AudioFocusRequest focus;
    private long generation;
    private String request;
    private int rate, previousMode;
    private long frames;
    private boolean capture, communication;
    private File spool;
    private RandomAccessFile spoolWriter, spoolReader;
    private long spoolWritten, spoolRead;
    private boolean streamEnded;
    private float gain = 1f;
    private int preRoll = 512;
    private final AudioManager.OnAudioFocusChangeListener focusListener = this::focusChanged;
    private void focusChanged(int change) {
        String id;
        synchronized (lock) { id = request; }
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            stop(); if (id != null) listener.failed(id, "audio_focus_lost");
        } else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK || change == AudioManager.AUDIOFOCUS_GAIN) {
            synchronized (lock) { if (track != null) track.setVolume(change == AudioManager.AUDIOFOCUS_GAIN ? 1f : 0.35f); }
        }
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
        synchronized (lock) { request = id; capture = false; current = generation; }
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
            if (sampleRate < 8000 || sampleRate > 192000 || pcm.length % 2 != 0 || streamEnded || rate != 0 && rate != sampleRate) {
                failure = "invalid_pcm";
            } else if (spoolWritten + pcm.length > sampleRate * 2L * MAX_STREAM_DURATION_MS / 1000) {
                failure = "speech_duration_limit";
            } else if (spoolWritten + pcm.length > MAX_SPOOL_BYTES) {
                failure = "speech_storage_limit";
            } else if (pcm.length > 0) {
                try {
                    if (spool == null) {
                        spool = File.createTempFile("sedes-voice-pcm-", ".pcm", context.getCacheDir());
                        spoolWriter = new RandomAccessFile(spool, "rw"); spoolReader = new RandomAccessFile(spool, "r");
                        rate = sampleRate;
                    }
                    spoolWriter.write(scaled(pcm, overrideGain == null ? gain : overrideGain));
                    spoolWritten += pcm.length;
                    lock.notifyAll();
                } catch (Exception error) { failure = "speech_storage_unavailable"; }
            }
        }
        if (failure != null) failCurrent(current, id, failure);
    }
    void end(String id) {
        synchronized (lock) { if (!id.equals(request) || capture) return; streamEnded = true; lock.notifyAll(); }
    }
    private void pump(long current, String id) {
        byte[] buffer = new byte[PUMP_BYTES];
        long deadline = android.os.SystemClock.elapsedRealtime() + MAX_STREAM_DURATION_MS + 60000;
        try {
            while (true) {
                int count, warmup = 0;
                synchronized (lock) {
                    while (current == generation && spoolRead == spoolWritten && !streamEnded) {
                        if (android.os.SystemClock.elapsedRealtime() >= deadline) throw new IllegalStateException("speech_timeout");
                        lock.wait(100);
                    }
                    if (current != generation) return;
                    if (spoolRead == spoolWritten && streamEnded) break;
                    if (track == null) { openTrack(rate); warmup = preRoll * rate / 1000 * 2; }
                    count = (int) Math.min(buffer.length, spoolWritten - spoolRead);
                    spoolReader.readFully(buffer, 0, count); spoolRead += count;
                }
                if (warmup > 0) {
                    byte[] silence = new byte[Math.min(PUMP_BYTES, warmup)];
                    while (warmup > 0 && current(current)) { int size = Math.min(silence.length, warmup); write(current, silence, size); warmup -= size; }
                }
                write(current, buffer, count);
                if (android.os.SystemClock.elapsedRealtime() >= deadline) throw new IllegalStateException("speech_timeout");
            }
            long drainDeadline = android.os.SystemClock.elapsedRealtime() + 15000;
            long drainFrames = primeDrain(current, drainDeadline);
            if (drainFrames < 0) return;
            while (true) {
                synchronized (lock) {
                    if (current != generation) return;
                    if (track == null) throw new IllegalStateException("empty_pcm_stream");
                    if ((track.getPlaybackHeadPosition() & 0xffffffffL) >= drainFrames) break;
                }
                if (android.os.SystemClock.elapsedRealtime() >= drainDeadline) throw new IllegalStateException("playback_drain_timeout");
                Thread.sleep(10);
            }
            synchronized (lock) { if (current != generation) return; releaseTrack(); releaseSpool(); request = null; abandonFocus(); }
            listener.drained(id);
        } catch (Exception error) { failCurrent(current, id, "playback_failed"); }
    }
    long pendingPcmBytes() { synchronized (lock) { return spoolWritten - spoolRead; } }
    File spoolForTest() { if (!BuildConfig.DEBUG) throw new IllegalStateException("test_audio_unavailable"); synchronized (lock) { return spool; } }
    AudioTrack trackForTest() { if (!BuildConfig.DEBUG) throw new IllegalStateException("test_audio_unavailable"); synchronized (lock) { return track; } }
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
            if (android.os.SystemClock.elapsedRealtime() >= deadline) throw new IllegalStateException("playback_drain_timeout");
            int count = output.write(silence, 0, (int) Math.min(silence.length, remaining), AudioTrack.WRITE_NON_BLOCKING);
            if (count < 0) throw new IllegalStateException("pcm_write_failed");
            if (count == 0) Thread.sleep(10);
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
        synchronized (lock) { request = id; capture = true; current = generation; }
        new Thread(() -> capture(current, id, inputDeviceId), "sedes-voice-capture").start();
    }
    private void capture(long current, String id, String inputDeviceId) {
        AudioRecord local = null;
        try {
            if (!hasPermission()) throw new SecurityException("microphone_permission_required");
            TestSource fixture = BuildConfig.DEBUG ? testSource : null;
            if (fixture == null) {
                synchronized (lock) {
                    if (current != generation) return;
                    if (!requestFocus(true)) throw new IllegalStateException("audio_focus_unavailable");
                    AudioDeviceInfo preferred = null;
                    if (inputDeviceId != null) {
                        for (AudioDeviceInfo device : manager.getDevices(AudioManager.GET_DEVICES_INPUTS))
                            if (Integer.toString(device.getId()).equals(inputDeviceId)) preferred = device;
                        if (preferred == null) throw new IllegalStateException("microphone_device_unavailable");
                    }
                    boolean bluetooth = preferred != null && (preferred.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                        (Build.VERSION.SDK_INT >= 31 && preferred.getType() == AudioDeviceInfo.TYPE_BLE_HEADSET));
                    if (bluetooth) {
                        previousMode = manager.getMode(); manager.setMode(AudioManager.MODE_IN_COMMUNICATION); communication = true;
                        if (Build.VERSION.SDK_INT >= 31) manager.setCommunicationDevice(preferred);
                        else manager.startBluetoothSco();
                    }
                    int minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
                    if (minimum <= 0) throw new IllegalStateException("microphone_format_unavailable");
                    if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
                        throw new SecurityException("microphone_permission_required");
                    local = new AudioRecord(bluetooth ? MediaRecorder.AudioSource.VOICE_COMMUNICATION : MediaRecorder.AudioSource.VOICE_RECOGNITION,
                        SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minimum, 6400));
                    if (local.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("microphone_unavailable");
                    if (preferred != null && !local.setPreferredDevice(preferred)) throw new IllegalStateException("microphone_route_failed");
                    recorder = local; local.startRecording();
                    if (local.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IllegalStateException("microphone_start_failed");
                }
            }
            listener.captureStarted(id);
            byte[] buffer = new byte[3200]; int total = 0;
            while (current(current)) {
                byte[] chunk;
                if (fixture != null) { chunk = fixture.next(); if (chunk == null) break; Thread.sleep(10); }
                else { int count = local.read(buffer, 0, buffer.length, AudioRecord.READ_BLOCKING); if (count <= 0) throw new IllegalStateException("microphone_read_failed"); chunk = Arrays.copyOf(buffer, count); }
                if (!current(current)) return;
                total += chunk.length;
                if (total > MAX_CAPTURE) throw new IllegalStateException("microphone_limit_reached");
                listener.captured(id, chunk);
            }
            if (current(current)) listener.captureEnded(id);
        } catch (Exception error) { if (current(current)) listener.failed(id, "microphone_failed"); }
        finally {
            synchronized (lock) {
                if (recorder == local) recorder = null;
                if (local != null) { try { local.stop(); } catch (Exception ignored) {} local.release(); }
                if (current == generation) { capture = false; request = null; abandonFocus(); releaseCommunication(); }
            }
        }
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
        rate = sampleRate; frames = 0; track.play();
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
    private boolean requestFocus(boolean recording) {
        if (manager == null) return false;
        int gain = recording ? AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE : AudioManager.AUDIOFOCUS_GAIN_TRANSIENT;
        if (Build.VERSION.SDK_INT >= 26) {
            focus = new AudioFocusRequest.Builder(gain).setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(recording ? AudioAttributes.USAGE_VOICE_COMMUNICATION : AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()).setOnAudioFocusChangeListener(focusListener, main).build();
            return manager.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        }
        return manager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, gain) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
    }
    private void abandonFocus() {
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 26 && focus != null) manager.abandonAudioFocusRequest(focus);
        else manager.abandonAudioFocus(focusListener);
        focus = null;
    }
    private void releaseCommunication() {
        if (!communication) return;
        if (Build.VERSION.SDK_INT >= 31) manager.clearCommunicationDevice(); else manager.stopBluetoothSco();
        manager.setMode(previousMode); communication = false;
    }
    void stop() {
        synchronized (lock) {
            generation++; request = null; capture = false;
            if (recorder != null) { try { recorder.stop(); } catch (Exception ignored) {} }
            releaseTrack(); releaseSpool(); abandonFocus(); releaseCommunication(); lock.notifyAll();
        }
    }
    private void releaseSpool() {
        try { if (spoolWriter != null) spoolWriter.close(); } catch (Exception ignored) {}
        try { if (spoolReader != null) spoolReader.close(); } catch (Exception ignored) {}
        spoolWriter = null; spoolReader = null;
        if (spool != null) { spool.delete(); spool = null; }
        spoolRead = 0; spoolWritten = 0; streamEnded = false;
    }
    private void releaseTrack() {
        if (track != null) { try { track.pause(); track.flush(); track.release(); } catch (Exception ignored) {} track = null; }
        frames = 0; rate = 0;
    }
    private void failCurrent(long current, String id, String code) {
        synchronized (lock) { if (current != generation) return; stop(); }
        listener.failed(id, code);
    }
}
