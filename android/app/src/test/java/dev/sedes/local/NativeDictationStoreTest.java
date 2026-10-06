package dev.sedes.local;

import static org.junit.Assert.*;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;
import javax.crypto.SecretKey;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** Exercises real AES-GCM files, replacement boundaries, and recovery rather than an in-memory journal fake. */
public class NativeDictationStoreTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private File root;
    private SecretKey key;
    private static final String BINDING = "profile\nhttps://sedes.example\n" + "a".repeat(64);
    private static final String OTHER = "profile\nhttps://other.example\n" + "a".repeat(64);
    private static final String[] FIELDS = { "speechProvider", "speechEndpoint", "sttModel", "inputDevice", "recognitionStartTimeoutMs",
        "recognitionCompletionTimeoutMs", "recognitionEndSilenceMs", "recognitionResultTimeoutMs", "longDictationTimeoutMs",
        "recognizeStopCommand", "recognitionCues", "cueGain", "followComposerMode" };

    @Before public void setup() throws Exception {
        root = temporary.newFolder("dictation"); javax.crypto.KeyGenerator generator = javax.crypto.KeyGenerator.getInstance("AES");
        generator.init(256); key = generator.generateKey();
    }
    private JSONObject config() {
        JSONObject defaults = NativeVoiceSettings.defaults().value, result = new JSONObject();
        for (String field : FIELDS) NativeVoiceJson.put(result, field, defaults.opt(field));
        return result;
    }
    private NativeDictationStore.Limits limits(long pending, int segments, long device) {
        return new NativeDictationStore.Limits(pending, segments, device, 8, 2048, 64);
    }
    private NativeDictationStore open() { return open(new NativeDictationStore.Disk(), limits(1024, 128, 4 * 1024 * 1024)); }
    private NativeDictationStore open(NativeDictationStore.Disk disk, NativeDictationStore.Limits limits) {
        return new NativeDictationStore(root, () -> key, disk, limits);
    }
    private NativeDictationStore.Journal create(NativeDictationStore store, String id) throws Exception {
        return store.create(BINDING, id, "target", "Private target title", config());
    }
    private List<File> files() throws Exception {
        try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(root.toPath())) {
            return paths.filter(Files::isRegularFile).map(java.nio.file.Path::toFile).collect(Collectors.toList());
        }
    }
    private File file(String name) throws Exception {
        return files().stream().filter(value -> value.getName().equals(name)).findFirst().orElseThrow();
    }
    private static byte[] pcm(int size) { byte[] value = new byte[size]; for (int i = 0; i < size; i++) value[i] = (byte) (i + 1); return value; }
    private static final class FaultDisk extends NativeDictationStore.Disk {
        String phase, name;
        void arm(String phase, String name) { this.phase = phase; this.name = name; }
        @Override void fault(String phase, File file) throws IOException {
            if (phase.equals(this.phase) && file.getName().equals(name)) { this.phase = null; throw new IOException("injected_storage_boundary"); }
        }
    }
    private static void failure(String code, Throwing action) throws Exception {
        try { action.run(); fail("Expected " + code); }
        catch (NativeDictationStore.Failure error) { assertEquals(code, error.code); }
    }
    private interface Throwing { void run() throws Exception; }
    private void completedSegment(NativeDictationStore.Journal journal, int ordinal, String text) throws Exception {
        journal.append(ordinal, pcm(2)); journal.checkpoint(); journal.seal(ordinal, ordinal, ordinal + 1, 0);
        journal.commitStarted(ordinal, "attempt" + ordinal); journal.committed(ordinal, "attempt" + ordinal, "item" + ordinal);
        journal.complete(ordinal, text);
    }

    @Test public void obsoleteManifestKeepsEncryptedFilesButCannotBeRetriedOrSent() throws Exception {
        String id = "obsolete";
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, id); journal.adopt(true); completedSegment(journal, 0, "Saved words");
            journal.finish("send", 1);
            java.lang.reflect.Method read = NativeDictationStore.class.getDeclaredMethod("readJson", String.class, String.class, String.class, int.class);
            read.setAccessible(true);
            JSONObject manifest = (JSONObject) read.invoke(store, BINDING, id, "manifest", 2 * 1024 * 1024);
            NativeVoiceJson.put(manifest, "version", 1);
            JSONObject config = manifest.getJSONObject("config"); config.remove("inputDevice"); NativeVoiceJson.put(config, "inputDeviceId", "42");
            java.lang.reflect.Method write = NativeDictationStore.class.getDeclaredMethod("writeRecord", String.class, String.class, String.class, byte[].class, boolean.class);
            write.setAccessible(true); write.invoke(store, BINDING, id, "manifest", manifest.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8), true);
        }
        List<File> preserved = files();
        java.util.Map<String, byte[]> content = new java.util.HashMap<>();
        for (File file : preserved) { byte[] bytes = Files.readAllBytes(file.toPath()); assertEquals(1, bytes[0]); content.put(file.getPath(), bytes); }
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Recording recording = store.recover(BINDING);
            assertEquals("unavailable", recording.stage); assertTrue(recording.adopted); assertEquals("", recording.text);
            assertTrue(recording.config.length() == 0); assertNull(recording.request); assertFalse(recording.complete());
            assertEquals(preserved, files());
            for (File file : preserved) assertArrayEquals(content.get(file.getPath()), Files.readAllBytes(file.toPath()));
        }
    }

    @Test public void transcriptTrimsExactlyEcmaWhitespaceAndPreservesNonWhitespaceControls() throws Exception {
        String nul = Character.toString((char) 0);
        assertEquals("", NativeDictationStore.trimTranscript("\u00a0\ufeff\u2028\u3000"));
        assertEquals(nul + " text " + nul, NativeDictationStore.trimTranscript("\u00a0" + nul + " text " + nul + "\ufeff"));
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "whitespace"); journal.adopt(true);
            completedSegment(journal, 0, "\u00a0\ufeff" + nul + "hello\u00a0\ufeff");
            completedSegment(journal, 1, "\ufeffworld\u00a0");
            assertEquals(nul + "hello world", journal.load().text);
        }
    }

    @Test public void restartReleasesAuthenticatedEmptyStartupButKeepsAudioTextAndUnreadableRecords() throws Exception {
        for (String content : new String[] { "empty", "audio", "text", "unreadable" }) {
            root = temporary.newFolder("startup-" + content);
            try (NativeDictationStore store = open()) {
                NativeDictationStore.Journal journal = create(store, "startup"); journal.adopt(true);
                if (content.equals("audio")) { journal.append(0, pcm(2)); journal.checkpoint(); }
                if (content.equals("text")) completedSegment(journal, 0, "Saved words");
                assertNotNull("Read-only bootstrap cannot delete a live cached startup", store.recover(BINDING));
            }
            if (content.equals("unreadable")) {
                File manifest = file("manifest.enc"); byte[] bytes = Files.readAllBytes(manifest.toPath()); bytes[bytes.length - 1] ^= 1;
                Files.write(manifest.toPath(), bytes);
            }
            try (NativeDictationStore store = open()) {
                NativeDictationStore.Recording recovered = store.recover(BINDING);
                if (content.equals("empty")) { assertNull(recovered); assertTrue(files().isEmpty()); }
                else {
                    assertNotNull(recovered);
                    if (content.equals("unreadable")) assertEquals("unavailable", recovered.stage);
                    else { assertEquals(1, recovered.durableSamples); if (content.equals("text")) assertEquals("Saved words", recovered.text); }
                    assertFalse(files().isEmpty());
                }
            }
        }
    }

    @Test public void failedFlushClearsEmptyRecordingButPreservesPriorDurableAudioAndText() throws Exception {
        for (String content : new String[] { "empty", "audio", "text" }) {
            root = temporary.newFolder("failed-flush-" + content); AtomicBoolean failing = new AtomicBoolean();
            NativeDictationStore.Disk disk = new NativeDictationStore.Disk() {
                @Override void fault(String phase, File file) throws IOException {
                    if (failing.get() && phase.equals("before_write") && file.getName().startsWith("pcm-")) throw new IOException("audio_write_failed");
                }
            };
            try (NativeDictationStore store = open(disk, limits(1024, 128, 4 * 1024 * 1024))) {
                NativeDictationStore.Journal journal = create(store, "captured"); journal.adopt(true);
                if (content.equals("audio")) { journal.append(0, pcm(2)); journal.checkpoint(); }
                if (content.equals("text")) completedSegment(journal, 0, "Saved words");
                long durable = journal.load().durableSamples; failing.set(true); journal.append(durable, pcm(2));
                failure("dictation_storage_unavailable", journal::checkpoint);
                journal.interrupt("dictation_storage_unavailable");
                NativeDictationStore.Recording settled = store.settleInterruption(BINDING, "captured");
                if (content.equals("empty")) { assertNull(settled); assertTrue(files().isEmpty()); }
                else { assertNotNull(settled); assertEquals(1, settled.durableSamples); assertEquals(content.equals("text") ? "Saved words" : "", settled.text); }
                assertTrue(store.pendingRetirements(BINDING).isEmpty()); assertEquals(0, reserved(store));
            }
            try (NativeDictationStore store = open()) {
                NativeDictationStore.Recording restored = store.recover(BINDING);
                if (content.equals("empty")) assertNull(restored);
                else { assertNotNull(restored); assertEquals(1, restored.durableSamples); assertEquals(content.equals("text") ? "Saved words" : "", restored.text); }
            }
        }
    }

    @Test public void neverCapturedStartupSettlementDoesNotNeedAnInterruptionWrite() throws Exception {
        FaultDisk disk = new FaultDisk();
        try (NativeDictationStore store = open(disk, limits(1024, 128, 4 * 1024 * 1024))) {
            create(store, "startup").adopt(true); assertTrue(reserved(store) > 0);
            disk.arm("before_write", "manifest.enc");
            assertNull(store.settleInterruption(BINDING, "startup")); assertTrue(files().isEmpty()); assertEquals(0, reserved(store));
            assertEquals("Settlement must not write an unused interruption", "before_write", disk.phase);
        }
    }

    @Test public void settlementReloadFailureKeepsStoppedClassificationAndRetainedWork() throws Exception {
        for (String content : new String[] { "empty", "audio", "text", "tail", "unreadable" }) {
            root = temporary.newFolder("settle-reload-" + content);
            java.util.ArrayDeque<String> faults = new java.util.ArrayDeque<>();
            NativeDictationStore.Disk disk = new NativeDictationStore.Disk() {
                @Override void fault(String phase, File file) throws IOException {
                    if ((phase + ":" + file.getName()).equals(faults.peek())) { faults.remove(); throw new IOException("injected_settlement_fault"); }
                }
            };
            try (NativeDictationStore store = open(disk, limits(1024, 128, 4 * 1024 * 1024))) {
                NativeDictationStore.Journal journal = create(store, "stopped"); journal.adopt(true);
                if (content.equals("audio")) { journal.append(0, pcm(2)); journal.checkpoint(); }
                if (content.equals("text")) completedSegment(journal, 0, "Saved words");
                if (content.equals("tail")) { journal.append(0, pcm(2)); faults.add("before_write:pcm-0.enc"); }
                faults.add("before_write:manifest.enc"); faults.add("before_read:manifest.enc");
                failure("dictation_storage_unavailable", () -> journal.interrupt("voice_off"));
                failure("dictation_storage_unavailable", () -> store.settleInterruption(BINDING, "stopped"));
                assertTrue(faults.isEmpty()); assertEquals(0, reserved(store));
                // A second control failure after reload must preserve the stopped marker on the replacement Live.
                faults.add("before_write:manifest.enc");
                assertEquals("unavailable", store.recover(BINDING).stage);
                if (content.equals("unreadable")) {
                    File manifest = file("manifest.enc"); byte[] bytes = Files.readAllBytes(manifest.toPath()); bytes[bytes.length - 1] ^= 1;
                    Files.write(manifest.toPath(), bytes);
                }
                NativeDictationStore.Recording restored = store.recover(BINDING);
                if (content.equals("empty")) { assertNull(restored); assertTrue(files().isEmpty()); }
                else if (content.equals("unreadable")) { assertNotNull(restored); assertEquals("unavailable", restored.stage); assertFalse(files().isEmpty()); }
                else {
                    assertNotNull(restored); assertEquals(1, restored.durableSamples); assertEquals(1, restored.endSample);
                    assertEquals(content.equals("text") ? "Saved words" : "", restored.text);
                    if (!content.equals("text")) assertArrayEquals(pcm(2), store.journal(BINDING, "stopped").read(0, 2));
                }
                assertEquals(0, reserved(store));
            }
            try (NativeDictationStore store = open()) {
                NativeDictationStore.Recording restored = store.recover(BINDING);
                if (content.equals("empty")) assertNull(restored);
                else if (content.equals("unreadable")) assertEquals("unavailable", restored.stage);
                else { assertNotNull(restored); assertEquals(1, restored.durableSamples); assertEquals(content.equals("text") ? "Saved words" : "", restored.text); }
            }
        }
    }

    @Test public void emptyCleanupFailureNeverPublishesATerminalDraftAsUnavailable() throws Exception {
        for (boolean bootstrap : new boolean[] { false, true }) for (boolean beforeMarker : new boolean[] { false, true }) {
            root = temporary.newFolder("empty-cleanup-" + bootstrap + "-" + beforeMarker);
            try (NativeDictationStore store = open()) { create(store, "startup").adopt(true); }
            FaultDisk disk = new FaultDisk(); disk.arm(beforeMarker ? "before_write" : "before_delete", beforeMarker ? "terminal.enc" : "manifest.enc");
            try (NativeDictationStore store = open(disk, limits(1024, 128, 4 * 1024 * 1024))) {
                failure("dictation_storage_unavailable", () -> { if (bootstrap) store.recover(BINDING); else store.settleInterruption(BINDING, "startup"); });
                assertEquals(beforeMarker ? 0 : 1, store.pendingRetirements(BINDING).size());
                assertNull(store.recover(BINDING)); assertTrue(files().isEmpty());
            }
        }
    }

    @Test public void authenticatedBlocksRecoverOnlyCheckpointedSamplesAndNeverStorePlaintext() throws Exception {
        byte[] pcm = pcm(12);
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "saved"); journal.adopt(true); journal.append(0, pcm);
            assertEquals(6, journal.load().acceptedSamples); assertEquals(4, journal.load().durableSamples);
            assertArrayEquals(Arrays.copyOf(pcm, 8), journal.read(0, 8));
            for (File file : files()) {
                byte[] bytes = Files.readAllBytes(file.toPath()); assertEquals(1, bytes[0]);
                String raw = new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
                assertFalse(raw.contains("Private target")); assertFalse(raw.contains("speechEndpoint"));
            }
        }
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Recording recovered = store.recover(BINDING);
            assertEquals(4, recovered.durableSamples); assertEquals(4, recovered.endSample);
            assertEquals("interrupted", recovered.stage); assertTrue(recovered.captureIncomplete); assertFalse(recovered.keepListening);
            assertArrayEquals(Arrays.copyOf(pcm, 8), store.journal(BINDING, "saved").read(0, 8));
        }
    }

    @Test public void partialCheckpointsRemainContiguousAndCrossingBlocksRetainTheirSuffix() throws Exception {
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "partial"); journal.adopt(true);
            journal.append(0, pcm(6)); journal.checkpoint(); journal.append(3, new byte[] {7,8,9,10,11,12}); journal.checkpoint();
            journal.seal(0, 0, 4, 0); journal.complete(0, " first ");
            assertFalse(files().stream().anyMatch(file -> file.getName().equals("pcm-0.enc")));
            assertTrue(files().stream().anyMatch(file -> file.getName().equals("pcm-1.enc")));
            assertArrayEquals(new byte[] {9,10,11,12}, journal.read(4, 8));
            journal.seal(1, 4, 6, 100); journal.finish("send", 6); journal.complete(1, " second ");
            assertEquals("first second", journal.load().text); assertTrue(journal.load().complete());
            assertFalse(files().stream().anyMatch(file -> file.getName().startsWith("pcm-")));
        }
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Recording record = store.recover(BINDING);
            assertEquals("first second", record.text); assertTrue(record.complete()); assertEquals("send", record.reason);
        }
    }

    @Test public void ordinaryAttemptsDoNotBecomeRecoverySlotsAndCachedOrdinaryCaptureSurvivesRefresh() throws Exception {
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal saved = create(store, "saved"); saved.adopt(true); saved.append(0, pcm(2)); saved.interrupt("disconnected");
            NativeDictationStore.Journal ordinary = create(store, "ordinary"); ordinary.append(0, pcm(8));
            assertEquals("saved", store.recover(BINDING).id); assertEquals(4, ordinary.load().durableSamples);
        }
        try (NativeDictationStore store = open()) {
            assertEquals("saved", store.recover(BINDING).id);
            assertFalse(files().stream().anyMatch(file -> file.getParentFile().getName().equals("ordinary")));
        }
    }

    @Test public void ordinaryHandedOffCleanupNeverCreatesAdmissionRetirementAuthority() throws Exception {
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "ordinary_sent"); completedSegment(journal, 0, "sent ordinary input");
            journal.finish("send", 1); store.finishIntent(BINDING, "ordinary_sent", "mutation", preference());
            store.saveFinalRequest(BINDING, "ordinary_sent", request("sent ordinary input")); store.markHandedOff(BINDING, "ordinary_sent");
            assertFalse(journal.load().adopted);
        }
        for (int restart = 0; restart < 2; restart++) {
            try (NativeDictationStore store = open()) {
                assertTrue(store.pendingRetirements(BINDING).isEmpty()); assertNull(store.recover(BINDING));
                assertTrue(store.pendingRetirements(BINDING).isEmpty()); assertTrue(files().isEmpty());
            }
        }
    }

    @Test public void checkpointBeforeReplacementKeepsOldBoundaryAndReclaimsUnacknowledgedBlock() throws Exception {
        checkpointCrash("after_write", 0);
    }
    @Test public void checkpointAfterReplacementRecoversNewBoundaryWithoutAcknowledgement() throws Exception {
        checkpointCrash("after_replace", 4);
    }
    private void checkpointCrash(String phase, int samples) throws Exception {
        FaultDisk disk = new FaultDisk();
        try (NativeDictationStore store = open(disk, limits(1024, 128, 4 * 1024 * 1024))) {
            NativeDictationStore.Journal journal = create(store, "crash"); journal.adopt(true); disk.arm(phase, "checkpoint.enc");
            failure("dictation_storage_unavailable", () -> journal.append(0, pcm(8)));
        }
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Recording record = store.recover(BINDING);
            if (samples == 0) { assertNull(record); assertTrue(files().isEmpty()); }
            else { assertEquals(samples, record.durableSamples); assertEquals(samples, record.endSample); assertTrue(record.captureIncomplete); }
        }
    }

    @Test public void transcriptBeforeManifestLinkKeepsAudioAndDropsOnlyUnlinkedPrefix() throws Exception {
        prefixCrash("before_write", false);
    }
    @Test public void transcriptAfterManifestLinkSurvivesMissingAcknowledgementAndReclaimsAudio() throws Exception {
        prefixCrash("after_replace", true);
    }
    private void prefixCrash(String phase, boolean linked) throws Exception {
        FaultDisk disk = new FaultDisk();
        try (NativeDictationStore store = open(disk, limits(1024, 128, 4 * 1024 * 1024))) {
            NativeDictationStore.Journal journal = create(store, "prefix"); journal.adopt(true); journal.append(0, pcm(8));
            journal.seal(0, 0, 4, 0); journal.finish("send", 4); disk.arm(phase, "manifest.enc");
            failure("dictation_storage_unavailable", () -> journal.complete(0, "durable transcript"));
        }
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Recording record = store.recover(BINDING);
            assertEquals(linked ? "durable transcript" : "", record.text);
            assertEquals(linked, record.complete()); assertEquals(linked ? 0 : 1, record.segments.size());
            assertEquals(!linked, files().stream().anyMatch(file -> file.getName().startsWith("pcm-")));
        }
    }

    @Test public void missingOrTamperedPcmIsUnavailableAndKeepsReadableText() throws Exception {
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "damaged"); journal.adopt(true); completedSegment(journal, 0, "safe prefix");
            journal.append(1, pcm(8));
        }
        File block = file("pcm-1.enc"); byte[] bytes = Files.readAllBytes(block.toPath()); bytes[bytes.length - 1] ^= 1; Files.write(block.toPath(), bytes);
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Recording record = store.recover(BINDING);
            assertEquals("unavailable", record.stage); assertEquals("dictation_storage_corrupt", record.reason);
            assertEquals("safe prefix", record.text); assertEquals("safe prefix", store.transcript(BINDING, "damaged")); assertTrue(block.exists());
        }
        Files.delete(block.toPath());
        try (NativeDictationStore store = open()) { assertEquals("unavailable", store.recover(BINDING).stage); }
    }

    @Test public void corruptPrefixCannotBeCopiedEvenIfACachedSnapshotPreviouslyReadIt() throws Exception {
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "prefix_copy"); journal.adopt(true); completedSegment(journal, 0, "safe prefix");
            assertEquals("safe prefix", store.transcript(BINDING, "prefix_copy"));
            File prefix = file("prefix-1.enc"); byte[] bytes = Files.readAllBytes(prefix.toPath()); bytes[bytes.length - 1] ^= 1;
            Files.write(prefix.toPath(), bytes);
            failure("dictation_storage_corrupt", () -> store.transcript(BINDING, "prefix_copy")); assertTrue(prefix.exists());
        }
    }

    @Test public void transientKeyFailureKeepsFilesAndLaterRetryRecovers() throws Exception {
        try (NativeDictationStore store = open()) { NativeDictationStore.Journal journal = create(store, "locked"); journal.adopt(true); completedSegment(journal, 0, "Saved words"); }
        List<File> before = files(); AtomicBoolean unavailable = new AtomicBoolean(true);
        try (NativeDictationStore store = new NativeDictationStore(root, () -> {
            if (unavailable.get()) throw new java.security.InvalidKeyException("temporarily busy"); return key;
        }, new NativeDictationStore.Disk(), limits(1024, 128, 4 * 1024 * 1024))) {
            assertEquals("dictation_storage_unavailable", store.recover(BINDING).reason);
            assertEquals(before, files()); unavailable.set(false); assertEquals("ready", store.recover(BINDING).stage);
        }
    }

    @Test public void ciphertextCopiedBetweenBindingsCannotAuthenticate() throws Exception {
        File source;
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "owner"); journal.adopt(true); completedSegment(journal, 0, "Owner words"); source = file("manifest.enc");
            store.create(OTHER, "owner", "target", null, config()).adopt(true);
        }
        File destination = files().stream().filter(value -> value.getName().equals("manifest.enc") && !value.equals(source)).findFirst().orElseThrow();
        Files.copy(source.toPath(), destination.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        try (NativeDictationStore store = open()) {
            assertEquals("ready", store.recover(BINDING).stage); assertEquals("unavailable", store.recover(OTHER).stage);
        }
    }

    @Test public void discardTombstoneOutlivesInterruptedCleanupAndPreventsResurrection() throws Exception {
        FaultDisk disk = new FaultDisk();
        try (NativeDictationStore store = open(disk, limits(1024, 128, 4 * 1024 * 1024))) {
            NativeDictationStore.Journal journal = create(store, "discard"); journal.adopt(true); journal.append(0, pcm(8));
            disk.arm("before_delete", "manifest.enc"); failure("dictation_storage_unavailable", journal::discard);
            assertTrue(file("terminal.enc").exists());
        }
        try (NativeDictationStore store = open()) { assertNull(store.recover(BINDING)); assertTrue(files().isEmpty()); }
    }

    @Test public void linkedRetirementRemainsHiddenAcrossBothJournalCleanupCrashBoundaries() throws Exception {
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "retire"); journal.adopt(true); completedSegment(journal, 0, "saved");
            journal.finish("send", 1); store.finishIntent(BINDING, "retire", "mutation", preference());
            store.saveFinalRequest(BINDING, "retire", request("saved")); store.markHandedOff(BINDING, "retire");
            store.beginDiscard(BINDING, "retire", "mutation");
            assertEquals("mutation", store.pendingRetirements(BINDING).get(0).mutationId);
            try { journal.load(); fail("Durable revocation must fence old journal"); }
            catch (IllegalStateException expected) { assertEquals("dictation_discarded", expected.getMessage()); }
        }
        // Crash before the separate admission journal can be removed: no ordinary recovery or owner may reappear.
        try (NativeDictationStore store = open()) {
            assertNull(store.recover(BINDING)); assertNull(store.ownerOfMutation(BINDING, "mutation"));
            assertEquals("retire", store.pendingRetirements(BINDING).get(0).recordingId); assertTrue(file("terminal.enc").exists());
        }
        // A second crash after removal of that journal still leaves a durable, replayable cleanup obligation.
        try (NativeDictationStore store = open()) {
            assertNull(store.recover(BINDING)); assertEquals(1, store.pendingRetirements(BINDING).size());
            store.finishDiscard(BINDING, "retire"); assertTrue(store.pendingRetirements(BINDING).isEmpty()); assertTrue(files().isEmpty());
        }
    }

    @Test public void corruptRetirementKeepsCopyAndExplicitDiscardAvailableWithoutAutomaticDeletion() throws Exception {
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "retire_corrupt"); journal.adopt(true); completedSegment(journal, 0, "safe prefix");
            journal.finish("send", 1); store.finishIntent(BINDING, "retire_corrupt", "mutation", preference());
            store.beginDiscard(BINDING, "retire_corrupt", "mutation");
        }
        File terminal = file("terminal.enc"); byte[] bytes = Files.readAllBytes(terminal.toPath()); bytes[bytes.length - 1] ^= 1;
        Files.write(terminal.toPath(), bytes);
        try (NativeDictationStore store = open()) {
            assertTrue(store.pendingRetirements(BINDING).isEmpty()); assertTrue(terminal.exists());
            NativeDictationStore.Recording record = store.recover(BINDING);
            assertEquals("unavailable", record.stage); assertEquals("mutation", record.mutationId);
            assertEquals("safe prefix", store.transcript(BINDING, record.id)); assertEquals(record.id, store.ownerOfMutation(BINDING, "mutation").id);
            store.beginDiscard(BINDING, record.id, record.mutationId); assertEquals(1, store.pendingRetirements(BINDING).size());
            store.finishDiscard(BINDING, record.id); assertTrue(files().isEmpty());
        }
    }

    @Test public void failedRetirementAcknowledgementStillLeavesTheCommittedMarker() throws Exception {
        FaultDisk disk = new FaultDisk();
        try (NativeDictationStore store = open(disk, limits(1024, 128, 4 * 1024 * 1024))) {
            NativeDictationStore.Journal journal = create(store, "retire_crash"); journal.adopt(true); completedSegment(journal, 0, "saved");
            journal.finish("send", 1); store.finishIntent(BINDING, "retire_crash", "mutation", preference());
            disk.arm("after_replace", "terminal.enc");
            failure("dictation_storage_unavailable", () -> store.beginDiscard(BINDING, "retire_crash", "mutation"));
        }
        try (NativeDictationStore store = open()) {
            assertNull(store.recover(BINDING)); assertEquals("mutation", store.pendingRetirements(BINDING).get(0).mutationId);
            store.finishDiscard(BINDING, "retire_crash"); assertTrue(files().isEmpty());
        }
    }

    @Test public void callerJsonMutationsCannotChangeFrozenConfigurationPreferenceOrRequest() throws Exception {
        try (NativeDictationStore store = open()) {
            JSONObject configuration = config(); String model = configuration.getString("sttModel");
            NativeDictationStore.Journal journal = store.create(BINDING, "detached", "target", null, configuration);
            NativeVoiceJson.put(configuration, "sttModel", "different"); assertEquals(model, journal.load().config.getString("sttModel"));
            journal.adopt(true); completedSegment(journal, 0, "saved"); journal.finish("send", 1);
            JSONObject preference = preference(); store.finishIntent(BINDING, "detached", "mutation", preference);
            NativeVoiceJson.put(preference, "originClientId", "different");
            JSONObject request = request("saved"); store.saveFinalRequest(BINDING, "detached", request);
            NativeVoiceJson.put(request, "text", "different");
            NativeDictationStore.Recording record = journal.load();
            assertEquals("saved", record.request.getString("text")); assertEquals("client", record.preference.getString("originClientId"));
            NativeVoiceJson.put(record.config, "sttModel", "different"); assertEquals(model, journal.load().config.getString("sttModel"));
        }
    }

    @Test public void missingCaptureBoundaryRequiresExplicitAcknowledgementEvenWithExistingIntent() throws Exception {
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "interrupted"); journal.adopt(true); completedSegment(journal, 0, "saved");
            journal.interrupt("recording_interrupted"); store.finishIntent(BINDING, "interrupted", "mutation", preference());
            try { store.saveFinalRequest(BINDING, "interrupted", request("saved")); fail("Intent must not acknowledge an unverified capture end"); }
            catch (IllegalStateException expected) { assertEquals("dictation_not_deliverable", expected.getMessage()); }
            store.finishIntent(BINDING, "interrupted", "mutation", preference());
            try { store.saveFinalRequest(BINDING, "interrupted", request("saved")); fail("Repeated intent must not acknowledge interruption"); }
            catch (IllegalStateException expected) { assertEquals("dictation_not_deliverable", expected.getMessage()); }
        }
        try (NativeDictationStore store = open()) {
            assertTrue(store.get(BINDING, "interrupted").captureIncomplete);
            store.acknowledgeIncomplete(BINDING, "interrupted"); store.saveFinalRequest(BINDING, "interrupted", request("saved"));
            assertEquals("mutation", store.get(BINDING, "interrupted").mutationId);
        }
    }

    @Test public void recognitionInterruptionAfterDurableFinishDoesNotClaimCaptureWasIncomplete() throws Exception {
        for (boolean failureBeforeIntent : new boolean[] {false, true}) {
            String id = failureBeforeIntent ? "before_intent" : "after_intent";
            try (NativeDictationStore store = open()) {
                NativeDictationStore.Journal journal = create(store, id); journal.adopt(true); completedSegment(journal, 0, "saved");
                journal.finish("send", 1);
                if (failureBeforeIntent) journal.interrupt("recognition_failed");
                store.finishIntent(BINDING, id, "mutation", preference());
                if (!failureBeforeIntent) journal.interrupt("recognition_failed");
                assertFalse(journal.load().captureIncomplete); store.saveFinalRequest(BINDING, id, request("saved"));
                store.beginDiscard(BINDING, id, "mutation"); store.finishDiscard(BINDING, id);
            }
        }
    }

    @Test public void authenticatedMutationOwnershipSurvivesUnreadableAudio() throws Exception {
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "owner"); journal.adopt(true); journal.append(0, pcm(8));
            journal.seal(0, 0, 4, 0); journal.finish("send", 4); store.finishIntent(BINDING, "owner", "mutation", preference());
        }
        Files.delete(file("pcm-0.enc").toPath());
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Recording unavailable = store.recover(BINDING);
            assertEquals("unavailable", unavailable.stage); assertEquals("mutation", unavailable.mutationId);
            assertEquals("owner", store.ownerOfMutation(BINDING, "mutation").id);
            store.beginDiscard(BINDING, "owner", unavailable.mutationId); assertEquals("mutation", store.pendingRetirements(BINDING).get(0).mutationId);
            store.finishDiscard(BINDING, "owner"); assertTrue(files().isEmpty());
        }
    }

    @Test public void profileRemovalFencesOldJournalsAndRemovesEveryBinding() throws Exception {
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "first"); journal.adopt(true);
            store.create(OTHER, "second", "target", null, config()).adopt(true); store.removeProfile("profile");
            assertTrue(files().isEmpty());
            try { journal.append(0, pcm(8)); fail("Stale journal must fail"); }
            catch (IllegalStateException expected) { assertEquals("dictation_stale", expected.getMessage()); }
            assertTrue(files().isEmpty());
        }
    }

    @Test public void pendingAudioAndSegmentLimitsNeverDiscardAcceptedWork() throws Exception {
        try (NativeDictationStore store = open(new NativeDictationStore.Disk(), limits(8, 1, 100000))) {
            NativeDictationStore.Journal journal = create(store, "quota"); journal.adopt(true); journal.append(0, pcm(8)); journal.seal(0, 0, 2, 0);
            failure("dictation_audio_capacity", () -> journal.append(4, pcm(2)));
            failure("dictation_segment_capacity", () -> journal.seal(1, 2, 4, 0));
            assertEquals(4, journal.load().acceptedSamples); assertArrayEquals(pcm(8), journal.read(0, 8));
            journal.complete(0, "prefix"); journal.append(4, pcm(2)); journal.checkpoint();
            assertEquals(5, journal.load().durableSamples);
        }
    }

    @Test public void globalReservationsCoverConcurrentStoresAndReleaseAfterClose() throws Exception {
        NativeDictationStore.Limits limits = new NativeDictationStore.Limits(1024, 128, 10000, 8, 2048, 6000);
        try (NativeDictationStore first = open(new NativeDictationStore.Disk(), limits);
             NativeDictationStore second = open(new NativeDictationStore.Disk(), limits)) {
            create(first, "reserved"); failure("dictation_storage_full", () -> create(second, "denied"));
            first.close(); create(second, "allowed"); assertTrue(files().stream().noneMatch(file -> file.getParentFile().getName().equals("denied")));
        }
    }

    @Test public void overflowKeepsCompletePrefixAndCannotProduceFinalRequest() throws Exception {
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "overflow"); journal.adopt(true);
            for (int ordinal = 0; ordinal < 4; ordinal++) completedSegment(journal, ordinal, "x".repeat(65535));
            assertEquals(262143, journal.load().textBytes); completedSegment(journal, 4, "z");
            assertEquals(262145, journal.load().textBytes); assertEquals("overflow", journal.load().stage);
            journal.interrupt("dictation_text_limit"); assertEquals("overflow", journal.load().stage);
            journal.finish("send_interrupted", 5); store.finishIntent(BINDING, "overflow", "mutation", preference());
            try { store.saveFinalRequest(BINDING, "overflow", request(journal.load().text)); fail("Overflow must not send"); }
            catch (IllegalStateException expected) { assertEquals("dictation_not_deliverable", expected.getMessage()); }
        }
        try (NativeDictationStore store = open()) { assertEquals(262145, store.recover(BINDING).textBytes); }
    }

    private static long reserved(NativeDictationStore store) throws Exception {
        java.lang.reflect.Field field = NativeDictationStore.class.getDeclaredField("ledger"); field.setAccessible(true);
        Object ledger = field.get(store); field = ledger.getClass().getDeclaredField("reservations"); field.setAccessible(true);
        return field.getLong(ledger);
    }
    private long initializeQuotaRecording(String id) throws Exception {
        try (NativeDictationStore store = open()) { create(store, id).adopt(true); }
        return new NativeDictationStore.Disk().size(root);
    }

    @Test public void pcmDrawsFromCaptureReservationAndReservedQueueStillDrainsAtTheDataLimit() throws Exception {
        long existing = initializeQuotaRecording("full");
        NativeDictationStore.Limits limits = new NativeDictationStore.Limits(1024, 128, existing + 256 + 4096, 8, 4096, 256);
        try (NativeDictationStore store = open(new NativeDictationStore.Disk(), limits)) {
            NativeDictationStore.Journal journal = store.journal(BINDING, "full");
            // The block is already covered by staging. Only replenishment for continued capture is rejected.
            failure("dictation_storage_full", () -> journal.append(0, pcm(8)));
            assertEquals(4, journal.load().acceptedSamples); assertEquals(4, journal.load().durableSamples);
            assertTrue(reserved(store) < 256);
            journal.append(4, pcm(16));
            assertTrue(new NativeDictationStore.Disk().size(root) + reserved(store) <= limits.deviceBytes);
            NativeDictationStore.Recording stopped = journal.interrupt("dictation_storage_full");
            assertEquals(12, stopped.endSample); assertEquals(12, stopped.durableSamples); assertTrue(stopped.captureIncomplete);
            assertEquals(0, reserved(store)); assertEquals(12, journal.finish("retry", 12).endSample);
            assertArrayEquals(pcm(16), journal.read(4, 16));
        }
        try (NativeDictationStore store = open()) { assertEquals(12, store.recover(BINDING).endSample); }
    }

    @Test public void uncheckpointedBlockReplacementReservesItsDuplicateSeparatelyFromQueuedPcm() throws Exception {
        long existing = initializeQuotaRecording("replacement");
        NativeDictationStore.Limits limits = new NativeDictationStore.Limits(1024, 128, existing + 128 + 4096, 8, 4096, 128);
        final NativeDictationStore[] owner = new NativeDictationStore[1]; AtomicBoolean failedCheckpoint = new AtomicBoolean(), checkedReplacement = new AtomicBoolean();
        NativeDictationStore.Disk disk = new NativeDictationStore.Disk() {
            @Override void fault(String phase, File file) throws IOException {
                if (phase.equals("before_write") && file.getName().equals("checkpoint.enc") && failedCheckpoint.compareAndSet(false, true))
                    throw new IOException("checkpoint failed");
                if (phase.equals("after_write") && file.getName().equals("pcm-0.enc") && file.exists()) {
                    try {
                        java.lang.reflect.Field ledgerField = NativeDictationStore.class.getDeclaredField("ledger"); ledgerField.setAccessible(true);
                        Object ledger = ledgerField.get(owner[0]); java.lang.reflect.Field sizeField = ledger.getClass().getDeclaredField("bytes"); sizeField.setAccessible(true);
                        long tracked = sizeField.getLong(ledger) + reserved(owner[0]);
                        // Seventy-one reserved bytes still belong to queued/unfinished PCM after the first 57-byte file.
                        assertTrue(tracked >= size(root) + 71); assertTrue(tracked <= limits.deviceBytes); checkedReplacement.set(true);
                    } catch (ReflectiveOperationException error) { throw new IOException(error); }
                    catch (Exception error) { throw new IOException(error); }
                }
            }
        };
        try (NativeDictationStore store = open(disk, limits)) {
            owner[0] = store; NativeDictationStore.Journal journal = store.journal(BINDING, "replacement");
            failure("dictation_storage_unavailable", () -> journal.append(0, pcm(8)));
            assertEquals(4, journal.load().acceptedSamples); assertEquals(0, journal.load().durableSamples);
            failure("dictation_storage_full", () -> journal.append(4, pcm(8)));
            journal.append(4, pcm(8));
            assertTrue(checkedReplacement.get()); assertEquals(8, journal.interrupt("dictation_storage_full").endSample);
            assertEquals(0, reserved(store)); assertArrayEquals(pcm(8), journal.read(0, 8)); assertArrayEquals(pcm(8), journal.read(4, 8));
        }
    }

    @Test public void failedTailFlushStillPersistsTheDurableEndWithoutLeakingReservationOrRetryTail() throws Exception {
        long existing = initializeQuotaRecording("tail_full");
        NativeDictationStore.Limits limits = new NativeDictationStore.Limits(1024, 128, existing + 128 + 4096, 8, 4096, 128);
        try (NativeDictationStore store = open(new NativeDictationStore.Disk(), limits)) {
            NativeDictationStore.Journal journal = store.journal(BINDING, "tail_full");
            failure("dictation_storage_full", () -> journal.append(0, pcm(8)));
            failure("dictation_storage_full", () -> journal.append(4, pcm(16)));
            assertEquals(12, journal.load().acceptedSamples); assertEquals(8, journal.load().durableSamples);
            NativeDictationStore.Recording stopped = journal.interrupt("dictation_storage_full");
            assertEquals(8, stopped.endSample); assertEquals(8, stopped.acceptedSamples); assertTrue(stopped.captureIncomplete);
            assertEquals(0, reserved(store)); assertEquals(8, journal.finish("retry", 8).durableSamples);
            assertTrue(new NativeDictationStore.Disk().size(root) <= limits.deviceBytes);
        }
        try (NativeDictationStore store = open()) { assertEquals(8, store.recover(BINDING).endSample); }
    }

    @Test public void interruptionControlFailureReleasesReservationAndCachedRecoveryRetriesTheBoundary() throws Exception {
        FaultDisk disk = new FaultDisk();
        try (NativeDictationStore store = open(disk, limits(1024, 128, 100000))) {
            NativeDictationStore.Journal journal = create(store, "control_full"); journal.adopt(true); journal.append(0, pcm(4));
            disk.arm("before_write", "manifest.enc"); failure("dictation_storage_unavailable", () -> journal.interrupt("recognition_failed"));
            assertEquals(0, reserved(store));
            NativeDictationStore.Recording recovered = store.recover(BINDING);
            assertEquals(2, recovered.endSample); assertEquals("interrupted", recovered.stage); assertTrue(recovered.captureIncomplete);
            assertEquals(0, reserved(store));
        }
    }

    @Test public void failedControlWritesPreserveTailAndReloadOnlyAuthoritativeMetadata() throws Exception {
        for (String phase : new String[] {"before_write", "after_replace"}) {
            FaultDisk disk = new FaultDisk(); String id = "control_" + phase;
            try (NativeDictationStore store = open(disk, limits(1024, 128, 100000))) {
                NativeDictationStore.Journal journal = create(store, id); journal.adopt(true); journal.append(0, pcm(4));
                disk.arm(phase, "manifest.enc"); failure("dictation_storage_unavailable", () -> store.retarget(BINDING, id, "changed", "Changed"));
                NativeDictationStore.Recording recovered = journal.load();
                assertEquals(phase.equals("after_replace") ? "changed" : "target", recovered.threadId);
                assertEquals(2, recovered.acceptedSamples); assertEquals(0, recovered.durableSamples);
                journal.append(2, new byte[] {5,6,7,8}); assertArrayEquals(pcm(8), journal.read(0, 8));
                journal.interrupt("recognition_failed"); store.discard(BINDING, id);
            }
        }
    }

    @Test public void failedAdoptionMetadataIsNotPublishedButIntentCanBeSavedByInterruption() throws Exception {
        FaultDisk disk = new FaultDisk();
        try (NativeDictationStore store = open(disk, limits(1024, 128, 100000))) {
            NativeDictationStore.Journal journal = create(store, "adopt_failure"); journal.append(0, pcm(4));
            disk.arm("before_write", "manifest.enc"); failure("dictation_storage_unavailable", () -> journal.adopt(true));
            assertFalse(journal.load().adopted); assertEquals(2, journal.load().acceptedSamples);
            journal.append(2, new byte[] {5,6,7,8});
            NativeDictationStore.Recording interrupted = journal.interrupt("dictation_storage_unavailable");
            assertTrue(interrupted.adopted); assertEquals(4, interrupted.endSample); assertArrayEquals(pcm(8), journal.read(0, 8));
        }
    }

    @Test public void postLinkReclamationFailureDoesNotUndoTheResultOrInterruptHealthyCapture() throws Exception {
        FaultDisk disk = new FaultDisk();
        try (NativeDictationStore store = open(disk, limits(1024, 128, 100000))) {
            NativeDictationStore.Journal journal = create(store, "reclaim"); journal.adopt(true); journal.append(0, pcm(8)); journal.seal(0, 0, 4, 0);
            disk.arm("before_delete", "pcm-0.enc");
            assertEquals("first", journal.complete(0, "first").text); assertTrue(file("pcm-0.enc").exists());
            journal.append(4, pcm(8)); journal.seal(1, 4, 8, 0); journal.finish("send", 8);
            assertEquals("first second", journal.complete(1, "second").text);
            assertFalse(files().stream().anyMatch(file -> file.getName().startsWith("pcm-")));
        }
    }

    private static final class ProcessCrash extends Error {}
    private static final class CrashDisk extends NativeDictationStore.Disk {
        final String phase, name;
        CrashDisk(String phase, String name) { this.phase = phase; this.name = name; }
        @Override void fault(String point, File file) { if (point.equals(phase) && file.getName().equals(name)) throw new ProcessCrash(); }
    }
    @Test public void everyInitialCreateCrashBoundaryRemainsOrdinary() throws Exception {
        for (String[] crash : new String[][] {{"before_write", "creating.enc"}, {"after_write", "creating.enc"}, {"after_replace", "creating.enc"},
            {"before_write", "manifest.enc"}, {"after_write", "manifest.enc"}, {"after_replace", "manifest.enc"},
            {"before_write", "checkpoint.enc"}, {"after_write", "checkpoint.enc"}, {"before_delete", "creating.enc"}}) {
            try (NativeDictationStore store = open(new CrashDisk(crash[0], crash[1]), limits(1024, 128, 100000))) {
                try { create(store, "create_crash"); fail("Expected process death"); } catch (ProcessCrash expected) {}
            }
            try (NativeDictationStore store = open()) { assertNull(store.recover(BINDING)); assertTrue(files().isEmpty()); }
        }
    }

    @Test public void missingAdoptedManifestWithAudioRemainsUnavailableAndHasNoInventedTarget() throws Exception {
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "missing_manifest"); journal.adopt(true); journal.append(0, pcm(8));
        }
        Files.delete(file("manifest.enc").toPath()); List<File> preserved = files();
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Recording unavailable = store.recover(BINDING);
            assertEquals("unavailable", unavailable.stage); assertTrue(unavailable.adopted); assertNull(unavailable.threadId); assertEquals(preserved, files());
        }
    }

    @Test public void tombstoneCleanupFailureIsReportedWithoutRepublishingADiscardedDraft() throws Exception {
        FaultDisk disk = new FaultDisk();
        try (NativeDictationStore store = open(disk, limits(1024, 128, 100000))) {
            NativeDictationStore.Journal journal = create(store, "retired"); journal.adopt(true); journal.append(0, pcm(8));
            store.beginDiscard(BINDING, "retired", null); disk.arm("before_delete", "manifest.enc");
            failure("dictation_storage_unavailable", () -> store.recover(BINDING));
            assertTrue(file("terminal.enc").exists()); assertNull(store.recover(BINDING)); assertTrue(files().isEmpty());
        }
    }

    private static JSONObject preference() { return NativeVoiceJson.object("mode", "queue", "originClientId", "client"); }
    private static JSONObject request(String text) {
        return NativeVoiceJson.object("mutationId", "mutation", "text", text, "origin", NativeVoiceJson.object("clientId", "client"),
            "runningPolicy", NativeVoiceJson.object("mode", "queue"));
    }
    @Test public void largeEscapedRequestAndMutationRemainImmutableAcrossHandoffAndRestart() throws Exception {
        String fullText;
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Journal journal = create(store, "large"); journal.adopt(true);
            for (int ordinal = 0; ordinal < 4; ordinal++) completedSegment(journal, ordinal, ("x" + Character.toString((char) 1)).repeat(32767) + "x");
            fullText = journal.load().text; journal.finish("send", 4); store.finishIntent(BINDING, "large", "mutation", preference());
            JSONObject request = request(fullText); assertTrue(NativeVoiceJson.bytes(request.toString()) > 512 * 1024);
            store.saveFinalRequest(BINDING, "large", request); store.markHandedOff(BINDING, "large");
            assertEquals("large", store.ownerOfMutation(BINDING, "mutation").id);
            JSONObject changed = NativeVoiceJson.copy(request); NativeVoiceJson.put(changed, "text", "different");
            try { store.saveFinalRequest(BINDING, "large", changed); fail("Frozen request must not change"); }
            catch (IllegalArgumentException expected) { assertEquals("dictation_request_invalid", expected.getMessage()); }
            store.reject(BINDING, "large", "backend_rejected");
        }
        try (NativeDictationStore store = open()) {
            NativeDictationStore.Recording record = store.recover(BINDING);
            assertEquals("rejected", record.stage); assertEquals(fullText, record.request.getString("text"));
            assertEquals("mutation", record.mutationId); assertTrue(record.handedOff);
        }
    }
}
