package dev.sedes.local;

import static org.junit.Assert.*;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class NativeVoiceSegmenterTest {
    @Test public void quietAudioIsOwnedAndLongQuietDoesNotCreateTinySegments() {
        List<NativeVoiceSegmenter.Segment> segments = new ArrayList<>();
        NativeVoiceSegmenter policy = new NativeVoiceSegmenter(60000, segments::add);
        for (int i = 0; i < 1205; i++) policy.accept(frame(200));
        policy.finish();
        assertEquals(3, segments.size());
        assertEquals(60L * 24000, segments.get(0).endSample);
        assertEquals(120L * 24000, segments.get(1).endSample);
        assertCoverage(segments, 1205L * 2400);
    }

    @Test public void pauseOwnsTheCompleteQuietRunAndNextWordHasANewOwner() {
        List<NativeVoiceSegmenter.Segment> segments = new ArrayList<>();
        NativeVoiceSegmenter policy = new NativeVoiceSegmenter(60000, segments::add);
        policy.accept(frame(1000));
        for (int i = 0; i < 11; i++) policy.accept(frame(0));
        assertTrue(segments.isEmpty());
        policy.accept(frame(0));
        assertEquals(NativeVoiceSegmenter.Boundary.PAUSE, segments.get(0).boundary);
        assertEquals(13L * 2400, segments.get(0).endSample);
        policy.accept(frame(1000)); policy.finish();
        assertCoverage(segments, 14L * 2400);
    }

    @Test public void reducedProviderLimitAlsoReducesTheSoftThreshold() {
        List<NativeVoiceSegmenter.Segment> segments = new ArrayList<>();
        NativeVoiceSegmenter policy = new NativeVoiceSegmenter(5000, segments::add);
        for (int i = 0; i < 25; i++) policy.accept(frame(1000));
        policy.accept(frame(0)); assertTrue(segments.isEmpty());
        policy.accept(frame(0));
        assertEquals(NativeVoiceSegmenter.Boundary.PAUSE, segments.get(0).boundary);
        assertEquals(27L * 2400, segments.get(0).endSample);
    }

    @Test public void hardCutSearchStaysInFinalSecondEvenWithNoUpload() {
        List<NativeVoiceSegmenter.Segment> segments = new ArrayList<>();
        NativeVoiceSegmenter policy = new NativeVoiceSegmenter(5000, segments::add);
        // The quietest old frame must not cause a retrospective cut near the beginning.
        policy.accept(frame(0));
        for (int i = 1; i < 50; i++) policy.accept(frame(1000));
        assertEquals(1, segments.size());
        assertEquals(50L * 2400, segments.get(0).endSample);
        assertEquals(NativeVoiceSegmenter.Boundary.HARD_LIMIT, segments.get(0).boundary);
    }

    @Test public void hardCutCarriesAnalyzedSpeechAndNeverMovesBehindUploadWatermark() {
        List<NativeVoiceSegmenter.Segment> segments = new ArrayList<>();
        NativeVoiceSegmenter policy = new NativeVoiceSegmenter(5000, segments::add);
        long largestUpload = 0;
        for (int i = 0; i < 50; i++) {
            policy.accept(frame(i == 41 ? 0 : 1000));
            if (segments.isEmpty()) largestUpload = Math.max(largestUpload, policy.uploadableEnd());
        }
        assertEquals(42L * 2400, segments.get(0).endSample);
        assertTrue(segments.get(0).endSample >= largestUpload);
        for (int i = 0; i < 12; i++) policy.accept(frame(0));
        assertEquals(2, segments.size());
        assertEquals(NativeVoiceSegmenter.Boundary.PAUSE, segments.get(1).boundary);
        assertCoverage(segments, 62L * 2400);
    }

    @Test public void arbitraryWholeSamplePacketsHaveIdenticalBoundaries() {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int i = 0; i < 160; i++) {
            byte[] frame = frame(i % 37 == 36 ? 0 : 1000);
            bytes.write(frame, 0, frame.length);
        }
        byte[] pcm = bytes.toByteArray();
        List<NativeVoiceSegmenter.Segment> expected = new ArrayList<>(), actual = new ArrayList<>();
        NativeVoiceSegmenter whole = new NativeVoiceSegmenter(5000, expected::add);
        whole.accept(pcm); whole.finish();
        NativeVoiceSegmenter split = new NativeVoiceSegmenter(5000, actual::add);
        for (int offset = 0, packet = 2; offset < pcm.length; packet = (packet * 7 + 12) % 9000 + 2) {
            int end = Math.min(pcm.length, offset + packet);
            split.accept(Arrays.copyOfRange(pcm, offset, end)); offset = end;
        }
        split.finish();
        assertEquals(expected.size(), actual.size());
        for (int i = 0; i < expected.size(); i++) {
            assertEquals(expected.get(i).startSample, actual.get(i).startSample);
            assertEquals(expected.get(i).endSample, actual.get(i).endSample);
            assertEquals(expected.get(i).boundary, actual.get(i).boundary);
        }
        assertCoverage(actual, pcm.length / 2);
    }

    @Test public void shortFinalTailIsPaddedWithoutOwningAdditionalRealSamples() {
        List<NativeVoiceSegmenter.Segment> segments = new ArrayList<>();
        NativeVoiceSegmenter policy = new NativeVoiceSegmenter(5000, segments::add);
        policy.accept(new byte[102]); policy.finish(); policy.finish();
        assertEquals(1, segments.size());
        assertEquals(51, segments.get(0).endSample);
        assertEquals(2349, segments.get(0).paddingSamples);
        assertEquals(51, policy.samples());
        List<NativeVoiceSegmenter.Segment> empty = new ArrayList<>();
        new NativeVoiceSegmenter(5000, empty::add).finish(); assertTrue(empty.isEmpty());
    }

    private static void assertCoverage(List<NativeVoiceSegmenter.Segment> segments, long end) {
        long cursor = 0, ordinal = 0;
        for (NativeVoiceSegmenter.Segment segment : segments) {
            assertEquals(ordinal++, segment.ordinal); assertEquals(cursor, segment.startSample);
            assertTrue(segment.endSample > cursor); cursor = segment.endSample;
        }
        assertEquals(end, cursor);
    }
    private static byte[] frame(int amplitude) {
        byte[] pcm = new byte[4800];
        for (int i = 0; i < pcm.length; i += 2) { pcm[i] = (byte) amplitude; pcm[i + 1] = (byte) (amplitude >> 8); }
        return pcm;
    }
}
