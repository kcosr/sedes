package dev.sedes.local;

import android.os.SystemClock;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** One sample-owned recording. Its serial journal worker owns PCM, recognition and ordered results. */
final class NativeVoiceRecording {
    static final int MAX_QUEUED_PACKETS = 64;
    static final int MAX_QUEUED_BYTES = MAX_QUEUED_PACKETS * NativeSpeechTransport.PCM_PACKET_BYTES;
    static final long FLUSH_TIMEOUT_MS = 5000;
    static final long OUTAGE_TIMEOUT_MS = 60_000;
    private static final long[] RETRY_DELAYS_MS = {1000, 2000, 4000, 8000, 16000};
    enum FinishReason { AUTOMATIC, SEND, TIMEOUT }
    interface Completion { void done(String error); }
    interface TransportFactory {
        NativeSpeechTransport.RecognitionSession open(String connectionId, NativeSpeechTransport.RecognitionListener listener);
    }
    interface Listener {
        void ready(String recordingId);
        void changed(String recordingId, boolean reconnecting);
        void completed(String recordingId, String text, boolean maySubmit);
        void failed(String recordingId, String code, boolean retained);
        void journalChanged(String recordingId, NativeDictationStore.Recording recording);
    }
    interface Timer { void cancel(); }
    interface Timing {
        long nowMs();
        Timer after(long delayMs, Runnable action);
        void close();
    }
    private static final class RealTiming implements Timing {
        private final ScheduledThreadPoolExecutor deadlines = new ScheduledThreadPoolExecutor(1, action -> {
            Thread thread = new Thread(action, "sedes-dictation-deadlines"); thread.setDaemon(true); return thread;
        });
        RealTiming() { deadlines.setRemoveOnCancelPolicy(true); }
        public long nowMs() { return SystemClock.elapsedRealtime(); }
        public Timer after(long delayMs, Runnable action) {
            java.util.concurrent.ScheduledFuture<?> future = deadlines.schedule(action, delayMs, TimeUnit.MILLISECONDS);
            return () -> future.cancel(false);
        }
        public void close() { deadlines.shutdownNow(); }
    }
    private static final class Pending {
        final long ordinal, start;
        long end, uploaded;
        int padding, paddingSent;
        boolean sealed, prepared, acknowledged;
        String attempt, item;
        Pending(long ordinal, long start) { this.ordinal = ordinal; this.start = this.end = this.uploaded = start; }
        void reset() { uploaded = start; paddingSent = 0; prepared = acknowledged = false; attempt = item = null; }
    }
    private static final class JournalError extends RuntimeException {
        JournalError(Exception cause) { super(cause); }
    }

    private final String id;
    private final String runId = java.util.UUID.randomUUID().toString();
    private final NativeDictationStore.Journal journal;
    private final Executor worker;
    private final TransportFactory factory;
    private final Listener listener;
    private final int hardSegmentMs;
    private final Timing timing;
    private final Object inputLock = new Object();
    private final ArrayDeque<byte[]> input = new ArrayDeque<>();
    private final List<Pending> pending = new ArrayList<>();
    private final AtomicBoolean terminal = new AtomicBoolean();
    private final AtomicBoolean discarded = new AtomicBoolean();
    private volatile NativeDictationStore.Recording recording;
    private volatile boolean adoptionIntent, sendRevoked;
    private volatile FinishReason finishRequested;
    private volatile long outageGeneration;
    private int queuedBytes;
    private boolean accepting, drainScheduled, finishBarrierDone;
    // The fields below are owned exclusively by journal.executor().
    private NativeVoiceSegmenter segmenter;
    private byte[] unfinishedPacket;
    private long unfinishedPacketStart;
    private Pending open, uploading, inFlight;
    private NativeSpeechTransport.RecognitionSession connection;
    private String connectionId;
    private long connectionSerial, attemptSerial, retryEnd;
    private boolean initialized, retryOnly, retryTailFinished, captureFinished, initialReady, connectionReady, connectionUsed;
    private boolean reconnecting, pumpScheduled, outageNeedsResult;
    private int retries;
    private long outageStarted = -1;
    private Timer pumpTimer, retryTimer, outageTimer;
    private volatile Timer flushTimer;

