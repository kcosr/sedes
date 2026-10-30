package dev.sedes.local;

import static org.junit.Assert.*;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.Test;

/** Exercises production PCM framing, codec pumping, and Ogg finalization with controlled platform EOS behavior. */
public class NativeVoiceOpusEncoderUnitTest {
    @Test public void wholeFramesNeedExplicitDelayPaddingWhenTheCodecEmitsOnlyEmptyEos() {
        for (int samples : new int[] {2400, 4800, 24000}) verify(samples, 312, false);
    }

    @Test public void partialFramesUseTheirExistingPaddingBeforeAddingAnyDelayFrames() {
        for (int samples : new int[] {2401, 2723, 2724, 2725, 2879, 2880, 2881}) verify(samples, 312, false);
    }

    @Test public void delayInThe48kClockCanBeZeroOddOrLongerThanOneInputFrame() {
        for (int delay : new int[] {0, 1, 120, 313, 960, 961, 2880, 65535}) {
            verify(2400, delay, false); verify(2401, delay, false);
        }
    }

    @Test public void codecsThatEmitAnExtraEosPacketStillHaveExactSourceDuration() {
        for (int samples : new int[] {2400, 2401, 2879, 24000}) verify(samples, 312, true);
    }

    @Test public void finishWaitsForDelayedFormatWithoutClaimingAnUnusedInputBuffer() {
        FakeCodec codec = new FakeCodec(312, false); codec.allowOutput = false;
        codec.outputs.add(new NativeVoiceOpusEncoder.Output(-3, 0, 0, false, false));
        try (NativeVoiceOpusEncoder encoder = new NativeVoiceOpusEncoder(codec)) {
            assertTrue(encoder.offer(pcm(2400)));
            encoder.finish(); encoder.finish();
            assertEquals(5, codec.inputFrames); assertEquals(0, codec.eosInputs);
            assertFalse(codec.inputOwned); assertEquals(2400, encoder.sourceSamples());
            codec.allowOutput = true;
            byte[] ogg = finish(encoder);
            assertEquals(6, codec.inputFrames); assertEquals(1, codec.eosInputs);
            assertEquals(0, codec.opusHeadRequestsBeforeFormat);
            assertDuration(ogg, 2400, 312);
        }
    }

    @Test public void repeatedFinishAndInputBackpressureDoNotDuplicateSourceOrPadding() {
        FakeCodec codec = new FakeCodec(961, false); codec.allowInput = false;
        byte[] first = pcm(2400), second = pcm(287);
        try (NativeVoiceOpusEncoder encoder = new NativeVoiceOpusEncoder(codec)) {
            assertTrue(encoder.offer(first));
            assertFalse(encoder.offer(first)); assertEquals(2400, encoder.sourceSamples());
            codec.allowInput = true;
            assertTrue(encoder.offer(second)); assertEquals(2687, encoder.sourceSamples());
            codec.allowInput = false;
            encoder.finish(); encoder.finish();
            assertEquals(0, codec.eosInputs);
            codec.allowInput = true;
            byte[] ogg = finish(encoder);
            assertEquals(7, codec.inputFrames); assertEquals(1, codec.eosInputs);
            assertEquals(2687, encoder.sourceSamples());
            byte[] accepted = concat(first, second), submitted = codec.pcm.toByteArray();
            assertArrayEquals(accepted, Arrays.copyOf(submitted, accepted.length));
            assertAllZero(submitted, accepted.length); assertDuration(ogg, 2687, 961);
        }
    }

    @Test public void boundedOutputCanBeDrainedAfterFinishWithoutLosingSource() {
        FakeCodec codec = new FakeCodec(312, false); codec.packetSize = 1200;
        byte[] packet = pcm(2400);
        try (NativeVoiceOpusEncoder encoder = new NativeVoiceOpusEncoder(codec)) {
            int accepted = 0;
            while (encoder.offer(packet)) { assertTrue(++accepted < 1000); }
            assertEquals(accepted * 2400L, encoder.sourceSamples());
            encoder.finish(); encoder.finish();
            assertFalse(encoder.finished());
            byte[] ogg = finish(encoder);
            assertEquals(accepted * 2400L, encoder.sourceSamples()); assertEquals(1, codec.eosInputs);
            assertDuration(ogg, accepted * 2400, 312);
        }
    }

    private static void verify(int samples, int delay, boolean extraEosPacket) {
        FakeCodec codec = new FakeCodec(delay, extraEosPacket);
        byte[] source = pcm(samples);
        ByteArrayOutputStream ogg = new ByteArrayOutputStream();
        try (NativeVoiceOpusEncoder encoder = new NativeVoiceOpusEncoder(codec)) {
            int offset = 0;
            for (int tries = 0; offset < source.length && tries < 10000; tries++) {
                int bytes = Math.min(4800, source.length - offset);
                if (encoder.offer(Arrays.copyOfRange(source, offset, offset + bytes))) offset += bytes;
                drain(encoder, ogg);
            }
            assertEquals(source.length, offset);
            byte[] ending = finish(encoder); ogg.write(ending, 0, ending.length);
            assertEquals(samples, encoder.sourceSamples()); assertEquals(1, codec.eosInputs);
            long requiredFrames = (samples * 2L + delay + 959) / 960;
            assertEquals("Only the required codec padding may be submitted", requiredFrames, codec.inputFrames);
            byte[] submitted = codec.pcm.toByteArray();
            assertArrayEquals(source, Arrays.copyOf(submitted, source.length));
            assertAllZero(submitted, source.length);
            for (int index = 0; index < codec.timestamps.size(); index++) assertEquals(index * 20000L, (long) codec.timestamps.get(index));
            assertDuration(ogg.toByteArray(), samples, delay);
        }
        assertTrue(codec.closed);
    }

