package dev.sedes.local;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.system.Os;
import android.system.OsConstants;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Encrypted recording ownership; invoke all I/O on {@link #executor()}. */
final class NativeDictationStore implements AutoCloseable {
    static final int SAMPLE_RATE = 24_000;
    static final long MAX_PENDING_PCM_BYTES = 32L * 1024 * 1024;
    static final int MAX_SEGMENTS = 128;
    static final long MAX_DEVICE_BYTES = 64L * 1024 * 1024;
    static final int MAX_TEXT_BYTES = 262_144;
    static final int MAX_SEGMENT_TEXT_BYTES = 65_536;
    static final int MAX_RETAINED_TEXT_BYTES = 327_681;
    private static final int VERSION = 1;
    private static final int BLOCK_PCM_BYTES = SAMPLE_RATE * 2;
    private static final int BLOCK_HEADER_BYTES = 20;
    private static final int ENCRYPTION_BYTES = 29;
    private static final int MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
    private static final int MAX_CHECKPOINT_BYTES = 4096;
    private static final int MAX_REQUEST_BYTES = 2 * 1024 * 1024;
    private static final long MAX_SAMPLE = 9_007_199_254_740_991L;
    private static final String KEY_ALIAS = "sedes.native-dictation.v1";
    private static final Object LOCK = new Object();
    private static final Map<String, Ledger> LEDGERS = new HashMap<>();
    private static final Set<String> STAGES = new HashSet<>(Arrays.asList("capturing", "finishing", "interrupted",
        "recognizing", "ready", "admitting", "rejected", "overflow", "unavailable"));
    private static final String[] CONFIG_FIELDS = { "speechProvider", "speechEndpoint", "sttModel", "inputDeviceId",
        "recognitionStartTimeoutMs", "recognitionCompletionTimeoutMs", "recognitionEndSilenceMs", "recognitionResultTimeoutMs",
        "longDictationTimeoutMs", "recognizeStopCommand", "recognitionCues", "cueGain", "followComposerMode" };

    /** Recoverable I/O failure and authenticated-content failure are both non-destructive. */
    static final class Failure extends Exception {
        final String code;
        final boolean corrupt;
        Failure(String code, boolean corrupt) { super(code); this.code = code; this.corrupt = corrupt; }
        Failure(String code, boolean corrupt, Throwable cause) { super(code, cause); this.code = code; this.corrupt = corrupt; }
    }

    interface Keys { SecretKey get() throws Exception; }

    /** Injectable disk boundaries let tests interrupt real encryption and atomic files, rather than mock the state machine. */
    static class Disk {
        void fault(String point, File file) throws IOException {}
        byte[] read(File file, int maximumBytes) throws IOException {
            fault("before_read", file);
            try (FileInputStream input = new FileInputStream(file)) {
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                byte[] buffer = new byte[Math.min(8192, maximumBytes + 1)]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (bytes.size() + count > maximumBytes) throw new IOException("dictation_record_limit");
                    bytes.write(buffer, 0, count);
                }
                return bytes.toByteArray();
            }
        }
        void atomicWrite(File file, byte[] bytes) throws Exception {
            File directory = file.getParentFile();
            ensureDirectory(directory);
            File temporary = new File(file.getPath() + ".new");
            try {
                fault("before_write", file);
                try (FileOutputStream output = new FileOutputStream(temporary)) {
                    output.write(bytes); output.flush(); output.getFD().sync();
                }
                fault("after_write", file);
                if (!temporary.renameTo(file)) throw new IOException("dictation_replace_failed");
                syncDirectory(directory);
                fault("after_replace", file);
            } catch (Exception error) {
                // A committed replacement is retained; only an unreferenced incomplete temporary may be removed.
                if (temporary.exists() && !temporary.delete()) error.addSuppressed(new IOException("dictation_temporary_cleanup_failed"));
                throw error;
            }
        }
        private void ensureDirectory(File directory) throws Exception {
            if (directory.isDirectory()) return;
            File parent = directory.getParentFile();
            if (parent == null || directory.exists()) throw new IOException("dictation_directory_unavailable");
            ensureDirectory(parent);
            if (!directory.mkdir() && !directory.isDirectory()) throw new IOException("dictation_directory_unavailable");
            syncDirectory(parent);
        }
        void syncDirectory(File directory) throws Exception {}
        void delete(File file) throws Exception {
            fault("before_delete", file);
            if (file.exists() && !file.delete()) throw new IOException("dictation_delete_failed");
            if (file.getParentFile().isDirectory()) syncDirectory(file.getParentFile());
        }
        File[] list(File directory) throws IOException {
            if (!directory.exists()) return new File[0];
            File[] children = directory.listFiles();
            if (children == null) throw new IOException("dictation_directory_unavailable");
            return children;
        }
        long size(File file) throws IOException {
            if (!file.exists()) return 0;
            if (!file.isDirectory()) return file.length();
            long result = 0;
            for (File child : list(file)) result = Math.addExact(result, size(child));
            return result;
        }
    }

    static final class Limits {
        final long pendingPcmBytes, deviceBytes, controlReserveBytes, captureReserveBytes;
        final int pendingSegments, blockPcmBytes;
        Limits(long pendingPcmBytes, int pendingSegments, long deviceBytes, int blockPcmBytes,
                long controlReserveBytes, long captureReserveBytes) {
            if (pendingPcmBytes < 2 || pendingSegments < 1 || deviceBytes < 1 || blockPcmBytes < 2 ||
                blockPcmBytes > BLOCK_PCM_BYTES || (blockPcmBytes & 1) != 0 || controlReserveBytes < 0 ||
                captureReserveBytes < blockPcmBytes || controlReserveBytes + captureReserveBytes >= deviceBytes)
                throw new IllegalArgumentException("dictation_limits_invalid");
            this.pendingPcmBytes = pendingPcmBytes; this.pendingSegments = pendingSegments; this.deviceBytes = deviceBytes;
            this.blockPcmBytes = blockPcmBytes; this.controlReserveBytes = controlReserveBytes;
            this.captureReserveBytes = captureReserveBytes;
        }
        static Limits defaults() {
            // Queue plus one accumulating block are accounted before capture can accept PCM. Control headroom is
            // inside the 64 MiB budget: two maximum manifests can coexist during an atomic request replacement.
            return new Limits(MAX_PENDING_PCM_BYTES, MAX_SEGMENTS, MAX_DEVICE_BYTES, BLOCK_PCM_BYTES,
                4L * 1024 * 1024, 307_200L + 4_800 + BLOCK_PCM_BYTES + 8L * (BLOCK_HEADER_BYTES + ENCRYPTION_BYTES));
        }
    }

    private static final class Ledger {
        long bytes = -1, reservations;
        int owners;
    }
    private static final class Block {
        final long ordinal, start, end;
        final File file;
        Block(long ordinal, long start, long end, File file) { this.ordinal = ordinal; this.start = start; this.end = end; this.file = file; }
    }
    private static final class Live {
        final String binding, id;
        final long profileGeneration;
        JSONObject manifest;
        final List<Block> blocks = new ArrayList<>();
        final ByteArrayOutputStream tail = new ByteArrayOutputStream();
        long durableSamples, acceptedSamples, nextBlock, captureReservedBytes;
        String text, pendingInterruption;
        boolean captureReserved, drainOnly, reloadNeeded, adoptionRequested;
        Live(String binding, String id, long profileGeneration, JSONObject manifest, String text) {
            this.binding = binding; this.id = id; this.profileGeneration = profileGeneration;
            this.manifest = manifest; this.text = text;
        }
    }

    private final File root;
    private final Keys keys;
    private final Disk disk;
    private final Limits limits;
    private final ExecutorService worker;
    private final Ledger ledger;
    private final String ledgerKey;
    private final Map<String, Live> live = new HashMap<>();
    private final Map<String, Long> profileGenerations = new HashMap<>();
    private final Set<String> removedProfiles = new HashSet<>();
    private boolean closed;

    interface Journal {
        Executor executor();
        Recording load() throws Exception;
        void append(long startSample, byte[] pcm) throws Exception;
        Recording checkpoint() throws Exception;
        Recording seal(long ordinal, long startSample, long endSample, int paddingSamples) throws Exception;
        Recording adopt(boolean keepListening) throws Exception;
        Recording commitStarted(long ordinal, String attemptId) throws Exception;
        Recording committed(long ordinal, String attemptId, String itemId) throws Exception;
        Recording failed(long ordinal, String attemptId, String reason, boolean uncertain) throws Exception;
        Recording complete(long ordinal, String text) throws Exception;
        Recording finish(String reason, long endSample) throws Exception;
        Recording interrupt(String reason) throws Exception;
        void discard() throws Exception;
        /** Contiguous durable PCM only; a missing block is an error, never inserted silence. */
        byte[] read(long startSample, int maximumBytes) throws Exception;
    }

    static final class Segment {
        final long ordinal, startSample, endSample;
        final int paddingSamples;
        final String state, attemptId, itemId, reason;
        final boolean uncertain;
        Segment(long ordinal, long startSample, long endSample, int paddingSamples,
                String state, String attemptId, String itemId, String reason, boolean uncertain) {
            this.ordinal = ordinal; this.startSample = startSample; this.endSample = endSample;
            this.paddingSamples = paddingSamples; this.state = state; this.attemptId = attemptId;
            this.itemId = itemId; this.reason = reason; this.uncertain = uncertain;
        }
    }

    /** Detached values. JSON objects are copies and never provide write access to the store. */
    static final class Recording {
        final String binding, id, threadId, threadTitle, stage, reason, text, mutationId;
        final long revision, acceptedSamples, durableSamples, completedOrdinal, completedSamples, endSample;
        final int textBytes;
        final boolean adopted, keepListening, captureIncomplete, handedOff;
        final JSONObject config, preference, request;
        final List<Segment> segments;
        Recording(String binding, String id, String threadId, String threadTitle, String stage, String reason,
                long revision, long acceptedSamples, long durableSamples, long completedOrdinal, long completedSamples,
                long endSample, boolean adopted, boolean keepListening, boolean captureIncomplete,
                String text, JSONObject config, List<Segment> segments, String mutationId,
                JSONObject preference, JSONObject request, boolean handedOff) {
            this.binding = binding; this.id = id; this.threadId = threadId; this.threadTitle = threadTitle;
            this.stage = stage; this.reason = reason; this.revision = revision; this.acceptedSamples = acceptedSamples;
            this.durableSamples = durableSamples; this.completedOrdinal = completedOrdinal;
            this.completedSamples = completedSamples; this.endSample = endSample; this.adopted = adopted;
            this.keepListening = keepListening; this.captureIncomplete = captureIncomplete; this.text = text;
            this.textBytes = NativeVoiceJson.bytes(text); this.config = NativeVoiceJson.copy(config);
            this.segments = java.util.Collections.unmodifiableList(new java.util.ArrayList<>(segments));
            this.mutationId = mutationId; this.preference = preference == null ? null : NativeVoiceJson.copy(preference);
            this.request = request == null ? null : NativeVoiceJson.copy(request); this.handedOff = handedOff;
        }
        boolean complete() { return endSample >= 0 && completedSamples == endSample && segments.isEmpty(); }
        boolean overflow() { return textBytes > MAX_TEXT_BYTES; }
        boolean empty() { return acceptedSamples == 0 && durableSamples == 0 && text.isEmpty() && request == null && !handedOff; }
    }

    NativeDictationStore(Context context) {
        this(new File(context.getApplicationContext().getNoBackupFilesDir(), "native-dictation"), NativeDictationStore::key,
            new Disk() {
                @Override void syncDirectory(File directory) throws Exception {
                    FileDescriptor descriptor = Os.open(directory.getPath(), OsConstants.O_RDONLY, 0);
                    try { Os.fsync(descriptor); } finally { Os.close(descriptor); }
                }
            }, Limits.defaults());
    }

    /** Real encrypted-file tests provide a temporary root, an ephemeral key and fault-injecting disk. */
    NativeDictationStore(File root, Keys keys, Disk disk, Limits limits) {
        this.root = root.getAbsoluteFile(); this.keys = keys; this.disk = disk; this.limits = limits;
        this.ledgerKey = this.root.getAbsolutePath();
        synchronized (LOCK) {
            ledger = LEDGERS.computeIfAbsent(ledgerKey, unused -> new Ledger()); ledger.owners++;
        }
        worker = Executors.newSingleThreadExecutor(task -> {
            Thread thread = new Thread(task, "sedes-dictation-storage"); thread.setDaemon(true); return thread;
        });
    }

    Executor executor() { return worker; }

    Journal create(String binding, String id, String threadId, String threadTitle, JSONObject config) throws Exception {
        synchronized (LOCK) {
            checkOwner(binding); validId(id); validTarget(threadId, threadTitle); validateConfig(config);
            File directory = directory(binding, id);
            if (directory.exists() || live.containsKey(cacheKey(binding, id))) throw new IllegalStateException("dictation_identity_conflict");
            JSONObject manifest = NativeVoiceJson.object("version", VERSION, "id", id, "binding", binding, "revision", 0,
                "threadId", threadId, "threadTitle", threadTitle, "config", NativeVoiceJson.copy(config), "stage", "capturing", "reason", null,
                "adopted", false, "keepListening", false, "captureIncomplete", false, "incompleteAccepted", false,
                "prefixRevision", 0, "textBytes", 0, "completedOrdinal", -1, "completedSamples", 0,
                "segments", new JSONArray(), "endSample", -1, "mutationId", null, "preference", null,
                "request", null, "requestFingerprint", null, "handedOff", false);
            Live item = new Live(binding, id, generation(profile(binding)), manifest, ""); reserveCapture(item);
            try {
                // Only initialization writes this marker, and create cannot return a Journal until its removal is durable.
                writeJson(item, "creating", NativeVoiceJson.object("version", VERSION, "id", id, "binding", binding, "creating", true), true);
                writeJson(item, "manifest", manifest, true);
                writeJson(item, "checkpoint", NativeVoiceJson.object("version", VERSION, "samples", 0, "nextBlock", 0), true);
                deleteFile(recordFile(binding, id, "creating"));
                live.put(cacheKey(binding, id), item);
                return journal(binding, id);
            } catch (Exception error) {
                releaseCapture(item);
                // Capture has not started and no adoption is possible before create returns.
                try { deleteTree(directory); } catch (Exception cleanup) { error.addSuppressed(cleanup); }
                throw storageFailure(error);
            }
        }
    }

    Journal journal(String binding, String id) {
        synchronized (LOCK) {
            checkOwner(binding); validId(id);
            final long epoch = generation(profile(binding));
            return new Journal() {
                private void fence() {
                    synchronized (LOCK) {
                        checkOwner(binding);
                        if (generation(profile(binding)) != epoch) throw new IllegalStateException("dictation_stale");
                    }
                }
                public Executor executor() { return worker; }
                public Recording load() throws Exception { fence(); return get(binding, id); }
                public void append(long start, byte[] pcm) throws Exception { fence(); appendPcm(binding, id, start, pcm); }
                public Recording checkpoint() throws Exception { fence(); return checkpointRecording(binding, id); }
                public Recording seal(long ordinal, long start, long end, int padding) throws Exception {
                    fence(); return sealSegment(binding, id, ordinal, start, end, padding);
                }
                public Recording adopt(boolean keep) throws Exception { fence(); return adoptRecording(binding, id, keep); }
                public Recording commitStarted(long ordinal, String attempt) throws Exception {
                    fence(); return changeAttempt(binding, id, ordinal, attempt, null, null, true, "commitStarted");
                }
                public Recording committed(long ordinal, String attempt, String item) throws Exception {
                    fence(); return changeAttempt(binding, id, ordinal, attempt, item, null, true, "committed");
                }
                public Recording failed(long ordinal, String attempt, String reason, boolean uncertain) throws Exception {
                    fence(); return changeAttempt(binding, id, ordinal, attempt, null, reason, uncertain, "failed");
                }
                public Recording complete(long ordinal, String text) throws Exception { fence(); return completeSegment(binding, id, ordinal, text); }
                public Recording finish(String reason, long end) throws Exception { fence(); return finishRecording(binding, id, reason, end); }
                public Recording interrupt(String reason) throws Exception { fence(); return interruptRecording(binding, id, reason); }
                public void discard() throws Exception { fence(); NativeDictationStore.this.discard(binding, id); }
                public byte[] read(long start, int maximum) throws Exception { fence(); return readPcm(binding, id, start, maximum); }
            };
        }
    }

    Recording get(String binding, String id) throws Exception {
        synchronized (LOCK) { return snapshot(require(binding, id)); }
    }

    /** Called after accepted PCM has drained and the interruption boundary has settled. */
    Recording settleInterruption(String binding, String id, boolean capturedAudio) throws Exception {
        synchronized (LOCK) {
            Recording record = get(binding, id);
            if (capturedAudio || !record.empty()) return record;
            discardEmptyStartup(binding, id); return null;
        }
    }

    /** Only for authenticated empty journals whose capture has stopped or belongs to a previous process. */
    private void discardEmptyStartup(String binding, String id) throws Exception {
        try { discard(binding, id); }
        catch (Exception error) {
            // A failed marker write leaves no retirement to drain. Do not let this inactive cache entry
            // look like a live startup and bypass the next bootstrap cleanup attempt.
            Live cached = live.remove(cacheKey(binding, id));
            if (cached != null) releaseCapture(cached);
            throw error;
        }
    }

    /** Bootstrap only: ordinary attempts are not adopted, and durable adopted work never restarts itself. */
    Recording recover(String binding) throws Exception {
        synchronized (LOCK) {
            checkOwner(binding);
            Recording result = null;
            for (File directory : sortedChildren(bindingDirectory(binding))) {
                if (!directory.isDirectory()) continue;
                String id = directory.getName();
                if (!isId(id)) throw new Failure("dictation_storage_corrupt", true);
                boolean cached = live.containsKey(cacheKey(binding, id));
                Recording candidate; boolean retired = false;
                try {
                    Retirement retirement = retirement(binding, id);
                    if (retirement != null) {
                        retired = true;
                        if (retirement.mutationId == null) deleteTree(directory);
                        continue;
                    }
                    if (!cached && incompleteCreate(binding, id, directory)) { deleteTree(directory); continue; }
                    Live item = require(binding, id);
                    if (item.pendingInterruption != null) {
                        interruptRecording(binding, id, item.pendingInterruption); item = require(binding, id);
                    }
                    if (!item.manifest.optBoolean("adopted")) {
                        if (!cached) discard(binding, id);
                        continue;
                    }
                    // Authenticate every stored watermark before deciding an abandoned startup has no work to keep.
                    if (!cached && snapshot(item).empty()) { retired = true; discardEmptyStartup(binding, id); continue; }
                    if (!cached) {
                        JSONObject next = NativeVoiceJson.copy(item.manifest);
                        String stage = next.optString("stage");
                        if (stage.equals("capturing") || stage.equals("finishing") || stage.equals("recognizing")) {
                            boolean lostTail = next.optLong("endSample", -1) < 0;
                            if (lostTail) NativeVoiceJson.put(next, "endSample", item.durableSamples);
                            NativeVoiceJson.put(next, "captureIncomplete", next.optBoolean("captureIncomplete") || lostTail);
                            NativeVoiceJson.put(next, "keepListening", false);
                            NativeVoiceJson.put(next, "stage", isComplete(item, next) ? "ready" : "interrupted");
                            NativeVoiceJson.put(next, "reason", "recording_interrupted");
                            persistManifest(item, next);
                        }
                        reclaim(item);
                    }
                    candidate = snapshot(item);
                } catch (Failure error) {
                    if (retired) throw error; // Cleanup failure is reported separately; an acknowledged discard cannot reappear.
                    // Unreadable audio is never mistaken for an ordinary empty attempt and silently discarded.
                    candidate = unavailable(binding, id, error.code);
                }
                if (!candidate.adopted) { if (!cached) discard(binding, id); continue; }
                if (result != null && !result.id.equals(candidate.id)) throw new Failure("dictation_storage_corrupt", true);
                result = candidate;
            }
            return result;
        }
    }

    Recording retarget(String binding, String id, String threadId, String threadTitle) throws Exception {
        synchronized (LOCK) {
            validTarget(threadId, threadTitle); Live item = require(binding, id); ensureCapturing(item);
            JSONObject next = NativeVoiceJson.copy(item.manifest);
            NativeVoiceJson.put(next, "threadId", threadId); NativeVoiceJson.put(next, "threadTitle", threadTitle);
            persistManifest(item, next); return snapshot(item);
        }
    }

    Recording finishIntent(String binding, String id, String mutationId, JSONObject preference) throws Exception {
        synchronized (LOCK) {
            validId(mutationId); validatePreference(preference); Live item = require(binding, id);
            if (item.manifest.optLong("endSample", -1) < 0) throw new IllegalStateException("dictation_not_finished");
            String previous = nullable(item.manifest, "mutationId");
            if (previous != null) {
                if (!previous.equals(mutationId) || !sameJson(item.manifest.optJSONObject("preference"), preference))
                    throw new IllegalStateException("dictation_finalization_conflict");
                return snapshot(item);
            }
            JSONObject next = NativeVoiceJson.copy(item.manifest);
            NativeVoiceJson.put(next, "mutationId", mutationId); NativeVoiceJson.put(next, "preference", NativeVoiceJson.copy(preference));
            persistManifest(item, next); return snapshot(item);
        }
    }

    /** Only the revision-checked recovery Send action may acknowledge the saved, possibly incomplete end. */
    Recording acknowledgeIncomplete(String binding, String id) throws Exception {
        synchronized (LOCK) {
            Live item = require(binding, id);
            if (item.manifest.optLong("endSample", -1) < 0) throw new IllegalStateException("dictation_not_finished");
            if (item.manifest.optBoolean("captureIncomplete") && !item.manifest.optBoolean("incompleteAccepted")) {
                JSONObject next = NativeVoiceJson.copy(item.manifest); NativeVoiceJson.put(next, "incompleteAccepted", true);
                persistManifest(item, next);
            }
            return snapshot(item);
        }
    }

    Recording saveFinalRequest(String binding, String id, JSONObject request) throws Exception {
        synchronized (LOCK) {
            Live item = require(binding, id); validateFinalRequest(item, request);
            if (!item.manifest.isNull("request")) {
                if (!sameJson(item.manifest.optJSONObject("request"), request)) throw new IllegalStateException("dictation_finalization_conflict");
                return snapshot(item);
            }
            JSONObject next = NativeVoiceJson.copy(item.manifest);
            NativeVoiceJson.put(next, "request", NativeVoiceJson.copy(request));
            NativeVoiceJson.put(next, "requestFingerprint", digest(canonical(request)));
            NativeVoiceJson.put(next, "stage", "ready"); persistManifest(item, next); return snapshot(item);
        }
    }

    Recording markHandedOff(String binding, String id) throws Exception {
        synchronized (LOCK) {
            Live item = require(binding, id);
            if (item.manifest.optJSONObject("request") == null) throw new IllegalStateException("dictation_request_missing");
            if (!item.manifest.optBoolean("handedOff")) {
                JSONObject next = NativeVoiceJson.copy(item.manifest);
                NativeVoiceJson.put(next, "handedOff", true); NativeVoiceJson.put(next, "stage", "admitting"); persistManifest(item, next);
            }
            return snapshot(item);
        }
    }

    Recording reject(String binding, String id, String reason) throws Exception {
        synchronized (LOCK) {
            validReason(reason); Live item = require(binding, id);
            if (item.manifest.optJSONObject("request") == null) throw new IllegalStateException("dictation_request_missing");
            JSONObject next = NativeVoiceJson.copy(item.manifest);
            NativeVoiceJson.put(next, "stage", "rejected"); NativeVoiceJson.put(next, "reason", reason);
            persistManifest(item, next); return snapshot(item);
        }
    }

    Recording ownerOfMutation(String binding, String mutationId) throws Exception {
        synchronized (LOCK) {
            checkOwner(binding); validId(mutationId);
            for (File directory : sortedChildren(bindingDirectory(binding))) {
                if (!directory.isDirectory() || !isId(directory.getName())) continue;
                try {
                    if (hasTombstone(binding, directory.getName())) continue;
                    Live item = require(binding, directory.getName());
                    if (item.manifest.optBoolean("adopted") && mutationId.equals(nullable(item.manifest, "mutationId"))) return snapshot(item);
                } catch (Failure error) {
                    Recording owner = unavailable(binding, directory.getName(), error.code);
                    if (owner.adopted && mutationId.equals(owner.mutationId)) return owner;
                    if (owner.mutationId == null) throw error; // Unknown ownership cannot become ordinary recovery by accident.
                }
            }
            return null;
        }
    }

    /** Copy reads only the authenticated transcript link, so damaged pending PCM cannot hide a valid prefix. */
    String transcript(String binding, String id) throws Exception {
        synchronized (LOCK) {
            checkOwner(binding); validId(id);
            try { if (hasTombstone(binding, id)) throw new IllegalStateException("dictation_discarded"); }
            catch (Failure error) { if (!error.corrupt) throw error; }
            try {
                JSONObject manifest = readJson(binding, id, "manifest", MAX_MANIFEST_BYTES); validateManifest(binding, id, manifest);
                long prefix = manifest.getLong("prefixRevision");
                String text = prefix == 0 ? "" : decodeUtf8(readRecord(binding, id, "prefix-" + prefix, MAX_RETAINED_TEXT_BYTES));
                if (NativeVoiceJson.bytes(text) != manifest.getInt("textBytes")) throw new Failure("dictation_storage_corrupt", true);
                return text;
            } catch (Failure error) { throw error; }
            catch (JSONException | IllegalArgumentException error) { throw new Failure("dictation_storage_corrupt", true, error); }
            catch (Exception error) { throw storageFailure(error); }
        }
    }

    static final class Retirement {
        final String recordingId, mutationId;
        Retirement(String recordingId, String mutationId) { this.recordingId = recordingId; this.mutationId = mutationId; }
    }

    /** Durable revocation precedes removal from the separate admission journal. */
    void beginDiscard(String binding, String id, String mutationId) throws Exception {
        synchronized (LOCK) {
            checkOwner(binding); validId(id); if (mutationId != null) validId(mutationId);
            File directory = directory(binding, id); Live item = live.get(cacheKey(binding, id));
            if (!directory.exists()) { if (item != null) releaseCapture(item); live.remove(cacheKey(binding, id)); return; }
            Retirement previous;
            try { previous = retirement(binding, id); }
            catch (Failure error) { if (!error.corrupt) throw error; previous = null; }
            if (previous != null && !java.util.Objects.equals(previous.mutationId, mutationId))
                throw new IllegalStateException("dictation_retirement_conflict");
            if (previous == null) {
                JSONObject terminal = NativeVoiceJson.object("version", VERSION, "id", id, "binding", binding,
                    "discarded", true, "mutationId", mutationId);
                writeRecord(binding, id, "terminal", terminal.toString().getBytes(StandardCharsets.UTF_8), true);
            }
            if (item != null) releaseCapture(item);
            live.remove(cacheKey(binding, id));
        }
    }

    /** Bootstrap must remove these linked admission entries before exposing ordinary journal recovery. */
    List<Retirement> pendingRetirements(String binding) throws Exception {
        synchronized (LOCK) {
            checkOwner(binding); List<Retirement> result = new ArrayList<>();
            for (File directory : sortedChildren(bindingDirectory(binding))) {
                if (!directory.isDirectory()) continue;
                validId(directory.getName());
                try {
                    Retirement retirement = retirement(binding, directory.getName());
                    if (retirement != null) result.add(retirement);
                } catch (Failure error) {
                    // Corruption is not proof of a discard: recovery exposes the retained content as unavailable.
                    // Transient I/O/key errors remain fatal and cannot let admission recovery bypass unknown ownership.
                    if (!error.corrupt) throw error;
                }
            }
            return result;
        }
    }

    /** Invoke only after the linked admission entry has been removed durably. */
    void finishDiscard(String binding, String id) throws Exception {
        synchronized (LOCK) {
            checkOwner(binding); validId(id); File directory = directory(binding, id);
            if (!directory.exists()) return;
            if (retirement(binding, id) == null) throw new IllegalStateException("dictation_retirement_missing");
            deleteTree(directory);
        }
    }

    void discard(String binding, String id) throws Exception {
        synchronized (LOCK) {
            checkOwner(binding); validId(id);
            Retirement previous;
            try { previous = retirement(binding, id); }
            catch (Failure error) { if (!error.corrupt) throw error; previous = null; }
            String mutation = previous == null ? null : previous.mutationId;
            if (previous == null && directory(binding, id).exists()) {
                Live item = live.get(cacheKey(binding, id));
                if (item != null && item.manifest.optBoolean("adopted")) mutation = nullable(item.manifest, "mutationId");
                else try {
                    JSONObject manifest = readJson(binding, id, "manifest", MAX_MANIFEST_BYTES);
                    validateManifest(binding, id, manifest);
                    if (manifest.optBoolean("adopted")) mutation = nullable(manifest, "mutationId");
                } catch (Failure ignored) { /* The explicit discard marker does not depend on an unreadable manifest. */ }
            }
            beginDiscard(binding, id, mutation);
            // Only adopted recordings own an admission journal. Ordinary capture cleanup cannot revoke an input
            // handed to that independent journal; its receipt reconciliation continues after this spool disappears.
            // A linked marker must remain until the runtime has removed its separate admission entry.
            if (mutation == null) finishDiscard(binding, id);
        }
    }

    /** Called on the serial executor after the runtime has stopped capture and revoked callbacks. */
    void removeProfile(String profileId) throws Exception {
        synchronized (LOCK) {
            ensureOpen(); validProfile(profileId);
            profileGenerations.put(profileId, generation(profileId) + 1); removedProfiles.add(profileId);
            for (Iterator<Map.Entry<String, Live>> entries = live.entrySet().iterator(); entries.hasNext();) {
                Live item = entries.next().getValue();
                if (profile(item.binding).equals(profileId)) { releaseCapture(item); entries.remove(); }
            }
            deleteTree(new File(root, digest(profileId)));
        }
    }

    @Override public void close() {
        synchronized (LOCK) {
            if (closed) return;
            closed = true;
            for (Live item : live.values()) releaseCapture(item);
            live.clear(); worker.shutdown();
            if (--ledger.owners == 0) LEDGERS.remove(ledgerKey);
        }
    }
    private void appendPcm(String binding, String id, long start, byte[] pcm) throws Exception {
        synchronized (LOCK) {
            Live item = require(binding, id); ensureCapturing(item);
            if (pcm == null || (pcm.length & 1) != 0 || start != item.acceptedSamples ||
                start > MAX_SAMPLE - pcm.length / 2) throw new IllegalArgumentException("dictation_pcm_invalid");
            if ((item.acceptedSamples - item.manifest.optLong("completedSamples")) * 2 + pcm.length > limits.pendingPcmBytes)
                throw new Failure("dictation_audio_capacity", false);
            if (!item.captureReserved) reserveCapture(item);
            replenishCapture(item);
            int offset = 0;
            while (offset < pcm.length) {
                int count = Math.min(pcm.length - offset, limits.blockPcmBytes - item.tail.size());
                item.tail.write(pcm, offset, count); item.acceptedSamples += count / 2; offset += count;
                if (item.tail.size() == limits.blockPcmBytes) { flush(item); replenishCapture(item); }
            }
        }
    }

    private Recording checkpointRecording(String binding, String id) throws Exception {
        synchronized (LOCK) { Live item = require(binding, id); flush(item); return snapshot(item); }
    }

    private void flush(Live item) throws Exception {
        if (item.tail.size() == 0) return;
        byte[] pcm = item.tail.toByteArray();
        long ordinal = item.nextBlock, end = item.durableSamples + pcm.length / 2;
        ByteBuffer record = ByteBuffer.allocate(BLOCK_HEADER_BYTES + pcm.length);
        record.putLong(ordinal).putLong(item.durableSamples).putInt(pcm.length).put(pcm);
        writeRecord(item.binding, item.id, "pcm-" + ordinal, record.array(), false, item);
        writeJson(item, "checkpoint", NativeVoiceJson.object("version", VERSION, "samples", end, "nextBlock", ordinal + 1), true);
        item.blocks.add(new Block(ordinal, item.durableSamples, end, recordFile(item.binding, item.id, "pcm-" + ordinal)));
        item.durableSamples = end; item.nextBlock++; item.tail.reset();
    }

    private Recording sealSegment(String binding, String id, long ordinal, long start, long end, int padding) throws Exception {
        synchronized (LOCK) {
            Live item = require(binding, id); JSONArray segments = item.manifest.getJSONArray("segments");
            if (segments.length() >= limits.pendingSegments) throw new Failure("dictation_segment_capacity", false);
            long previousOrdinal = item.manifest.getLong("completedOrdinal"), previousEnd = item.manifest.getLong("completedSamples");
            if (segments.length() > 0) {
                JSONObject previous = segments.getJSONObject(segments.length() - 1);
                previousOrdinal = previous.getLong("ordinal"); previousEnd = previous.getLong("endSample");
            }
            if (ordinal != previousOrdinal + 1 || start != previousEnd || end <= start || end > item.durableSamples ||
                padding < 0 || padding > SAMPLE_RATE || item.manifest.optJSONObject("request") != null)
                throw new IllegalStateException("dictation_segment_invalid");
            JSONObject next = NativeVoiceJson.copy(item.manifest);
            next.getJSONArray("segments").put(NativeVoiceJson.object("ordinal", ordinal, "startSample", start, "endSample", end,
                "paddingSamples", padding, "state", "sealed", "attemptId", null, "itemId", null, "reason", null, "uncertain", false));
            persistManifest(item, next); return snapshot(item);
        }
    }

    private Recording adoptRecording(String binding, String id, boolean keep) throws Exception {
        synchronized (LOCK) {
            Live item = require(binding, id);
            if (keep) ensureCapturing(item);
            item.adoptionRequested = true;
            flush(item);
            JSONObject next = NativeVoiceJson.copy(item.manifest);
            NativeVoiceJson.put(next, "adopted", true); NativeVoiceJson.put(next, "keepListening", keep);
            persistManifest(item, next); return snapshot(item);
        }
    }

    private Recording changeAttempt(String binding, String id, long ordinal, String attempt, String itemId,
            String reason, boolean uncertain, String state) throws Exception {
        synchronized (LOCK) {
            validId(attempt); if (itemId != null) validId(itemId); if (reason != null) validReason(reason);
            Live item = require(binding, id); JSONObject next = NativeVoiceJson.copy(item.manifest);
            JSONArray segments = next.getJSONArray("segments"); JSONObject segment = null;
            for (int index = 0; index < segments.length(); index++)
                if (segments.getJSONObject(index).getLong("ordinal") == ordinal) { segment = segments.getJSONObject(index); break; }
            if (segment == null) throw new IllegalStateException("dictation_segment_stale");
            if (!state.equals("commitStarted") && !attempt.equals(nullable(segment, "attemptId")))
                throw new IllegalStateException("dictation_attempt_stale");
            if (state.equals("committed") && (!segment.optString("state").equals("commitStarted") || itemId == null))
                throw new IllegalStateException("dictation_attempt_invalid");
            NativeVoiceJson.put(segment, "state", state); NativeVoiceJson.put(segment, "attemptId", attempt);
            NativeVoiceJson.put(segment, "itemId", itemId); NativeVoiceJson.put(segment, "reason", reason);
            NativeVoiceJson.put(segment, "uncertain", uncertain);
            persistManifest(item, next); return snapshot(item);
        }
    }

    private Recording completeSegment(String binding, String id, long ordinal, String text) throws Exception {
        synchronized (LOCK) {
            if (text == null) throw new IllegalArgumentException("dictation_text_invalid");
            if (utf8(text).length > MAX_SEGMENT_TEXT_BYTES) throw new Failure("dictation_segment_text_limit", false);
            Live item = require(binding, id);
            if (NativeVoiceJson.bytes(item.text) > MAX_TEXT_BYTES) throw new Failure("dictation_text_limit", false);
            JSONArray previous = item.manifest.getJSONArray("segments");
            if (previous.length() == 0 || previous.getJSONObject(0).getLong("ordinal") != ordinal)
                throw new IllegalStateException("dictation_segment_stale");
            JSONObject segment = previous.getJSONObject(0);
            String addition = trimTranscript(text);
            String assembled = addition.isEmpty() ? item.text : item.text.isEmpty() ? addition : item.text + " " + addition;
            byte[] prefix = utf8(assembled);
            long prefixRevision = item.manifest.getLong("prefixRevision") + 1;
            writeRecord(binding, id, "prefix-" + prefixRevision, prefix, false);
            JSONObject next = NativeVoiceJson.copy(item.manifest); JSONArray remaining = new JSONArray();
            for (int index = 1; index < previous.length(); index++) remaining.put(previous.getJSONObject(index));
            NativeVoiceJson.put(next, "segments", remaining); NativeVoiceJson.put(next, "prefixRevision", prefixRevision);
            NativeVoiceJson.put(next, "textBytes", prefix.length); NativeVoiceJson.put(next, "completedOrdinal", ordinal);
            NativeVoiceJson.put(next, "completedSamples", segment.getLong("endSample"));
            if (prefix.length > MAX_TEXT_BYTES) { NativeVoiceJson.put(next, "stage", "overflow"); NativeVoiceJson.put(next, "keepListening", false); }
            else if (isComplete(item, next)) NativeVoiceJson.put(next, "stage", "ready");
            persistManifest(item, next); item.text = assembled;
            // The manifest links the encrypted transcript before any now-redundant PCM is reclaimed.
            reclaim(item); return snapshot(item);
        }
    }

    private Recording finishRecording(String binding, String id, String reason, long end) throws Exception {
        synchronized (LOCK) {
            validReason(reason); Live item = require(binding, id); flush(item);
            long previous = item.manifest.optLong("endSample", -1);
            if (end != item.durableSamples || (previous >= 0 && previous != end)) throw new IllegalStateException("dictation_finish_invalid");
            JSONObject next = NativeVoiceJson.copy(item.manifest);
            NativeVoiceJson.put(next, "endSample", end); NativeVoiceJson.put(next, "reason", reason); NativeVoiceJson.put(next, "keepListening", false);
            NativeVoiceJson.put(next, "stage", NativeVoiceJson.bytes(item.text) > MAX_TEXT_BYTES ? "overflow" : isComplete(item, next) ? "ready" : "recognizing");
            persistManifest(item, next); releaseCapture(item); return snapshot(item);
        }
    }

    private Recording interruptRecording(String binding, String id, String reason) throws Exception {
        synchronized (LOCK) {
            validReason(reason); Live item = live.get(cacheKey(binding, id));
            if (item != null) item.pendingInterruption = reason;
            try {
                item = require(binding, id); item.pendingInterruption = reason;
                try { flush(item); }
                catch (Exception failure) {
                    // A PCM/checkpoint failure must not prevent the small control write that freezes its durable end.
                    // A replacement may have committed before its acknowledgement failed; reload that watermark first.
                    if (item.reloadNeeded) item = require(binding, id);
                }
                JSONObject next = NativeVoiceJson.copy(item.manifest);
                if (item.adoptionRequested) NativeVoiceJson.put(next, "adopted", true);
                boolean incomplete = next.optBoolean("captureIncomplete") || next.optLong("endSample", -1) < 0 || item.acceptedSamples > item.durableSamples;
                NativeVoiceJson.put(next, "endSample", item.durableSamples); NativeVoiceJson.put(next, "reason", reason);
                NativeVoiceJson.put(next, "captureIncomplete", incomplete); NativeVoiceJson.put(next, "keepListening", false);
                NativeVoiceJson.put(next, "stage", NativeVoiceJson.bytes(item.text) > MAX_TEXT_BYTES ? "overflow" : isComplete(item, next) ? "ready" : "interrupted");
                persistManifest(item, next);
                // Once this boundary is durable, an unwritable tail cannot be appended beyond it on Retry.
                item.tail.reset(); item.acceptedSamples = item.durableSamples; item.pendingInterruption = null;
                return snapshot(item);
            } finally { if (item != null) releaseCapture(item); }
        }
    }

    private byte[] readPcm(String binding, String id, long start, int maximum) throws Exception {
        synchronized (LOCK) {
            Live item = require(binding, id);
            if (start < item.manifest.optLong("completedSamples") || start > item.durableSamples || maximum < 2 || (maximum & 1) != 0 || maximum > BLOCK_PCM_BYTES)
                throw new IllegalArgumentException("dictation_read_invalid");
            int wanted = (int) Math.min(maximum, (item.durableSamples - start) * 2);
            byte[] result = new byte[wanted]; int offset = 0; long cursor = start;
            for (Block block : item.blocks) {
                if (block.end <= cursor || block.start > cursor) continue;
                byte[] pcm = decodeBlock(item, block.file, block.ordinal).pcm;
                int begin = (int) ((cursor - block.start) * 2), count = Math.min(wanted - offset, pcm.length - begin);
                System.arraycopy(pcm, begin, result, offset, count); offset += count; cursor += count / 2;
                if (offset == wanted) break;
            }
            if (offset != wanted) throw new Failure("dictation_storage_corrupt", true);
            return result;
        }
    }

    private Live require(String binding, String id) throws Exception {
        checkOwner(binding); validId(id); String cacheKey = cacheKey(binding, id);
        Live cached = live.get(cacheKey);
        if (cached != null && !cached.reloadNeeded) return cached;
        Live item = loadDisk(binding, id);
        if (cached != null) {
            // Keep accepted PCM across control failures, but trust only freshly authenticated metadata/checkpoints.
            byte[] tail = cached.tail.toByteArray();
            if (tail.length != (cached.acceptedSamples - cached.durableSamples) * 2 ||
                item.durableSamples < cached.durableSamples || item.durableSamples > cached.acceptedSamples)
                throw new Failure("dictation_storage_corrupt", true);
            int acknowledged = (int) ((item.durableSamples - cached.durableSamples) * 2);
            item.tail.write(tail, acknowledged, tail.length - acknowledged); item.acceptedSamples = cached.acceptedSamples;
            item.captureReserved = cached.captureReserved; item.captureReservedBytes = cached.captureReservedBytes;
            item.drainOnly = cached.drainOnly; item.pendingInterruption = cached.pendingInterruption; item.adoptionRequested = cached.adoptionRequested;
        }
        live.put(cacheKey, item); return item;
    }

    private Live loadDisk(String binding, String id) throws Exception {
        try {
            if (hasTombstone(binding, id)) throw new IllegalStateException("dictation_discarded");
            JSONObject manifest = readJson(binding, id, "manifest", MAX_MANIFEST_BYTES);
            validateManifest(binding, id, manifest);
            long prefixRevision = manifest.getLong("prefixRevision");
            String text = prefixRevision == 0 ? "" : decodeUtf8(readRecord(binding, id, "prefix-" + prefixRevision, MAX_RETAINED_TEXT_BYTES));
            if (NativeVoiceJson.bytes(text) != manifest.getInt("textBytes")) throw new Failure("dictation_storage_corrupt", true);
            Live item = new Live(binding, id, generation(profile(binding)), manifest, text);
            JSONObject checkpoint = readJson(binding, id, "checkpoint", MAX_CHECKPOINT_BYTES);
            exactKeys(checkpoint, "version", "samples", "nextBlock"); NativeVoiceJson.integer(checkpoint, "version", VERSION, VERSION);
            item.durableSamples = NativeVoiceJson.integer(checkpoint, "samples", 0, MAX_SAMPLE);
            item.acceptedSamples = item.durableSamples;
            item.nextBlock = NativeVoiceJson.integer(checkpoint, "nextBlock", 0, MAX_SAMPLE);
            long completed = manifest.getLong("completedSamples"), end = manifest.getLong("endSample");
            if (completed > item.durableSamples || end > item.durableSamples || (end >= 0 && end != item.durableSamples))
                throw new Failure("dictation_storage_corrupt", true);
            JSONArray segments = manifest.getJSONArray("segments");
            if (segments.length() > 0 && segments.getJSONObject(segments.length() - 1).getLong("endSample") > item.durableSamples)
                throw new Failure("dictation_storage_corrupt", true);
            for (File file : sortedChildren(directory(binding, id))) {
                String name = file.getName();
                if (!name.matches("pcm-(0|[1-9][0-9]*)[.]enc")) continue;
                long ordinal;
                try { ordinal = Long.parseLong(name.substring(4, name.length() - 4)); }
                catch (NumberFormatException error) { throw new Failure("dictation_storage_corrupt", true, error); }
                if (ordinal >= item.nextBlock) continue; // Only checkpoint-owned files are needed; others were never acknowledged.
                DecodedBlock decoded = decodeBlock(item, file, ordinal);
                item.blocks.add(new Block(ordinal, decoded.start, decoded.start + decoded.pcm.length / 2, file));
            }
            item.blocks.sort(Comparator.comparingLong(block -> block.start));
            long cursor = completed, previousEnd = -1, previousOrdinal = -1;
            for (Block block : item.blocks) {
                if (block.start < previousEnd || block.ordinal <= previousOrdinal || block.end > item.durableSamples)
                    throw new Failure("dictation_storage_corrupt", true);
                previousEnd = block.end; previousOrdinal = block.ordinal;
                if (block.end <= completed) continue;
                if (block.start > cursor || block.end <= cursor) throw new Failure("dictation_storage_corrupt", true);
                cursor = block.end;
            }
            if (cursor != item.durableSamples || (item.durableSamples - completed) * 2 > limits.pendingPcmBytes)
                throw new Failure("dictation_storage_corrupt", true);
            JSONObject request = manifest.optJSONObject("request");
            if (request != null) {
                validateFinalRequest(item, request);
                if (!digest(canonical(request)).equals(manifest.optString("requestFingerprint"))) throw new Failure("dictation_storage_corrupt", true);
            }
            return item;
        } catch (Failure error) { throw error; }
        catch (IllegalStateException error) { if ("dictation_discarded".equals(error.getMessage())) throw error; throw new Failure("dictation_storage_corrupt", true, error); }
        catch (JSONException | IllegalArgumentException error) { throw new Failure("dictation_storage_corrupt", true, error); }
        catch (Exception error) { throw storageFailure(error); }
    }

    private static final class DecodedBlock {
        final long start; final byte[] pcm;
        DecodedBlock(long start, byte[] pcm) { this.start = start; this.pcm = pcm; }
    }
    private DecodedBlock decodeBlock(Live item, File file, long ordinal) throws Exception {
        byte[] bytes = readRecord(item.binding, item.id, "pcm-" + ordinal, BLOCK_HEADER_BYTES + limits.blockPcmBytes);
        if (bytes.length < BLOCK_HEADER_BYTES + 2) throw new Failure("dictation_storage_corrupt", true);
        ByteBuffer value = ByteBuffer.wrap(bytes); long actualOrdinal = value.getLong(), start = value.getLong(); int count = value.getInt();
        if (actualOrdinal != ordinal || start < 0 || count < 2 || (count & 1) != 0 || count != bytes.length - BLOCK_HEADER_BYTES ||
            start > MAX_SAMPLE - count / 2) throw new Failure("dictation_storage_corrupt", true);
        return new DecodedBlock(start, Arrays.copyOfRange(bytes, BLOCK_HEADER_BYTES, bytes.length));
    }

    private void validateManifest(String binding, String id, JSONObject value) throws Exception {
        exactKeys(value, "version", "id", "binding", "revision", "threadId", "threadTitle", "config", "stage", "reason",
            "adopted", "keepListening", "captureIncomplete", "incompleteAccepted", "prefixRevision", "textBytes", "completedOrdinal",
            "completedSamples", "segments", "endSample", "mutationId", "preference", "request", "requestFingerprint", "handedOff");
        NativeVoiceJson.integer(value, "version", VERSION, VERSION);
        if (!id.equals(value.optString("id")) || !binding.equals(value.optString("binding"))) throw new IllegalArgumentException("dictation_identity_invalid");
        validTarget(NativeVoiceJson.string(value, "threadId", 160), NativeVoiceJson.nullableString(value, "threadTitle", 512));
        validateConfig(NativeVoiceJson.requiredObject(value, "config"));
        if (!STAGES.contains(NativeVoiceJson.string(value, "stage", 32))) throw new IllegalArgumentException("dictation_stage_invalid");
        String reason = nullable(value, "reason"); if (reason != null) validReason(reason);
        for (String field : new String[] { "adopted", "keepListening", "captureIncomplete", "incompleteAccepted", "handedOff" }) NativeVoiceJson.bool(value, field);
        NativeVoiceJson.integer(value, "revision", 0, MAX_SAMPLE);
        long prefix = NativeVoiceJson.integer(value, "prefixRevision", 0, MAX_SAMPLE);
        NativeVoiceJson.integer(value, "textBytes", 0, MAX_RETAINED_TEXT_BYTES);
        long ordinal = NativeVoiceJson.integer(value, "completedOrdinal", -1, MAX_SAMPLE);
        long start = NativeVoiceJson.integer(value, "completedSamples", 0, MAX_SAMPLE);
        NativeVoiceJson.integer(value, "endSample", -1, MAX_SAMPLE);
        if (prefix != ordinal + 1 || (ordinal == -1 && start != 0)) throw new IllegalArgumentException("dictation_prefix_invalid");
        JSONArray segments = value.optJSONArray("segments");
        if (segments == null || segments.length() > limits.pendingSegments) throw new IllegalArgumentException("dictation_segments_invalid");
        for (int index = 0; index < segments.length(); index++) {
            JSONObject segment = segments.getJSONObject(index);
            exactKeys(segment, "ordinal", "startSample", "endSample", "paddingSamples", "state", "attemptId", "itemId", "reason", "uncertain");
            if (NativeVoiceJson.integer(segment, "ordinal", 0, MAX_SAMPLE) != ++ordinal ||
                NativeVoiceJson.integer(segment, "startSample", 0, MAX_SAMPLE) != start) throw new IllegalArgumentException("dictation_segment_invalid");
            start = NativeVoiceJson.integer(segment, "endSample", start + 1, MAX_SAMPLE);
            NativeVoiceJson.integer(segment, "paddingSamples", 0, SAMPLE_RATE);
            String state = NativeVoiceJson.string(segment, "state", 32);
            if (!Arrays.asList("sealed", "commitStarted", "committed", "failed").contains(state)) throw new IllegalArgumentException("dictation_attempt_invalid");
            String attempt = nullable(segment, "attemptId"), item = nullable(segment, "itemId"), failure = nullable(segment, "reason");
            if (attempt != null) validId(attempt); if (item != null) validId(item); if (failure != null) validReason(failure);
            if (!state.equals("sealed") && attempt == null || state.equals("committed") && item == null)
                throw new IllegalArgumentException("dictation_attempt_invalid");
            NativeVoiceJson.bool(segment, "uncertain");
        }
        String mutation = nullable(value, "mutationId"); JSONObject preference = value.optJSONObject("preference");
        if (mutation != null) { validId(mutation); validatePreference(preference); }
        else if (preference != null || value.optJSONObject("request") != null || value.optBoolean("handedOff")) throw new IllegalArgumentException("dictation_intent_invalid");
    }

    private Recording snapshot(Live item) throws Exception {
        JSONObject value = item.manifest; List<Segment> segments = new ArrayList<>(); JSONArray raw = value.getJSONArray("segments");
        for (int index = 0; index < raw.length(); index++) {
            JSONObject segment = raw.getJSONObject(index);
            segments.add(new Segment(segment.getLong("ordinal"), segment.getLong("startSample"), segment.getLong("endSample"),
                segment.getInt("paddingSamples"), segment.getString("state"), nullable(segment, "attemptId"), nullable(segment, "itemId"),
                nullable(segment, "reason"), segment.getBoolean("uncertain")));
        }
        return new Recording(item.binding, item.id, value.getString("threadId"), nullable(value, "threadTitle"), value.getString("stage"),
            nullable(value, "reason"), value.getLong("revision"), item.acceptedSamples, item.durableSamples,
            value.getLong("completedOrdinal"), value.getLong("completedSamples"), value.getLong("endSample"), value.getBoolean("adopted"),
            value.getBoolean("keepListening"), value.getBoolean("captureIncomplete"), item.text, value.getJSONObject("config"), segments,
            nullable(value, "mutationId"), value.optJSONObject("preference"), value.optJSONObject("request"), value.getBoolean("handedOff"));
    }

    private Recording unavailable(String binding, String id, String reason) {
        String target = null, title = null, text = "", mutation = null;
        JSONObject config = new JSONObject(), preference = null, request = null;
        long revision = 0; boolean handedOff = false, adopted = true;
        try {
            JSONObject manifest = readJson(binding, id, "manifest", MAX_MANIFEST_BYTES); validateManifest(binding, id, manifest);
            target = manifest.getString("threadId"); title = nullable(manifest, "threadTitle"); config = manifest.getJSONObject("config");
            revision = manifest.getLong("revision"); adopted = manifest.getBoolean("adopted"); long prefix = manifest.getLong("prefixRevision");
            mutation = nullable(manifest, "mutationId"); preference = manifest.optJSONObject("preference"); handedOff = manifest.optBoolean("handedOff");
            if (prefix > 0) {
                String readable = decodeUtf8(readRecord(binding, id, "prefix-" + prefix, MAX_RETAINED_TEXT_BYTES));
                if (NativeVoiceJson.bytes(readable) != manifest.getInt("textBytes")) throw new Failure("dictation_storage_corrupt", true);
                text = readable;
            }
            JSONObject frozen = manifest.optJSONObject("request");
            if (frozen != null) {
                Live owner = new Live(binding, id, generation(profile(binding)), manifest, text);
                validateFinalRequest(owner, frozen);
                if (digest(canonical(frozen)).equals(manifest.optString("requestFingerprint"))) request = frozen;
            }
        } catch (Exception ignored) { /* Preserve every file for explicit recovery/discard. */ }
        return new Recording(binding, id, target, title, "unavailable", reason, revision, 0, 0, -1, 0, -1,
            adopted, false, true, text, config, Collections.emptyList(), mutation, preference, request, handedOff);
    }

    private static boolean isComplete(Live item, JSONObject value) {
        return value.optLong("endSample", -1) >= 0 && value.optLong("completedSamples") == value.optLong("endSample") &&
            value.optJSONArray("segments") != null && value.optJSONArray("segments").length() == 0;
    }
    private static void ensureCapturing(Live item) {
        if (item.manifest.optLong("endSample", -1) >= 0 || !item.manifest.optString("stage").equals("capturing"))
            throw new IllegalStateException("dictation_not_capturing");
    }
    private void persistManifest(Live item, JSONObject next) throws Exception {
        NativeVoiceJson.put(next, "revision", item.manifest.getLong("revision") + 1);
        writeJson(item, "manifest", next, true); item.manifest = next;
    }

    /** Initializer-only artifacts are distinguishable from a damaged recording without guessing its adoption state. */
    private boolean incompleteCreate(String binding, String id, File directory) throws Exception {
        List<File> files = sortedChildren(directory);
        boolean markerOnly = true;
        for (File file : files) {
            String name = file.getName();
            if (file.isDirectory() || !Arrays.asList("creating.enc", "creating.enc.new", "manifest.enc", "manifest.enc.new", "checkpoint.enc", "checkpoint.enc.new").contains(name))
                return false; // In particular, never sweep a prefix or PCM block on initialization evidence alone.
            if (!name.equals("creating.enc") && !name.equals("creating.enc.new")) markerOnly = false;
        }
        if (markerOnly) return true;
        if (!recordFile(binding, id, "creating").exists()) return false;
        JSONObject marker = readJson(binding, id, "creating", MAX_CHECKPOINT_BYTES);
        try {
            exactKeys(marker, "version", "id", "binding", "creating");
            NativeVoiceJson.integer(marker, "version", VERSION, VERSION);
            if (!id.equals(marker.optString("id")) || !binding.equals(marker.optString("binding")) || !NativeVoiceJson.bool(marker, "creating"))
                throw new IllegalArgumentException("dictation_record_invalid");
            return true;
        } catch (RuntimeException error) { throw new Failure("dictation_storage_corrupt", true, error); }
    }

    private void reclaim(Live item) {
        try { cleanupOrphans(item); }
        catch (Exception ignored) { /* Linked transcript and pending PCM remain valid; a later sweep can reclaim leftovers. */ }
    }

    private void cleanupOrphans(Live item) throws Exception {
        long completed = item.manifest.getLong("completedSamples"), prefix = item.manifest.getLong("prefixRevision");
        for (File file : sortedChildren(directory(item.binding, item.id))) {
            String name = file.getName(); boolean remove = name.endsWith(".new");
            if (name.matches("prefix-(0|[1-9][0-9]*)[.]enc"))
                remove = !name.equals("prefix-" + prefix + ".enc");
            if (name.matches("pcm-(0|[1-9][0-9]*)[.]enc")) {
                long ordinal = Long.parseLong(name.substring(4, name.length() - 4));
                if (ordinal >= item.nextBlock) remove = true;
                else for (Block block : item.blocks) if (block.ordinal == ordinal && block.end <= completed) { remove = true; break; }
            }
            if (remove) deleteFile(file);
        }
        item.blocks.removeIf(block -> block.end <= completed);
    }

    private boolean hasTombstone(String binding, String id) throws Exception { return retirement(binding, id) != null; }
    private Retirement retirement(String binding, String id) throws Exception {
        if (!recordFile(binding, id, "terminal").exists()) return null;
        JSONObject terminal = readJson(binding, id, "terminal", MAX_CHECKPOINT_BYTES);
        try {
            exactKeys(terminal, "version", "id", "binding", "discarded", "mutationId");
            NativeVoiceJson.integer(terminal, "version", VERSION, VERSION);
            if (!id.equals(terminal.optString("id")) || !binding.equals(terminal.optString("binding")) || !NativeVoiceJson.bool(terminal, "discarded"))
                throw new IllegalArgumentException("dictation_terminal_invalid");
            String mutation = nullable(terminal, "mutationId"); if (mutation != null) validId(mutation);
            return new Retirement(id, mutation);
        } catch (RuntimeException error) { throw new Failure("dictation_storage_corrupt", true, error); }
    }

    private void writeJson(Live item, String name, JSONObject value, boolean control) throws Exception {
        byte[] bytes = value.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > (name.equals("manifest") ? MAX_MANIFEST_BYTES : MAX_CHECKPOINT_BYTES)) throw new Failure("dictation_storage_capacity", false);
        writeRecord(item.binding, item.id, name, bytes, control);
    }
    private JSONObject readJson(String binding, String id, String name, int maximum) throws Exception {
        try { return new JSONObject(decodeUtf8(readRecord(binding, id, name, maximum))); }
        catch (JSONException error) { throw new Failure("dictation_storage_corrupt", true, error); }
    }
    private byte[] readRecord(String binding, String id, String name, int maximum) throws Exception {
        try {
            File file = recordFile(binding, id, name);
            byte[] encrypted;
            try { encrypted = disk.read(file, maximum + ENCRYPTION_BYTES); }
            catch (FileNotFoundException error) {
                if (!file.exists() && file.getParentFile().isDirectory()) throw new Failure("dictation_storage_corrupt", true, error);
                throw error;
            }
            if (encrypted.length < ENCRYPTION_BYTES || encrypted[0] != VERSION) throw new Failure("dictation_storage_corrupt", true);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, keys.get(), new GCMParameterSpec(128, Arrays.copyOfRange(encrypted, 1, 13)));
            cipher.updateAAD(aad(binding, id, name));
            return cipher.doFinal(encrypted, 13, encrypted.length - 13);
        } catch (AEADBadTagException error) { throw new Failure("dictation_storage_corrupt", true, error); }
        catch (Failure error) { throw error; }
        catch (Exception error) { throw storageFailure(error); }
    }
    private void writeRecord(String binding, String id, String name, byte[] plain, boolean control) throws Exception {
        writeRecord(binding, id, name, plain, control, null);
    }
    private void writeRecord(String binding, String id, String name, byte[] plain, boolean control, Live capture) throws Exception {
        long bytesNeeded = plain.length + ENCRYPTION_BYTES;
        File file = recordFile(binding, id, name);
        long previousFileBytes = file.length() + new File(file.getPath() + ".new").length();
        ensureLedger();
        boolean pcmReplacement = capture != null && previousFileBytes > 0;
        // A duplicate of an uncheckpointed block coexists with queued staging: account it separately, from control headroom.
        long credit = capture == null || pcmReplacement ? 0 : Math.min(capture.captureReservedBytes, bytesNeeded);
        long extra = bytesNeeded - credit;
        if (extra > 0) reserve(extra, control || pcmReplacement);
        long previousBytes = ledger.bytes;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, keys.get());
            cipher.updateAAD(aad(binding, id, name)); byte[] ciphertext = cipher.doFinal(plain);
            byte[] bytes = ByteBuffer.allocate(1 + cipher.getIV().length + ciphertext.length).put((byte) VERSION).put(cipher.getIV()).put(ciphertext).array();
            disk.atomicWrite(file, bytes); ledger.bytes += bytes.length - previousFileBytes;
        } catch (Exception error) {
            try { ledger.bytes = disk.size(root); }
            catch (Exception recount) { ledger.bytes = -1; error.addSuppressed(recount); }
            Live cached = live.get(cacheKey(binding, id)); if (cached != null) cached.reloadNeeded = true;
            throw storageFailure(error);
        } finally {
            // PCM replaces its owner's queued reservation with actual ciphertext; it does not reserve the same block twice.
            long growth = ledger.bytes < 0 ? Math.max(0, file.length() + new File(file.getPath() + ".new").length() - previousFileBytes) : Math.max(0, ledger.bytes - previousBytes);
            long consumed = Math.min(credit, growth);
            if (capture != null) { capture.captureReservedBytes -= consumed; ledger.reservations -= consumed; }
            ledger.reservations -= extra;
        }
    }
    private static byte[] aad(String binding, String id, String name) {
        return (KEY_ALIAS + "\n" + binding + "\n" + id + "\n" + name).getBytes(StandardCharsets.UTF_8);
    }
    private void ensureLedger() throws Failure {
        try { if (ledger.bytes < 0) ledger.bytes = disk.size(root); }
        catch (Exception error) { throw storageFailure(error); }
    }
    private void reserve(long bytes, boolean control) throws Exception {
        ensureLedger();
        long maximum = limits.deviceBytes - (control ? 0 : limits.controlReserveBytes);
        if (bytes > maximum - ledger.bytes - ledger.reservations) throw new Failure("dictation_storage_full", false);
        ledger.reservations += bytes;
    }
    private void reserveCapture(Live item) throws Exception {
        reserve(limits.captureReserveBytes, false); item.captureReserved = true; item.captureReservedBytes = limits.captureReserveBytes;
    }
    private void replenishCapture(Live item) throws Exception {
        if (item.drainOnly || item.captureReservedBytes == limits.captureReserveBytes) return;
        long needed = limits.captureReserveBytes - item.captureReservedBytes;
        try { reserve(needed, false); item.captureReservedBytes += needed; }
        catch (Failure error) {
            if (error.code.equals("dictation_storage_full")) item.drainOnly = true;
            throw error;
        }
    }
    private void releaseCapture(Live item) {
        if (item.captureReserved) {
            ledger.reservations -= item.captureReservedBytes; item.captureReservedBytes = 0; item.captureReserved = false;
        }
    }
    private void deleteFile(File file) throws Exception {
        long bytes = file.length();
        try { disk.delete(file); if (ledger.bytes >= 0) ledger.bytes -= bytes; }
        catch (Exception error) { ledger.bytes = -1; throw storageFailure(error); }
    }
    private void deleteTree(File file) throws Exception {
        try {
            if (file.isDirectory()) {
                List<File> children = sortedChildren(file);
                // Terminal and initialization proofs outlive every content file even when cleanup is interrupted.
                children.sort(Comparator.comparing(child -> child.getName().equals("terminal.enc") || child.getName().equals("creating.enc") ? 1 : 0));
                for (File child : children) deleteTree(child);
                disk.delete(file);
            } else deleteFile(file);
        } catch (Exception error) { ledger.bytes = -1; throw storageFailure(error); }
    }
    private List<File> sortedChildren(File directory) throws Exception {
        try { List<File> files = new ArrayList<>(Arrays.asList(disk.list(directory))); files.sort(Comparator.comparing(File::getName)); return files; }
        catch (Exception error) { throw storageFailure(error); }
    }
    private File bindingDirectory(String binding) throws Exception { return new File(new File(root, digest(profile(binding))), digest(binding)); }
    private File directory(String binding, String id) throws Exception { return new File(bindingDirectory(binding), id); }
    private File recordFile(String binding, String id, String name) throws Exception { return new File(directory(binding, id), name + ".enc"); }
    private static String cacheKey(String binding, String id) { return binding + "\n" + id; }
    private static String profile(String binding) {
        if (binding == null) throw new IllegalArgumentException("dictation_binding_invalid");
        String[] pieces = binding.split("\n", -1);
        if (pieces.length != 3 || !isId(pieces[0]) || !pieces[2].matches("[0-9a-f]{64}") ||
            !NativeVoiceSettings.origin(pieces[1]).equals(pieces[1])) throw new IllegalArgumentException("dictation_binding_invalid");
        return pieces[0];
    }
    private void checkOwner(String binding) {
        ensureOpen(); if (removedProfiles.contains(profile(binding))) throw new IllegalStateException("dictation_stale");
    }
    private void ensureOpen() { if (closed) throw new IllegalStateException("dictation_store_closed"); }
    private long generation(String profile) { return profileGenerations.getOrDefault(profile, 0L); }
    private static boolean isId(String id) { return id != null && id.matches("[A-Za-z0-9._:-]{1,160}") && !id.equals(".") && !id.equals(".."); }
    private static void validId(String id) { if (!isId(id)) throw new IllegalArgumentException("dictation_identity_invalid"); }
    private static void validProfile(String id) { validId(id); }
    private static void validTarget(String id, String title) {
        if (id == null || id.isEmpty() || id.length() > 160 || title != null && (title.isEmpty() || title.length() > 512))
            throw new IllegalArgumentException("dictation_target_invalid");
    }
    private static void validReason(String reason) {
        if (reason == null || !reason.matches("[a-z][a-z0-9_]{0,95}")) throw new IllegalArgumentException("dictation_reason_invalid");
    }
    private static void exactKeys(JSONObject value, String... fields) {
        NativeVoiceJson.keys(value, fields);
        if (value.length() != fields.length) throw new IllegalArgumentException("dictation_record_invalid");
    }
    private static String nullable(JSONObject value, String name) { return NativeVoiceJson.nullableString(value, name, 4096); }
    private static void validateConfig(JSONObject value) {
        if (value == null) throw new IllegalArgumentException("dictation_config_invalid");
        exactKeys(value, CONFIG_FIELDS);
        for (String field : CONFIG_FIELDS) if (!value.has(field)) throw new IllegalArgumentException("dictation_config_invalid");
        String provider = NativeVoiceJson.string(value, "speechProvider", 16);
        if (!provider.equals("openai") && !provider.equals("server")) throw new IllegalArgumentException("dictation_config_invalid");
        String endpoint = NativeVoiceJson.string(value, "speechEndpoint", 2048);
        if (!endpoint.equals(NativeVoiceSettings.speechBaseUrl(endpoint)) ||
            provider.equals("openai") && !endpoint.equals(NativeVoiceSettings.OPENAI_ENDPOINT)) throw new IllegalArgumentException("dictation_config_invalid");
        String model = NativeVoiceJson.string(value, "sttModel", 160);
        if (!model.equals(model.trim()) || model.chars().anyMatch(Character::isISOControl)) throw new IllegalArgumentException("dictation_config_invalid");
        NativeVoiceJson.nullableString(value, "inputDeviceId", 80);
        for (String field : new String[] { "recognitionStartTimeoutMs", "recognitionCompletionTimeoutMs", "recognitionResultTimeoutMs" })
            NativeVoiceJson.integer(value, field, 1000, 300000);
        NativeVoiceJson.integer(value, "recognitionEndSilenceMs", 100, 30000);
        if (NativeVoiceJson.integer(value, "longDictationTimeoutMs", 60000, 86400000) % 60000 != 0) throw new IllegalArgumentException("dictation_config_invalid");
        NativeVoiceJson.integer(value, "cueGain", 0, 200);
        for (String field : new String[] { "recognizeStopCommand", "recognitionCues", "followComposerMode" }) NativeVoiceJson.bool(value, field);
    }
    private static void validatePreference(JSONObject value) {
        if (value == null) throw new IllegalArgumentException("dictation_preference_invalid");
        exactKeys(value, "mode", "originClientId");
        String mode = NativeVoiceJson.string(value, "mode", 16);
        if (!mode.equals("queue") && !mode.equals("steer")) throw new IllegalArgumentException("dictation_preference_invalid");
        NativeVoiceJson.string(value, "originClientId", 160);
    }
    private static void validateFinalRequest(Live item, JSONObject request) throws Exception {
        JSONObject manifest = item.manifest, preference = manifest.optJSONObject("preference");
        if (request == null || !isComplete(item, manifest) || preference == null || NativeVoiceJson.bytes(item.text) > MAX_TEXT_BYTES || trimTranscript(item.text).isEmpty() ||
            manifest.optBoolean("captureIncomplete") && !manifest.optBoolean("incompleteAccepted")) throw new IllegalStateException("dictation_not_deliverable");
        exactKeys(request, "mutationId", "text", "origin", "runningPolicy");
        if (!manifest.optString("mutationId").equals(NativeVoiceJson.string(request, "mutationId", 160)) ||
            !item.text.equals(NativeVoiceJson.string(request, "text", MAX_TEXT_BYTES)))
            throw new IllegalArgumentException("dictation_request_invalid");
        JSONObject origin = NativeVoiceJson.requiredObject(request, "origin"); exactKeys(origin, "clientId");
        if (!preference.optString("originClientId").equals(NativeVoiceJson.string(origin, "clientId", 160))) throw new IllegalArgumentException("dictation_request_invalid");
        JSONObject policy = NativeVoiceJson.requiredObject(request, "runningPolicy"); String mode = NativeVoiceJson.string(policy, "mode", 16);
        if (mode.equals("queue")) exactKeys(policy, "mode");
        else if (mode.equals("steer") && preference.optString("mode").equals("steer")) {
            exactKeys(policy, "mode", "target", "onUnavailable"); NativeVoiceJson.requiredObject(policy, "target");
            if (!policy.optString("onUnavailable").equals("queue")) throw new IllegalArgumentException("dictation_request_invalid");
        } else throw new IllegalArgumentException("dictation_request_invalid");
        if (NativeVoiceJson.bytes(request.toString()) > MAX_REQUEST_BYTES) throw new Failure("dictation_storage_capacity", false);
    }
    /** ECMAScript String.trim whitespace, shared with the server admission contract. */
    static String trimTranscript(String text) {
        int start = 0, end = text.length();
        while (start < end && transcriptWhitespace(text.charAt(start))) start++;
        while (end > start && transcriptWhitespace(text.charAt(end - 1))) end--;
        return text.substring(start, end);
    }
    private static boolean transcriptWhitespace(char c) {
        return c >= 0x09 && c <= 0x0d || c == 0x20 || c == 0xa0 || c == 0x1680 || c >= 0x2000 && c <= 0x200a ||
            c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
    }
    private static byte[] utf8(String text) throws Exception {
        try {
            ByteBuffer encoded = StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).encode(java.nio.CharBuffer.wrap(text));
            byte[] result = new byte[encoded.remaining()]; encoded.get(result); return result;
        } catch (CharacterCodingException error) { throw new IllegalArgumentException("dictation_text_invalid", error); }
    }
    private static String decodeUtf8(byte[] bytes) throws Failure {
        try { return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString(); }
        catch (CharacterCodingException error) { throw new Failure("dictation_storage_corrupt", true, error); }
    }
    static boolean sameJson(JSONObject first, JSONObject second) { return first != null && second != null && canonical(first).equals(canonical(second)); }
    private static String canonical(Object value) {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value; List<String> names = new ArrayList<>();
            Iterator<String> iterator = object.keys(); while (iterator.hasNext()) names.add(iterator.next()); Collections.sort(names);
            StringBuilder text = new StringBuilder("{");
            for (String name : names) { if (text.length() > 1) text.append(','); text.append(JSONObject.quote(name)).append(':').append(canonical(object.opt(name))); }
            return text.append('}').toString();
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value; StringBuilder text = new StringBuilder("[");
            for (int index = 0; index < array.length(); index++) { if (index > 0) text.append(','); text.append(canonical(array.opt(index))); }
            return text.append(']').toString();
        }
        return value instanceof String ? JSONObject.quote((String) value) : String.valueOf(value);
    }
    private static String digest(String value) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)))
            result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }
    private static Failure storageFailure(Exception error) {
        return error instanceof Failure ? (Failure) error : new Failure("dictation_storage_unavailable", false, error);
    }
    private static SecretKey key() throws Exception {
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
        if (!keys.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
            generator.generateKey();
        }
        return (SecretKey) keys.getKey(KEY_ALIAS, null);
    }
}