    NativeVoiceRecording(String id, NativeDictationStore.Journal journal, TransportFactory factory,
            Listener listener, long hardSegmentMs, long resultTimeoutMs) {
        this(id, journal, factory, listener, hardSegmentMs, resultTimeoutMs, new RealTiming());
    }
    NativeVoiceRecording(String id, NativeDictationStore.Journal journal, TransportFactory factory,
            Listener listener, long hardSegmentMs, long resultTimeoutMs, Timing timing) {
        if (id == null || id.isEmpty() || journal == null || factory == null || listener == null || timing == null ||
            hardSegmentMs < 5000 || hardSegmentMs > 60000 || hardSegmentMs % 100 != 0 || resultTimeoutMs <= 0)
            throw new IllegalArgumentException("dictation_configuration_invalid");
        this.id = id; this.journal = journal; this.worker = journal.executor(); this.factory = factory;
        this.listener = listener; this.hardSegmentMs = (int) hardSegmentMs; this.timing = timing;
    }

    void start() {
        execute(() -> {
            if (initialized || terminal.get()) return;
            initialized = true; update(journal.load());
            if (recording.acceptedSamples != 0 || recording.completedSamples != 0 || !recording.segments.isEmpty() || recording.endSample >= 0)
                throw new IllegalStateException("dictation_invalid_state");
            segmenter = new NativeVoiceSegmenter(hardSegmentMs, this::seal);
            open = new Pending(0, 0);
            synchronized (inputLock) { accepting = !terminal.get(); }
            openConnection();
        });
    }

    /** Recognizes retained durable audio only. This path never asks its listener to start a microphone. */
    void retry() {
        execute(() -> {
            if (initialized || terminal.get()) return;
            initialized = retryOnly = true; adoptionIntent = true; update(journal.load());
            if (!recording.adopted || recording.handedOff || recording.overflow()) throw new IllegalStateException("dictation_invalid_state");
            long end = recording.completedSamples, ordinal = recording.completedOrdinal + 1;
            for (NativeDictationStore.Segment saved : recording.segments) {
                if (saved.ordinal != ordinal || saved.startSample != end || saved.endSample <= end || saved.endSample > recording.durableSamples)
                    throw new NativeDictationStore.Failure("dictation_storage_corrupt", true);
                long realSamples = saved.endSample - saved.startSample;
                int expectedPadding = realSamples < NativeVoiceSegmenter.FRAME_SAMPLES ? (int) (NativeVoiceSegmenter.FRAME_SAMPLES - realSamples) : 0;
                if (saved.paddingSamples != expectedPadding || realSamples + saved.paddingSamples > (long) hardSegmentMs * NativeVoiceSegmenter.SAMPLE_RATE / 1000)
                    throw new NativeDictationStore.Failure("dictation_segment_incompatible", false);
                Pending item = new Pending(ordinal++, end); item.end = saved.endSample;
                item.padding = saved.paddingSamples; item.sealed = true; pending.add(item); end = item.end;
            }
            if (end < recording.durableSamples) {
                if (end % NativeVoiceSegmenter.FRAME_SAMPLES != 0)
                    throw new NativeDictationStore.Failure("dictation_storage_corrupt", true);
                open = new Pending(ordinal, end);
                segmenter = new NativeVoiceSegmenter(hardSegmentMs, end, ordinal, this::seal);
                retryEnd = recording.durableSamples;
                fillRetryTail();
            }
            captureFinished = true;
            update(journal.finish("retry", recording.durableSamples));
            if (!completeIfReady()) openConnection();
        });
    }

    /** Copies into a bounded queue only; the audio callback never waits for disk or a socket. */
    boolean accept(byte[] pcm) {
        if (pcm == null || pcm.length == 0 || (pcm.length & 1) != 0) {
            requestFailure("dictation_capture_invalid"); return false;
        }
        boolean schedule = false, overflow = false;
        synchronized (inputLock) {
            if (!accepting || terminal.get()) return false;
            int packets = (pcm.length + NativeSpeechTransport.PCM_PACKET_BYTES - 1) / NativeSpeechTransport.PCM_PACKET_BYTES;
            if (packets > MAX_QUEUED_PACKETS - input.size() || pcm.length > MAX_QUEUED_BYTES - queuedBytes) overflow = true;
            else {
                for (int offset = 0; offset < pcm.length; offset += NativeSpeechTransport.PCM_PACKET_BYTES)
                    input.addLast(Arrays.copyOfRange(pcm, offset, Math.min(pcm.length, offset + NativeSpeechTransport.PCM_PACKET_BYTES)));
                queuedBytes += pcm.length;
                if (!drainScheduled) { drainScheduled = true; schedule = true; }
            }
        }
        if (overflow) { requestFailure("dictation_capture_backpressure"); return false; }
        if (schedule) execute(this::drain);
        return true;
    }

