package dev.sedes.local;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;

/**
 * Streaming mono Ogg Opus muxer. Packets never cross pages; each output is a complete page.
 * Keeps the last audio page until codec EOS so that exact source duration can trim encoder padding.
 * All granules, including pre-skip, use the mandatory Ogg Opus 48 kHz clock (RFC 7845).
 */
final class NativeOggOpusWriter {
    static final int MAX_QUEUED_BYTES = 64 * 1024;
    static final int MAX_PAGE_BYTES = 16 * 1024;
    static final int MAX_PACKET_BYTES = 8192;
    private static final int PAGE_SAMPLES = 4800; // approximately 100 ms per page
    private static final byte[] OPUS_HEAD = "OpusHead".getBytes(StandardCharsets.US_ASCII);
    private final ArrayDeque<byte[]> output = new ArrayDeque<>();
    private final ArrayList<byte[]> packets = new ArrayList<>();
    private final int serial, preSkip;
    private int sequence, queuedBytes, pageBytes, pageLaces;
    private long samples, pageSamples, finalGranule = -1;
    private boolean ended;

    NativeOggOpusWriter(byte[] identification, Long preSkipNanoseconds, int serial) {
        byte[] head = opusHead(identification, preSkipNanoseconds);
        this.serial = serial;
        this.preSkip = (head[10] & 255) | (head[11] & 255) << 8;
        emit(2, 0, java.util.Collections.singletonList(head));
        byte[] vendor = "Sedes".getBytes(StandardCharsets.UTF_8);
        ByteBuffer tags = ByteBuffer.allocate(16 + vendor.length).order(ByteOrder.LITTLE_ENDIAN);
        tags.put("OpusTags".getBytes(StandardCharsets.US_ASCII)).putInt(vendor.length).put(vendor).putInt(0);
        emit(0, 0, java.util.Collections.singletonList(tags.array()));
    }

