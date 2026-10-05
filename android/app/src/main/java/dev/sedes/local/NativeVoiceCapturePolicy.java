package dev.sedes.local;

/** Sample-clock ordinary endpointing; a held recording suspends only these endpoints. */
final class NativeVoiceCapturePolicy {
    static final int SAMPLE_RATE = 24000;
    static final int FRAME_SAMPLES = SAMPLE_RATE / 10;
    // Matches the former adapter's normalized PCM RMS threshold and 100 ms microphone chunks.
    static final double SPEECH_RMS = 0.012;
    enum End { CONTINUE, NO_SPEECH, SILENCE, MAX_DURATION }
    private final long startSamples, completionSamples, silenceSamples;
    private long samples, intervalStart, firstSpeech = -1, lastSpeech;
    private int frameSamples;
    private double squares;
    private End end = End.CONTINUE;
    private boolean held, sawSpeech;

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
                    sawSpeech = true;
                    if (firstSpeech < 0) firstSpeech = samples;
                    lastSpeech = samples;
                }
                frameSamples = 0; squares = 0;
                if (held) continue;
                if (firstSpeech < 0 && samples - intervalStart >= startSamples) end = End.NO_SPEECH;
                else if (firstSpeech >= 0 && samples - firstSpeech >= completionSamples) end = End.MAX_DURATION;
                else if (firstSpeech >= 0 && samples - lastSpeech >= silenceSamples) end = End.SILENCE;
            }
        }
        return end;
    }
    void setHeld(boolean value) {
        if (end != End.CONTINUE) throw new IllegalStateException("capture_already_ended");
        if (held && !value) resetTiming(sawSpeech);
        held = value;
    }
    /** Retains accepted sample accounting and speech evidence, but starts every ordinary deadline afresh. */
    void resetTiming(boolean knownSpeech) {
        if (end != End.CONTINUE) throw new IllegalStateException("capture_already_ended");
        intervalStart = samples;
        firstSpeech = knownSpeech || sawSpeech ? samples : -1;
        lastSpeech = samples;
        frameSamples = 0; squares = 0;
    }
    long samples() { return samples; }
    boolean sawSpeech() { return sawSpeech; }
}