    void setKeepListening(boolean keepListening, Completion completion) {
        if (keepListening) adoptionIntent = true;
        execute(() -> {
            if (terminal.get() || captureFinished || !initialized || retryOnly) { completion.done("dictation_invalid_state"); return; }
            try {
                update(journal.adopt(keepListening));
                completion.done(null);
            } catch (Exception error) {
                completion.done(code(error)); throw error;
            }
        });
    }

    /** Called at the accepted finish action, before the physical AudioRecord drain begins. */
    void beginFinish(FinishReason reason) {
        if (terminal.get() || reason == null) return;
        synchronized (inputLock) {
            if (terminal.get() || finishBarrierDone) return;
            if (finishRequested == null) finishRequested = reason;
            if (flushTimer == null) flushTimer = timing.after(FLUSH_TIMEOUT_MS, () -> {
                synchronized (inputLock) {
                    if (flushTimer != null) requestFailure("dictation_flush_timeout");
                }
            });
        }
    }

    /** Called after all previously captured PCM callbacks have returned. */
    void finish(FinishReason reason) {
        beginFinish(reason);
        synchronized (inputLock) { accepting = false; }
        execute(() -> {
            if (terminal.get() || captureFinished) return;
            drainInput(Integer.MAX_VALUE);
            segmenter.finish();
            update(journal.checkpoint());
            update(journal.finish(finishCode(), segmenter.samples()));
            captureFinished = true;
            synchronized (inputLock) { finishBarrierDone = true; }
            cancelFlush();
            if (!completeIfReady()) pump();
        });
    }

    void interrupt(String reason) { requestFailure(reason == null ? "dictation_interrupted" : reason); }

    /** Runtime-owned Discard durably tombstones both stores before removing their files. */
    void cancelForDiscard() { cancelForDiscard(false); }
    void discard() { cancelForDiscard(true); }
    private void cancelForDiscard(boolean removeJournal) {
        if (!discarded.compareAndSet(false, true)) return;
        terminal.set(true);
        synchronized (inputLock) { accepting = false; input.clear(); queuedBytes = 0; }
        cancelFlush(); timing.close();
        worker.execute(() -> {
            closeConnection();
            if (!removeJournal) return;
            try { journal.discard(); }
            catch (Exception error) { listener.failed(id, code(error), true); }
        });
    }

    private interface Work { void run() throws Exception; }
    private void execute(Work work) {
        worker.execute(() -> {
            try { work.run(); }
            catch (JournalError error) { requestFailure(code(error.getCause())); }
            catch (Exception error) { requestFailure(code(error)); }
        });
    }
    private void drain() throws Exception {
        if (terminal.get()) return;
        drainInput(16);
        synchronized (inputLock) {
            drainScheduled = !input.isEmpty();
            if (drainScheduled) execute(this::drain);
        }
        pump();
    }
    private void drainInput(int maximum) throws Exception {
        int count = 0;
        while (count++ < maximum) {
            byte[] bytes;
            synchronized (inputLock) {
                bytes = input.pollFirst();
                if (bytes != null) queuedBytes -= bytes.length;
            }
            if (bytes == null) break;
            unfinishedPacket = bytes; unfinishedPacketStart = segmenter.samples();
            journal.append(unfinishedPacketStart, bytes);
            segmenter.accept(bytes);
            open.end = segmenter.samples();
            unfinishedPacket = null;
        }
        update(journal.load());
    }
    private void seal(NativeVoiceSegmenter.Segment segment) {
        try {
            if (open == null || segment.ordinal != open.ordinal || segment.startSample != open.start || open.uploaded > segment.endSample)
                throw new IllegalStateException("dictation_segment_order");
            open.end = segment.endSample; open.padding = segment.paddingSamples; open.sealed = true;
            update(journal.checkpoint());
            update(journal.seal(open.ordinal, open.start, open.end, open.padding));
            pending.add(open);
            open = new Pending(segment.ordinal + 1, segment.endSample);
        } catch (Exception error) { throw new JournalError(error); }
    }
    private void fillRetryTail() throws Exception {
        if (!retryOnly || segmenter == null || retryTailFinished || !pending.isEmpty()) return;
        // Drain immutable saved ranges first. Otherwise a full 128-segment backlog could never free a slot
        // for the unsealed tail retained at the very capacity failure that led to this Retry.
        while (pending.isEmpty() && segmenter.samples() < retryEnd) {
            int bytes = (int) Math.min(NativeSpeechTransport.PCM_PACKET_BYTES, (retryEnd - segmenter.samples()) * 2);
            segmenter.accept(readExact(segmenter.samples(), bytes));
            open.end = segmenter.samples();
        }
        if (segmenter.samples() == retryEnd) { segmenter.finish(); retryTailFinished = true; }
    }
    private void update(NativeDictationStore.Recording value) {
        NativeDictationStore.Recording before = recording;
        recording = value;
        if (value.adopted) adoptionIntent = true;
        if (before == null || before.revision != value.revision || before.durableSamples != value.durableSamples)
            listener.journalChanged(id, value);
    }
    private String finishCode() {
        if (finishRequested == FinishReason.SEND && sendRevoked) return "send_interrupted";
        if (finishRequested == FinishReason.TIMEOUT) return "timeout";
        return finishRequested == FinishReason.SEND ? "send" : "automatic";
    }

