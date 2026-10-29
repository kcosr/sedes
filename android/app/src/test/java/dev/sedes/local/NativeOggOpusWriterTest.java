package dev.sedes.local;

import static org.junit.Assert.*;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class NativeOggOpusWriterTest {
    private static final byte[] SILENCE_20_MS = {(byte) 0xf8, (byte) 0xff, (byte) 0xfe};

    @Test public void producesCompleteHeaderPagesWithAndroidDelayInThe48kClock() {
        NativeOggOpusWriter writer = new NativeOggOpusWriter(head(156), 6_500_000L, 0x12345678);
        Page identification = take(writer), comments = take(writer);
        assertEquals(2, identification.flags); assertEquals(0, identification.granule);
        assertEquals(0, identification.sequence); assertEquals(0x12345678, identification.serial);
        assertEquals(1, identification.packets.size());
        byte[] head = identification.packets.get(0);
        assertEquals(312, unsigned16(head, 10)); assertEquals(24000, little(head).getInt(12));
        assertEquals(0, comments.flags); assertEquals(0, comments.granule); assertEquals(1, comments.sequence);
        assertEquals("OpusTags", new String(comments.packets.get(0), 0, 8, StandardCharsets.US_ASCII));
        assertEquals(0, little(comments.packets.get(0)).getInt(comments.packets.get(0).length - 4));
        assertNull(writer.peek()); assertFalse(writer.finished());
    }

    @Test public void holdsTheLastPageForEosAndDropsOnlyWholeSurplusPaddingPackets() {
        NativeOggOpusWriter writer = new NativeOggOpusWriter(head(312), null, 7);
        take(writer); take(writer);
        for (int i = 0; i < 5; i++) writer.packet(SILENCE_20_MS);
        assertNull("The final page must remain available for EOS", writer.peek());
        writer.endInput(2401);
        writer.packet(SILENCE_20_MS);
        Page first = take(writer);
        assertEquals(5, first.packets.size()); assertEquals(4800, first.granule); assertEquals(0, first.flags);
        writer.packet(SILENCE_20_MS); // A device may drain an additional whole padding packet.
        writer.finish(); writer.finish();
        assertFalse(writer.finished());
        Page last = take(writer);
        assertEquals(1, last.packets.size()); assertEquals(5114, last.granule); assertEquals(4, last.flags);
        assertEquals(3, last.sequence); assertEquals(5760, writer.packetSamples()); assertTrue(writer.finished());
    }

    @Test public void exactPacketEndNeedsNoPaddingPacketAndOneSampleInputIsRepresentable() {
        for (int sourceSamples : new int[] {1, 324, 2400, 2401, 2879, 2880, 2881, 24000}) {
            NativeOggOpusWriter writer = new NativeOggOpusWriter(head(312), null, sourceSamples);
            take(writer); take(writer); writer.endInput(sourceSamples);
            long needed = 312L + sourceSamples * 2;
            for (long encoded = 0; encoded < needed + 960; encoded += 960) writer.packet(SILENCE_20_MS);
            writer.finish();
            Page previous = null, last = null;
            while (writer.peek() != null) { previous = last; last = take(writer); }
            assertNotNull(last); assertEquals(4, last.flags); assertEquals(needed, last.granule);
            if (previous != null) assertTrue(previous.granule <= last.granule);
            assertTrue(writer.finished());
        }
    }

    @Test public void exactMultiplesOf255HaveTerminatingZeroLacesWithoutContinuation() {
        NativeOggOpusWriter writer = new NativeOggOpusWriter(head(0), null, -1);
        take(writer); take(writer);
        byte[] packet = new byte[510]; packet[0] = (byte) 0xf8;
        writer.endInput(480); writer.packet(packet); writer.finish();
        byte[] page = writer.peek();
        assertEquals(3, page[26] & 255); assertEquals(255, page[27] & 255);
        assertEquals(255, page[28] & 255); assertEquals(0, page[29] & 255);
        Page decoded = take(writer); assertEquals(4, decoded.flags); assertArrayEquals(packet, decoded.packets.get(0));
    }

    @Test public void stopsAcceptingBeforeTheOutputQueueCanGrowWithoutBound() {
        NativeOggOpusWriter writer = new NativeOggOpusWriter(head(312), null, 1);
        byte[] packet = new byte[8192]; packet[0] = (byte) 0xf8;
        int accepted = 0;
        while (writer.canAcceptPacket()) { writer.packet(packet); assertTrue(++accepted < 100); }
        assertThrows(IllegalStateException.class, () -> writer.packet(packet));
        int queuedBytes = 0;
        while (writer.peek() != null) { queuedBytes += writer.peek().length; take(writer); }
        assertTrue(queuedBytes <= NativeOggOpusWriter.MAX_QUEUED_BYTES);
        assertTrue(writer.canAcceptPacket());
    }

    @Test public void rejectsMissingAudioImpossibleTrimmingAndUnsupportedHeaders() {
        NativeOggOpusWriter writer = new NativeOggOpusWriter(head(312), null, 1);
        assertThrows(IllegalArgumentException.class, () -> writer.endInput(0));
        assertThrows(IllegalStateException.class, writer::finish);
        writer.endInput(2400); writer.packet(SILENCE_20_MS);
        assertThrows(IllegalStateException.class, writer::finish);
        assertThrows(IllegalStateException.class, () -> writer.endInput(2401));
        byte[] stereo = head(312); stereo[9] = 2;
        assertThrows(IllegalArgumentException.class, () -> new NativeOggOpusWriter(stereo, null, 1));
        assertThrows(IllegalArgumentException.class, () -> new NativeOggOpusWriter(head(0), -1L, 1));
        assertThrows(IllegalArgumentException.class, () -> new NativeOggOpusWriter(head(0), Long.MAX_VALUE, 1));
    }

    @Test public void readsAllTocDurationsAndRejectsInvalidPacketCountsAndStereo() {
        assertEquals(120, NativeOggOpusWriter.packetSamples(new byte[] {(byte) 0x80}));
        assertEquals(240, NativeOggOpusWriter.packetSamples(new byte[] {(byte) 0x88}));
        assertEquals(480, NativeOggOpusWriter.packetSamples(new byte[] {(byte) 0x90}));
        assertEquals(960, NativeOggOpusWriter.packetSamples(SILENCE_20_MS));
        assertEquals(2880, NativeOggOpusWriter.packetSamples(new byte[] {0x18}));
        assertEquals(5760, NativeOggOpusWriter.packetSamples(new byte[] {0x1b, 2}));
        assertThrows(IllegalArgumentException.class, () -> NativeOggOpusWriter.packetSamples(new byte[] {0x1b, 3}));
        assertThrows(IllegalArgumentException.class, () -> NativeOggOpusWriter.packetSamples(new byte[] {0x03, 0}));
        assertThrows(IllegalArgumentException.class, () -> NativeOggOpusWriter.packetSamples(new byte[] {0x03}));
        assertThrows(IllegalArgumentException.class, () -> NativeOggOpusWriter.packetSamples(new byte[] {(byte) 0xfc}));
    }

    static byte[] head(int skip) {
        ByteBuffer header = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN);
        header.put("OpusHead".getBytes(StandardCharsets.US_ASCII));
        header.put((byte) 1).put((byte) 1).putShort((short) skip).putInt(24000).putShort((short) 0).put((byte) 0);
        return header.array();
    }
    private static ByteBuffer little(byte[] bytes) { return ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN); }
    private static int unsigned16(byte[] bytes, int offset) { return little(bytes).getShort(offset) & 65535; }
    private static Page take(NativeOggOpusWriter writer) {
        byte[] bytes = writer.peek(); assertNotNull(bytes); Page page = new Page(bytes); writer.pop(); return page;
    }
    private static final class Page {
        final int flags, sequence, serial; final long granule;
        final List<byte[]> packets = new ArrayList<>();
        Page(byte[] page) {
            assertEquals("OggS", new String(page, 0, 4, StandardCharsets.US_ASCII)); assertEquals(0, page[4]);
            flags = page[5] & 255; assertEquals(0, flags & 1);
            granule = little(page).getLong(6); serial = little(page).getInt(14); sequence = little(page).getInt(18);
            int expectedCrc = little(page).getInt(22);
            byte[] unchecked = page.clone(); Arrays.fill(unchecked, 22, 26, (byte) 0);
            // Independent table-driven Ogg CRC calculation, rather than java.util.zip's reflected CRC32.
            int[] table = new int[256];
            for (int value = 0; value < 256; value++) {
                int remainder = value << 24;
                for (int bit = 0; bit < 8; bit++) remainder = remainder < 0 ? remainder << 1 ^ 0x04c11db7 : remainder << 1;
                table[value] = remainder;
            }
            int crc = 0;
            for (byte value : unchecked) crc = crc << 8 ^ table[(crc >>> 24 ^ value) & 255];
            assertEquals(expectedCrc, crc);
            int count = page[26] & 255, position = 27 + count, length = 0;
            for (int i = 0; i < count; i++) {
                int lace = page[27 + i] & 255; length += lace;
                if (lace < 255) { packets.add(Arrays.copyOfRange(page, position, position + length)); position += length; length = 0; }
            }
            assertEquals(0, length); assertEquals(page.length, position);
        }
    }
}
