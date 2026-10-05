package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import android.system.Os;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class NativeVoiceStoreTest {
    private static final String IDENTITY_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final String IDENTITY_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static final String ORIGIN = "http://127.0.0.1:65123";
    private final NativeVoiceTestContext context = new NativeVoiceTestContext();
    @org.junit.After public void closeInstallation() { context.close(); }

    @Test public void devicePreferencesAndExactThreadSelectionsSurviveRestartAndProfileDeletion() throws Exception {
        String profile = "voice-test-" + UUID.randomUUID(), other = "voice-test-" + UUID.randomUUID();
        String a = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_A);
        String b = NativeVoiceStore.binding(profile, "https://other.example", IDENTITY_A);
        String account = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_B), otherProfile = NativeVoiceStore.binding(other, ORIGIN, IDENTITY_A);
        NativeVoiceStore store = new NativeVoiceStore(context);
        store.settings(a, store.settings(a).patch(0, NativeVoiceJson.object("autoListen", false, "ttsVoice", "private-voice",
            "voiceThreadId", "a-thread", "voiceThreadTitle", "A thread")));
        assertNull(store.settings(b).text("voiceThreadId")); assertEquals("private-voice", store.settings(b).text("ttsVoice"));
        store.settings(b, store.settings(b).patch(1, NativeVoiceJson.object("voiceThreadId", "b-thread", "voiceThreadTitle", "B thread")));
        File stored = new File(store.directory(NativeVoiceStore.DEVICE_BINDING), NativeVoiceStore.PREFERENCES_RECORD + ".enc");
        assertFalse(new String(Files.readAllBytes(stored.toPath()), StandardCharsets.ISO_8859_1).contains("private-voice"));
        assertTrue(stored.renameTo(new File(stored.getPath() + ".bak")));
        NativeVoiceStore restored = new NativeVoiceStore(context);
        assertEquals("a-thread", restored.settings(a).text("voiceThreadId"));
        assertEquals("b-thread", restored.settings(b).text("voiceThreadId"));
        for (String binding : new String[] { account, otherProfile }) {
            assertNull(restored.settings(binding).text("voiceThreadId")); assertFalse(restored.settings(binding).flag("autoListen"));
        }
        restored.removeProfile(profile);
        for (String binding : new String[] { a, b, account, otherProfile }) {
            assertNull(restored.settings(binding).text("voiceThreadId")); assertNull(restored.settings(binding).text("voiceThreadTitle"));
            assertFalse(restored.settings(binding).flag("autoListen")); assertEquals("private-voice", restored.settings(binding).text("ttsVoice"));
        }
    }

    @Test public void profileJournalsAreRemovedEvenWhenDevicePreferencesCannotBeReadOrWritten() throws Exception {
        for (boolean failWrite : new boolean[] { false, true }) {
            String profile = "voice-test-" + UUID.randomUUID(), binding = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_A);
            NativeVoiceStore store = new NativeVoiceStore(context);
            NativeVoiceSettings settings = store.settings(binding);
            store.settings(binding, settings.patch(settings.revision, NativeVoiceJson.object("ttsVoice", "saved-voice", "voiceThreadId", "saved-thread")));
            store.saveEntry(binding, entry(UUID.randomUUID().toString(), "private input must be removed"));
            File directory = store.directory(NativeVoiceStore.DEVICE_BINDING);
            File record = new File(directory, NativeVoiceStore.PREFERENCES_RECORD + ".enc"), restricted = failWrite ? directory : record;
            int mode = Os.stat(restricted.getPath()).st_mode & 0777, recordMode = Os.stat(record.getPath()).st_mode & 0777;
            try {
                // Fail writes for both AtomicFile layouts: replacing .new and opening the pre-R base file.
                if (failWrite) Os.chmod(record.getPath(), 0400);
                Os.chmod(restricted.getPath(), failWrite ? 0500 : 0000);
                assertThrows(Exception.class, () -> store.removeProfile(profile));
                assertFalse("Journal cleanup is independent of preference access", store.directory(binding).exists());
                assertEquals(0, store.journal(binding).length());
            } finally { Os.chmod(restricted.getPath(), mode); Os.chmod(record.getPath(), recordMode); }
            assertEquals("saved-voice", store.settings(binding).text("ttsVoice"));
            assertEquals("saved-thread", store.settings(binding).text("voiceThreadId"));
        }
    }

    @Test public void profileRemovalReportsBothIndependentCleanupFailures() throws Exception {
        String profile = "voice-test-" + UUID.randomUUID(), binding = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_A);
        NativeVoiceStore store = new NativeVoiceStore(context);
        store.settings(binding, store.settings(binding).patch(0, NativeVoiceJson.object("voiceThreadId", "saved-thread")));
        store.saveEntry(binding, entry(UUID.randomUUID().toString(), "private input"));
        File preferences = new File(store.directory(NativeVoiceStore.DEVICE_BINDING), NativeVoiceStore.PREFERENCES_RECORD + ".enc");
        File journalDirectory = store.directory(binding);
        int preferenceMode = Os.stat(preferences.getPath()).st_mode & 0777, journalMode = Os.stat(journalDirectory.getPath()).st_mode & 0777;
        try {
            Os.chmod(preferences.getPath(), 0000); Os.chmod(journalDirectory.getPath(), 0500);
            Exception error = assertThrows(Exception.class, () -> store.removeProfile(profile));
            assertEquals("voice_storage_unavailable", error.getMessage());
            assertEquals(1, error.getSuppressed().length);
            assertEquals("voice_storage_unavailable", error.getSuppressed()[0].getMessage());
        } finally {
            Os.chmod(preferences.getPath(), preferenceMode); Os.chmod(journalDirectory.getPath(), journalMode);
        }
        assertEquals("saved-thread", store.settings(binding).text("voiceThreadId"));
        store.removeProfile(profile); assertFalse(journalDirectory.exists()); assertNull(store.settings(binding).text("voiceThreadId"));
    }

    @Test public void journalIsEncryptedAtomicAndIdentityBound() throws Exception {
        String profile = "voice-test-" + UUID.randomUUID();
        String binding = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_A);
        NativeVoiceStore store = new NativeVoiceStore(context);
        String mutation = UUID.randomUUID().toString(), content = "private recognized text " + UUID.randomUUID();
        JSONObject entry = entry(mutation, content);
        File directory = store.directory(binding);
        try {
            store.saveEntry(binding, entry);
            assertEquals(content, store.journal(binding).getJSONObject(0).getJSONObject("request").getString("text"));
            NativeVoiceJson.put(entry, "stage", "possiblySubmitted"); NativeVoiceJson.put(entry, "cancelled", true); store.saveEntry(binding, entry);
            assertTrue(new NativeVoiceStore(context).journal(binding).getJSONObject(0).getBoolean("cancelled"));
            assertEquals(0, store.journal(NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_B)).length());
            byte[] encrypted = Files.readAllBytes(new File(directory, "journal.enc").toPath());
            assertFalse(new String(encrypted, StandardCharsets.ISO_8859_1).contains(content));
            assertFalse(directory.toString().startsWith(context.getFilesDir().toString()));
            JSONObject summary = store.summaries(binding).getJSONObject(0);
            assertFalse("Snapshot summaries carry no recognized text", summary.toString().contains(content));
            assertTrue(summary.getBoolean("cancelled"));
            store.removeEntry(binding, mutation); assertEquals(0, store.journal(binding).length());
            assertEquals(0, new NativeVoiceStore(context).journal(binding).length());
        } finally { store.removeProfile(profile); }
    }

    @Test public void maximalEscapedDictationFitsTheExistingAdmissionJournal() throws Exception {
        String profile = "voice-test-" + UUID.randomUUID(), binding = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_A);
        String mutation = UUID.randomUUID().toString(), text = ("x" + Character.toString((char) 1)).repeat(131071) + "x";
        NativeVoiceStore store = new NativeVoiceStore(context);
        JSONObject entry = entry(mutation, text);
        assertEquals(262143, NativeVoiceJson.bytes(text));
        assertTrue(NativeVoiceJson.bytes(entry.getJSONObject("request").toString()) > 512 * 1024);
        try {
            store.saveEntry(binding, entry);
            assertEquals(text, new NativeVoiceStore(context).entry(binding, mutation).getJSONObject("request").getString("text"));
        } finally { store.removeProfile(profile); }
    }

    @Test public void adoptedRecordingLinkIsIndependentDurableAndImmutable() throws Exception {
        String profile = "voice-test-" + UUID.randomUUID(), binding = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_A);
        String mutation = UUID.randomUUID().toString(); NativeVoiceStore store = new NativeVoiceStore(context);
        JSONObject adopted = entry(mutation, "private dictated input"); NativeVoiceJson.put(adopted, "recordingId", "saved-recording");
        try {
            store.saveEntry(binding, adopted);
            NativeVoiceStore reader = new NativeVoiceStore(context);
            assertEquals("saved-recording", reader.entry(binding, mutation).getString("recordingId"));
            assertEquals("saved-recording", reader.summaries(binding).getJSONObject(0).getString("recordingId"));
            JSONObject stripped = NativeVoiceJson.copy(adopted); stripped.remove("recordingId");
            assertThrows(IllegalStateException.class, () -> store.saveEntry(binding, stripped));
            JSONObject changed = NativeVoiceJson.copy(adopted); NativeVoiceJson.put(changed, "recordingId", "different-recording");
            assertThrows(IllegalStateException.class, () -> store.saveEntry(binding, changed));
            JSONObject duplicateOwner = entry(UUID.randomUUID().toString(), "different mutation"); NativeVoiceJson.put(duplicateOwner, "recordingId", "saved-recording");
            assertThrows(IllegalStateException.class, () -> store.saveEntry(binding, duplicateOwner));
            JSONObject ordinary = entry(UUID.randomUUID().toString(), "ordinary input"); store.saveEntry(binding, ordinary);
            JSONArray summaries = new NativeVoiceStore(context).summaries(binding);
            assertEquals(2, summaries.length()); assertFalse(summaries.getJSONObject(1).has("recordingId"));
            assertEquals("saved-recording", new NativeVoiceStore(context).entry(binding, mutation).getString("recordingId"));
        } finally { store.removeProfile(profile); }
    }

    @Test public void absentRecordsDoNotCreateDirectories() throws Exception {
        String profile = "voice-test-" + UUID.randomUUID();
        String binding = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_A);
        NativeVoiceStore store = new NativeVoiceStore(context);
        assertEquals(0, store.journal(binding).length()); assertEquals("off", store.settings(binding).mode());
        store.removeEntry(binding, UUID.randomUUID().toString());
        assertFalse(store.directory(binding).exists());
    }

    @Test public void speechCatalogSurvivesRecreationAndRejectsOtherOwnersOrAccountScopes() throws Exception {
        String profile = "voice-test-" + UUID.randomUUID();
        String binding = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_A);
        NativeVoiceStore store = new NativeVoiceStore(context);
        NativeVoiceSettings settings = NativeVoiceSettings.defaults();
        String scope = NativeSpeechCatalogCache.scope(binding, settings, "account-a");
        JSONObject catalog = NativeSpeechCatalog.empty("openai");
        NativeVoiceJson.put(catalog, "voices", new JSONArray().put("private-voice"));
        try {
            store.speechCatalog(binding, new NativeSpeechCatalogCache(scope, 1234, catalog));
            NativeSpeechCatalogCache restored = new NativeVoiceStore(context).speechCatalog(binding, scope);
            assertNotNull(restored); assertEquals(1234, restored.fetchedAt);
            assertEquals("private-voice", restored.catalog.getJSONArray("voices").getString(0));
            byte[] encrypted = Files.readAllBytes(new File(store.directory(binding), "speech-catalog.enc").toPath());
            assertFalse(new String(encrypted, StandardCharsets.ISO_8859_1).contains("private-voice"));
            for (String other : new String[] { NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_B),
                NativeVoiceStore.binding(profile, "https://other.example", IDENTITY_A) })
                assertNull(store.speechCatalog(other, scope));
            assertNull(store.speechCatalog(binding, NativeSpeechCatalogCache.scope(binding, settings, "account-b")));
            assertFalse(new File(store.directory(binding), "speech-catalog.enc").exists());
            assertNull("Changing back cannot resurrect the invalidated account catalog", store.speechCatalog(binding, scope));
        } finally { store.removeProfile(profile); }
    }

    @Test public void interruptedWriteRestoresTheBackupInsteadOfLosingTheJournal() throws Exception {
        String profile = "voice-test-" + UUID.randomUUID();
        String binding = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_A);
        NativeVoiceStore store = new NativeVoiceStore(context);
        String mutation = UUID.randomUUID().toString();
        try {
            store.saveEntry(binding, entry(mutation, "survives an interrupted write"));
            // AtomicFile keeps the previous record as a backup while a write is in progress.
            File base = new File(store.directory(binding), "journal.enc"), backup = new File(base.getPath() + ".bak");
            assertTrue(base.renameTo(backup)); assertFalse(base.exists());
            assertEquals(mutation, new NativeVoiceStore(context).journal(binding).getJSONObject(0).getString("mutationId"));
        } finally { store.removeProfile(profile); }
    }

    @Test public void unreadableJournalDoesNotCacheAnEmptyJournal() throws Exception {
        assertFailedReadPreservesJournal(ReadFailure.UNREADABLE_RECORD);
    }

    @Test public void inaccessibleJournalDirectoryDoesNotCacheAnEmptyJournal() throws Exception {
        assertFailedReadPreservesJournal(ReadFailure.INACCESSIBLE_DIRECTORY);
    }

    @Test public void failedBackupRestoreDoesNotCacheAnEmptyJournal() throws Exception {
        assertFailedReadPreservesJournal(ReadFailure.BLOCKED_BACKUP_RESTORE);
    }

    private enum ReadFailure { UNREADABLE_RECORD, INACCESSIBLE_DIRECTORY, BLOCKED_BACKUP_RESTORE }

    private void assertFailedReadPreservesJournal(ReadFailure failure) throws Exception {
        String profile = "voice-test-" + UUID.randomUUID();
        String binding = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_A);
        NativeVoiceStore writer = new NativeVoiceStore(context), reader = new NativeVoiceStore(context);
        String first = UUID.randomUUID().toString(), second = UUID.randomUUID().toString();
        try {
            writer.saveEntry(binding, entry(first, "pending before the failed read"));
            File directory = writer.directory(binding), base = new File(directory, "journal.enc");
            if (failure == ReadFailure.BLOCKED_BACKUP_RESTORE) assertTrue(base.renameTo(new File(base.getPath() + ".bak")));
            File restricted = failure == ReadFailure.UNREADABLE_RECORD ? base : directory;
            int permissions = Os.stat(restricted.getPath()).st_mode & 0777;
            try {
                // A readable but unwritable directory prevents AtomicFile from restoring its sole backup.
                Os.chmod(restricted.getPath(), failure == ReadFailure.BLOCKED_BACKUP_RESTORE ? 0500 : 0000);
                IllegalStateException error = assertThrows(IllegalStateException.class, () -> reader.journal(binding));
                assertEquals("voice_storage_unavailable", error.getMessage());
            } finally { Os.chmod(restricted.getPath(), permissions); }
            // Reuse the failed reader: a cached empty journal would overwrite the first pending input here.
            reader.saveEntry(binding, entry(second, "pending after access is restored"));
            JSONArray persisted = new NativeVoiceStore(context).journal(binding);
            assertEquals(2, persisted.length());
            assertEquals(first, persisted.getJSONObject(0).getString("mutationId"));
            assertEquals(second, persisted.getJSONObject(1).getString("mutationId"));
        } finally { writer.removeProfile(profile); }
    }

    @Test public void corruptRecordsAreReportedAndQuarantined() throws Exception {
        String profile = "voice-test-" + UUID.randomUUID();
        String binding = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_A);
        NativeVoiceStore store = new NativeVoiceStore(context);
        try {
            store.settings(binding, NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("audioMode", "response")));
            store.saveEntry(binding, entry(UUID.randomUUID().toString(), "unreadable later"));
            byte[] garbage = new byte[64]; garbage[0] = 1;
            for (String name : new String[] { NativeVoiceStore.PREFERENCES_RECORD, "journal" }) {
                String owner = name.equals(NativeVoiceStore.PREFERENCES_RECORD) ? NativeVoiceStore.DEVICE_BINDING : binding;
                Files.write(new File(store.directory(owner), name + ".enc").toPath(), garbage);
                NativeVoiceStore reader = new NativeVoiceStore(context);
                try {
                    if (name.equals(NativeVoiceStore.PREFERENCES_RECORD)) reader.settings(binding); else reader.journal(binding);
                    fail("Accepted a corrupt " + name + " record");
                } catch (NativeVoiceStore.CorruptRecord expected) { assertEquals(name, expected.record); }
                reader.quarantine(binding, name);
                assertTrue(new File(store.directory(owner), name + ".corrupt").exists());
                if (name.equals(NativeVoiceStore.PREFERENCES_RECORD)) assertEquals("off", reader.settings(binding).mode());
                else assertEquals(0, reader.journal(binding).length());
            }
        } finally { store.removeProfile(profile); }
    }

    @Test public void profileRemovalDeletesEveryBindingOfOnlyThatProfile() throws Exception {
        String profile = "voice-test-" + UUID.randomUUID(), other = "voice-test-" + UUID.randomUUID();
        NativeVoiceStore store = new NativeVoiceStore(context);
        String first = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_A), second = NativeVoiceStore.binding(profile, "https://example.test", IDENTITY_B);
        String kept = NativeVoiceStore.binding(other, ORIGIN, IDENTITY_A);
        try {
            for (String binding : new String[] { first, second, kept }) { store.saveEntry(binding, entry(UUID.randomUUID().toString(), "text")); }
            store.removeProfile(profile);
            assertFalse(store.directory(first).exists()); assertFalse(store.directory(second).exists());
            assertEquals(0, store.journal(first).length());
            assertEquals(1, store.journal(kept).length()); assertEquals(1, new NativeVoiceStore(context).journal(kept).length());
        } finally { store.removeProfile(profile); store.removeProfile(other); }
    }

    private static JSONObject entry(String mutation, String content) {
        return NativeVoiceJson.object("mutationId", mutation, "threadId", "thread-test",
            "request", NativeVoiceJson.object("mutationId", mutation, "text", content,
                "origin", NativeVoiceJson.object("clientId", UUID.randomUUID().toString()), "runningPolicy", NativeVoiceJson.object("mode", "queue")),
            "stage", "prepared", "cancelled", false, "createdAt", System.currentTimeMillis());
    }
}