    private void openConnection() {
        if (terminal.get()) return;
        connectionId = runId + "-connection-" + (++connectionSerial);
        connectionReady = connectionUsed = false;
        String opening = connectionId;
        connection = factory.open(opening, new NativeSpeechTransport.RecognitionListener() {
            public void ready(String connectionId, long deadlineMs) { execute(() -> onReady(connectionId)); }
            public void committed(String connectionId, String attemptId, String itemId) {
                execute(() -> onCommitted(connectionId, attemptId, itemId));
            }
            public void completed(String connectionId, String attemptId, String itemId, String text) {
                execute(() -> onCompleted(connectionId, attemptId, itemId, text));
            }
            public void failed(String connectionId, String attemptId, NativeSpeechTransport.Failure failure) {
                execute(() -> onRecognitionFailure(connectionId, failure));
            }
        });
    }
    private boolean current(String candidate) { return !terminal.get() && candidate != null && candidate.equals(connectionId); }
    private void onReady(String candidate) throws Exception {
        if (!current(candidate) || connectionReady) return;
        connectionReady = true; setReconnecting(false);
        if (!initialReady && !retryOnly) { initialReady = true; listener.ready(id); }
        pump();
    }
    private void onCommitted(String candidate, String attempt, String item) throws Exception {
        if (!current(candidate) || inFlight == null || !inFlight.attempt.equals(attempt) || inFlight.acknowledged) return;
        inFlight.acknowledged = true; inFlight.item = item;
        update(journal.committed(inFlight.ordinal, attempt, item));
        pump();
    }
    private void onCompleted(String candidate, String attempt, String item, String text) throws Exception {
        if (!current(candidate) || inFlight == null || !inFlight.attempt.equals(attempt) || !inFlight.acknowledged ||
            !inFlight.item.equals(item)) return;
        Pending done = inFlight;
        NativeDictationStore.Recording saved = journal.complete(done.ordinal, text);
        clearOutage();
        update(saved);
        pending.remove(done); inFlight = null;
        if (recording.overflow()) { requestFailure("dictation_text_overflow"); return; }
        fillRetryTail();
        if (!completeIfReady()) pump();
    }
    private void onRecognitionFailure(String candidate, NativeSpeechTransport.Failure failure) throws Exception {
        if (!current(candidate)) return;
        if (finishRequested == FinishReason.SEND) {
            sendRevoked = true;
            if (recording.endSample >= 0) update(journal.finish("send_interrupted", recording.endSample));
        }
        for (Pending item : pending) if (item.prepared) {
            outageNeedsResult = true;
            update(journal.failed(item.ordinal, item.attempt, failure.code, true));
        }
        closeConnection();
        for (Pending item : pending) item.reset();
        if (open != null) open.reset();
        uploading = inFlight = null;
        if (!adoptionIntent || !failure.retryable()) { requestFailure(failure.code); return; }
        long now = timing.nowMs();
        if (outageStarted < 0) {
            outageStarted = now;
            long generation = ++outageGeneration;
            outageTimer = timing.after(OUTAGE_TIMEOUT_MS, () -> {
                synchronized (inputLock) {
                    if (!terminal.get() && outageGeneration == generation)
                        requestFailure("dictation_reconnect_timeout");
                }
            });
        }
        if (retries >= RETRY_DELAYS_MS.length || now - outageStarted >= OUTAGE_TIMEOUT_MS) {
            requestFailure("dictation_reconnect_exhausted"); return;
        }
        setReconnecting(true);
        long delay = RETRY_DELAYS_MS[retries++];
        retryTimer = timing.after(delay, () -> execute(() -> {
            if (terminal.get()) return;
            if (timing.nowMs() - outageStarted >= OUTAGE_TIMEOUT_MS) requestFailure("dictation_reconnect_timeout");
            else openConnection();
        }));
    }

