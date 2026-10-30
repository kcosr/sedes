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
    /** The platform boundary lets JVM checks exercise this encoder's actual buffering and EOS state machine. */
    interface Codec extends AutoCloseable {
        int dequeueInput();
        ByteBuffer inputBuffer(int index);
        void queueInput(int index, int size, long timestampUs, boolean eos);
        Output dequeueOutput();
        ByteBuffer outputBuffer(int index);
        byte[] opusHead();
        void releaseOutput(int index);
        @Override void close();
    }
    static final class Output {
        final int index, offset, size;
        final boolean config, eos;
        Output(int index, int offset, int size, boolean config, boolean eos) {
            this.index = index; this.offset = offset; this.size = size; this.config = config; this.eos = eos;
        }
    }
    private final Codec codec;
    // At most one 100 ms accepted packet and a partial codec frame await input buffers.
    private final byte[] pending = new byte[MAX_PCM_PACKET_BYTES + FRAME_BYTES];
    private NativeOggOpusWriter writer;
    private int pendingBytes;
    private long sourceSamples, submittedSamples;
    private boolean finishing, inputEos, outputEos, closed;

    NativeVoiceOpusEncoder(int bitrate) {
        if (bitrate != 24000 && bitrate != 64000) throw new IllegalArgumentException("speech_opus_invalid_bitrate");
        codec = new PlatformCodec(bitrate);
    }
    NativeVoiceOpusEncoder(Codec codec) { this.codec = java.util.Objects.requireNonNull(codec); }

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
        // CSD arrives after initial PCM has been submitted. Wait for it only when all source
        // input is queued, so we know the lookahead without preventing the codec from starting.
        boolean sourceEnded = finishing && pendingBytes == 0;
        if (sourceEnded && writer == null) return false;
        boolean padDelay = sourceEnded && submittedSamples * 2 < sourceSamples * 2 + writer.preSkip();
        int index = codec.dequeueInput();
        if (index < 0) return false;
        ByteBuffer buffer = codec.inputBuffer(index);
        if (buffer == null || buffer.capacity() < FRAME_BYTES)
            throw new IllegalStateException("speech_opus_input_buffer_invalid");
        buffer.clear();
        long timestampUs = submittedSamples * 1_000_000L / SAMPLE_RATE;
        if (pendingBytes == 0 && !padDelay) {
            codec.queueInput(index, 0, timestampUs, true);
            inputEos = true;
        } else {
            int count = Math.min(FRAME_BYTES, pendingBytes);
            buffer.put(pending, 0, count);
            // Feed whole frames and explicitly cover encoder lookahead before EOS. Some Android
            // codecs return an empty EOS without emitting a final packet. Existing partial-frame
            // padding counts toward lookahead; sourceSamples never includes either kind of padding.
            for (int pad = count; pad < FRAME_BYTES; pad++) buffer.put((byte) 0);
            codec.queueInput(index, FRAME_BYTES, timestampUs, false);
            submittedSamples += FRAME_BYTES / 2;
            System.arraycopy(pending, count, pending, 0, pendingBytes - count);
            Arrays.fill(pending, pendingBytes - count, pendingBytes, (byte) 0);
            pendingBytes -= count;
        }
        return true;
    }

    private boolean drainOne() {
        Output output = codec.dequeueOutput();
        if (output == null) return false;
        if (output.index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { configureWriter(); return true; }
        if (output.index < 0) return true;
        try {
            if (writer == null) configureWriter();
            if (!output.config && output.size > 0) {
                if (writer == null || output.size > NativeOggOpusWriter.MAX_PACKET_BYTES)
                    throw new IllegalStateException("speech_opus_output_invalid");
                ByteBuffer buffer = codec.outputBuffer(output.index);
                if (buffer == null || output.offset < 0 || output.size < 0 || output.offset > buffer.capacity() - output.size)
                    throw new IllegalStateException("speech_opus_output_invalid");
                ByteBuffer packet = buffer.duplicate(); packet.position(output.offset); packet.limit(output.offset + output.size);
                byte[] bytes = new byte[output.size]; packet.get(bytes); writer.packet(bytes);
            }
            if (output.eos) {
                if (!inputEos || writer == null) throw new IllegalStateException("speech_opus_unexpected_eos");
                writer.finish(); outputEos = true;
            }
            return true;
        } finally { codec.releaseOutput(output.index); }
    }

    private void configureWriter() {
        if (writer != null) return;
        byte[] identification = codec.opusHead();
        if (identification == null) return;
        writer = new NativeOggOpusWriter(identification, null, ThreadLocalRandom.current().nextInt());
        if (finishing) writer.endInput(sourceSamples);
    }

    private void checkOpen() { if (closed) throw new IllegalStateException("speech_opus_encoder_closed"); }
    @Override public void close() {
        if (closed) return;
        closed = true; Arrays.fill(pending, (byte) 0); pendingBytes = 0;
        codec.close();
    }

    private static final class PlatformCodec implements Codec {
        private final MediaCodec codec;
        private final MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        PlatformCodec(int bitrate) {
            MediaCodec created = null;
            try {
                created = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
                MediaFormat format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, SAMPLE_RATE, 1);
                format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
                format.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
                format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, FRAME_BYTES);
                created.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
                created.start(); codec = created;
            } catch (Exception failure) {
                if (created != null) { try { created.release(); } catch (RuntimeException ignored) {} }
                throw new IllegalStateException("speech_opus_encoder_unavailable");
            }
        }
        @Override public int dequeueInput() { return codec.dequeueInputBuffer(0); }
        @Override public ByteBuffer inputBuffer(int index) { return codec.getInputBuffer(index); }
        @Override public void queueInput(int index, int size, long timestampUs, boolean eos) {
            codec.queueInputBuffer(index, 0, size, timestampUs, eos ? MediaCodec.BUFFER_FLAG_END_OF_STREAM : 0);
        }
        @Override public Output dequeueOutput() {
            int index = codec.dequeueOutputBuffer(info, 0);
            if (index == MediaCodec.INFO_TRY_AGAIN_LATER) return null;
            if (index < 0) return new Output(index, 0, 0, false, false);
            return new Output(index, info.offset, info.size,
                (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0, (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0);
        }
        @Override public ByteBuffer outputBuffer(int index) { return codec.getOutputBuffer(index); }
        @Override public byte[] opusHead() {
            MediaFormat format = codec.getOutputFormat();
            ByteBuffer head = format.getByteBuffer("csd-0");
            return head == null ? null : NativeVoiceOpusConfig.opusHead(head, format.getByteBuffer("csd-1"), format.getByteBuffer("csd-2"));
        }
        @Override public void releaseOutput(int index) { codec.releaseOutputBuffer(index, false); }
        @Override public void close() {
            try { codec.stop(); } catch (RuntimeException ignored) {}
            finally { codec.release(); }
        }
    }
}