    private static byte[] finish(NativeVoiceOpusEncoder encoder) {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        for (int tries = 0; !encoder.finished() && tries < 10000; tries++) { encoder.finish(); drain(encoder, output); }
        assertTrue("Codec did not finish", encoder.finished());
        encoder.finish(); assertNull(encoder.peek());
        return output.toByteArray();
    }
    private static void drain(NativeVoiceOpusEncoder encoder, ByteArrayOutputStream output) {
        byte[] page;
        while ((page = encoder.peek()) != null) { output.write(page, 0, page.length); encoder.pop(); }
    }
    private static byte[] pcm(int samples) {
        byte[] bytes = new byte[samples * 2];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) (i % 113 + 1);
        return bytes;
    }
    private static void assertAllZero(byte[] bytes, int from) { for (int i = from; i < bytes.length; i++) assertEquals(0, bytes[i]); }
    private static byte[] concat(byte[] first, byte[] second) {
        byte[] result = Arrays.copyOf(first, first.length + second.length); System.arraycopy(second, 0, result, first.length, second.length); return result;
    }
    private static void assertDuration(byte[] ogg, int samples, int delay) {
        int offset = 0, sequence = 0, lastPacketSamples = 0;
        long packetSamples = 0, previousGranule = 0;
        boolean eos = false;
        while (offset < ogg.length) {
            assertFalse(eos);
            ByteBuffer page = ByteBuffer.wrap(ogg, offset, ogg.length - offset).slice().order(ByteOrder.LITTLE_ENDIAN);
            assertEquals(0x5367674f, page.getInt()); assertEquals(sequence++, page.getInt(18));
            int flags = page.get(5) & 255, laces = page.get(26) & 255;
            assertEquals(0, flags & 1);
            int length = 0, position = offset + 27 + laces;
            for (int index = 0; index < laces; index++) {
                int lace = page.get(27 + index) & 255; length += lace;
                if (lace < 255) {
                    if (sequence > 2) { lastPacketSamples = NativeOggOpusWriter.packetSamples(Arrays.copyOfRange(ogg, position, position + length)); packetSamples += lastPacketSamples; }
                    position += length; length = 0;
                }
            }
            assertEquals(0, length);
            long granule = page.getLong(6); assertTrue(granule >= previousGranule); previousGranule = granule;
            eos = (flags & 4) != 0;
            if (eos) { assertEquals(samples * 2L + delay, granule); assertTrue(packetSamples - granule >= 0); assertTrue(packetSamples - granule < lastPacketSamples); }
            else if (sequence > 2) assertEquals(packetSamples, granule);
            offset = position;
        }
        assertEquals(ogg.length, offset); assertTrue(eos);
    }

    private static final class FakeCodec implements NativeVoiceOpusEncoder.Codec {
        final int delay;
        final boolean extraEosPacket;
        final ByteArrayOutputStream pcm = new ByteArrayOutputStream();
        final List<Long> timestamps = new ArrayList<>();
        final ByteBuffer input = ByteBuffer.allocate(960);
        final ArrayDeque<NativeVoiceOpusEncoder.Output> outputs = new ArrayDeque<>();
        final Map<Integer, byte[]> payloads = new HashMap<>();
        boolean allowInput = true, allowOutput = true, inputOwned, formatQueued, formatReady, closed;
        int inputFrames, eosInputs, nextIndex, opusHeadRequestsBeforeFormat, packetSize = 3;
        FakeCodec(int delay, boolean extraEosPacket) { this.delay = delay; this.extraEosPacket = extraEosPacket; }
        @Override public int dequeueInput() {
            assertFalse(inputOwned);
            if (!allowInput) return -1;
            inputOwned = true; return 0;
        }
        @Override public ByteBuffer inputBuffer(int index) { assertTrue(inputOwned); assertEquals(0, index); return input; }
        @Override public void queueInput(int index, int size, long timestampUs, boolean eos) {
            assertTrue(inputOwned); inputOwned = false; assertEquals(0, index);
            assertEquals(0, eosInputs);
            if (!formatQueued) { outputs.add(new NativeVoiceOpusEncoder.Output(-2, 0, 0, false, false)); formatQueued = true; }
            if (eos) {
                assertEquals(0, size); eosInputs++;
                output(extraEosPacket, true);
            } else {
                assertEquals(960, size); inputFrames++; timestamps.add(timestampUs);
                pcm.write(input.array(), 0, size); output(true, false);
            }
        }
        private void output(boolean packet, boolean eos) {
            byte[] bytes = new byte[packet ? packetSize : 0];
            if (packet) { bytes[0] = (byte) 0xf8; bytes[1] = (byte) 0xff; bytes[2] = (byte) 0xfe; }
            int index = nextIndex++; payloads.put(index, bytes);
            outputs.add(new NativeVoiceOpusEncoder.Output(index, 0, bytes.length, false, eos));
        }
        @Override public NativeVoiceOpusEncoder.Output dequeueOutput() {
            if (!allowOutput) return null;
            NativeVoiceOpusEncoder.Output output = outputs.pollFirst();
            if (output != null && output.index == -2) formatReady = true;
            return output;
        }
        @Override public ByteBuffer outputBuffer(int index) { return ByteBuffer.wrap(payloads.get(index)); }
        @Override public byte[] opusHead() {
            if (!formatReady) { opusHeadRequestsBeforeFormat++; return null; }
            return ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN).put("OpusHead".getBytes(StandardCharsets.US_ASCII))
                .put((byte) 1).put((byte) 1).putShort((short) delay).putInt(24000).putShort((short) 0).put((byte) 0).array();
        }
        @Override public void releaseOutput(int index) { assertNotNull(payloads.remove(index)); }
        @Override public void close() { closed = true; }
    }
}