    private void pump() throws Exception {
        if (terminal.get() || !connectionReady || connection == null) return;
        if (outageStarted >= 0 && timing.nowMs() - outageStarted >= OUTAGE_TIMEOUT_MS) {
            requestFailure("dictation_reconnect_timeout"); return;
        }
        for (int count = 0; count < 16; count++) {
            if (uploading == null) {
                if (inFlight != null && !inFlight.acknowledged) return;
                Pending next = null;
                for (Pending item : pending) if (item != inFlight) { next = item; break; }
                if (next == null && open != null && Math.min(recording.durableSamples, segmenter.uploadableEnd()) > open.start) next = open;
                if (next == null) { completeIfReady(); return; }
                if (!connection.canAssign(hardSegmentMs)) {
                    if (connection.ended()) { schedulePump(); return; }
                    if (inFlight != null) return;
                    if (!connectionUsed) { requestFailure("recognition_session_budget"); return; }
                    closeConnection(); openConnection(); return;
                }
                uploading = next;
                uploading.attempt = runId + "-segment-" + next.ordinal + "-attempt-" + (++attemptSerial);
            }
            Pending item = uploading;
            long available = item.sealed ? item.end : Math.min(item.end, segmenter.uploadableEnd());
            available = Math.min(available, recording.durableSamples);
            if (item.uploaded < available) {
                int bytes = (int) Math.min(NativeSpeechTransport.PCM_PACKET_BYTES, (available - item.uploaded) * 2);
                NativeSpeechTransport.SendResult sent = connection.append(item.attempt, readExact(item.uploaded, bytes));
                if (sent != NativeSpeechTransport.SendResult.ACCEPTED) { waitForTransport(sent); return; }
                item.uploaded += bytes / 2; connectionUsed = true;
                // An open buffer has no outstanding recognition result. A ready replacement accepting
                // its audio ends recovery without waiting for quiet audio to reach the hard cut.
                if (outageStarted >= 0 && !outageNeedsResult && !item.sealed) clearOutage();
                continue;
            }
            if (!item.sealed) return;
            if (item.uploaded != item.end) throw new NativeDictationStore.Failure("dictation_storage_corrupt", true);
            if (item.paddingSent < item.padding) {
                int samples = Math.min(NativeSpeechTransport.PCM_PACKET_BYTES / 2, item.padding - item.paddingSent);
                NativeSpeechTransport.SendResult sent = connection.append(item.attempt, new byte[samples * 2]);
                if (sent != NativeSpeechTransport.SendResult.ACCEPTED) { waitForTransport(sent); return; }
                item.paddingSent += samples; continue;
            }
            if (inFlight != null) return;
            if (!item.prepared) {
                if (outageStarted >= 0) outageNeedsResult = true;
                update(journal.commitStarted(item.ordinal, item.attempt)); item.prepared = true;
            }
            NativeSpeechTransport.SendResult sent = connection.commit(item.attempt);
            if (sent != NativeSpeechTransport.SendResult.ACCEPTED) { waitForTransport(sent); return; }
            inFlight = item; uploading = null;
        }
        schedulePump();
    }
    private byte[] readExact(long start, int bytes) throws Exception {
        byte[] value = journal.read(start, bytes);
        if (value == null || value.length != bytes) throw new NativeDictationStore.Failure("dictation_storage_corrupt", true);
        return value;
    }
    private void waitForTransport(NativeSpeechTransport.SendResult result) throws Exception {
        if (result == NativeSpeechTransport.SendResult.WAITING && uploading != null && uploading.uploaded == uploading.start && uploading.paddingSent == 0) {
            // No packet belongs to this attempt yet. Reassess session lifetime after a prior result arrives.
            uploading.attempt = null; uploading = null;
        }
        // ENDED's precise failure callback is queued on the same worker; do not replace its classification.
        schedulePump();
    }
    private void schedulePump() {
        if (pumpScheduled || terminal.get()) return;
        pumpScheduled = true;
        pumpTimer = timing.after(20, () -> execute(() -> { pumpScheduled = false; pump(); }));
    }
    private boolean completeIfReady() {
        if (terminal.get() || !captureFinished || !pending.isEmpty() || !recording.complete()) return false;
        if (!terminal.compareAndSet(false, true)) return true;
        synchronized (inputLock) { accepting = false; }
        closeConnection(); cancelFlush(); timing.close();
        boolean maySubmit = !retryOnly && !sendRevoked && finishRequested != FinishReason.TIMEOUT;
        listener.completed(id, recording.text, maySubmit); return true;
    }
    private void closeConnection() {
        NativeSpeechTransport.RecognitionSession old = connection;
        connection = null; connectionId = null; connectionReady = false;
        if (old != null) old.cancel();
    }
    private void clearOutage() {
        outageStarted = -1; retries = 0; outageNeedsResult = false;
        synchronized (inputLock) { outageGeneration++; }
        if (outageTimer != null) { outageTimer.cancel(); outageTimer = null; }
        if (retryTimer != null) { retryTimer.cancel(); retryTimer = null; }
        setReconnecting(false);
    }
    private void setReconnecting(boolean value) {
        if (reconnecting == value) return;
        reconnecting = value; listener.changed(id, value);
    }
    private void cancelFlush() {
        Timer timer;
        synchronized (inputLock) { timer = flushTimer; flushTimer = null; }
        if (timer != null) timer.cancel();
    }
    private void drainRetainedInput() throws Exception {
        long accepted = journal.load().acceptedSamples;
        if (unfinishedPacket != null) {
            long end = unfinishedPacketStart + unfinishedPacket.length / 2;
            if (accepted < unfinishedPacketStart || accepted > end)
                throw new NativeDictationStore.Failure("dictation_storage_corrupt", true);
            if (accepted < end)
                journal.append(accepted, Arrays.copyOfRange(unfinishedPacket, (int) ((accepted - unfinishedPacketStart) * 2), unfinishedPacket.length));
            accepted = end; unfinishedPacket = null;
        }
        // Failed control writes must not prevent healthy PCM writes. Leave this tail unsealed for Retry.
        while (true) {
            byte[] bytes;
            synchronized (inputLock) {
                bytes = input.pollFirst();
                if (bytes != null) queuedBytes -= bytes.length;
            }
            if (bytes == null) return;
            journal.append(accepted, bytes); accepted += bytes.length / 2;
        }
    }
    private void requestFailure(String code) {
        if (!terminal.compareAndSet(false, true)) return;
        synchronized (inputLock) { accepting = false; }
        cancelFlush(); timing.close();
        NativeDictationStore.Recording current = recording;
        boolean retained = adoptionIntent || current != null && current.adopted;
        // Queue cleanup before notifying the actor, so its subsequent recovery read cannot overtake this write.
        worker.execute(() -> {
            closeConnection();
            if (discarded.get()) return;
            try {
                if (retained) {
                    try {
                        if (adoptionIntent && !journal.load().adopted) update(journal.adopt(false));
                    } catch (Exception ignored) { /* Still try PCM and the durable interruption boundary. */ }
                    try {
                        if (segmenter != null && !captureFinished && !retryOnly) drainRetainedInput();
                    } catch (Exception ignored) { /* Interrupt persists the last durable watermark even if PCM cannot flush. */ }
                    update(journal.interrupt(code));
                } else journal.discard();
            } catch (Exception ignored) {
                // Durable blocks and their last authenticated watermark remain available for recovery.
            } finally {
                unfinishedPacket = null;
                synchronized (inputLock) { input.clear(); queuedBytes = 0; }
            }
        });
        // Notification itself does not wait for cleanup: hardware release must not wait for a stalled filesystem.
        listener.failed(id, code, retained);
    }
    private static String code(Throwable error) {
        if (error instanceof NativeDictationStore.Failure) return ((NativeDictationStore.Failure) error).code;
        if (error instanceof IllegalStateException && error.getMessage() != null && error.getMessage().startsWith("dictation_"))
            return error.getMessage();
        return "dictation_storage_unavailable";
    }
}
