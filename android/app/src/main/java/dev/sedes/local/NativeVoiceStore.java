package dev.sedes.local;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

/** Dedicated, authenticated records: no plaintext journals, backups, or token-format reuse. */
final class NativeVoiceStore {
    private static final Object LOCK = new Object();
    private static final String KEY_ALIAS = "sedes.native-voice.v1";
    private final Context context;
    NativeVoiceStore(Context context) { this.context = context.getApplicationContext(); }

    static String binding(String profileId, String origin, String identity) {
        if (profileId == null || !profileId.matches("[A-Za-z0-9._:-]{1,160}") ||
            identity == null || !identity.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("voice_identity_invalid");
        return profileId + "\n" + NativeVoiceSettings.origin(origin) + "\n" + identity;
    }
    private AtomicFile file(String binding, String name) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(binding.getBytes(StandardCharsets.UTF_8));
        StringBuilder directoryName = new StringBuilder();
        for (byte b : digest) directoryName.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        File directory = new File(new File(context.getNoBackupFilesDir(), "native-voice"), directoryName.toString());
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("voice_storage_unavailable");
        return new AtomicFile(new File(directory, name + ".enc"));
    }
    private static SecretKey key() throws Exception {
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore");
        keys.load(null);
        if (!keys.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
            generator.generateKey();
        }
        return (SecretKey) keys.getKey(KEY_ALIAS, null);
    }
    private JSONObject read(String binding, String name) throws Exception {
        AtomicFile target = file(binding, name);
        if (!target.getBaseFile().exists()) return null;
        byte[] encrypted = target.readFully();
        if (encrypted.length < 29 || encrypted.length > 9 * 1024 * 1024 || encrypted[0] != 1)
            throw new IllegalStateException("voice_record_invalid");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(encrypted, 1, 13)));
        cipher.updateAAD((binding + "\n" + name).getBytes(StandardCharsets.UTF_8));
        return new JSONObject(new String(cipher.doFinal(encrypted, 13, encrypted.length - 13), StandardCharsets.UTF_8));
    }
    private void write(String binding, String name, JSONObject value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD((binding + "\n" + name).getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
        AtomicFile target = file(binding, name);
        FileOutputStream output = null;
        try {
            output = target.startWrite();
            output.write(1); output.write(cipher.getIV()); output.write(encrypted);
            target.finishWrite(output);
        } catch (Exception error) { if (output != null) target.failWrite(output); throw error; }
    }
    NativeVoiceSettings settings(String binding) throws Exception {
        synchronized (LOCK) {
            JSONObject value = read(binding, "settings");
            return value == null ? NativeVoiceSettings.defaults() : NativeVoiceSettings.fromRecord(value);
        }
    }
    void settings(String binding, NativeVoiceSettings settings) throws Exception {
        synchronized (LOCK) { write(binding, "settings", settings.record()); }
    }
    String originId(String binding) throws Exception {
        synchronized (LOCK) {
            JSONObject value = read(binding, "origin");
            if (value != null) {
                NativeVoiceJson.keys(value, "version", "clientId");
                NativeVoiceJson.integer(value, "version", 1, 1);
                return NativeVoiceJson.string(value, "clientId", 160);
            }
            String id = UUID.randomUUID().toString();
            write(binding, "origin", NativeVoiceJson.object("version", 1, "clientId", id));
            return id;
        }
    }
    JSONArray journal(String binding) throws Exception {
        synchronized (LOCK) {
            JSONObject value = read(binding, "journal");
            if (value == null) return new JSONArray();
            NativeVoiceJson.keys(value, "version", "entries");
            NativeVoiceJson.integer(value, "version", 1, 1);
            JSONArray entries = value.optJSONArray("entries");
            if (entries == null || entries.length() > 64) throw new IllegalStateException("voice_journal_invalid");
            for (int i = 0; i < entries.length(); i++) validateEntry(entries.getJSONObject(i));
            return entries;
        }
    }
    void saveEntry(String binding, JSONObject entry) throws Exception {
        synchronized (LOCK) {
            validateEntry(entry);
            JSONArray entries = journal(binding), next = new JSONArray();
            boolean replaced = false;
            for (int i = 0; i < entries.length(); i++) {
                JSONObject old = entries.getJSONObject(i);
                if (old.getString("mutationId").equals(entry.getString("mutationId"))) { next.put(entry); replaced = true; }
                else next.put(old);
            }
            if (!replaced) next.put(entry);
            if (next.length() > 64 || NativeVoiceJson.bytes(next.toString()) > 8 * 1024 * 1024)
                throw new IllegalStateException("voice_journal_capacity");
            write(binding, "journal", NativeVoiceJson.object("version", 1, "entries", next));
        }
    }
    void removeEntry(String binding, String mutationId) throws Exception {
        synchronized (LOCK) {
            JSONArray entries = journal(binding), next = new JSONArray();
            for (int i = 0; i < entries.length(); i++) {
                JSONObject value = entries.getJSONObject(i);
                if (!mutationId.equals(value.getString("mutationId"))) next.put(value);
            }
            write(binding, "journal", NativeVoiceJson.object("version", 1, "entries", next));
        }
    }
    private static void validateEntry(JSONObject entry) {
        NativeVoiceJson.keys(entry, "mutationId", "threadId", "request", "stage", "cancelled", "createdAt");
        String id = NativeVoiceJson.string(entry, "mutationId", 160);
        NativeVoiceJson.string(entry, "threadId", 512);
        JSONObject request = NativeVoiceJson.requiredObject(entry, "request");
        if (!id.equals(request.optString("mutationId"))) throw new IllegalArgumentException("voice_journal_identity");
        NativeVoiceJson.bool(entry, "cancelled");
        NativeVoiceJson.integer(entry, "createdAt", 0, Long.MAX_VALUE);
        String stage = NativeVoiceJson.string(entry, "stage", 32);
        if (!stage.equals("prepared") && !stage.equals("possiblySubmitted")) throw new IllegalArgumentException("voice_journal_stage");
        if (NativeVoiceJson.bytes(request.toString()) > 512 * 1024) throw new IllegalArgumentException("voice_input_too_large");
    }
}
