package dev.sedes.local;

/** Sample-clock endpointing for signed PCM16 mono. Network and recorder timing cannot extend an utterance. */
final class NativeVoiceCapturePolicy {
    static final int SAMPLE_RATE = 24000;
    static final int FRAME_SAMPLES = SAMPLE_RATE / 10;
    static final long MAX_CAPTURE_SAMPLES = SAMPLE_RATE * 600L;
    // Matches the former adapter's normalized PCM RMS threshold and 100 ms microphone chunks.
    static final double SPEECH_RMS = 0.012;
    enum End { CONTINUE, NO_SPEECH, SILENCE, MAX_DURATION }
    private final long startSamples, completionSamples, silenceSamples;
    private long samples, firstSpeech = -1, lastSpeech;
    private int frameSamples;
    private double squares;
    private End end = End.CONTINUE;

    NativeVoiceCapturePolicy(int startTimeoutMs, int completionTimeoutMs, int endSilenceMs) {
        if (startTimeoutMs <= 0 || completionTimeoutMs <= 0 || endSilenceMs <= 0)
            throw new IllegalArgumentException("invalid_capture_timing");
        startSamples = SAMPLE_RATE * (long) startTimeoutMs / 1000;
        completionSamples = SAMPLE_RATE * (long) completionTimeoutMs / 1000;
        silenceSamples = SAMPLE_RATE * (long) endSilenceMs / 1000;
    }

    End accept(byte[] pcm) {
        if ((pcm.length & 1) != 0) throw new IllegalArgumentException("invalid_capture_pcm");
        for (int offset = 0; offset < pcm.length && end == End.CONTINUE; offset += 2) {
            short value = (short) ((pcm[offset] & 255) | (pcm[offset + 1] << 8));
            double normalized = value / 32768.0;
            squares += normalized * normalized; samples++; frameSamples++;
            if (frameSamples == FRAME_SAMPLES) {
                if (squares / frameSamples >= SPEECH_RMS * SPEECH_RMS) {
                    if (firstSpeech < 0) firstSpeech = samples;
                    lastSpeech = samples;
                }
                frameSamples = 0; squares = 0;
                if (samples >= MAX_CAPTURE_SAMPLES) end = End.MAX_DURATION;
                else if (firstSpeech < 0 && samples >= startSamples) end = End.NO_SPEECH;
                else if (firstSpeech >= 0 && samples - firstSpeech >= completionSamples) end = End.MAX_DURATION;
                else if (firstSpeech >= 0 && samples - lastSpeech >= silenceSamples) end = End.SILENCE;
            }
        }
        return end;
    }
    long samples() { return samples; }
    boolean sawSpeech() { return firstSpeech >= 0; }
}
