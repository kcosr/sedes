package dev.sedes.local;

import java.io.Closeable;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;

/** Private PCM for exactly one speech request. Its owner serializes append, read and close. */
final class NativeVoicePcmSpool implements Closeable {
    static final long MAX_DURATION_MS = 10 * 60 * 1000L;
    private static final long MAX_BYTES = 256 * 1024 * 1024L;
    final String requestId;
    private final File directory;
    private File file;
    private RandomAccessFile writer, reader;
    private int sampleRate, carry = -1;
    private long written, read;
    private boolean ended, closed;

    NativeVoicePcmSpool(String requestId, File directory) {
        this.requestId = requestId;
        this.directory = directory;
    }

    int sampleRate() { return sampleRate; }
    long available() { return written - read; }
    boolean ended() { return ended; }
    File file() { return file; }
    void end() { ended = true; }

    void append(int rate, byte[] pcm, float gain) throws IOException {
        if (ended || closed || rate < 8000 || rate > 192000 || (sampleRate != 0 && sampleRate != rate))
            throw new IllegalArgumentException("invalid_pcm");
        int carried = carry < 0 ? 0 : 1;
        int length = pcm.length + carried;
        int even = length & ~1;
        if (written + even > rate * 2L * MAX_DURATION_MS / 1000) throw new IllegalArgumentException("speech_duration_limit");
        if (written + even > MAX_BYTES) throw new IllegalArgumentException("speech_storage_limit");
        sampleRate = rate;
        byte[] samples = pcm;
        if (carried != 0 || length != even) {
            samples = new byte[even];
            if (even > 0) {
                if (carried != 0) samples[0] = (byte) carry;
                System.arraycopy(pcm, 0, samples, carried, even - carried);
            }
        }
        if (length == even) carry = -1;
        else if (pcm.length > 0) carry = pcm[pcm.length - 1] & 255;
        if (even == 0) return;
        if (file == null) {
            file = File.createTempFile("sedes-voice-pcm-", ".pcm", directory);
            writer = new RandomAccessFile(file, "rw");
            reader = new RandomAccessFile(file, "r");
        }
        writer.write(scaled(samples, gain));
        written += even;
    }

    int read(byte[] output) throws IOException {
        int count = (int) Math.min(output.length, available());
        if (count > 0) {
            reader.readFully(output, 0, count);
            read += count;
        }
        return count;
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

    @Override public void close() {
        closed = true;
        try { if (writer != null) writer.close(); } catch (IOException ignored) {}
        try { if (reader != null) reader.close(); } catch (IOException ignored) {}
        writer = null; reader = null;
        if (file != null) { file.delete(); file = null; }
    }
}
