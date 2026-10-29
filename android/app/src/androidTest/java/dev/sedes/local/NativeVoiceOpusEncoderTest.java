package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.SystemClock;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import org.junit.Test;

/** Real platform codec checks. Compiling this class does not establish Android device behavior. */
public class NativeVoiceOpusEncoderTest {
    @Test public void realEncoderProducesDecodableStreamsAtSegmentAndCodecFrameBoundaries() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        for (int bitrate : new int[] {24000, 64000}) {
            for (int samples : new int[] {2400, 2401, 2879, 2880, 2881, 24479}) {
                byte[] ogg = encode(tone(samples), bitrate);
                assertExactOggDuration(ogg, samples);
                File file = File.createTempFile("sedes-opus-boundary-", ".ogg", context.getCacheDir());
                try {
                    try (FileOutputStream output = new FileOutputStream(file)) { output.write(ogg); }
                    assertDecodable(file, samples);
                } finally { assertTrue(file.delete()); }
            }
        }
    }

    @Test public void backpressureRetriesDoNotConsumePcmTwiceAndFinishIsIdempotent() throws Exception {
        byte[] packet = tone(2400);
        long deadline = SystemClock.elapsedRealtime() + 15000;
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (NativeVoiceOpusEncoder encoder = new NativeVoiceOpusEncoder(64000)) {
            int accepted = 0;
            // Deliberately stop consuming output to exercise the bounded queue on an actual codec.
            while (accepted < 1000 && SystemClock.elapsedRealtime() < deadline) {
                long before = encoder.sourceSamples();
                if (!encoder.offer(packet)) {
                    assertEquals(before, encoder.sourceSamples());
                    break;
                } else accepted++;
            }
            assertTrue("Output must become bounded", accepted < 1000);
            assertTrue("Codec did not accept audio", accepted > 0);
            assertEquals(accepted * 2400L, encoder.sourceSamples());
            while (SystemClock.elapsedRealtime() < deadline) {
                drain(encoder, output);
                if (encoder.offer(packet)) { accepted++; break; }
                SystemClock.sleep(2);
            }
            assertEquals(accepted * 2400L, encoder.sourceSamples());
            encoder.finish(); encoder.finish();
            while (!encoder.finished() && SystemClock.elapsedRealtime() < deadline) {
                drain(encoder, output); encoder.finish(); SystemClock.sleep(2);
            }
            assertTrue("Codec EOS did not drain", encoder.finished());
            assertExactOggDuration(output.toByteArray(), accepted * 2400);
        }
    }

    private static byte[] encode(byte[] pcm, int bitrate) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 15000;
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (NativeVoiceOpusEncoder encoder = new NativeVoiceOpusEncoder(bitrate)) {
            int offset = 0;
            while (offset < pcm.length && SystemClock.elapsedRealtime() < deadline) {
                int length = Math.min(4800, pcm.length - offset);
                if (encoder.offer(Arrays.copyOfRange(pcm, offset, offset + length))) offset += length;
                drain(encoder, output); SystemClock.sleep(2);
            }
            assertEquals("Codec input did not drain", pcm.length, offset);
            encoder.finish(); encoder.finish();
            while (!encoder.finished() && SystemClock.elapsedRealtime() < deadline) {
                drain(encoder, output); SystemClock.sleep(2);
            }
            assertTrue("Codec EOS did not drain", encoder.finished());
            assertEquals(pcm.length / 2, encoder.sourceSamples());
        }
        return output.toByteArray();
    }
    private static void drain(NativeVoiceAudioEncoder encoder, ByteArrayOutputStream output) {
        byte[] page;
        while ((page = encoder.peek()) != null) { output.write(page, 0, page.length); encoder.pop(); }
    }
    private static byte[] tone(int samples) {
        ByteBuffer pcm = ByteBuffer.allocate(samples * 2).order(ByteOrder.LITTLE_ENDIAN);
        for (int sample = 0; sample < samples; sample++)
            pcm.putShort((short) Math.round(10000 * Math.sin(2 * Math.PI * 440 * sample / 24000)));
        return pcm.array();
    }

    private static void assertExactOggDuration(byte[] ogg, int sourceSamples) {
        int position = 0, expectedSequence = 0, preSkip = -1;
        long packetSamples = 0, lastGranule = 0;
        boolean eos = false;
        while (position < ogg.length) {
            assertFalse("Page after EOS", eos);
            ByteBuffer page = ByteBuffer.wrap(ogg, position, ogg.length - position).slice().order(ByteOrder.LITTLE_ENDIAN);
            assertEquals(0x5367674f, page.getInt(0)); assertEquals(0, page.get(4));
            int flags = page.get(5) & 255, laces = page.get(26) & 255, bytes = 0;
            assertEquals(0, flags & 1); assertEquals(expectedSequence++, page.getInt(18));
            int packetStart = position + 27 + laces, packetLength = 0, finalPacketSamples = 0;
            for (int i = 0; i < laces; i++) {
                int lace = page.get(27 + i) & 255; bytes += lace; packetLength += lace;
                if (lace < 255) {
                    byte[] packet = Arrays.copyOfRange(ogg, packetStart, packetStart + packetLength);
                    if (expectedSequence == 1) {
                        assertEquals(2, flags); assertEquals(19, packet.length);
                        preSkip = ByteBuffer.wrap(packet).order(ByteOrder.LITTLE_ENDIAN).getShort(10) & 65535;
                    } else if (expectedSequence > 2) {
                        finalPacketSamples = NativeOggOpusWriter.packetSamples(packet);
                        packetSamples += finalPacketSamples;
                    }
                    packetStart += packetLength; packetLength = 0;
                }
            }
            assertEquals(0, packetLength);
            long granule = page.getLong(6); assertTrue(granule >= lastGranule); lastGranule = granule;
            eos = (flags & 4) != 0;
            if (eos) {
                assertEquals(preSkip + 2L * sourceSamples, granule);
                assertTrue(finalPacketSamples > 0); assertTrue(granule <= packetSamples);
                assertTrue("Padding crossed the final packet", packetSamples - granule < finalPacketSamples);
            } else if (expectedSequence > 2) assertEquals(packetSamples, granule);
            position += 27 + laces + bytes;
        }
        assertEquals(ogg.length, position); assertTrue(eos); assertTrue(preSkip >= 0);
    }

    private static void assertDecodable(File file, int sourceSamples) throws Exception {
        MediaExtractor extractor = new MediaExtractor(); MediaCodec decoder = null;
        try {
            extractor.setDataSource(file.getAbsolutePath()); assertEquals(1, extractor.getTrackCount());
            MediaFormat format = extractor.getTrackFormat(0);
            assertEquals(MediaFormat.MIMETYPE_AUDIO_OPUS, format.getString(MediaFormat.KEY_MIME));
            assertEquals(1, format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)); extractor.selectTrack(0);
            format.setInteger(MediaFormat.KEY_PCM_ENCODING, AudioFormat.ENCODING_PCM_16BIT);
            decoder = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS);
            decoder.configure(format, null, null, 0); decoder.start();
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            long deadline = SystemClock.elapsedRealtime() + 15000, decodedSamples = 0;
            int sampleRate = 0; boolean inputEos = false, outputEos = false;
            while (!outputEos && SystemClock.elapsedRealtime() < deadline) {
                if (!inputEos) {
                    int input = decoder.dequeueInputBuffer(0);
                    if (input >= 0) {
                        ByteBuffer buffer = decoder.getInputBuffer(input); assertNotNull(buffer); buffer.clear();
                        int count = extractor.readSampleData(buffer, 0);
                        if (count < 0) { decoder.queueInputBuffer(input, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputEos = true; }
                        else { decoder.queueInputBuffer(input, 0, count, extractor.getSampleTime(), 0); extractor.advance(); }
                    }
                }
                int output = decoder.dequeueOutputBuffer(info, 0);
                if (output == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat decoded = decoder.getOutputFormat(); sampleRate = decoded.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    assertEquals(1, decoded.getInteger(MediaFormat.KEY_CHANNEL_COUNT));
                    assertEquals(AudioFormat.ENCODING_PCM_16BIT, decoded.getInteger(MediaFormat.KEY_PCM_ENCODING));
                } else if (output >= 0) {
                    decodedSamples += info.size / 2;
                    outputEos = (info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0;
                    decoder.releaseOutputBuffer(output, false);
                } else SystemClock.sleep(2);
            }
            assertTrue("Decoder EOS did not drain", outputEos); assertTrue(sampleRate > 0);
            long expectedSamples = sourceSamples * (long) sampleRate / 24000;
            // Android extractors differ in whether they apply the final Ogg granule's end trim.
            // Container granules above assert exact duration; decoding must retain all source audio.
            assertTrue("Encoder lost the source tail", decodedSamples >= expectedSamples);
            assertTrue("Unexpected codec padding", decodedSamples < expectedSamples + sampleRate * 120L / 1000);
        } finally {
            if (decoder != null) { try { decoder.stop(); } finally { decoder.release(); } }
            extractor.release();
        }
    }
}
