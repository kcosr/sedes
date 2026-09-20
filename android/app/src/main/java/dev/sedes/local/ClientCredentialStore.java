package dev.sedes.local;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Device-owned credentials are encrypted and excluded from Android backup. */
final class ClientCredentialStore {
    private static final Object LOCK = new Object();
    private static final String KEY_ALIAS = "sedes.client-credentials.v1";
    private final Context context;
    ClientCredentialStore(Context context) { this.context = context; }

    private static String binding(String profileId, String serverUrl) throws Exception {
        if (profileId == null || !profileId.matches("[A-Za-z0-9._:-]{1,160}")) throw new IllegalArgumentException("credential_profile_invalid");
        URI uri = new URI(serverUrl);
        String scheme = uri.getScheme();
        if (!("https".equals(scheme) || "http".equals(scheme)) || uri.getHost() == null || uri.getRawUserInfo() != null ||
            !(uri.getRawPath().isEmpty() || uri.getRawPath().equals("/")) || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IllegalArgumentException("credential_origin_invalid");
        }
        int port = uri.getPort();
        String origin = scheme + "://" + uri.getHost().toLowerCase(java.util.Locale.ROOT) +
            (port < 0 || (scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80) ? "" : ":" + port);
        return profileId + "\n" + origin;
    }
    private AtomicFile file(String binding) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(binding.getBytes(StandardCharsets.UTF_8));
        StringBuilder name = new StringBuilder();
        for (byte value : hash) name.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        File directory = profileDirectory(binding.substring(0, binding.indexOf("\n")));
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("credential_storage_unavailable");
        return new AtomicFile(new File(directory, name + ".enc"));
    }
    private File profileDirectory(String profileId) throws Exception {
        if (profileId == null || !profileId.matches("[A-Za-z0-9._:-]{1,160}")) throw new IllegalArgumentException("credential_profile_invalid");
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(profileId.getBytes(StandardCharsets.UTF_8));
        StringBuilder name = new StringBuilder();
        for (byte value : hash) name.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return new File(new File(context.getNoBackupFilesDir(), "credentials"), name.toString());
    }
    void removeProfileCredentials(String profileId) throws Exception {
        synchronized (LOCK) {
            File directory = profileDirectory(profileId);
            File[] files = directory.listFiles();
            if (files != null) for (File file : files) if (!file.delete()) throw new IllegalStateException("credential_removal_failed");
            if (directory.exists() && !directory.delete()) throw new IllegalStateException("credential_removal_failed");
        }
    }
    private static synchronized SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
            generator.generateKey();
        }
        return (SecretKey) store.getKey(KEY_ALIAS, null);
    }
    String getCredential(String profileId, String serverUrl) throws Exception {
        synchronized (LOCK) {
        String binding = binding(profileId, serverUrl);
        AtomicFile file = file(binding);
        if (!file.getBaseFile().exists()) return null;
        byte[] encrypted = file.readFully();
        if (encrypted.length < 29 || encrypted[0] != 1) throw new IllegalStateException("credential_record_invalid");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(encrypted, 1, 13)));
        cipher.updateAAD(binding.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(encrypted, 13, encrypted.length - 13), StandardCharsets.UTF_8);
        }
    }
    void setCredential(String profileId, String serverUrl, String credential) throws Exception {
        synchronized (LOCK) {
        String binding = binding(profileId, serverUrl);
        if (credential == null || !credential.matches("[A-Za-z0-9._~-]{16,4096}")) throw new IllegalArgumentException("credential_invalid");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        cipher.updateAAD(binding.getBytes(StandardCharsets.UTF_8));
        AtomicFile file = file(binding);
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
    synchronized void removeCredential(String profileId, String serverUrl) throws Exception { synchronized (LOCK) { file(binding(profileId, serverUrl)).delete(); } }
}
