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
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Device-owned speech secrets never cross the WebView bridge; encryption keys require no interactive unlock. */
final class SpeechCredentialStore {
    private static final Object LOCK = new Object();
    private static final String KEY_ALIAS = "sedes.speech-credentials.v1";
    private final Context context;
    SpeechCredentialStore(Context context) { this.context = context; }

    /** Separate purpose, provider and canonical API root prevent a Sedes token or another speech token being reused. */
    static String binding(String provider, String endpoint) {
        if (!("openai".equals(provider) || "server".equals(provider))) throw new IllegalArgumentException("speech_provider_invalid");
        String base = NativeVoiceSettings.speechBaseUrl(endpoint);
        if (provider.equals("openai") && !NativeVoiceSettings.OPENAI_ENDPOINT.equals(base)) throw new IllegalArgumentException("speech_endpoint_invalid");
        return "speech\n" + provider + "\n" + base;
    }
    private AtomicFile file(String binding) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(binding.getBytes(StandardCharsets.UTF_8));
        StringBuilder name = new StringBuilder();
        for (byte value : hash) name.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        File directory = new File(context.getNoBackupFilesDir(), "device-speech-credentials");
        return new AtomicFile(new File(directory, name + ".enc"));
    }
    private static synchronized SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).setUserAuthenticationRequired(false).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(KEY_ALIAS, null);
    }
    String getCredential(String provider, String endpoint) throws Exception {
        synchronized (LOCK) {
        String binding = binding(provider, endpoint);
        byte[] encrypted;
        AtomicFile target = file(binding);
        // readFully restores an interrupted pre-R write from its backup; checking the base file first would discard it.
        try { encrypted = target.readFully(); }
        catch (FileNotFoundException error) {
            // Failed opens also report permissions and I/O errors this way. Only proven absence means unpaired.
            try {
                if (missing(target.getBaseFile()) && missing(new File(target.getBaseFile().getPath() + ".bak"))) return null;
            } catch (ErrnoException check) { error.addSuppressed(check); }
            throw new IllegalStateException("credential_storage_unavailable", error);
        }
        if (encrypted.length < 29 || encrypted[0] != 1) throw new IllegalStateException("credential_record_invalid");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(encrypted, 1, 13)));
        cipher.updateAAD(binding.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(encrypted, 13, encrypted.length - 13), StandardCharsets.UTF_8);
        }
    }
    private static boolean missing(File file) throws ErrnoException {
        try { Os.lstat(file.getPath()); return false; }
        catch (ErrnoException error) {
            if (error.errno == OsConstants.ENOENT) return true;
            throw error;
        }
    }
    static void validateCredential(String credential) {
        if (credential == null || !credential.matches("[\\x21-\\x7e]{1,4096}")) throw new IllegalArgumentException("credential_invalid");
    }
    void setCredential(String provider, String endpoint, String credential) throws Exception {
        synchronized (LOCK) {
        String binding = binding(provider, endpoint);
        validateCredential(credential);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(binding.getBytes(StandardCharsets.UTF_8));
        AtomicFile file = file(binding);
        File directory = file.getBaseFile().getParentFile();
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("credential_storage_unavailable");
        FileOutputStream output = null;
        try {
            output = file.startWrite();
            output.write(1);
            output.write(cipher.getIV());
            output.write(cipher.doFinal(credential.getBytes(StandardCharsets.UTF_8)));
            file.finishWrite(output);
        } catch (Exception error) { if (output != null) file.failWrite(output); throw error; }
        }
    }
    void removeCredential(String provider, String endpoint) throws Exception {
        synchronized (LOCK) {
            AtomicFile record = file(binding(provider, endpoint)); record.delete();
            if (!missing(record.getBaseFile()) || !missing(new File(record.getBaseFile().getPath() + ".bak")) ||
                !missing(new File(record.getBaseFile().getPath() + ".new"))) throw new IllegalStateException("credential_removal_failed");
        }
    }
}
