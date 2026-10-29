package dev.sedes.local;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaFormat;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.concurrent.ThreadLocalRandom;

/** Android 10+ Opus encoding for one segment. Called only by the recording/transport worker. */
final class NativeVoiceOpusEncoder implements NativeVoiceAudioEncoder {
    private static final int SAMPLE_RATE = 24000;
    private static final int FRAME_BYTES = 960; // 20 ms, mono PCM16
    private static final int MAX_PCM_PACKET_BYTES = 4800;
    private static final int MAX_PUMP_STEPS = 32;
    private final MediaCodec codec;
    private final MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
    // At most one 100 ms accepted packet and a partial codec frame await input buffers.
    private final byte[] pending = new byte[MAX_PCM_PACKET_BYTES + FRAME_BYTES];
    private NativeOggOpusWriter writer;
    private int pendingBytes;
    private long sourceSamples, submittedSamples;
    private boolean finishing, inputEos, outputEos, closed;

    NativeVoiceOpusEncoder(int bitrate) {
        if (bitrate != 24000 && bitrate != 64000) throw new IllegalArgumentException("speech_opus_invalid_bitrate");
        MediaCodec created = null;
        try {
            created = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
            MediaFormat format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, SAMPLE_RATE, 1);
            format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
            format.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
            format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, FRAME_BYTES);
            created.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
            created.start();
            codec = created;
        } catch (Exception failure) {
            if (created != null) { try { created.release(); } catch (RuntimeException ignored) {} }
            throw new IllegalStateException("speech_opus_encoder_unavailable");
        }
    }

    @Override public boolean offer(byte[] pcm) {
        checkOpen();
        if (finishing) throw new IllegalStateException("speech_opus_input_finished");
        if (pcm == null || pcm.length == 0 || (pcm.length & 1) != 0 || pcm.length > MAX_PCM_PACKET_BYTES)
            throw new IllegalArgumentException("speech_opus_invalid_pcm");
        advance();
        if (pendingBytes + pcm.length > pending.length || writer != null && !writer.canAcceptPacket()) return false;
        System.arraycopy(pcm, 0, pending, pendingBytes, pcm.length);
        pendingBytes += pcm.length; sourceSamples += pcm.length / 2;
        advance();
        return true;
    }

    @Override public void finish() {
        checkOpen();
        if (!finishing) {
            if (sourceSamples == 0) throw new IllegalStateException("speech_opus_empty_input");
            finishing = true;
            if (writer != null) writer.endInput(sourceSamples);
        }
        advance();
    }

    @Override public byte[] peek() {
        checkOpen(); advance(); return writer == null ? null : writer.peek();
    }
    @Override public void pop() {
        checkOpen();
        if (writer == null) throw new IllegalStateException("speech_opus_output_empty");
        writer.pop();
    }
    @Override public boolean finished() { return outputEos && writer != null && writer.finished(); }
    @Override public long sourceSamples() { return sourceSamples; }

    /** Zero-timeout codec operations and a fixed work budget keep the runtime worker responsive. */
    private void advance() {
        for (int step = 0; step < MAX_PUMP_STEPS && !outputEos; step++) {
            if (writer != null && !writer.canAcceptPacket()) return;
            boolean progress = drainOne();
            if (outputEos) return;
            if (!inputEos && (pendingBytes >= FRAME_BYTES || finishing)) progress = feedOne() || progress;
            if (!progress) return;
        }
    }

    private boolean feedOne() {
        int index = codec.dequeueInputBuffer(0);
        if (index < 0) return false;
        ByteBuffer buffer = codec.getInputBuffer(index);
        if (buffer == null || buffer.capacity() < FRAME_BYTES)
            throw new IllegalStateException("speech_opus_input_buffer_invalid");
        buffer.clear();
        long timestampUs = submittedSamples * 1_000_000L / SAMPLE_RATE;
        if (pendingBytes == 0) {
            codec.queueInputBuffer(index, 0, 0, timestampUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
            inputEos = true;
        } else {
            int count = Math.min(FRAME_BYTES, pendingBytes);
            buffer.put(pending, 0, count);
            // Feed whole codec frames, including the final partial frame. A separate EOS drains
            // encoder lookahead; the Ogg granule removes both this padding and any surplus packet.
            for (int pad = count; pad < FRAME_BYTES; pad++) buffer.put((byte) 0);
            codec.queueInputBuffer(index, 0, FRAME_BYTES, timestampUs, 0);
            submittedSamples += FRAME_BYTES / 2;
            System.arraycopy(pending, count, pending, 0, pendingBytes - count);
            Arrays.fill(pending, pendingBytes - count, pendingBytes, (byte) 0);
            pendingBytes -= count;
        }
        return true;
    }

    private boolean drainOne() {
        int index = codec.dequeueOutputBuffer(info, 0);
        if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { configureWriter(codec.getOutputFormat()); return true; }
        if (index == MediaCodec.INFO_OUTPUT_BUFFERS_CHANGED) return true;
        if (index < 0) return false;
        try {
            boolean config = (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0;
            if (writer == null) configureWriter(codec.getOutputFormat());
            if (!config && info.size > 0) {
                if (writer == null || info.size > NativeOggOpusWriter.MAX_PACKET_BYTES)
                    throw new IllegalStateException("speech_opus_output_invalid");
                ByteBuffer buffer = codec.getOutputBuffer(index);
                if (buffer == null || info.offset < 0 || info.size < 0 || info.offset > buffer.capacity() - info.size)
                    throw new IllegalStateException("speech_opus_output_invalid");
                ByteBuffer packet = buffer.duplicate(); packet.position(info.offset); packet.limit(info.offset + info.size);
                byte[] bytes = new byte[info.size]; packet.get(bytes); writer.packet(bytes);
            }
            if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                if (!inputEos || writer == null) throw new IllegalStateException("speech_opus_unexpected_eos");
                writer.finish(); outputEos = true;
            }
            return true;
        } finally { codec.releaseOutputBuffer(index, false); }
    }

    private void configureWriter(MediaFormat format) {
        if (writer != null) return;
        ByteBuffer head = format.getByteBuffer("csd-0");
        if (head == null) return;
        byte[] identification = NativeVoiceOpusConfig.opusHead(head, format.getByteBuffer("csd-1"), format.getByteBuffer("csd-2"));
        writer = new NativeOggOpusWriter(identification, null, ThreadLocalRandom.current().nextInt());
        if (finishing) writer.endInput(sourceSamples);
    }

    private void checkOpen() { if (closed) throw new IllegalStateException("speech_opus_encoder_closed"); }
    @Override public void close() {
        if (closed) return;
        closed = true; Arrays.fill(pending, (byte) 0); pendingBytes = 0;
        try { codec.stop(); } catch (RuntimeException ignored) {}
        finally { codec.release(); }
    }
}
