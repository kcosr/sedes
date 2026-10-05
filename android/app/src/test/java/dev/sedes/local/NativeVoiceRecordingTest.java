package dev.sedes.local;

import static org.junit.Assert.*;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.crypto.SecretKey;
import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class NativeVoiceRecordingTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void pipelinesOnlyAfterAckAndPersistsResultsBeforeNextCommit() {
        Harness h = new Harness(); h.start(true);
        h.feedFrames(50);
        Session socket = h.latest(); assertEquals(1, socket.commits.size());
        String first = socket.commits.get(0);
        h.feedFrames(10); assertEquals(1, socket.audio.size());
        socket.ack(first); h.flush();
        h.feedFrames(40);
        assertEquals(2, socket.audio.size());
        assertEquals("Second segment must wait for the first final result", 1, socket.commits.size());
        socket.result(first, "one"); h.flush();
        assertEquals(2, socket.commits.size());
        assertEquals("result:0", h.journal.events.get(h.journal.events.indexOf("commit:1") - 1));
        String second = socket.commits.get(1); socket.ack(second); h.flush();
        byte[] tail = pcm(17, 2100); assertTrue(h.recording.accept(tail)); h.flush();
        h.recording.beginFinish(NativeVoiceRecording.FinishReason.SEND);
        h.recording.finish(NativeVoiceRecording.FinishReason.SEND); h.flush();
        assertEquals(2, socket.commits.size());
        socket.result(second, "two"); h.flush();
        String third = socket.commits.get(2); socket.ack(third); h.flush(); socket.result(third, "three"); h.flush();
        assertEquals("one two three", h.listener.text); assertTrue(h.listener.maySubmit);
        assertEquals(240017, h.journal.end); assertEquals(240017, h.journal.completedSamples);
        assertArrayEquals(pcm(120000, 2100), socket.audio.get(first).toByteArray());
        assertArrayEquals(pcm(120000, 2100), socket.audio.get(second).toByteArray());
        byte[] padded = new byte[4800]; System.arraycopy(tail, 0, padded, 0, tail.length);
        assertArrayEquals(padded, socket.audio.get(third).toByteArray());
        assertNull(h.listener.error);
    }

    @Test public void aJournalAdoptedBeforeStartupHasHeldRetryAndRetentionSemanticsImmediately() {
        Harness h = new Harness(); h.journal.adopt(true); h.recording.start(true); h.flush();
        assertTrue(h.journal.keep); h.feedFrames(1);
        h.latest().fail(NativeSpeechTransport.Kind.NETWORK, "recognition_network_error"); h.flush();
        assertNull(h.listener.error); assertTrue(h.listener.reconnecting); assertFalse(h.journal.discarded);
        h.advance(1000); assertEquals(2, h.sessions.size());
        h.latest().fail(NativeSpeechTransport.Kind.AUTHENTICATION, "recognition_authentication_failed"); h.flush();
        assertEquals("recognition_authentication_failed", h.listener.error); assertTrue(h.listener.retained);
        assertTrue(h.journal.interrupted); assertEquals(2400, h.journal.durable); assertFalse(h.journal.discarded);
    }

    @Test public void backpressureReplaysExactlyTheUnacceptedPacket() {
        Harness h = new Harness(); h.start(true); h.latest().backpressure = true;
        h.feedFrames(50);
        assertTrue(h.latest().audio.isEmpty()); assertTrue(h.journal.durable > 0);
        h.latest().backpressure = false; h.advance(100);
        h.advance(100); h.advance(100); h.advance(100);
        assertEquals(1, h.latest().commits.size());
        String attempt = h.latest().commits.get(0);
        assertArrayEquals(pcm(120000, 2100), h.latest().audio.get(attempt).toByteArray());
    }

    @Test public void adoptedCaptureContinuesThroughUncertainRetryAndNeverReplaysCompletedPrefix() {
        Harness h = new Harness(); h.start(true); h.feedFrames(50);
        Session first = h.latest(); String done = first.commits.get(0);
        first.ack(done); h.flush(); first.result(done, "saved"); h.flush();
        h.feedFrames(50); String uncertain = first.commits.get(1); first.ack(uncertain); h.flush();
        first.fail(NativeSpeechTransport.Kind.NETWORK, "recognition_network"); h.flush();
        assertNull(h.listener.error); assertTrue(h.listener.reconnecting);
        h.feedFrames(10); assertEquals(264000, h.journal.accepted);
        h.advance(1000); assertEquals(2, h.sessions.size()); h.advance(100); h.advance(100); h.advance(100);
        Session retried = h.latest(); assertEquals(1, retried.commits.size());
        String retry = retried.commits.get(0);
        assertTrue(retry.contains("segment-1")); assertFalse(retry.equals(uncertain));
        assertArrayEquals(pcm(120000, 2100), retried.audio.get(retry).toByteArray());
        // Late callbacks from the closed connection cannot append text or move the durable prefix.
        first.result(uncertain, "stale"); h.flush(); assertEquals("saved", h.journal.text);
        retried.ack(retry); h.flush(); retried.result(retry, "new"); h.flush();
        assertEquals("saved new", h.journal.text); assertEquals(1, h.journal.completedOrdinal);
        assertNull(h.listener.error);
    }

    @Test public void recognitionErrorDuringPhysicalSendDrainRevokesAutomaticSubmission() {
        Harness h = new Harness(); h.start(true); h.feedFrames(50);
        Session socket = h.latest(); String attempt = socket.commits.get(0); socket.ack(attempt); h.flush();
        h.recording.beginFinish(NativeVoiceRecording.FinishReason.SEND);
        socket.fail(NativeSpeechTransport.Kind.TIMEOUT, "recognition_result_timeout"); h.flush();
        h.recording.finish(NativeVoiceRecording.FinishReason.SEND); h.flush();
        assertEquals("send_interrupted", h.journal.reason);
        h.advance(1000); h.advance(100); h.advance(100); h.advance(100);
        Session retry = h.latest(); String retried = retry.commits.get(0);
        retry.ack(retried); h.flush(); retry.result(retried, "retained"); h.flush();
        assertEquals("retained", h.listener.text); assertFalse(h.listener.maySubmit);
    }

    @Test public void replacementReadyWithoutAnyAcceptedUploadKeepsTheOutageDeadline() {
        Harness h = new Harness(); h.start(true); h.feedFrames(2);
        h.latest().fail(NativeSpeechTransport.Kind.NETWORK, "recognition_network"); h.flush();
        h.advance(1000); assertEquals(2, h.sessions.size()); assertNull(h.listener.error);
        h.advance(58999); assertNull(h.listener.error);
        h.advance(1); assertEquals("dictation_reconnect_timeout", h.listener.error);
        assertTrue(h.listener.retained); assertTrue(h.journal.interrupted);
    }

    @Test public void reconnectedQuietOpenSegmentKeepsRecordingPastTheOldOutageDeadline() {
        Harness h = new Harness(60000); h.start(true);
        for (int frame = 0; frame < 20; frame++) {
            assertTrue(h.recording.accept(pcm(2400, 0))); h.advance(100);
        }
        assertFalse(h.latest().audio.isEmpty()); assertTrue(h.latest().commits.isEmpty());
        h.latest().fail(NativeSpeechTransport.Kind.NETWORK, "recognition_network"); h.flush();
        for (int frame = 0; frame < 610; frame++) {
            assertTrue(h.recording.accept(pcm(2400, 0))); h.advance(100);
        }
        assertEquals(63000, h.time.now); assertEquals(2, h.sessions.size());
        assertEquals(1, h.latest().commits.size()); assertEquals(630L * 2400, h.journal.accepted);
        assertNull(h.listener.error); assertFalse(h.listener.reconnecting); assertNull(h.listener.text);
    }

    @Test public void retriedCommittedJobStillNeedsADurableResultBeforeTheOutageDeadline() {
        Harness h = new Harness(); h.start(true); h.feedFrames(50);
        String initial = h.latest().commits.get(0); h.latest().ack(initial); h.flush();
        h.latest().fail(NativeSpeechTransport.Kind.NETWORK, "recognition_network"); h.flush();
        h.advance(1000); h.advance(100); h.advance(100); h.advance(100);
        String retry = h.latest().commits.get(0); h.latest().ack(retry); h.flush();
        h.feedFrames(20); // Following open audio being accepted does not resolve the earlier committed job.
        h.advance(60000 - h.time.now - 1); assertNull(h.listener.error);
        h.advance(1); assertEquals("dictation_reconnect_timeout", h.listener.error);
        assertTrue(h.listener.retained); assertTrue(h.journal.interrupted);
    }

    @Test public void segmentSealedDuringTheOutageCannotClearItsNewCommitByUploadingTheNextOpenSegment() {
        Harness h = new Harness(); h.start(true); h.feedFrames(49);
        h.latest().fail(NativeSpeechTransport.Kind.NETWORK, "recognition_network"); h.flush();
        h.feedFrames(11); h.advance(1000); h.advance(100); h.advance(100); h.advance(100);
        String attempt = h.latest().commits.get(0); h.latest().ack(attempt); h.flush();
        h.feedFrames(10); assertEquals(2, h.latest().audio.size());
        h.advance(60000 - h.time.now); assertEquals("dictation_reconnect_timeout", h.listener.error);
        assertTrue(h.journal.interrupted);
    }

    @Test public void recoveryOfAnOpenUploadDoesNotRestoreTheRevokedSendContinuation() {
        Harness h = new Harness(); h.start(true); h.feedFrames(20);
        h.recording.beginFinish(NativeVoiceRecording.FinishReason.SEND);
        h.latest().fail(NativeSpeechTransport.Kind.NETWORK, "recognition_network"); h.flush();
        h.advance(1000); assertFalse(h.latest().audio.isEmpty()); assertTrue(h.latest().commits.isEmpty());
        h.recording.finish(NativeVoiceRecording.FinishReason.SEND); h.flush();
        String attempt = h.latest().commits.get(0); h.latest().ack(attempt); h.flush(); h.latest().result(attempt, "saved"); h.flush();
        assertEquals("saved", h.listener.text); assertFalse(h.listener.maySubmit); assertEquals("send_interrupted", h.journal.reason);
    }

    @Test public void retryUsesFiveFixedDelaysAndThenStops() {
        Harness h = new Harness(); h.start(true);
        int[] delays = {1000, 2000, 4000, 8000, 16000};
        for (int index = 0; index < delays.length; index++) {
            h.latest().fail(NativeSpeechTransport.Kind.NETWORK, "recognition_network"); h.flush();
            assertNull(h.listener.error); int before = h.sessions.size();
            h.advance(delays[index] - 1); assertEquals(before, h.sessions.size());
            h.advance(1); assertEquals(before + 1, h.sessions.size());
        }
        h.latest().fail(NativeSpeechTransport.Kind.NETWORK, "recognition_network"); h.flush();
        assertEquals("dictation_reconnect_exhausted", h.listener.error);
        assertEquals(6, h.sessions.size()); assertTrue(h.journal.interrupted);
    }

    @Test public void ordinaryFailureAndPermanentAdoptedFailureDoNotRetry() {
        Harness ordinary = new Harness(); ordinary.start(false);
        ordinary.latest().fail(NativeSpeechTransport.Kind.NETWORK, "recognition_network"); ordinary.flush();
        assertEquals("recognition_network", ordinary.listener.error); assertTrue(ordinary.journal.discarded);
        assertFalse(ordinary.listener.retained); ordinary.advance(60000); assertEquals(1, ordinary.sessions.size());
        Harness adopted = new Harness(); adopted.start(true);
        adopted.latest().fail(NativeSpeechTransport.Kind.AUTHENTICATION, "recognition_authentication"); adopted.flush();
        assertEquals("recognition_authentication", adopted.listener.error); assertTrue(adopted.listener.retained);
        adopted.advance(60000); assertEquals(1, adopted.sessions.size());
    }

    @Test public void acceptanceIsBoundedEvenWhileJournalWorkerIsStalled() {
        Harness h = new Harness(); h.start(true);
        for (int index = 0; index < NativeVoiceRecording.MAX_QUEUED_PACKETS; index++)
            assertTrue(h.recording.accept(pcm(2400, 2100)));
        assertEquals(1, h.worker.queue.size());
        assertFalse(h.recording.accept(pcm(2400, 2100)));
        assertEquals("dictation_capture_backpressure", h.listener.error);
        assertTrue(h.listener.retained); assertEquals(0, h.journal.accepted);
        h.flush(); assertTrue(h.journal.interrupted); assertEquals(153600, h.journal.durable);
    }

    @Test public void finishTimeoutReleasesRuntimeBeforeBlockedJournalCleanup() {
        Harness h = new Harness(); h.start(true); h.feedFrames(1);
        h.recording.beginFinish(NativeVoiceRecording.FinishReason.SEND);
        h.recording.finish(NativeVoiceRecording.FinishReason.SEND);
        // Do not run the journal worker: timer failure must not need it to signal the audio owner.
        h.time.advance(5000);
        assertEquals("dictation_flush_timeout", h.listener.error); assertTrue(h.listener.retained);
        h.flush(); assertTrue(h.journal.interrupted); assertNull(h.listener.text);
    }

    @Test public void retainedRetrySegmentsUnsealedTailWithoutStartingMicrophoneOrSending() {
        Harness h = new Harness();
        h.journal.adopted = true; h.journal.append(0, pcm(120017, 2100)); h.journal.checkpoint();
        h.recording.retry(); h.flush(); h.advance(100); h.advance(100); h.advance(100);
        assertEquals(0, h.listener.ready); assertEquals(1, h.journal.segments.size());
        Session socket = h.latest(); String first = socket.commits.get(0);
        socket.ack(first); h.flush(); socket.result(first, "first"); h.flush();
        String second = socket.commits.get(1); socket.ack(second); h.flush(); socket.result(second, "tail"); h.flush();
        assertEquals("first tail", h.listener.text); assertFalse(h.listener.maySubmit);
        assertEquals(120017, h.journal.accepted); assertEquals(120017, h.journal.completedSamples);
    }

    @Test public void timeoutFinishesTranscriptWithoutSubmissionAndMissingPcmFailsClosed() {
        Harness timeout = new Harness(); timeout.start(true); timeout.feedFrames(2);
        timeout.recording.finish(NativeVoiceRecording.FinishReason.TIMEOUT); timeout.flush();
        Session socket = timeout.latest(); String attempt = socket.commits.get(0);
        socket.ack(attempt); timeout.flush(); socket.result(attempt, "saved"); timeout.flush();
        assertFalse(timeout.listener.maySubmit); assertEquals("timeout", timeout.journal.reason);
        Harness gap = new Harness(); gap.start(true); gap.journal.truncateReads = true; gap.feedFrames(11);
        assertEquals("dictation_storage_corrupt", gap.listener.error); assertTrue(gap.listener.retained);
        assertTrue(gap.latest().audio.isEmpty());
    }

    @Test public void retryRejectsImmutableSegmentThatExceedsRefreshedCapabilitiesBeforeConnecting() {
        Harness h = new Harness(); h.journal.adopted = true;
        h.journal.append(0, pcm(144000, 2100)); h.journal.checkpoint(); h.journal.seal(0, 0, 144000, 0);
        h.recording.retry(); h.flush();
        assertEquals("dictation_segment_incompatible", h.listener.error);
        assertTrue(h.listener.retained); assertTrue(h.sessions.isEmpty()); assertEquals(1, h.journal.segments.size());
    }

    @Test public void sessionRotationWaitsForResolvedPrefixAndKeepsCapturingIntoSpool() {
        Harness h = new Harness(); h.start(true); h.feedFrames(50);
        Session first = h.latest(); String attempt = first.commits.get(0); first.assignable = false;
        first.ack(attempt); h.flush(); h.feedFrames(50);
        assertEquals(1, h.sessions.size()); assertEquals(240000, h.journal.durable);
        first.result(attempt, "saved"); h.flush();
        assertEquals(2, h.sessions.size()); assertTrue(first.cancelled);
        h.advance(100); h.advance(100); h.advance(100);
        assertEquals(1, h.latest().commits.size());
        String second = h.latest().commits.get(0);
        assertTrue(second.contains("segment-1")); assertArrayEquals(pcm(120000, 2100), h.latest().audio.get(second).toByteArray());
        assertNull(h.listener.error);
    }

    @Test public void failureCleanupPrecedesTheRuntimeRecoveryReadAndPreservesPendingAdoption() {
        Harness h = new Harness(); h.start(false);
        for (int index = 0; index < NativeVoiceRecording.MAX_QUEUED_PACKETS; index++)
            assertTrue(h.recording.accept(pcm(2400, 2100)));
        h.recording.setKeepListening(true, ignored -> {});
        h.listener.afterFailure = () -> h.worker.execute(() -> {
            assertTrue(h.journal.interrupted); assertTrue(h.journal.adopted); assertEquals(153600, h.journal.durable);
        });
        assertFalse(h.recording.accept(pcm(2400, 2100))); h.flush();
        assertTrue(h.listener.retained); assertFalse(h.journal.discarded);
    }

    @Test public void duplicateFinishCannotCreateASecondFlushDeadlineWhileRecognitionIsPending() {
        Harness h = new Harness(); h.start(true); h.feedFrames(2);
        h.recording.finish(NativeVoiceRecording.FinishReason.SEND); h.flush();
        h.recording.finish(NativeVoiceRecording.FinishReason.SEND); h.flush(); h.advance(5000);
        assertNull(h.listener.error); assertEquals(1, h.latest().commits.size());
    }

    @Test public void retryAtSegmentCapacityRecognizesSavedRangesBeforeSealingUnresolvedTail() {
        Harness h = new Harness(); h.journal.adopted = true; h.journal.pendingLimit = 2;
        h.journal.append(0, pcm(240017, 2100)); h.journal.checkpoint();
        h.journal.seal(0, 0, 120000, 0); h.journal.seal(1, 120000, 240000, 0);
        h.recording.retry(); h.flush(); h.advance(100); h.advance(100); h.advance(100);
        Session socket = h.latest(); String first = socket.commits.get(0);
        socket.ack(first); h.flush(); socket.result(first, "first"); h.flush();
        h.advance(100); h.advance(100); h.advance(100);
        String second = socket.commits.get(1); socket.ack(second); h.flush(); socket.result(second, "second"); h.flush();
        String third = socket.commits.get(2); socket.ack(third); h.flush(); socket.result(third, "tail"); h.flush();
        assertEquals("first second tail", h.listener.text); assertNull(h.listener.error);
        assertEquals(240017, h.journal.completedSamples); assertFalse(h.listener.maySubmit);
    }

    @Test public void failureDiscoveredDuringAssignmentKeepsItsRetryClassificationAndRevokesSend() {
        for (NativeSpeechTransport.Kind kind : new NativeSpeechTransport.Kind[] {NativeSpeechTransport.Kind.NETWORK, NativeSpeechTransport.Kind.TIMEOUT}) {
            Harness h = new Harness(); h.start(true); h.feedFrames(2);
            h.latest().assignmentFailure = kind;
            h.recording.finish(NativeVoiceRecording.FinishReason.SEND); h.flush();
            assertNull(h.listener.error); assertTrue(h.listener.reconnecting); assertEquals("send_interrupted", h.journal.reason);
            h.advance(1000);
            Session retry = h.latest(); String attempt = retry.commits.get(0);
            retry.ack(attempt); h.flush(); retry.result(attempt, "saved"); h.flush();
            assertEquals("saved", h.listener.text); assertFalse(h.listener.maySubmit);
        }
    }

    @Test public void firstUploadMatchesTheAdvertisedInitialSessionBudgetDelay() {
        Harness h = new Harness(); h.start(true);
        long firstUpload = NativeSpeechCapabilities.FIRST_UPLOAD_DELAY_MS;
        int frameMs = (int) NativeSpeechCapabilities.CAPTURE_FRAME_MS;
        assertEquals(0, firstUpload % frameMs);
        h.feedFrames((int) (firstUpload / frameMs) - 1); assertTrue(h.latest().audio.isEmpty());
        h.feedFrames(1); assertFalse(h.latest().audio.isEmpty());
    }

    @Test public void failedSealControlWriteStillDrainsHealthyQueuedPcmWithoutRepeatedSealing() {
        Harness h = new Harness(); h.start(true); h.feedFrames(49); h.journal.failSeal = true;
        for (int frame = 0; frame < 10; frame++) assertTrue(h.recording.accept(pcm(2400, 2100)));
        h.flush();
        assertEquals("dictation_storage_unavailable", h.listener.error); assertTrue(h.journal.interrupted);
        assertEquals(59L * 2400, h.journal.accepted); assertEquals(h.journal.accepted, h.journal.durable);
        assertArrayEquals(pcm(59 * 2400, 2100), h.journal.pcm.toByteArray());
    }

    @Test public void partialAppendFailureRetainsAndResumesOnlyTheUnacceptedPacketRemainder() {
        Harness h = new Harness(); h.start(true); h.journal.failAppendAfterSamples = 100;
        ByteArrayOutputStream expected = new ByteArrayOutputStream();
        for (int value : new int[] {2100, 2200, 2300}) {
            byte[] frame = pcm(2400, value); expected.write(frame, 0, frame.length); assertTrue(h.recording.accept(frame));
        }
        h.flush();
        assertEquals("dictation_storage_unavailable", h.listener.error); assertTrue(h.journal.interrupted);
        assertEquals(7200, h.journal.accepted); assertEquals(7200, h.journal.durable);
        assertArrayEquals(expected.toByteArray(), h.journal.pcm.toByteArray());
    }

    @Test public void checkpointFailureCannotSkipTheDurableInterruptionMarker() {
        Harness h = new Harness(); h.start(true); h.feedFrames(1); h.journal.failCheckpoint = true;
        h.recording.finish(NativeVoiceRecording.FinishReason.SEND); h.flush();
        assertEquals("dictation_storage_unavailable", h.listener.error);
        assertTrue(h.journal.interrupted); assertEquals(0, h.journal.end); assertTrue(h.listener.retained);
    }

    @Test public void encryptedStoreRetainsEveryAcceptedSampleAfterSealManifestFailureAndReopen() throws Exception {
        String binding = "profile\nhttps://sedes.example\n" + "a".repeat(64);
        javax.crypto.KeyGenerator generator = javax.crypto.KeyGenerator.getInstance("AES"); generator.init(256);
        SecretKey key = generator.generateKey();
        JSONObject defaults = NativeVoiceSettings.defaults().value, config = new JSONObject();
        for (String field : new String[] {"speechProvider", "speechEndpoint", "sttModel", "inputDeviceId", "recognitionStartTimeoutMs",
                "recognitionCompletionTimeoutMs", "recognitionEndSilenceMs", "recognitionResultTimeoutMs", "longDictationTimeoutMs",
                "recognizeStopCommand", "recognitionCues", "cueGain", "followComposerMode"})
            NativeVoiceJson.put(config, field, defaults.opt(field));
        byte[] frame = pcm(2400, 2100), expected = pcm(59 * 2400, 2100);
        for (String boundary : new String[] {"before_write", "after_replace"}) {
            File directory = temporary.newFolder(boundary); AtomicBoolean armed = new AtomicBoolean();
            NativeDictationStore.Disk disk = new NativeDictationStore.Disk() {
                @Override void fault(String point, File file) throws IOException {
                    if (armed.get() && point.equals(boundary) && file.getName().equals("manifest.enc")) {
                        armed.set(false); throw new IOException("injected_manifest_boundary");
                    }
                }
            };
            try (NativeDictationStore store = new NativeDictationStore(directory, () -> key, disk, NativeDictationStore.Limits.defaults())) {
                Queue queue = new Queue(); Listener listener = new Listener(); Time time = new Time();
                NativeDictationStore.Journal journal = store.create(binding, "recording", "thread", "Thread", config);
                NativeVoiceRecording recording = new NativeVoiceRecording("recording", onQueue(journal, queue), (id, events) -> {
                    events.ready(id, Long.MAX_VALUE);
                    return new NativeSpeechTransport.RecognitionSession() {
                        boolean ended;
                        public NativeSpeechTransport.SendResult append(String attempt, byte[] pcm) { return NativeSpeechTransport.SendResult.ACCEPTED; }
                        public NativeSpeechTransport.SendResult commit(String attempt) { throw new AssertionError("Control fault must precede commit"); }
                        public long deadlineMs() { return Long.MAX_VALUE; }
                        public boolean canAssign(long duration) { return true; }
                        public boolean ended() { return ended; }
                        public void cancel() { ended = true; }
                    };
                }, listener, 5000, 15000, time);
                recording.start(false); queue.run(); recording.setKeepListening(true, error -> assertNull(error)); queue.run();
                for (int count = 0; count < 49; count++) { assertTrue(recording.accept(frame)); queue.run(); }
                armed.set(true);
                for (int count = 0; count < 10; count++) assertTrue(recording.accept(frame));
                queue.run();
                assertFalse("Manifest fault must have fired", armed.get());
                assertEquals("dictation_storage_unavailable", listener.error); assertTrue(listener.retained);
                assertEquals("interrupted", journal.load().stage); assertEquals(59L * 2400, journal.load().endSample);
                assertArrayEquals(expected, durablePcm(journal));
            }
            try (NativeDictationStore store = new NativeDictationStore(directory, () -> key, new NativeDictationStore.Disk(), NativeDictationStore.Limits.defaults())) {
                NativeDictationStore.Recording recovered = store.recover(binding);
                assertEquals("interrupted", recovered.stage); assertEquals(59L * 2400, recovered.durableSamples);
                assertArrayEquals(expected, durablePcm(store.journal(binding, "recording")));
            }
        }
    }

    @Test public void durableAdoptionSurvivesInterruptionsBeforeTheFirstStartupWorker() throws Exception {
        for (boolean retry : new boolean[] { false, true }) {
            for (String reason : new String[] { "voice_off", "connection_changed", "audio_focus_lost" })
                assertAdoptedStartupRetained(retry, reason, false);
        }
    }

    @Test public void durableAdoptionSurvivesAnInitialJournalReadFailure() throws Exception {
        for (boolean retry : new boolean[] { false, true })
            assertAdoptedStartupRetained(retry, "dictation_storage_unavailable", true);
    }

    @Test public void anOrdinaryStartupInterruptionAndAnExplicitAdoptedDiscardStillDeleteTheirJournal() {
        Harness ordinary = new Harness(); ordinary.recording.start(false); ordinary.recording.interrupt("voice_off");
        assertFalse(ordinary.listener.retained); ordinary.flush(); assertTrue(ordinary.journal.discarded); assertTrue(ordinary.sessions.isEmpty());
        Harness adopted = new Harness(); adopted.journal.adopt(true); adopted.recording.start(true); adopted.recording.discard();
        adopted.flush(); assertTrue(adopted.journal.discarded); assertNull(adopted.listener.error); assertTrue(adopted.sessions.isEmpty());
    }

    private void assertAdoptedStartupRetained(boolean retry, String reason, boolean failFirstLoad) throws Exception {
        String binding = "profile\nhttps://sedes.example\n" + "a".repeat(64);
        javax.crypto.KeyGenerator generator = javax.crypto.KeyGenerator.getInstance("AES"); generator.init(256); SecretKey key = generator.generateKey();
        File directory = temporary.newFolder(); JSONObject config = new JSONObject(), defaults = NativeVoiceSettings.defaults().value;
        for (String field : new String[] {"speechProvider", "speechEndpoint", "sttModel", "inputDeviceId", "recognitionStartTimeoutMs",
                "recognitionCompletionTimeoutMs", "recognitionEndSilenceMs", "recognitionResultTimeoutMs", "longDictationTimeoutMs",
                "recognizeStopCommand", "recognitionCues", "cueGain", "followComposerMode"}) NativeVoiceJson.put(config, field, defaults.opt(field));
        try (NativeDictationStore store = new NativeDictationStore(directory, () -> key, new NativeDictationStore.Disk(), NativeDictationStore.Limits.defaults())) {
            NativeDictationStore.Journal journal = store.create(binding, "recording", "thread", "Thread", config); journal.adopt(true);
            if (retry) {
                journal.append(0, pcm(2400, 2100)); journal.checkpoint(); journal.seal(0, 0, 2400, 0); journal.complete(0, "Saved prefix");
                journal.append(2400, pcm(2400, 1200)); journal.checkpoint(); journal.finish("timeout", 4800);
            }
            Queue worker = new Queue(); Time time = new Time(); Listener listener = new Listener();
            NativeVoiceRecording recording = new NativeVoiceRecording("recording", onQueue(journal, worker, new AtomicBoolean(failFirstLoad)),
                (id, events) -> { fail("Interrupted startup must not open a transport"); return null; }, listener, 5000, 15000, time);
            if (retry) recording.retry(); else recording.start(true);
            if (!failFirstLoad) {
                // No queued coordinator work, including the initial journal read, has run yet.
                recording.interrupt(reason); assertTrue(listener.retained); assertEquals(reason, listener.error);
            }
            worker.run(); time.advance(60000); worker.run();
            assertTrue(time.closed); assertTrue(listener.retained); assertEquals(reason, listener.error); assertNull(listener.text);
            NativeDictationStore.Recording retained = journal.load(); assertTrue(retained.adopted); assertEquals(retry ? "interrupted" : "ready", retained.stage);
            assertEquals(retry ? "Saved prefix" : "", retained.text); assertEquals(retry ? 4800 : 0, retained.durableSamples);
            if (retry) assertArrayEquals(pcm(2400, 1200), journal.read(2400, 4800));
            assertTrue("An interruption must not create a discard marker", store.pendingRetirements(binding).isEmpty());
        }
        try (NativeDictationStore reopened = new NativeDictationStore(directory, () -> key, new NativeDictationStore.Disk(), NativeDictationStore.Limits.defaults())) {
            NativeDictationStore.Recording retained = reopened.recover(binding); assertNotNull(retained); assertTrue(retained.adopted);
            assertEquals(retry ? "Saved prefix" : "", retained.text); assertEquals(retry ? 4800 : 0, retained.durableSamples);
            if (retry) assertArrayEquals(pcm(2400, 1200), reopened.journal(binding, "recording").read(2400, 4800));
        }
    }

    @Test public void runtimeOwnedDiscardFencesCallbacksAndTimersWithoutChangingTheEncryptedDraft() throws Exception {
        String binding = "profile\nhttps://sedes.example\n" + "a".repeat(64);
        javax.crypto.KeyGenerator generator = javax.crypto.KeyGenerator.getInstance("AES"); generator.init(256);
        SecretKey key = generator.generateKey(); AtomicBoolean failTerminal = new AtomicBoolean();
        NativeDictationStore.Disk disk = new NativeDictationStore.Disk() {
            @Override void fault(String point, File file) throws IOException {
                if (point.equals("before_write") && file.getName().equals("terminal.enc") && failTerminal.getAndSet(false))
                    throw new IOException("injected_terminal_write_failure");
            }
        };
        File directory = temporary.newFolder("runtime-discard");
        JSONObject defaults = NativeVoiceSettings.defaults().value, config = new JSONObject();
        for (String field : new String[] {"speechProvider", "speechEndpoint", "sttModel", "inputDeviceId", "recognitionStartTimeoutMs",
                "recognitionCompletionTimeoutMs", "recognitionEndSilenceMs", "recognitionResultTimeoutMs", "longDictationTimeoutMs",
                "recognizeStopCommand", "recognitionCues", "cueGain", "followComposerMode"}) NativeVoiceJson.put(config, field, defaults.opt(field));
        try (NativeDictationStore store = new NativeDictationStore(directory, () -> key, disk, NativeDictationStore.Limits.defaults())) {
            NativeDictationStore.Journal journal = store.create(binding, "recording", "thread", "Thread", config);
            journal.adopt(true); journal.append(0, pcm(2400, 2100)); journal.checkpoint(); journal.seal(0, 0, 2400, 0);
            journal.complete(0, "Retained prefix"); journal.append(2400, pcm(2400, 1200)); journal.checkpoint();
            journal.seal(1, 2400, 4800, 0); journal.finish("timeout", 4800);
            Queue worker = new Queue(); Time time = new Time(); Listener listener = new Listener();
            List<NativeSpeechTransport.RecognitionListener> callbacks = new ArrayList<>(); List<String> connections = new ArrayList<>();
            String[] attempt = { null }; boolean[] cancelled = { false };
            NativeVoiceRecording recording = new NativeVoiceRecording("recording", onQueue(journal, worker), (id, events) -> {
                callbacks.add(events); connections.add(id); events.ready(id, Long.MAX_VALUE);
                return new NativeSpeechTransport.RecognitionSession() {
                    public NativeSpeechTransport.SendResult append(String current, byte[] pcm) { return NativeSpeechTransport.SendResult.ACCEPTED; }
                    public NativeSpeechTransport.SendResult commit(String current) { attempt[0] = current; return NativeSpeechTransport.SendResult.ACCEPTED; }
                    public long deadlineMs() { return Long.MAX_VALUE; }
                    public boolean canAssign(long duration) { return true; }
                    public boolean ended() { return cancelled[0]; }
                    public void cancel() { cancelled[0] = true; }
                };
            }, listener, 5000, 15000, time);
            recording.retry(); worker.run(); assertNotNull(attempt[0]);
            callbacks.get(0).committed(connections.get(0), attempt[0], "item"); worker.run();
            NativeDictationStore.Recording before = journal.load(); Map<String, byte[]> files = encryptedFiles(directory);
            // These callbacks were already queued before the user pressed Discard; none may change the saved draft.
            callbacks.get(0).completed(connections.get(0), attempt[0], "item", "Late result");
            callbacks.get(0).failed(connections.get(0), attempt[0], new NativeSpeechTransport.Failure(NativeSpeechTransport.Kind.NETWORK, "recognition_network_error", 0));
            recording.cancelForDiscard(); worker.run(); time.advance(60000); worker.run();
            assertTrue(cancelled[0]); assertTrue(time.closed); assertEquals(1, connections.size());
            assertNull(listener.text); assertNull(listener.error); assertFalse(recording.accept(pcm(2400, 1)));
            // A failed runtime tombstone must leave the same authenticated text/audio available to retry or copy.
            failTerminal.set(true); assertThrows(NativeDictationStore.Failure.class, () -> store.beginDiscard(binding, "recording", null));
            NativeDictationStore.Recording retained = journal.load(); assertEquals(before.revision, retained.revision);
            assertEquals(before.stage, retained.stage); assertEquals("Retained prefix", store.transcript(binding, "recording"));
            assertArrayEquals(pcm(2400, 1200), journal.read(2400, 4800)); assertTrue(store.pendingRetirements(binding).isEmpty());
            Map<String, byte[]> after = encryptedFiles(directory); assertEquals(files.keySet(), after.keySet());
            for (String name : files.keySet()) assertArrayEquals(name, files.get(name), after.get(name));
        }
    }
    private static Map<String, byte[]> encryptedFiles(File root) throws IOException {
        Map<String, byte[]> result = new LinkedHashMap<>();
        File[] children = root.listFiles(); if (children == null) throw new IOException("unreadable_fixture_directory");
        for (File child : children) {
            if (child.isDirectory()) for (Map.Entry<String, byte[]> nested : encryptedFiles(child).entrySet())
                result.put(child.getName() + "/" + nested.getKey(), nested.getValue());
            else result.put(child.getName(), java.nio.file.Files.readAllBytes(child.toPath()));
        }
        return result;
    }

    private static byte[] durablePcm(NativeDictationStore.Journal journal) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); long durable = journal.load().durableSamples;
        for (long sample = 0; sample < durable;) {
            byte[] part = journal.read(sample, (int) Math.min(48000, (durable - sample) * 2));
            bytes.write(part); sample += part.length / 2;
        }
        return bytes.toByteArray();
    }
    private static NativeDictationStore.Journal onQueue(NativeDictationStore.Journal delegate, Queue queue) {
        return onQueue(delegate, queue, new AtomicBoolean());
    }
    private static NativeDictationStore.Journal onQueue(NativeDictationStore.Journal delegate, Queue queue, AtomicBoolean failFirstLoad) {
        return new NativeDictationStore.Journal() {
            public Executor executor() { return queue; }
            public NativeDictationStore.Recording load() throws Exception {
                if (failFirstLoad.getAndSet(false)) throw new IOException("injected_initial_read_failure");
                return delegate.load();
            }
            public void append(long start, byte[] pcm) throws Exception { delegate.append(start, pcm); }
            public NativeDictationStore.Recording checkpoint() throws Exception { return delegate.checkpoint(); }
            public NativeDictationStore.Recording seal(long ordinal, long start, long end, int padding) throws Exception { return delegate.seal(ordinal, start, end, padding); }
            public NativeDictationStore.Recording adopt(boolean keep) throws Exception { return delegate.adopt(keep); }
            public NativeDictationStore.Recording commitStarted(long ordinal, String attempt) throws Exception { return delegate.commitStarted(ordinal, attempt); }
            public NativeDictationStore.Recording committed(long ordinal, String attempt, String item) throws Exception { return delegate.committed(ordinal, attempt, item); }
            public NativeDictationStore.Recording failed(long ordinal, String attempt, String reason, boolean uncertain) throws Exception { return delegate.failed(ordinal, attempt, reason, uncertain); }
            public NativeDictationStore.Recording complete(long ordinal, String text) throws Exception { return delegate.complete(ordinal, text); }
            public NativeDictationStore.Recording finish(String reason, long end) throws Exception { return delegate.finish(reason, end); }
            public NativeDictationStore.Recording interrupt(String reason) throws Exception { return delegate.interrupt(reason); }
            public void discard() throws Exception { delegate.discard(); }
            public byte[] read(long start, int maximum) throws Exception { return delegate.read(start, maximum); }
        };
    }

    private static byte[] pcm(int samples, int value) {
        byte[] result = new byte[samples * 2];
        for (int index = 0; index < result.length; index += 2) { result[index] = (byte) value; result[index + 1] = (byte) (value >> 8); }
        return result;
    }
    private static final class Queue implements Executor {
        final ArrayDeque<Runnable> queue = new ArrayDeque<>();
        public void execute(Runnable action) { queue.addLast(action); }
        void run() { int count = 0; while (!queue.isEmpty()) { if (++count > 10000) fail("worker did not quiesce"); queue.removeFirst().run(); } }
    }
    private static final class Time implements NativeVoiceRecording.Timing {
        static final class Event { final long at; final Runnable action; boolean cancelled; Event(long at, Runnable action) { this.at = at; this.action = action; } }
        final List<Event> events = new ArrayList<>(); long now; boolean closed;
        public long nowMs() { return now; }
        public NativeVoiceRecording.Timer after(long delay, Runnable action) {
            if (closed) throw new IllegalStateException("timer_closed");
            Event event = new Event(now + delay, action); events.add(event); return () -> event.cancelled = true;
        }
        public void close() { closed = true; for (Event event : events) event.cancelled = true; }
        void advance(long amount) {
            now += amount;
            while (true) {
                Event next = null;
                for (Event event : events) if (!event.cancelled && event.at <= now && (next == null || event.at < next.at)) next = event;
                if (next == null) return;
                next.cancelled = true; next.action.run();
            }
        }
    }
    private static final class Listener implements NativeVoiceRecording.Listener {
        int ready; String text, error; boolean maySubmit, retained, reconnecting;
        Runnable afterFailure;
        public void ready(String id) { ready++; }
        public void changed(String id, boolean value) { reconnecting = value; }
        public void completed(String id, String text, boolean maySubmit) { this.text = text; this.maySubmit = maySubmit; }
        public void failed(String id, String code, boolean retained) {
            this.error = code; this.retained = retained; if (afterFailure != null) afterFailure.run();
        }
        public void journalChanged(String id, NativeDictationStore.Recording value) {}
    }
    private static final class Session implements NativeSpeechTransport.RecognitionSession {
        final String id; final NativeSpeechTransport.RecognitionListener listener; final Journal journal;
        final Map<String, ByteArrayOutputStream> audio = new LinkedHashMap<>(); final List<String> commits = new ArrayList<>();
        boolean backpressure, cancelled, assignable = true;
        NativeSpeechTransport.Kind assignmentFailure;
        Session(String id, NativeSpeechTransport.RecognitionListener listener, Journal journal) { this.id = id; this.listener = listener; this.journal = journal; }
        public NativeSpeechTransport.SendResult append(String attempt, byte[] bytes) {
            if (cancelled) return NativeSpeechTransport.SendResult.ENDED;
            if (backpressure) return NativeSpeechTransport.SendResult.BACKPRESSURE;
            ByteArrayOutputStream value = audio.computeIfAbsent(attempt, ignored -> new ByteArrayOutputStream());
            value.write(bytes, 0, bytes.length); return NativeSpeechTransport.SendResult.ACCEPTED;
        }
        public NativeSpeechTransport.SendResult commit(String attempt) {
            assertEquals(attempt, journal.lastPrepared); commits.add(attempt); return NativeSpeechTransport.SendResult.ACCEPTED;
        }
        public long deadlineMs() { return Long.MAX_VALUE; }
        public boolean canAssign(long duration) {
            if (assignmentFailure != null) {
                NativeSpeechTransport.Kind kind = assignmentFailure; assignmentFailure = null; cancelled = true;
                fail(kind, kind == NativeSpeechTransport.Kind.NETWORK ? "recognition_network" : "recognition_session_timeout"); return false;
            }
            return assignable;
        }
        public boolean ended() { return cancelled; }
        public void cancel() { cancelled = true; }
        void ack(String attempt) { listener.committed(id, attempt, "item-" + attempt); }
        void result(String attempt, String text) { listener.completed(id, attempt, "item-" + attempt, text); }
        void fail(NativeSpeechTransport.Kind kind, String code) { listener.failed(id, commits.isEmpty() ? null : commits.get(commits.size() - 1), new NativeSpeechTransport.Failure(kind, code, 0)); }
    }
    private static final class Harness {
        final Queue worker = new Queue(); final Time time = new Time(); final Journal journal = new Journal(worker);
        final Listener listener = new Listener(); final List<Session> sessions = new ArrayList<>();
        final NativeVoiceRecording recording;
        Harness() { this(5000); }
        Harness(long hardSegmentMs) {
            recording = new NativeVoiceRecording("recording", journal, (id, events) -> {
                Session session = new Session(id, events, journal); sessions.add(session); events.ready(id, Long.MAX_VALUE); return session;
            }, listener, hardSegmentMs, 15000, time);
        }
        void start(boolean adopt) { recording.start(false); flush(); if (adopt) { recording.setKeepListening(true, error -> assertNull(error)); flush(); } }
        void feedFrames(int count) { for (int index = 0; index < count; index++) { assertTrue(recording.accept(pcm(2400, 2100))); flush(); } }
        void flush() { worker.run(); }
        void advance(long amount) { time.advance(amount); flush(); }
        Session latest() { return sessions.get(sessions.size() - 1); }
    }
    private static final class Journal implements NativeDictationStore.Journal {
        final Queue worker; final ByteArrayOutputStream pcm = new ByteArrayOutputStream();
        final List<NativeDictationStore.Segment> segments = new ArrayList<>(); final List<String> events = new ArrayList<>();
        long revision, accepted, durable, completedOrdinal = -1, completedSamples, end = -1;
        int pendingLimit = 128;
        int failAppendAfterSamples = -1;
        String text = "", reason = "", lastPrepared; boolean adopted, keep, interrupted, discarded, truncateReads, failSeal, failCheckpoint;
        Journal(Queue worker) { this.worker = worker; }
        public Executor executor() { return worker; }
        public NativeDictationStore.Recording load() {
            return new NativeDictationStore.Recording("binding", "recording", "thread", "Thread", interrupted ? "interrupted" : "capturing", reason,
                revision, accepted, durable, completedOrdinal, completedSamples, end, adopted, keep, interrupted, text, new JSONObject(),
                segments, null, null, null, false);
        }
        public void append(long start, byte[] value) {
            assertEquals(accepted, start);
            if (failAppendAfterSamples >= 0) {
                int bytes = Math.min(value.length, failAppendAfterSamples * 2); failAppendAfterSamples = -1;
                pcm.write(value, 0, bytes); accepted += bytes / 2;
                throw new IllegalStateException("dictation_storage_unavailable");
            }
            pcm.write(value, 0, value.length); accepted += value.length / 2;
            durable = accepted / 24000 * 24000;
        }
        public NativeDictationStore.Recording checkpoint() {
            if (failCheckpoint) throw new IllegalStateException("dictation_storage_unavailable");
            durable = accepted; revision++; return load();
        }
        public NativeDictationStore.Recording seal(long ordinal, long start, long end, int padding) {
            if (failSeal) throw new IllegalStateException("dictation_storage_unavailable");
            if (segments.size() >= pendingLimit) throw new IllegalStateException("dictation_segment_capacity");
            assertTrue(end <= durable); segments.add(new NativeDictationStore.Segment(ordinal, start, end, padding, "sealed", null, null, "", false));
            revision++; return load();
        }
        public NativeDictationStore.Recording adopt(boolean keep) { adopted = true; this.keep = keep; revision++; return load(); }
        public NativeDictationStore.Recording commitStarted(long ordinal, String attempt) { lastPrepared = attempt; events.add("commit:" + ordinal); revision++; return load(); }
        public NativeDictationStore.Recording committed(long ordinal, String attempt, String item) { revision++; return load(); }
        public NativeDictationStore.Recording failed(long ordinal, String attempt, String reason, boolean uncertain) { revision++; return load(); }
        public NativeDictationStore.Recording complete(long ordinal, String value) {
            NativeDictationStore.Segment first = segments.remove(0); assertEquals(first.ordinal, ordinal);
            assertEquals(completedOrdinal + 1, ordinal); completedOrdinal = ordinal; completedSamples = first.endSample;
            if (!value.isEmpty()) text += (text.isEmpty() ? "" : " ") + value;
            events.add("result:" + ordinal); revision++; return load();
        }
        public NativeDictationStore.Recording finish(String reason, long end) { this.reason = reason; this.end = end; revision++; return load(); }
        public NativeDictationStore.Recording interrupt(String reason) {
            try { checkpoint(); } catch (Exception ignored) {}
            interrupted = true; this.reason = reason; end = durable; revision++; return load();
        }
        public void discard() { discarded = true; }
        public byte[] read(long start, int maximumBytes) {
            assertTrue(start >= completedSamples); assertTrue(start * 2 + maximumBytes <= durable * 2);
            return Arrays.copyOfRange(pcm.toByteArray(), (int) (start * 2), (int) (start * 2) + maximumBytes - (truncateReads ? 2 : 0));
        }
    }
}
