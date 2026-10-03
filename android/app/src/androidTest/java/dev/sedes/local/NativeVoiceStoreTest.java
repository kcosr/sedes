package dev.sedes.local;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.UUID;
import org.json.JSONObject;
import org.junit.Test;

public class NativeVoiceStoreTest {
    private static final String IDENTITY_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final String IDENTITY_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    @Test public void journalIsEncryptedAtomicAndIdentityBound() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String profile = "voice-test-" + UUID.randomUUID();
        String binding = NativeVoiceStore.binding(profile, "http://127.0.0.1:65123", IDENTITY_A);
        NativeVoiceStore store = new NativeVoiceStore(context);
        String mutation = UUID.randomUUID().toString(), content = "private recognized text " + UUID.randomUUID();
        JSONObject entry = NativeVoiceJson.object("mutationId", mutation, "threadId", "thread-test",
            "request", NativeVoiceJson.object("mutationId", mutation, "text", content,
                "origin", NativeVoiceJson.object("clientId", UUID.randomUUID().toString()), "runningPolicy", NativeVoiceJson.object("mode", "queue")),
            "stage", "prepared", "cancelled", false, "createdAt", System.currentTimeMillis());
        File directory = directory(context, binding);
        try {
            store.saveEntry(binding, entry);
            assertEquals(content, store.journal(binding).getJSONObject(0).getJSONObject("request").getString("text"));
            NativeVoiceJson.put(entry, "stage", "possiblySubmitted"); NativeVoiceJson.put(entry, "cancelled", true); store.saveEntry(binding, entry);
            assertTrue(new NativeVoiceStore(context).journal(binding).getJSONObject(0).getBoolean("cancelled"));
            assertEquals(0, store.journal(NativeVoiceStore.binding(profile, "http://127.0.0.1:65123", IDENTITY_B)).length());
            byte[] encrypted = Files.readAllBytes(new File(directory, "journal.enc").toPath());
            assertFalse(new String(encrypted, StandardCharsets.ISO_8859_1).contains(content));
            assertFalse(directory.toString().startsWith(context.getFilesDir().toString()));
            store.removeEntry(binding, mutation); assertEquals(0, store.journal(binding).length());
            String origin = store.originId(binding); assertEquals(origin, new NativeVoiceStore(context).originId(binding));
        } finally {
            remove(directory); remove(directory(context, NativeVoiceStore.binding(profile, "http://127.0.0.1:65123", IDENTITY_B)));
        }
    }
    private static File directory(Context context, String binding) throws Exception {
        StringBuilder name = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(binding.getBytes(StandardCharsets.UTF_8))) name.append(String.format("%02x", b & 255));
        return new File(new File(context.getNoBackupFilesDir(), "native-voice"), name.toString());
    }
    private static void remove(File directory) {
        File[] files = directory.listFiles(); if (files != null) for (File file : files) assertTrue(file.delete());
        if (directory.exists()) assertTrue(directory.delete());
    }
}
