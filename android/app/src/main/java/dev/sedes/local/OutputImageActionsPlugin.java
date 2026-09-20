package dev.sedes.local;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import android.widget.Toast;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.UUID;

@CapacitorPlugin(name = "OutputImageActions")
public final class OutputImageActionsPlugin extends Plugin {

    private static final String CLIPBOARD_DIRECTORY = "output-image-clipboard";
    private static final String TRANSFER_DIRECTORY = "output-image-transfer";
    private static final int TRANSFER_CHUNK_BYTES = 192 * 1024;
    private static final int TRANSFER_CHUNK_BASE64_CHARACTERS = 256 * 1024;

    private final Object transferLock = new Object();
    private ActiveTransfer activeTransfer;

    @PluginMethod
    public void presentActions(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            AlertDialog dialog = new AlertDialog.Builder(getActivity())
                .setTitle("Image actions")
                .setItems(new CharSequence[] { "Save image", "Copy image" }, (ignored, index) -> {
                    JSObject result = new JSObject();
                    result.put("action", index == 0 ? "save" : "copy");
                    call.resolve(result);
                })
                .setNegativeButton("Cancel", (ignored, index) -> resolveAction(call, "cancelled"))
                .setOnCancelListener(ignored -> resolveAction(call, "cancelled"))
                .create();
            dialog.show();
        });
    }

    @PluginMethod
    public void beginTransfer(PluginCall call) {
        try {
            String transferId = canonicalTransferId(call.getString("transferId"));
            String action = call.getString("action");
            String mimeType = call.getString("mimeType");
            String expectedSha256 = call.getString("sha256");
            Integer expectedByteSize = call.getInt("byteSize");
            if (
                !("save".equals(action) || "copy".equals(action)) ||
                mimeType == null ||
                expectedByteSize == null ||
                expectedByteSize <= 0 ||
                expectedByteSize > OutputImageActionsPolicy.MAXIMUM_IMAGE_BYTES ||
                !OutputImageActionsPolicy.isCanonicalSha256(expectedSha256)
            ) {
                throw new IllegalArgumentException("image_transfer_metadata_invalid");
            }
            String extension = OutputImageActionsPolicy.extensionForMimeType(mimeType);
            String fileName = OutputImageActionsPolicy.normalizedFileName(call.getString("fileName"), mimeType);

            synchronized (transferLock) {
                if (activeTransfer != null) throw new IllegalStateException("image_transfer_busy");
                File directory = privateCacheDirectory(TRANSFER_DIRECTORY);
                removeChildren(directory, null);
                File staged = File.createTempFile("image-", ".tmp", directory);
                FileOutputStream output = new FileOutputStream(staged);
                try {
                    activeTransfer = new ActiveTransfer(
                        transferId,
                        action,
                        mimeType,
                        expectedByteSize,
                        expectedSha256,
                        extension,
                        fileName,
                        staged,
                        output,
                        MessageDigest.getInstance("SHA-256")
                    );
                } catch (Exception error) {
                    output.close();
                    staged.delete();
                    throw error;
                }
            }
            call.resolve();
        } catch (Exception error) {
            rejectAction(call, "transfer_begin_failed", error);
        }
    }

    @PluginMethod
    public void appendTransfer(PluginCall call) {
        ActiveTransfer transfer = null;
        try {
            String transferId = canonicalTransferId(call.getString("transferId"));
            Integer index = call.getInt("index");
            String encoded = call.getString("data");
            if (
                index == null || index < 0 || encoded == null || encoded.isEmpty() ||
                encoded.length() > TRANSFER_CHUNK_BASE64_CHARACTERS || encoded.length() % 4 != 0
            ) {
                throw new IllegalArgumentException("image_transfer_chunk_invalid");
            }
            byte[] bytes;
            try {
                bytes = Base64.decode(encoded, Base64.NO_WRAP);
            } catch (IllegalArgumentException error) {
                throw new IllegalArgumentException("image_transfer_chunk_base64_invalid", error);
            }
            if (
                bytes.length == 0 || bytes.length > TRANSFER_CHUNK_BYTES ||
                !Base64.encodeToString(bytes, Base64.NO_WRAP).equals(encoded)
            ) {
                throw new IllegalArgumentException("image_transfer_chunk_noncanonical");
            }

            synchronized (transferLock) {
                transfer = requireActiveTransfer(transferId);
                if (index != transfer.nextIndex) throw new IllegalArgumentException("image_transfer_chunk_order_invalid");
                if (
                    transfer.receivedBytes + bytes.length > transfer.expectedByteSize ||
                    transfer.receivedBytes + bytes.length > OutputImageActionsPolicy.MAXIMUM_IMAGE_BYTES
                ) {
                    throw new IllegalArgumentException("image_transfer_byte_limit_exceeded");
                }
                transfer.output.write(bytes);
                transfer.digest.update(bytes);
                transfer.captureHeader(bytes);
                transfer.receivedBytes += bytes.length;
                transfer.nextIndex += 1;
            }
            call.resolve();
        } catch (Exception error) {
            if (transfer != null) clearTransfer(transfer);
            rejectAction(call, "transfer_append_failed", error);
        }
    }

    @PluginMethod
    public void completeTransfer(PluginCall call) {
        ActiveTransfer transfer = null;
        try {
            String transferId = canonicalTransferId(call.getString("transferId"));
            synchronized (transferLock) {
                transfer = requireActiveTransfer(transferId);
                transfer.output.getFD().sync();
                transfer.output.close();
                transfer.closed = true;
                if (transfer.receivedBytes != transfer.expectedByteSize || transfer.staged.length() != transfer.expectedByteSize) {
                    throw new IllegalArgumentException("image_transfer_byte_size_mismatch");
                }
                OutputImageActionsPolicy.validateImageHeader(
                    transfer.header,
                    transfer.receivedBytes,
                    transfer.mimeType
                );
                String actualSha256 = hexDigest(transfer.digest.digest());
                if (!MessageDigest.isEqual(
                    actualSha256.getBytes(StandardCharsets.US_ASCII),
                    transfer.expectedSha256.getBytes(StandardCharsets.US_ASCII)
                )) {
                    throw new IllegalArgumentException("image_transfer_digest_mismatch");
                }
                activeTransfer = null;
            }

            if ("copy".equals(transfer.action)) {
                copyToClipboard(transfer);
                resolveAction(call, "copied");
                return;
            }

            call.getData().put("stagedPath", transfer.staged.getAbsolutePath());
            call.getData().put("fileName", transfer.fileName);
            call.getData().put("mimeType", transfer.mimeType);
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(transfer.mimeType)
                .putExtra(Intent.EXTRA_TITLE, transfer.fileName);
            startActivityForResult(call, intent, "saveImageResult");
        } catch (Exception error) {
            if (transfer != null) clearTransfer(transfer);
            rejectAction(call, "transfer_complete_failed", error);
        }
    }

    @PluginMethod
    public void abortTransfer(PluginCall call) {
        try {
            String transferId = canonicalTransferId(call.getString("transferId"));
            synchronized (transferLock) {
                if (activeTransfer == null) {
                    call.resolve();
                    return;
                }
                if (!activeTransfer.transferId.equals(transferId)) {
                    throw new IllegalArgumentException("image_transfer_identity_mismatch");
                }
                clearTransferLocked(activeTransfer);
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("The image transfer could not be cancelled.", "transfer_abort_failed", error);
        }
    }

    @ActivityCallback
    private void saveImageResult(PluginCall call, ActivityResult result) {
        String stagedPath = call.getString("stagedPath");
        File staged = stagedPath == null ? null : new File(stagedPath);
        try {
            if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
                resolveAction(call, "cancelled");
                return;
            }
            if (staged == null || !staged.isFile()) throw new IOException("save_staging_unavailable");
            Uri destination = result.getData().getData();
            try (
                FileInputStream input = new FileInputStream(staged);
                OutputStream output = getContext().getContentResolver().openOutputStream(destination, "w")
            ) {
                if (output == null) throw new IOException("save_destination_unavailable");
                input.transferTo(output);
                output.flush();
            }
            Toast.makeText(getContext(), "Image saved", Toast.LENGTH_SHORT).show();
            resolveAction(call, "saved");
        } catch (Exception error) {
            rejectAction(call, "save_failed", error);
        } finally {
            if (staged != null) staged.delete();
        }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (transferLock) {
            if (activeTransfer != null) clearTransferLocked(activeTransfer);
        }
    }

    private void copyToClipboard(ActiveTransfer transfer) throws IOException {
        File directory = privateCacheDirectory(CLIPBOARD_DIRECTORY);
        File imageFile = new File(directory, transfer.expectedSha256 + transfer.extension);
        publishStagedFile(transfer.staged, imageFile);

        Context context = getContext();
        Uri uri = FileProvider.getUriForFile(
            context,
            context.getPackageName() + ".output-image-files",
            imageFile,
            transfer.fileName
        );
        ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) {
            imageFile.delete();
            throw new IOException("clipboard_unavailable");
        }
        clipboard.setPrimaryClip(ClipData.newUri(context.getContentResolver(), transfer.fileName, uri));
        removeChildren(directory, imageFile);
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.S_V2) {
            Toast.makeText(context, "Image copied", Toast.LENGTH_SHORT).show();
        }
    }

    private ActiveTransfer requireActiveTransfer(String transferId) {
        if (activeTransfer == null || !activeTransfer.transferId.equals(transferId)) {
            throw new IllegalArgumentException("image_transfer_identity_mismatch");
        }
        return activeTransfer;
    }

    private void clearTransfer(ActiveTransfer transfer) {
        synchronized (transferLock) {
            clearTransferLocked(transfer);
        }
    }

    private void clearTransferLocked(ActiveTransfer transfer) {
        if (activeTransfer == transfer) activeTransfer = null;
        if (!transfer.closed) {
            try {
                transfer.output.close();
            } catch (IOException ignored) {}
            transfer.closed = true;
        }
        transfer.staged.delete();
    }

    private File privateCacheDirectory(String name) throws IOException {
        File directory = new File(getContext().getCacheDir(), name);
        if ((!directory.exists() && !directory.mkdirs()) || !directory.isDirectory()) {
            throw new IOException("image_cache_unavailable");
        }
        return directory;
    }

    private static void publishStagedFile(File staged, File destination) throws IOException {
        if (destination.exists() && !destination.delete()) throw new IOException("image_cache_replace_failed");
        if (!staged.renameTo(destination)) throw new IOException("image_cache_publish_failed");
    }

    private static void removeChildren(File directory, File except) {
        File[] children = directory.listFiles();
        if (children == null) return;
        for (File child : children) {
            if (except == null || !child.equals(except)) child.delete();
        }
    }

    private static String canonicalTransferId(String value) {
        if (value == null) throw new IllegalArgumentException("image_transfer_id_invalid");
        UUID parsed;
        try {
            parsed = UUID.fromString(value);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("image_transfer_id_invalid", error);
        }
        String canonical = parsed.toString();
        if (!canonical.equals(value)) throw new IllegalArgumentException("image_transfer_id_invalid");
        return canonical;
    }

    private static String hexDigest(byte[] digest) {
        StringBuilder result = new StringBuilder(64);
        for (byte value : digest) result.append(String.format("%02x", value & 0xff));
        return result.toString();
    }

    private static void resolveAction(PluginCall call, String action) {
        JSObject result = new JSObject();
        result.put("action", action);
        call.resolve(result);
    }

    private void rejectAction(PluginCall call, String code, Exception error) {
        Toast.makeText(getContext(), "Image action failed", Toast.LENGTH_SHORT).show();
        call.reject("The image action could not be completed.", code, error);
    }

    private static final class ActiveTransfer {

        final String transferId;
        final String action;
        final String mimeType;
        final int expectedByteSize;
        final String expectedSha256;
        final String extension;
        final String fileName;
        final File staged;
        final FileOutputStream output;
        final MessageDigest digest;
        final byte[] header = new byte[12];
        int headerBytes;
        int receivedBytes;
        int nextIndex;
        boolean closed;

        ActiveTransfer(
            String transferId,
            String action,
            String mimeType,
            int expectedByteSize,
            String expectedSha256,
            String extension,
            String fileName,
            File staged,
            FileOutputStream output,
            MessageDigest digest
        ) {
            this.transferId = transferId;
            this.action = action;
            this.mimeType = mimeType;
            this.expectedByteSize = expectedByteSize;
            this.expectedSha256 = expectedSha256;
            this.extension = extension;
            this.fileName = fileName;
            this.staged = staged;
            this.output = output;
            this.digest = digest;
        }

        void captureHeader(byte[] bytes) {
            int count = Math.min(bytes.length, header.length - headerBytes);
            if (count <= 0) return;
            System.arraycopy(bytes, 0, header, headerBytes, count);
            headerBytes += count;
        }
    }
}
