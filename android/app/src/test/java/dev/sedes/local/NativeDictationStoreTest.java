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
    private static final String[] FIELDS = { "speechProvider", "speechEndpoint", "sttModel", "inputDeviceId", "recognitionStartTimeoutMs",
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
            NativeDictationStore.Journal saved = create(store, "saved"); saved.adopt(true); saved.interrupt("disconnected");
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
            NativeDictationStore.Recording record = store.recover(BINDING); assertEquals(samples, record.durableSamples);
            assertEquals(samples, record.endSample); assertTrue(record.captureIncomplete);
            if (samples == 0) assertFalse(files().stream().anyMatch(file -> file.getName().startsWith("pcm-")));
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
        try (NativeDictationStore store = open()) { create(store, "locked").adopt(true); }
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
            create(store, "owner").adopt(true); source = file("manifest.enc");
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

    @Test public void interruptedCaptureRequiresExplicitAcknowledgementRegardlessOfIntentTaskOrder() throws Exception {
        for (boolean interruptFirst : new boolean[] {false, true}) {
            String id = interruptFirst ? "interrupted_before" : "interrupted_after";
            try (NativeDictationStore store = open()) {
                NativeDictationStore.Journal journal = create(store, id); journal.adopt(true); completedSegment(journal, 0, "saved");
                journal.finish("send", 1);
                if (interruptFirst) journal.interrupt("recording_interrupted");
                store.finishIntent(BINDING, id, "mutation", preference());
                if (!interruptFirst) journal.interrupt("recording_interrupted");
                try { store.saveFinalRequest(BINDING, id, request("saved")); fail("Queued Send must not accept partial capture"); }
                catch (IllegalStateException expected) { assertEquals("dictation_not_deliverable", expected.getMessage()); }
                // Repeating intent creation with the same ID also cannot acknowledge interruption.
                store.finishIntent(BINDING, id, "mutation", preference());
                try { store.saveFinalRequest(BINDING, id, request("saved")); fail("Intent retry must not accept partial capture"); }
                catch (IllegalStateException expected) { assertEquals("dictation_not_deliverable", expected.getMessage()); }
            }
            try (NativeDictationStore store = open()) {
                assertTrue(store.get(BINDING, id).captureIncomplete);
                store.acknowledgeIncomplete(BINDING, id); store.saveFinalRequest(BINDING, id, request("saved"));
                assertEquals("mutation", store.get(BINDING, id).mutationId);
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
            create(first, "reserved"); failure("dictation_storage_capacity", () -> create(second, "denied"));
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
