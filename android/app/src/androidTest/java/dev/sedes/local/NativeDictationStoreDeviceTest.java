package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;
import org.json.JSONObject;
import org.junit.Test;

/** Real Android Keystore, fsync/rename, no-backup placement and separate admission-journal retirement. */
public class NativeDictationStoreDeviceTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private static JSONObject config() {
        JSONObject result = new JSONObject(), settings = NativeVoiceSettings.defaults().value;
        for (String field : new String[] { "speechProvider", "speechEndpoint", "sttModel", "inputDeviceId", "recognitionStartTimeoutMs",
            "recognitionCompletionTimeoutMs", "recognitionEndSilenceMs", "recognitionResultTimeoutMs", "longDictationTimeoutMs",
            "recognizeStopCommand", "recognitionCues", "cueGain", "followComposerMode" }) NativeVoiceJson.put(result, field, settings.opt(field));
        return result;
    }
    private static String binding(String profile) { return NativeVoiceStore.binding(profile, "https://dictation.example", "a".repeat(64)); }
    private File profileDirectory(String profile) throws Exception {
        StringBuilder digest = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(profile.getBytes(StandardCharsets.UTF_8)))
            digest.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return new File(new File(context.getNoBackupFilesDir(), "native-dictation"), digest.toString());
    }
    private static List<File> files(File directory) throws Exception {
        try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(directory.toPath())) {
            return paths.filter(Files::isRegularFile).map(java.nio.file.Path::toFile).collect(Collectors.toList());
        }
    }

    @Test public void keystoreBlocksStayOutsideBackupsAndRecoverOnlyTheAcknowledgedCheckpoint() throws Exception {
        String profile = "dictation-device-" + UUID.randomUUID(), binding = binding(profile);
        byte[] audio = new byte[48_002]; Arrays.fill(audio, (byte) 37);
        try {
            try (NativeDictationStore store = new NativeDictationStore(context)) {
                NativeDictationStore.Journal journal = store.create(binding, "capture", "target", "private dictation target", config());
                journal.adopt(true); journal.append(0, audio);
                assertEquals(24_001, journal.load().acceptedSamples); assertEquals(24_000, journal.load().durableSamples);
                assertTrue(profileDirectory(profile).getPath().startsWith(context.getNoBackupFilesDir().getPath()));
                assertFalse(profileDirectory(profile).getPath().startsWith(context.getFilesDir().getPath()));
                for (File file : files(profileDirectory(profile))) {
                    byte[] encrypted = Files.readAllBytes(file.toPath()); assertEquals(1, encrypted[0]);
                    String raw = new String(encrypted, StandardCharsets.ISO_8859_1);
                    assertFalse(raw.contains("private dictation target")); assertFalse(raw.contains("speechEndpoint"));
                    assertFalse(raw.contains("%%%%%%%%%%%%%%%%%%%%%%%%"));
                }
            }
            try (NativeDictationStore store = new NativeDictationStore(context)) {
                NativeDictationStore.Recording recovered = store.recover(binding);
                assertEquals("interrupted", recovered.stage); assertTrue(recovered.captureIncomplete); assertFalse(recovered.keepListening);
                assertEquals(24_000, recovered.endSample); assertArrayEquals(Arrays.copyOf(audio, 48_000), store.journal(binding, "capture").read(0, 48_000));
            }
        } finally { try (NativeDictationStore store = new NativeDictationStore(context)) { store.removeProfile(profile); } }
    }

    @Test public void ordinaryHandoffKeepsItsUncertainAdmissionAcrossTwoRecoveryRestarts() throws Exception {
        String profile = "dictation-device-" + UUID.randomUUID(), binding = binding(profile), mutation = UUID.randomUUID().toString();
        NativeVoiceStore inputs = new NativeVoiceStore(context);
        try {
            try (NativeDictationStore store = new NativeDictationStore(context)) {
                NativeDictationStore.Journal journal = store.create(binding, "ordinary", "target", null, config());
                journal.append(0, new byte[] {1,2}); journal.checkpoint(); journal.seal(0, 0, 1, 0);
                journal.complete(0, "ordinary transcript"); journal.finish("send", 1);
                store.finishIntent(binding, "ordinary", mutation, NativeVoiceJson.object("mode", "queue", "originClientId", "client"));
                JSONObject request = NativeVoiceJson.object("mutationId", mutation, "text", "ordinary transcript", "origin", NativeVoiceJson.object("clientId", "client"),
                    "runningPolicy", NativeVoiceJson.object("mode", "queue"));
                store.saveFinalRequest(binding, "ordinary", request);
                inputs.saveEntry(binding, NativeVoiceJson.object("mutationId", mutation, "threadId", "target", "request", request,
                    "stage", "possiblySubmitted", "cancelled", false, "createdAt", System.currentTimeMillis()));
                store.markHandedOff(binding, "ordinary");
            }
            for (int restart = 0; restart < 2; restart++) {
                try (NativeDictationStore store = new NativeDictationStore(context)) {
                    for (NativeDictationStore.Retirement retirement : store.pendingRetirements(binding)) {
                        if (retirement.mutationId != null) inputs.removeEntry(binding, retirement.mutationId);
                        store.finishDiscard(binding, retirement.recordingId);
                    }
                    assertNull(store.recover(binding)); assertTrue(store.pendingRetirements(binding).isEmpty());
                    JSONObject entry = new NativeVoiceStore(context).entry(binding, mutation);
                    assertNotNull(entry); assertEquals("possiblySubmitted", entry.getString("stage")); assertFalse(entry.getBoolean("cancelled"));
                }
            }
        } finally {
            inputs.removeProfile(profile);
            try (NativeDictationStore store = new NativeDictationStore(context)) { store.removeProfile(profile); }
        }
    }

    @Test public void unreadableManifestStillHasIndependentAdmissionOwnershipForDiscardAfterRestart() throws Exception {
        String profile = "dictation-device-" + UUID.randomUUID(), binding = binding(profile), mutation = UUID.randomUUID().toString();
        NativeVoiceStore inputs = new NativeVoiceStore(context);
        try {
            try (NativeDictationStore store = new NativeDictationStore(context)) {
                NativeDictationStore.Journal journal = store.create(binding, "damaged", "target", null, config());
                journal.adopt(true); journal.append(0, new byte[] {1,2}); journal.checkpoint(); journal.seal(0, 0, 1, 0);
                journal.complete(0, "complete transcript"); journal.finish("send", 1);
                store.finishIntent(binding, "damaged", mutation, NativeVoiceJson.object("mode", "queue", "originClientId", "client"));
                JSONObject request = NativeVoiceJson.object("mutationId", mutation, "text", "complete transcript", "origin", NativeVoiceJson.object("clientId", "client"),
                    "runningPolicy", NativeVoiceJson.object("mode", "queue"));
                store.saveFinalRequest(binding, "damaged", request);
                inputs.saveEntry(binding, NativeVoiceJson.object("mutationId", mutation, "threadId", "target", "request", request,
                    "recordingId", "damaged", "stage", "possiblySubmitted", "cancelled", false, "createdAt", System.currentTimeMillis()));
                store.markHandedOff(binding, "damaged");
            }
            File manifest = files(profileDirectory(profile)).stream().filter(file -> file.getName().equals("manifest.enc")).findFirst().orElseThrow();
            byte[] corrupted = Files.readAllBytes(manifest.toPath()); corrupted[corrupted.length - 1] ^= 1; Files.write(manifest.toPath(), corrupted);
            try (NativeDictationStore store = new NativeDictationStore(context)) {
                NativeDictationStore.Recording unavailable = store.recover(binding);
                assertEquals("unavailable", unavailable.stage); assertNull(unavailable.mutationId);
                JSONObject independentlyOwned = new NativeVoiceStore(context).summaries(binding).getJSONObject(0);
                assertEquals(unavailable.id, independentlyOwned.getString("recordingId"));
                store.beginDiscard(binding, unavailable.id, independentlyOwned.getString("mutationId"));
            }
            // A crash immediately after Discard intent still leaves enough independent identity to remove the journal.
            try (NativeDictationStore store = new NativeDictationStore(context)) {
                assertNull(store.recover(binding));
                for (NativeDictationStore.Retirement retirement : store.pendingRetirements(binding)) {
                    assertEquals("damaged", retirement.recordingId); assertEquals(mutation, retirement.mutationId);
                    inputs.removeEntry(binding, retirement.mutationId); store.finishDiscard(binding, retirement.recordingId);
                }
                assertNull(new NativeVoiceStore(context).entry(binding, mutation)); assertTrue(store.pendingRetirements(binding).isEmpty());
            }
        } finally {
            inputs.removeProfile(profile);
            try (NativeDictationStore store = new NativeDictationStore(context)) { store.removeProfile(profile); }
        }
    }

    @Test public void durableRetirementFencesAnActualAdmissionJournalAcrossBothRestartWindows() throws Exception {
        String profile = "dictation-device-" + UUID.randomUUID(), binding = binding(profile), mutation = UUID.randomUUID().toString();
        NativeVoiceStore inputs = new NativeVoiceStore(context);
        try {
            try (NativeDictationStore store = new NativeDictationStore(context)) {
                NativeDictationStore.Journal journal = store.create(binding, "capture", "target", null, config());
                journal.adopt(true); journal.append(0, new byte[] {1,2}); journal.checkpoint(); journal.seal(0, 0, 1, 0);
                journal.complete(0, "complete transcript"); journal.finish("send", 1);
                store.finishIntent(binding, "capture", mutation, NativeVoiceJson.object("mode", "queue", "originClientId", "client"));
                JSONObject request = NativeVoiceJson.object("mutationId", mutation, "text", "complete transcript", "origin", NativeVoiceJson.object("clientId", "client"),
                    "runningPolicy", NativeVoiceJson.object("mode", "queue"));
                store.saveFinalRequest(binding, "capture", request);
                inputs.saveEntry(binding, NativeVoiceJson.object("mutationId", mutation, "threadId", "target", "request", request,
                    "recordingId", "capture", "stage", "prepared", "cancelled", false, "createdAt", System.currentTimeMillis()));
                store.markHandedOff(binding, "capture"); store.beginDiscard(binding, "capture", mutation);
            }
            try (NativeDictationStore store = new NativeDictationStore(context)) {
                assertNull(store.recover(binding)); assertEquals(mutation, store.pendingRetirements(binding).get(0).mutationId);
                assertNotNull(new NativeVoiceStore(context).entry(binding, mutation));
                inputs.removeEntry(binding, mutation);
            }
            try (NativeDictationStore store = new NativeDictationStore(context)) {
                assertNull(store.recover(binding)); assertNull(new NativeVoiceStore(context).entry(binding, mutation));
                assertEquals(1, store.pendingRetirements(binding).size()); store.finishDiscard(binding, "capture");
                assertTrue(store.pendingRetirements(binding).isEmpty()); assertTrue(files(profileDirectory(profile)).isEmpty());
            }
        } finally {
            inputs.removeProfile(profile);
            try (NativeDictationStore store = new NativeDictationStore(context)) { store.removeProfile(profile); }
        }
    }
}
