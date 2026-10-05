package dev.sedes.local;

import java.util.ArrayDeque;

/** Sample-owned PCM segmentation. Energy selects boundaries; it never discards quiet audio. */
final class NativeVoiceSegmenter {
    static final int SAMPLE_RATE = 24000;
    static final int FRAME_SAMPLES = 2400;
    static final int TAIL_SAMPLES = SAMPLE_RATE;
    static final double SPEECH_RMS = 0.012;
    enum Boundary { PAUSE, HARD_LIMIT, FINISH }
    interface Listener { void sealed(Segment segment); }

    static final class Segment {
        final long ordinal, startSample, endSample;
        final int paddingSamples;
        final Boundary boundary;
        Segment(long ordinal, long startSample, long endSample, int paddingSamples, Boundary boundary) {
            this.ordinal = ordinal; this.startSample = startSample; this.endSample = endSample;
            this.paddingSamples = paddingSamples; this.boundary = boundary;
        }
        long realSamples() { return endSample - startSample; }
    }
    private static final class Frame {
        final long end;
        final double energy;
        Frame(long end, double energy) { this.end = end; this.energy = energy; }
        boolean speech() { return energy >= SPEECH_RMS * SPEECH_RMS; }
    }

    private final long hardSamples, softSamples;
    private final Listener listener;
    private final ArrayDeque<Frame> tail = new ArrayDeque<>();
    private long samples, segmentStart, nextOrdinal, lastSpeech = -1;
    private int partialSamples;
    private double squares;
    private boolean finished;

    NativeVoiceSegmenter(int hardSegmentMs, Listener listener) { this(hardSegmentMs, 0, 0, listener); }
    NativeVoiceSegmenter(int hardSegmentMs, long startSample, long firstOrdinal, Listener listener) {
        if (hardSegmentMs < 5000 || hardSegmentMs > 60000 || hardSegmentMs % 100 != 0 ||
            startSample < 0 || startSample % FRAME_SAMPLES != 0 || firstOrdinal < 0 || listener == null)
            throw new IllegalArgumentException("invalid_segment_policy");
        this.hardSamples = (long) hardSegmentMs * SAMPLE_RATE / 1000;
        this.softSamples = Math.min(30L * SAMPLE_RATE, hardSamples / 2) / FRAME_SAMPLES * FRAME_SAMPLES;
        this.samples = this.segmentStart = startSample; this.nextOrdinal = firstOrdinal; this.listener = listener;
    }

    void accept(byte[] pcm) {
        if (finished) throw new IllegalStateException("segmenter_finished");
        if (pcm == null || (pcm.length & 1) != 0) throw new IllegalArgumentException("invalid_capture_pcm");
        for (int offset = 0; offset < pcm.length; offset += 2) {
            short value = (short) ((pcm[offset] & 255) | (pcm[offset + 1] << 8));
            double normalized = value / 32768.0;
            squares += normalized * normalized; samples++; partialSamples++;
            if (partialSamples == FRAME_SAMPLES) {
                Frame frame = new Frame(samples, squares / FRAME_SAMPLES);
                tail.addLast(frame);
                // The first candidate scores the frame just before the one-second tail.
                while (tail.size() > TAIL_SAMPLES / FRAME_SAMPLES + 1) tail.removeFirst();
                if (frame.speech()) lastSpeech = samples;
                partialSamples = 0; squares = 0;
                long age = samples - segmentStart;
                long quiet = lastSpeech < segmentStart ? -1 : samples - lastSpeech;
                long pauseSamples = age >= softSamples ? FRAME_SAMPLES * 2L : FRAME_SAMPLES * 12L;
                if (quiet >= pauseSamples) seal(samples, Boundary.PAUSE);
                else if (age >= hardSamples) {
                    long earliest = Math.max(segmentStart + FRAME_SAMPLES, samples - TAIL_SAMPLES);
                    Frame best = null;
                    for (Frame candidate : tail) {
                        if (candidate.end < earliest || candidate.end > samples) continue;
                        if (best == null || candidate.energy <= best.energy) best = candidate;
                    }
                    if (best == null) throw new IllegalStateException("segment_boundary_unavailable");
                    seal(best.end, Boundary.HARD_LIMIT);
                }
            }
        }
    }

    /** Upper upload watermark while this segment remains open; earlier sealed ranges may upload in full. */
    long uploadableEnd() {
        return finished ? samples : Math.max(segmentStart, samples / FRAME_SAMPLES * FRAME_SAMPLES - TAIL_SAMPLES);
    }
    long samples() { return samples; }
    long segmentStart() { return segmentStart; }
    long nextOrdinal() { return nextOrdinal; }

    void finish() {
        if (finished) return;
        finished = true;
        if (samples > segmentStart) seal(samples, Boundary.FINISH);
    }
    private void seal(long end, Boundary boundary) {
        long count = end - segmentStart;
        if (count <= 0 || count > hardSamples) throw new IllegalStateException("invalid_segment_boundary");
        int padding = boundary == Boundary.FINISH && count < FRAME_SAMPLES ? (int) (FRAME_SAMPLES - count) : 0;
        Segment sealed = new Segment(nextOrdinal++, segmentStart, end, padding, boundary);
        segmentStart = end; lastSpeech = -1;
        // A retrospective hard cut carries already analyzed frames into the new segment.
        for (Frame frame : tail) if (frame.end > end && frame.speech()) lastSpeech = frame.end;
        listener.sealed(sealed);
    }
}
