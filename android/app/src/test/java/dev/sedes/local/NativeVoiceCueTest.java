package dev.sedes.local;

import static org.junit.Assert.*;
import org.junit.Test;

public class NativeVoiceCueTest {
    @Test public void startRisesAndFailureDescendsWithASilentGap() {
        byte[] start = NativeVoiceCue.pcm(NativeVoiceCue.Kind.START);
        byte[] failure = NativeVoiceCue.pcm(NativeVoiceCue.Kind.FAILURE);
        assertEquals(290 * NativeVoiceCue.SAMPLE_RATE / 1000 * 2, start.length);
        assertEquals(300 * NativeVoiceCue.SAMPLE_RATE / 1000 * 2, failure.length);
        assertEquals(523.25, frequency(start, 15, 80), 20);
        assertEquals(659.25, frequency(start, 165, 275), 20);
        assertEquals(659.25, frequency(failure, 15, 90), 20);
        assertEquals(493.88, frequency(failure, 175, 285), 20);
        assertSilent(start, 95, 150);
        assertSilent(failure, 105, 160);
    }
    @Test public void successIsASingleShortToneAndAllCuesFadeToSilence() {
        byte[] success = NativeVoiceCue.pcm(NativeVoiceCue.Kind.SUCCESS);
        assertEquals(140 * NativeVoiceCue.SAMPLE_RATE / 1000 * 2, success.length);
        assertEquals(659.25, frequency(success, 15, 125), 20);
        for (NativeVoiceCue.Kind kind : NativeVoiceCue.Kind.values()) {
            byte[] pcm = NativeVoiceCue.pcm(kind);
            assertEquals(0, sample(pcm, 0)); assertEquals(0, sample(pcm, pcm.length / 2 - 1));
            int peak = 0;
            for (int i = 0; i < pcm.length / 2; i++) peak = Math.max(peak, Math.abs(sample(pcm, i)));
            assertTrue("Cue must be audible and leave gain headroom", peak > 4000 && peak < 6000);
        }
    }
    private static int sample(byte[] pcm, int index) {
        return (short) ((pcm[index * 2] & 255) | (pcm[index * 2 + 1] << 8));
    }
    private static double frequency(byte[] pcm, int fromMs, int toMs) {
        int start = fromMs * NativeVoiceCue.SAMPLE_RATE / 1000, end = toMs * NativeVoiceCue.SAMPLE_RATE / 1000;
        int crossings = 0;
        for (int i = start + 1; i < end; i++) if (sample(pcm, i - 1) <= 0 && sample(pcm, i) > 0) crossings++;
        return crossings * NativeVoiceCue.SAMPLE_RATE / (double) (end - start);
    }
    private static void assertSilent(byte[] pcm, int fromMs, int toMs) {
        for (int i = fromMs * NativeVoiceCue.SAMPLE_RATE / 1000; i < toMs * NativeVoiceCue.SAMPLE_RATE / 1000; i++)
            assertEquals(0, sample(pcm, i));
    }
}