    /** Android CSD-1 is a native-order nanosecond duration and overrides CSD-0's pre-skip. */
    static byte[] opusHead(byte[] identification, Long preSkipNanoseconds) {
        if (identification == null || identification.length != 19 ||
            !Arrays.equals(Arrays.copyOf(identification, 8), OPUS_HEAD) || identification[8] != 1 ||
            identification[9] != 1 || identification[16] != 0 || identification[17] != 0 || identification[18] != 0)
            throw new IllegalArgumentException("speech_opus_invalid_header");
        byte[] head = identification.clone();
        if (preSkipNanoseconds != null) {
            // Bound before multiplication; an OpusHead can represent at most 65,535 samples.
            if (preSkipNanoseconds < 0 || preSkipNanoseconds > 1_365_312_500L)
                throw new IllegalArgumentException("speech_opus_invalid_preskip");
            long skip = (preSkipNanoseconds * 48000 + 500_000_000L) / 1_000_000_000L;
            if (skip > 65535) throw new IllegalArgumentException("speech_opus_invalid_preskip");
            head[10] = (byte) skip; head[11] = (byte) (skip >>> 8);
        }
        // This is source metadata, not the Ogg granule clock or the decoder's output rate.
        ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN).putInt(12, 24000);
        return head;
    }

    int preSkip() { return preSkip; }
    long packetSamples() { return samples; }
    // One codec output can flush an ordinary page and then flush a second page at EOS.
    boolean canAcceptPacket() { return !ended && queuedBytes <= MAX_QUEUED_BYTES - 2 * MAX_PAGE_BYTES; }
    byte[] peek() { return output.peekFirst(); }
    void pop() {
        byte[] page = output.pollFirst();
        if (page == null) throw new IllegalStateException("speech_opus_output_empty");
        queuedBytes -= page.length;
    }
    boolean finished() { return ended && output.isEmpty(); }

    /** Must be set before draining codec padding. No samples are added for codec input padding. */
    void endInput(long sourceSamples24k) {
        if (sourceSamples24k <= 0 || sourceSamples24k > (Long.MAX_VALUE - preSkip) / 2)
            throw new IllegalArgumentException("speech_opus_invalid_duration");
        long requested = preSkip + sourceSamples24k * 2;
        if (finalGranule != -1 && finalGranule != requested)
            throw new IllegalStateException("speech_opus_duration_changed");
        if (requested < samples - pageSamples)
            throw new IllegalStateException("speech_opus_duration_already_sent");
        finalGranule = requested;
    }

    void packet(byte[] packet) {
        if (ended) throw new IllegalStateException("speech_opus_already_finished");
        int duration = packetSamples(packet);
        // A codec can produce a complete trailing packet after the exact source end is covered.
        if (finalGranule >= 0 && samples >= finalGranule) return;
        if (!canAcceptPacket()) throw new IllegalStateException("speech_opus_output_limit");
        int laces = packet.length / 255 + 1;
        if (!packets.isEmpty() && (pageSamples >= PAGE_SAMPLES || pageLaces + laces > 255 ||
            27 + pageLaces + laces + pageBytes + packet.length > MAX_PAGE_BYTES)) flush(false);
        packets.add(packet.clone());
        pageBytes += packet.length; pageLaces += laces; pageSamples += duration; samples += duration;
    }

    void finish() {
        if (ended) return;
        if (finalGranule < 0 || packets.isEmpty() || finalGranule > samples ||
            samples - finalGranule >= packetSamples(packets.get(packets.size() - 1)))
            throw new IllegalStateException("speech_opus_incomplete_output");
        flush(true); ended = true;
    }

    private void flush(boolean eos) {
        emit(eos ? 4 : 0, eos ? finalGranule : samples, packets);
        packets.clear(); pageBytes = 0; pageLaces = 0; pageSamples = 0;
    }

    private void emit(int flags, long granule, java.util.List<byte[]> pagePackets) {
        int dataLength = 0, laces = 0;
        for (byte[] packet : pagePackets) { dataLength += packet.length; laces += packet.length / 255 + 1; }
        if (laces > 255 || 27 + laces + dataLength > MAX_PAGE_BYTES)
            throw new IllegalStateException("speech_opus_page_limit");
        ByteBuffer page = ByteBuffer.allocate(27 + laces + dataLength).order(ByteOrder.LITTLE_ENDIAN);
        page.put(new byte[] {'O', 'g', 'g', 'S', 0, (byte) flags});
        page.putLong(granule).putInt(serial).putInt(sequence++).putInt(0).put((byte) laces);
        for (byte[] packet : pagePackets) {
            int remaining = packet.length;
            while (remaining >= 255) { page.put((byte) 255); remaining -= 255; }
            page.put((byte) remaining);
        }
        for (byte[] packet : pagePackets) page.put(packet);
        byte[] bytes = page.array();
        page.putInt(22, crc(bytes));
        if (queuedBytes + bytes.length > MAX_QUEUED_BYTES)
            throw new IllegalStateException("speech_opus_output_limit");
        output.addLast(bytes); queuedBytes += bytes.length;
    }

    /** RFC 6716 TOC duration. Complete packet layout is independently validated by the server. */
    static int packetSamples(byte[] packet) {
        if (packet == null || packet.length < 1 || packet.length > MAX_PACKET_BYTES || (packet[0] & 4) != 0)
            throw new IllegalArgumentException("speech_opus_invalid_packet");
        int toc = packet[0] & 255, config = toc >>> 3;
        int frameSamples = config >= 16 ? 120 << (config & 3) :
            config >= 12 ? 480 << (config & 1) : (config & 3) == 3 ? 2880 : 480 << (config & 3);
        int code = toc & 3;
        int count = code == 0 ? 1 : code != 3 ? 2 : packet.length < 2 ? 0 : packet[1] & 63;
        if (count == 0 || count * frameSamples > 5760)
            throw new IllegalArgumentException("speech_opus_invalid_packet");
        return count * frameSamples;
    }

    private static int crc(byte[] bytes) {
        int crc = 0;
        for (byte value : bytes) {
            crc ^= (value & 255) << 24;
            for (int bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc & 0x80000000) == 0 ? 0 : 0x04c11db7);
        }
        return crc;
    }
}
