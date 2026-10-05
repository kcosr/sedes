package dev.sedes.local;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.ProviderException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Dedicated, authenticated records: no plaintext journals, backups, or token-format reuse. */
final class NativeVoiceStore {
    /**
     * A record exists but its framing, authentication tag, JSON or contents are invalid. Keystore failures, including
     * transient InvalidKeyException, IllegalBlockSizeException and ProviderException from AndroidKeyStore, and I/O
     * failures are not corruption: they surface as voice_storage_unavailable and the record is kept.
     */
    static final class CorruptRecord extends Exception {
        final String record;
        CorruptRecord(String record, Throwable cause) { super("voice_record_invalid", cause); this.record = record; }
    }
    private static final Object LOCK = new Object();
    private static final String KEY_ALIAS = "sedes.native-voice.v1";
    private final Context context;
    // Decrypted, validated journals for this owner. Every journal write goes through this instance.
    private final Map<String, JSONArray> journals = new HashMap<>();
    NativeVoiceStore(Context context) { this.context = context.getApplicationContext(); }

    static String binding(String profileId, String origin, String identity) {
        if (profileId == null || !profileId.matches("[A-Za-z0-9._:-]{1,160}") ||
            identity == null || !identity.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("voice_identity_invalid");
        return profileId + "\n" + NativeVoiceSettings.origin(origin) + "\n" + identity;
    }
    private static String digest(String value) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }
    private File profileDirectory(String profileId) throws Exception {
        if (profileId == null || !profileId.matches("[A-Za-z0-9._:-]{1,160}")) throw new IllegalArgumentException("voice_identity_invalid");
        return new File(new File(context.getNoBackupFilesDir(), "native-voice"), digest(profileId));
    }
    /** Records are grouped by profile so profile removal can delete every binding without knowing its origin or identity. */
    File directory(String binding) throws Exception { return new File(profileDirectory(binding.substring(0, binding.indexOf('\n'))), digest(binding)); }
    private AtomicFile file(String binding, String name) throws Exception { return new AtomicFile(new File(directory(binding), name + ".enc")); }
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
        byte[] encrypted;
        AtomicFile target = file(binding, name);
        // readFully restores an interrupted pre-R write from its backup; checking the base file first would discard it.
        try { encrypted = target.readFully(); }
        catch (FileNotFoundException error) {
            // Failed opens also report permissions and I/O errors this way. Only proven absence is an empty record.
            try {
                if (missing(target.getBaseFile()) && missing(new File(target.getBaseFile().getPath() + ".bak"))) return null;
            } catch (ErrnoException check) { error.addSuppressed(check); }
            throw new IllegalStateException("voice_storage_unavailable", error);
        }
        if (encrypted.length < 29 || encrypted.length > 9 * 1024 * 1024 || encrypted[0] != 1) throw new CorruptRecord(name, null);
        byte[] plain;
        try { plain = decrypt(binding, name, encrypted); }
        catch (GeneralSecurityException | ProviderException first) {
            if (corruption(first)) throw new CorruptRecord(name, first);
            // AndroidKeyStore can fail transiently; retry once, then keep the record and report storage unavailable.
            try { plain = decrypt(binding, name, encrypted); }
            catch (GeneralSecurityException | ProviderException error) {
                if (corruption(error)) throw new CorruptRecord(name, error);
                throw new IllegalStateException("voice_storage_unavailable", error);
            }
        }
        try { return new JSONObject(new String(plain, StandardCharsets.UTF_8)); }
        catch (JSONException error) { throw new CorruptRecord(name, error); }
    }
    private static boolean missing(File file) throws ErrnoException {
        try { Os.lstat(file.getPath()); return false; }
        catch (ErrnoException error) {
            if (error.errno == OsConstants.ENOENT) return true;
            throw error;
        }
    }
    private static byte[] decrypt(String binding, String name, byte[] encrypted) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(encrypted, 1, 13)));
        cipher.updateAAD((binding + "\n" + name).getBytes(StandardCharsets.UTF_8));
        return cipher.doFinal(encrypted, 13, encrypted.length - 13);
    }
    /** Only a failed authentication tag proves the ciphertext is unusable; every other decrypt failure may be transient. */
    static boolean corruption(Throwable error) { return error instanceof AEADBadTagException; }
    private void write(String binding, String name, JSONObject value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD((binding + "\n" + name).getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
        File directory = directory(binding);
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("voice_storage_unavailable");
        AtomicFile target = file(binding, name);
        FileOutputStream output = null;
        try {
            output = target.startWrite();
            output.write(1); output.write(cipher.getIV()); output.write(encrypted);
            target.finishWrite(output);
        } catch (Exception error) { if (output != null) target.failWrite(output); throw error; }
    }
    /** Moves an unreadable record aside, keeping only the newest copy, so the caller can continue from defaults. */
    void quarantine(String binding, String name) throws Exception {
        synchronized (LOCK) {
            if (name.equals("journal")) journals.remove(binding);
            AtomicFile target = file(binding, name);
            File aside = new File(directory(binding), name + ".corrupt");
            if (aside.exists() && !aside.delete()) throw new IllegalStateException("voice_storage_unavailable");
            if (target.getBaseFile().exists() && !target.getBaseFile().renameTo(aside)) target.delete();
            if (target.getBaseFile().exists()) throw new IllegalStateException("voice_storage_unavailable");
        }
    }
    /** Deletes every native voice record for the profile: settings, journals and quarantined copies. */
    void removeProfile(String profileId) throws Exception {
        synchronized (LOCK) {
            Iterator<String> cached = journals.keySet().iterator();
            while (cached.hasNext()) if (cached.next().startsWith(profileId + "\n")) cached.remove();
            File directory = profileDirectory(profileId);
            delete(directory);
            if (directory.exists()) throw new IllegalStateException("voice_storage_unavailable");
        }
    }
    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        file.delete();
    }
    NativeVoiceSettings settings(String binding) throws Exception {
        synchronized (LOCK) {
            JSONObject value = read(binding, "settings");
            if (value == null) return NativeVoiceSettings.defaults();
            try { return NativeVoiceSettings.fromRecord(value); }
            catch (RuntimeException error) { throw new CorruptRecord("settings", error); }
        }
    }
    void settings(String binding, NativeVoiceSettings settings) throws Exception {
        synchronized (LOCK) { write(binding, "settings", settings.record()); }
    }
    NativeSpeechCatalogCache speechCatalog(String binding, String scope) throws Exception {
        synchronized (LOCK) {
            JSONObject value = read(binding, "speech-catalog");
            if (value == null) return null;
            final NativeSpeechCatalogCache cached;
            try { cached = NativeSpeechCatalogCache.fromRecord(value); }
            catch (RuntimeException error) { throw new CorruptRecord("speech-catalog", error); }
            if (cached.scope.equals(scope)) return cached;
            removeSpeechCatalog(binding); return null;
        }
    }
    void speechCatalog(String binding, NativeSpeechCatalogCache catalog) throws Exception {
        synchronized (LOCK) { write(binding, "speech-catalog", catalog.record()); }
    }
    void removeSpeechCatalog(String binding) throws Exception {
        synchronized (LOCK) {
            AtomicFile record = file(binding, "speech-catalog"); record.delete();
            if (!missing(record.getBaseFile()) || !missing(new File(record.getBaseFile().getPath() + ".bak")) ||
                !missing(new File(record.getBaseFile().getPath() + ".new"))) throw new IllegalStateException("voice_storage_unavailable");
        }
    }
    private JSONArray entries(String binding) throws Exception {
        JSONArray cached = journals.get(binding);
        if (cached != null) return cached;
        JSONObject value = read(binding, "journal");
        JSONArray entries;
        if (value == null) entries = new JSONArray();
        else try {
            NativeVoiceJson.keys(value, "version", "entries");
            NativeVoiceJson.integer(value, "version", 1, 1);
            entries = value.optJSONArray("entries");
            if (entries == null || entries.length() > 64) throw new IllegalStateException("voice_journal_invalid");
            Set<String> mutations = new HashSet<>(), recordings = new HashSet<>();
            for (int i = 0; i < entries.length(); i++) {
                JSONObject entry = entries.getJSONObject(i); validateEntry(entry);
                if (!mutations.add(entry.getString("mutationId")) || entry.has("recordingId") && !recordings.add(entry.getString("recordingId")))
                    throw new IllegalStateException("voice_journal_ownership_conflict");
            }
        } catch (RuntimeException | JSONException error) { throw new CorruptRecord("journal", error); }
        journals.put(binding, entries);
        return entries;
    }
    /** A detached copy of the complete journal. */
    JSONArray journal(String binding) throws Exception {
        synchronized (LOCK) { return new JSONArray(entries(binding).toString()); }
    }
    /** A detached copy of one entry, or null. */
    JSONObject entry(String binding, String mutationId) throws Exception {
        synchronized (LOCK) {
            JSONArray entries = entries(binding);
            for (int i = 0; i < entries.length(); i++) {
                JSONObject value = entries.getJSONObject(i);
                if (mutationId.equals(value.optString("mutationId"))) return NativeVoiceJson.copy(value);
            }
            return null;
        }
    }
    /** Content-free entry summaries for snapshots; served from memory after the first read. */
    JSONArray summaries(String binding) throws Exception {
        synchronized (LOCK) {
            JSONArray entries = entries(binding), result = new JSONArray();
            for (int i = 0; i < entries.length(); i++) {
                JSONObject value = entries.getJSONObject(i);
                JSONObject summary = NativeVoiceJson.object("mutationId", value.optString("mutationId"), "threadId", value.optString("threadId"),
                    "stage", value.optString("stage"), "cancelled", value.optBoolean("cancelled"));
                if (value.has("recordingId")) NativeVoiceJson.put(summary, "recordingId", value.getString("recordingId"));
                result.put(summary);
            }
            return result;
        }
    }
    void saveEntry(String binding, JSONObject entry) throws Exception {
        synchronized (LOCK) {
            validateEntry(entry);
            JSONArray entries = entries(binding), next = new JSONArray();
            boolean replaced = false;
            for (int i = 0; i < entries.length(); i++) {
                JSONObject old = entries.getJSONObject(i);
                String owner = NativeVoiceJson.nullableString(entry, "recordingId", 160), oldOwner = NativeVoiceJson.nullableString(old, "recordingId", 160);
                if (old.getString("mutationId").equals(entry.getString("mutationId"))) {
                    if (!java.util.Objects.equals(owner, oldOwner)) throw new IllegalStateException("voice_journal_ownership_conflict");
                    next.put(NativeVoiceJson.copy(entry)); replaced = true;
                } else {
                    if (owner != null && owner.equals(oldOwner)) throw new IllegalStateException("voice_journal_ownership_conflict");
                    next.put(old);
                }
            }
            if (!replaced) next.put(NativeVoiceJson.copy(entry));
            if (next.length() > 64 || NativeVoiceJson.bytes(next.toString()) > 8 * 1024 * 1024)
                throw new IllegalStateException("voice_journal_capacity");
            journals.remove(binding);
            write(binding, "journal", NativeVoiceJson.object("version", 1, "entries", next));
            journals.put(binding, next);
        }
    }
    void removeEntry(String binding, String mutationId) throws Exception {
        synchronized (LOCK) {
            JSONArray entries = entries(binding), next = new JSONArray();
            for (int i = 0; i < entries.length(); i++) {
                JSONObject value = entries.getJSONObject(i);
                if (!mutationId.equals(value.getString("mutationId"))) next.put(value);
            }
            // An absent entry needs no write; this also avoids recreating records after profile removal.
            if (next.length() == entries.length()) return;
            journals.remove(binding);
            write(binding, "journal", NativeVoiceJson.object("version", 1, "entries", next));
            journals.put(binding, next);
        }
    }
    static void validateEntry(JSONObject entry) {
        NativeVoiceJson.keys(entry, "mutationId", "threadId", "request", "stage", "cancelled", "createdAt", "recordingId");
        // Field presence is the ownership discriminator: ordinary entries omit it; adopted entries carry one safe ID.
        if (entry.has("recordingId")) {
            String recording = NativeVoiceJson.string(entry, "recordingId", 160);
            if (!recording.matches("[A-Za-z0-9._:-]{1,160}") || recording.equals(".") || recording.equals(".."))
                throw new IllegalArgumentException("voice_journal_recording_invalid");
        }
        String id = NativeVoiceJson.string(entry, "mutationId", 160);
        NativeVoiceJson.string(entry, "threadId", 512);
        JSONObject request = NativeVoiceJson.requiredObject(entry, "request");
        if (!id.equals(request.optString("mutationId"))) throw new IllegalArgumentException("voice_journal_identity");
        NativeVoiceJson.bool(entry, "cancelled");
        NativeVoiceJson.integer(entry, "createdAt", 0, Long.MAX_VALUE);
        String stage = NativeVoiceJson.string(entry, "stage", 32);
        if (!stage.equals("prepared") && !stage.equals("possiblySubmitted")) throw new IllegalArgumentException("voice_journal_stage");
        // A legal 256 KiB transcript can expand sixfold when JSON escapes control characters.
        if (NativeVoiceJson.bytes(request.toString()) > 2 * 1024 * 1024) throw new IllegalArgumentException("voice_input_too_large");
    }
}
