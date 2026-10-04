package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;
import org.json.JSONObject;
import org.junit.Test;

public class NativeVoiceStoreTest {
    private static final String IDENTITY_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final String IDENTITY_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static final String ORIGIN = "http://127.0.0.1:65123";
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

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
            String origin = store.originId(binding); assertEquals(origin, new NativeVoiceStore(context).originId(binding));
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

    @Test public void corruptRecordsAreReportedAndQuarantined() throws Exception {
        String profile = "voice-test-" + UUID.randomUUID();
        String binding = NativeVoiceStore.binding(profile, ORIGIN, IDENTITY_A);
        NativeVoiceStore store = new NativeVoiceStore(context);
        try {
            store.settings(binding, NativeVoiceSettings.defaults().patch(0, NativeVoiceJson.object("audioMode", "response")));
            store.saveEntry(binding, entry(UUID.randomUUID().toString(), "unreadable later"));
            byte[] garbage = new byte[64]; garbage[0] = 1;
            for (String name : new String[] { "settings", "journal" }) {
                Files.write(new File(store.directory(binding), name + ".enc").toPath(), garbage);
                NativeVoiceStore reader = new NativeVoiceStore(context);
                try {
                    if (name.equals("settings")) reader.settings(binding); else reader.journal(binding);
                    fail("Accepted a corrupt " + name + " record");
                } catch (NativeVoiceStore.CorruptRecord expected) { assertEquals(name, expected.record); }
                reader.quarantine(binding, name);
                assertTrue(new File(store.directory(binding), name + ".corrupt").exists());
                if (name.equals("settings")) assertEquals("off", reader.settings(binding).mode());
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
            for (String binding : new String[] { first, second, kept }) { store.originId(binding); store.saveEntry(binding, entry(UUID.randomUUID().toString(), "text")); }
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
