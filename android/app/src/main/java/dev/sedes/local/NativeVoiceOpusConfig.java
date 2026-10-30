package dev.sedes.local;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/** Normalizes platform Opus CSD to the mono Ogg identification header used on the wire. */
final class NativeVoiceOpusConfig {
    // AOSP OpusHeader.h: largest unified CSD, including the maximum channel mapping table.
    private static final int MAX_CSD_BYTES = 340;

    private NativeVoiceOpusConfig() {}

    static byte[] opusHead(ByteBuffer csd0, ByteBuffer csd1, ByteBuffer csd2) {
        if (csd0 == null || csd0.remaining() < 19 || csd0.remaining() > MAX_CSD_BYTES) throw invalid();
        ByteBuffer config = csd0.duplicate().order(ByteOrder.nativeOrder());
        String firstMarker = marker(config.duplicate());
        if (firstMarker.equals("OpusHead")) {
            // MediaCodec's documented separate CSD buffers, also used by some platform codecs.
            byte[] head = new byte[config.remaining()]; config.get(head);
            Long delay = csd1 == null ? null : duration(csd1);
            if (csd2 != null) duration(csd2); // Seek pre-roll is metadata; streaming does not seek.
            return NativeOggOpusWriter.opusHead(head, delay);
        }
        if (!firstMarker.startsWith("AOPUS") || csd1 != null || csd2 != null) throw invalid();

        // C2SoftOpusEnc::WriteOpusHeaders emits native-order {8-byte tag, uint64 length, data}.
        // CCodec passes that entire blob through csd-0; it only splits AVC codec-specific data.
        byte[] head = null;
        Long delay = null;
        boolean sawPreRoll = false;
        while (config.hasRemaining()) {
            if (config.remaining() < 16) throw invalid();
            String tag = marker(config);
            long length = config.getLong();
            if (length < 0 || length > config.remaining()) throw invalid();
            if (tag.equals("AOPUSHDR")) {
                if (head != null || length != 19) throw invalid();
                head = new byte[(int) length]; config.get(head);
            } else if (tag.equals("AOPUSDLY")) {
                if (delay != null || length != Long.BYTES) throw invalid();
                delay = nonnegative(config.getLong());
            } else if (tag.equals("AOPUSPRL")) {
                if (sawPreRoll || length != Long.BYTES) throw invalid();
                nonnegative(config.getLong()); sawPreRoll = true;
            } else throw invalid();
        }
        if (head == null || delay == null || !sawPreRoll) throw invalid();
        // Codec delay overrides the embedded header: AOSP stores lookahead in the input-rate
        // clock in OpusHead, but the nanosecond delay converts correctly to the Ogg 48 kHz clock.
        return NativeOggOpusWriter.opusHead(head, delay);
    }

    private static String marker(ByteBuffer bytes) {
        if (bytes.remaining() < 8) throw invalid();
        byte[] marker = new byte[8]; bytes.get(marker);
        return new String(marker, StandardCharsets.US_ASCII);
    }
    private static long duration(ByteBuffer bytes) {
        if (bytes.remaining() != Long.BYTES) throw invalid();
        return nonnegative(bytes.duplicate().order(ByteOrder.nativeOrder()).getLong());
    }
    private static long nonnegative(long value) { if (value < 0) throw invalid(); return value; }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("speech_opus_invalid_config"); }
}
