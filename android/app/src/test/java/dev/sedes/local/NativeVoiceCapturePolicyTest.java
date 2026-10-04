package dev.sedes.local;

import static org.junit.Assert.*;
import java.util.Arrays;
import org.junit.Test;

public class NativeVoiceCapturePolicyTest {
    @Test public void silenceEndsByAudioDurationRegardlessOfDeliverySpeed() {
        NativeVoiceCapturePolicy policy = policy(1000, 5000, 500);
        for (int i = 0; i < 9; i++) assertEquals(NativeVoiceCapturePolicy.End.CONTINUE, policy.accept(frame(0)));
        assertEquals(NativeVoiceCapturePolicy.End.NO_SPEECH, policy.accept(frame(0)));
        assertFalse(policy.sawSpeech());
        assertEquals(24000, policy.samples());
        assertEquals(NativeVoiceCapturePolicy.End.NO_SPEECH, policy.accept(frame(1000)));
        assertEquals("A terminal recording never consumes later capture", 24000, policy.samples());
    }
    @Test public void legacyRmsThresholdDistinguishesQuietInputAndSignedSpeech() {
        for (int amplitude : new int[] { 393, -393 }) {
            NativeVoiceCapturePolicy policy = policy(100, 5000, 100);
            assertEquals(NativeVoiceCapturePolicy.End.NO_SPEECH, policy.accept(frame(amplitude)));
            assertFalse(policy.sawSpeech());
        }
        for (int amplitude : new int[] { 394, -394, Short.MIN_VALUE, Short.MAX_VALUE }) {
            NativeVoiceCapturePolicy policy = policy(100, 5000, 100);
            assertEquals(NativeVoiceCapturePolicy.End.CONTINUE, policy.accept(frame(amplitude)));
            assertTrue(policy.sawSpeech());
            assertEquals(NativeVoiceCapturePolicy.End.SILENCE, policy.accept(frame(0)));
        }
    }
    @Test public void renewedSpeechResetsTrailingSilenceWithoutExtendingTheMaximum() {
        NativeVoiceCapturePolicy policy = policy(1000, 600, 300);
        assertEquals(NativeVoiceCapturePolicy.End.CONTINUE, policy.accept(frame(1000)));
        for (int i = 0; i < 2; i++) assertEquals(NativeVoiceCapturePolicy.End.CONTINUE, policy.accept(frame(0)));
        assertEquals(NativeVoiceCapturePolicy.End.CONTINUE, policy.accept(frame(1000)));
        for (int i = 0; i < 2; i++) assertEquals(NativeVoiceCapturePolicy.End.CONTINUE, policy.accept(frame(0)));
        assertEquals(NativeVoiceCapturePolicy.End.MAX_DURATION, policy.accept(frame(1000)));
        assertEquals(24000 * 7 / 10, policy.samples());
    }
    @Test public void arbitraryWholeSampleChunksUseTheSameFramesAndDeadlines() {
        NativeVoiceCapturePolicy policy = policy(1000, 5000, 100);
        byte[] speech = frame(1000);
        assertEquals(NativeVoiceCapturePolicy.End.CONTINUE, policy.accept(Arrays.copyOfRange(speech, 0, 998)));
        assertEquals(NativeVoiceCapturePolicy.End.CONTINUE, policy.accept(Arrays.copyOfRange(speech, 998, speech.length)));
        assertEquals(NativeVoiceCapturePolicy.End.SILENCE, policy.accept(frame(0)));
        assertEquals(4800, policy.samples());
    }
    @Test public void absoluteCaptureBoundAppliesEvenAfterALateSpeechStart() {
        NativeVoiceCapturePolicy policy = policy(300000, 300000, 30000);
        for (int i = 0; i < 2999; i++) assertEquals(NativeVoiceCapturePolicy.End.CONTINUE, policy.accept(frame(0)));
        for (int i = 2999; i < 5999; i++) assertEquals(NativeVoiceCapturePolicy.End.CONTINUE, policy.accept(frame(1000)));
        assertEquals(NativeVoiceCapturePolicy.End.MAX_DURATION, policy.accept(frame(1000)));
        assertEquals(NativeVoiceCapturePolicy.MAX_CAPTURE_SAMPLES, policy.samples());
    }
    @Test public void malformedSamplesAreRejected() {
        try { policy(1000, 1000, 100).accept(new byte[3]); fail("Accepted half a sample"); }
        catch (IllegalArgumentException expected) { assertEquals("invalid_capture_pcm", expected.getMessage()); }
    }
    @Test public void aLargeReadStopsExactlyAtTheEndpointSample() {
        NativeVoiceCapturePolicy policy = policy(1000, 5000, 100);
        assertEquals(NativeVoiceCapturePolicy.End.NO_SPEECH, policy.accept(new byte[48000 + 2000]));
        assertEquals("The runtime can trim a partial final read at this sample", 24000, policy.samples());
    }
    private static NativeVoiceCapturePolicy policy(int start, int completion, int silence) {
        return new NativeVoiceCapturePolicy(start, completion, silence);
    }
    private static byte[] frame(int amplitude) {
        byte[] pcm = new byte[NativeVoiceCapturePolicy.FRAME_SAMPLES * 2];
        for (int i = 0; i < pcm.length; i += 2) { pcm[i] = (byte) amplitude; pcm[i + 1] = (byte) (amplitude >> 8); }
        return pcm;
    }
}
