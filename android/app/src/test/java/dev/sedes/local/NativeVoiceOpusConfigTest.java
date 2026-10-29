package dev.sedes.local;

import static org.junit.Assert.*;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.Test;

public class NativeVoiceOpusConfigTest {
    /**
     * Exact mono layout from AOSP WriteOpusHeaders: marker + native uint64 length + payload.
     * C2SoftOpusEnc uses 156 input samples of lookahead at 24 kHz, which is 312 Ogg samples.
     */
    private static byte[] aospCsd() {
        return join(tag("AOPUSHDR", head(156)), tag("AOPUSDLY", duration(6_500_000)), tag("AOPUSPRL", duration(80_000_000)));
    }

    @Test public void normalizesTheActualAospEncoderUnifiedCsdAndItsDelay() {
        byte[] csd = aospCsd(); assertEquals(83, csd.length);
        ByteBuffer input = ByteBuffer.wrap(csd);
        byte[] normalized = NativeVoiceOpusConfig.opusHead(input, null, null);
        assertArrayEquals(head(312), normalized); assertEquals(0, input.position());
        NativeOggOpusWriter writer = new NativeOggOpusWriter(normalized, null, 17);
        assertEquals(312, writer.preSkip());
        byte[] page = writer.peek();
        assertArrayEquals(normalized, Arrays.copyOfRange(page, 28, page.length));
    }

    @Test public void acceptsDocumentedSeparateCsdWithoutMutatingBufferRanges() {
        ByteBuffer head = ByteBuffer.wrap(join(new byte[] {1, 2}, head(156), new byte[] {3}));
        head.position(2); head.limit(21);
        ByteBuffer delay = ByteBuffer.wrap(duration(6_500_000));
        assertArrayEquals(head(312), NativeVoiceOpusConfig.opusHead(head, delay, ByteBuffer.wrap(duration(80_000_000))));
        assertEquals(2, head.position()); assertEquals(21, head.limit()); assertEquals(0, delay.position());
        assertArrayEquals(head(312), NativeVoiceOpusConfig.opusHead(ByteBuffer.wrap(head(312)), null, null));
    }

    @Test public void rejectsTruncationTrailingBytesLengthsAndUnknownTags() {
        byte[] csd = aospCsd();
        for (int length = 0; length < csd.length; length++) invalid(Arrays.copyOf(csd, length));
        invalid(join(csd, new byte[] {0}));
        byte[] tooLong = csd.clone(); nativeBuffer(tooLong).putLong(8, Long.MAX_VALUE); invalid(tooLong);
        byte[] negativeLength = csd.clone(); nativeBuffer(negativeLength).putLong(8, -1); invalid(negativeLength);
        byte[] shortDelay = csd.clone(); nativeBuffer(shortDelay).putLong(43, 7); invalid(shortDelay);
        byte[] badTag = csd.clone(); badTag[39] = 'X'; invalid(badTag);
        invalid(new byte[341]);
    }

    @Test public void rejectsDuplicateMissingAndAmbiguousConfigurationFields() {
        byte[] head = tag("AOPUSHDR", head(156)), delay = tag("AOPUSDLY", duration(6_500_000)), preroll = tag("AOPUSPRL", duration(80_000_000));
        invalid(join(head, head, delay, preroll));
        invalid(join(head, delay, delay, preroll));
        invalid(join(head, delay, preroll, preroll));
        invalid(join(delay, preroll)); invalid(join(head, preroll)); invalid(join(head, delay));
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceOpusConfig.opusHead(ByteBuffer.wrap(aospCsd()), ByteBuffer.wrap(duration(6_500_000)), null));
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceOpusConfig.opusHead(ByteBuffer.wrap(aospCsd()), null, ByteBuffer.wrap(duration(80_000_000))));
    }

    @Test public void rejectsInvalidMonoHeaderDelayAndPrerollValues() {
        byte[] stereo = head(156); stereo[9] = 2;
        invalid(join(tag("AOPUSHDR", stereo), tag("AOPUSDLY", duration(6_500_000)), tag("AOPUSPRL", duration(80_000_000))));
        for (long delay : new long[] {-1, Long.MIN_VALUE, Long.MAX_VALUE, 1_365_312_501L}) {
            invalid(join(tag("AOPUSHDR", head(156)), tag("AOPUSDLY", duration(delay)), tag("AOPUSPRL", duration(80_000_000))));
            assertThrows(IllegalArgumentException.class, () -> NativeVoiceOpusConfig.opusHead(ByteBuffer.wrap(head(156)), ByteBuffer.wrap(duration(delay)), null));
        }
        invalid(join(tag("AOPUSHDR", head(156)), tag("AOPUSDLY", duration(6_500_000)), tag("AOPUSPRL", duration(-1))));
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceOpusConfig.opusHead(ByteBuffer.wrap(head(156)), ByteBuffer.wrap(new byte[7]), null));
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceOpusConfig.opusHead(ByteBuffer.wrap(head(156)), null, ByteBuffer.wrap(new byte[9])));
    }

    private static void invalid(byte[] csd) {
        assertThrows(IllegalArgumentException.class, () -> NativeVoiceOpusConfig.opusHead(ByteBuffer.wrap(csd), null, null));
    }
    private static byte[] head(int skip) {
        return ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN).put("OpusHead".getBytes(StandardCharsets.US_ASCII))
            .put((byte) 1).put((byte) 1).putShort((short) skip).putInt(24000).putShort((short) 0).put((byte) 0).array();
    }
    private static ByteBuffer nativeBuffer(byte[] bytes) { return ByteBuffer.wrap(bytes).order(ByteOrder.nativeOrder()); }
    private static byte[] duration(long ns) { return ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(ns).array(); }
    private static byte[] tag(String tag, byte[] data) {
        return ByteBuffer.allocate(16 + data.length).order(ByteOrder.nativeOrder())
            .put(tag.getBytes(StandardCharsets.US_ASCII)).putLong(data.length).put(data).array();
    }
    private static byte[] join(byte[]... inputs) {
        int length = 0; for (byte[] input : inputs) length += input.length;
        byte[] joined = new byte[length]; int offset = 0;
        for (byte[] input : inputs) { System.arraycopy(input, 0, joined, offset, input.length); offset += input.length; }
        return joined;
    }
}
