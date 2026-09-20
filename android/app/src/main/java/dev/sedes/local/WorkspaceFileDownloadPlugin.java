package dev.sedes.local;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.widget.Toast;
import android.webkit.MimeTypeMap;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "WorkspaceFileDownload")
public final class WorkspaceFileDownloadPlugin extends Plugin {

    private final Object downloadLock = new Object();
    private final ExecutorService downloadExecutor = Executors.newSingleThreadExecutor();
    private ActiveDownload activeDownload;

    @PluginMethod
    public void downloadFile(PluginCall call) {
        ActiveDownload transfer = null;
        try {
            String transferId = canonicalTransferId(call.getString("transferId"));
            URI requestUri = WorkspaceFileDownloadPolicy.validatedDownloadUri(
                call.getString("serverOrigin"),
                call.getString("url")
            );
            String fileName = WorkspaceFileDownloadPolicy.safeFileName(call.getString("suggestedFileName"));
            long expectedByteSize = WorkspaceFileDownloadPolicy.validatedByteSize(
                call.getData().opt("expectedContentLength")
            );
            String expectedContentDisposition = WorkspaceFileDownloadPolicy.validatedContentDisposition(
                call.getString("expectedContentDisposition")
            );
            String expectedRevision = WorkspaceFileDownloadPolicy.validatedRevision(call.getString("expectedRevision"));

            transfer = new ActiveDownload(
                transferId,
                requestUri,
                expectedByteSize,
                expectedContentDisposition,
                expectedRevision,
                call.getString("profileId"),
                call.getString("serverOrigin")
            );
            synchronized (downloadLock) {
                if (activeDownload != null) throw new IllegalStateException("workspace_file_download_busy");
                activeDownload = transfer;
            }

            call.getData().put("transferId", transferId);
            Intent intent = createDocumentIntent(fileName);
            startActivityForResult(call, intent, "createDocumentResult");
        } catch (Exception error) {
            if (transfer != null) clearActiveDownload(transfer);
            call.reject("The file download could not be started.", "workspace_file_download_start_failed", error);
        }
    }

    static Intent createDocumentIntent(String fileName) {
        return new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(WorkspaceFileDownloadPolicy.documentMimeType(
                fileName, MimeTypeMap.getSingleton()::getMimeTypeFromExtension
            ))
            .putExtra(Intent.EXTRA_TITLE, fileName);
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        try {
            String transferId = canonicalTransferId(call.getString("transferId"));
            synchronized (downloadLock) {
                if (activeDownload == null) {
                    call.resolve();
                    return;
                }
                if (!activeDownload.transferId.equals(transferId)) {
                    throw new IllegalArgumentException("workspace_file_download_identity_mismatch");
                }
                activeDownload.cancel();
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("The file download could not be cancelled.", "workspace_file_download_cancel_failed", error);
        }
    }

    @ActivityCallback
    private void createDocumentResult(PluginCall call, ActivityResult result) {
        ActiveDownload transfer;
        Uri selectedDestination = result.getData() == null ? null : result.getData().getData();
        try {
            String transferId = canonicalTransferId(call.getString("transferId"));
            synchronized (downloadLock) {
                transfer = requireActiveDownload(transferId);
                if (result.getResultCode() != Activity.RESULT_OK || selectedDestination == null) {
                    activeDownload = null;
                    resolveAction(call, "cancelled");
                    return;
                }
                transfer.destination = selectedDestination;
                if (transfer.cancelled) {
                    activeDownload = null;
                    deleteDestination(transfer.destination);
                    resolveAction(call, "cancelled");
                    return;
                }
            }
            downloadExecutor.execute(() -> streamDownload(call, transfer));
        } catch (Exception error) {
            deleteDestination(selectedDestination);
            clearActiveDownload();
            call.reject("The file download could not use the selected destination.", "workspace_file_download_destination_failed", error);
        }
    }

    private void streamDownload(PluginCall call, ActiveDownload transfer) {
        boolean completed = false;
        try {
            HttpURLConnection connection = (HttpURLConnection) transfer.requestUri.toURL().openConnection();
            transfer.connection = connection;
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(WorkspaceFileDownloadPolicy.CONNECT_TIMEOUT_MILLISECONDS);
            connection.setReadTimeout(WorkspaceFileDownloadPolicy.READ_INACTIVITY_TIMEOUT_MILLISECONDS);
            // Missing or temporarily unreadable credentials leave authorization
            // to the server. Never remove a saved credential on a read failure.
            String credential = null;
            try {
                credential = new ClientCredentialStore(getContext()).getCredential(transfer.profileId, transfer.serverOrigin);
            } catch (Exception ignored) {}
            if (credential != null) connection.setRequestProperty("Authorization", "Bearer " + credential);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Accept", "application/octet-stream");
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setUseCaches(false);

            int status = connection.getResponseCode();
            WorkspaceFileDownloadPolicy.validateResponse(
                status,
                connection.getContentLengthLong(),
                connection.getHeaderField("Content-Type"),
                connection.getHeaderField("Content-Disposition"),
                connection.getHeaderField("X-Sedes-Workspace-File-Revision"),
                transfer.expectedByteSize,
                transfer.expectedContentDisposition,
                transfer.expectedRevision
            );
            if (transfer.cancelled) throw new DownloadCancelledException();

            try (
                InputStream input = connection.getInputStream();
                OutputStream output = getContext().getContentResolver().openOutputStream(transfer.destination, "wt")
            ) {
                if (output == null) throw new IOException("workspace_file_download_destination_unavailable");
                transfer.output = output;
                byte[] buffer = new byte[WorkspaceFileDownloadPolicy.STREAM_BUFFER_BYTES];
                long written = 0;
                while (true) {
                    if (transfer.cancelled) throw new DownloadCancelledException();
                    int count = input.read(buffer);
                    if (count < 0) break;
                    if (count == 0) continue;
                    written += count;
                    if (written > transfer.expectedByteSize) {
                        throw new IOException("workspace_file_download_byte_size_exceeded");
                    }
                    output.write(buffer, 0, count);
                }
                if (written != transfer.expectedByteSize) {
                    throw new IOException("workspace_file_download_byte_size_mismatch");
                }
                output.flush();
            } finally {
                transfer.output = null;
            }
            if (transfer.cancelled) throw new DownloadCancelledException();
            completed = true;
            clearActiveDownload(transfer);
            resolveAction(call, "saved");
            showSavedToastBestEffort();
        } catch (Exception error) {
            if (transfer.cancelled || error instanceof DownloadCancelledException) {
                resolveAction(call, "cancelled");
            } else {
                call.reject(
                    "The file could not be downloaded.",
                    WorkspaceFileDownloadPolicy.recognizedFailureCode(error),
                    error
                );
            }
        } finally {
            if (!completed) deleteDestination(transfer.destination);
            clearActiveDownload(transfer);
        }
    }

    @Override
    protected void handleOnDestroy() {
        clearActiveDownload();
        downloadExecutor.shutdownNow();
    }

    private ActiveDownload requireActiveDownload(String transferId) {
        if (activeDownload == null || !activeDownload.transferId.equals(transferId)) {
            throw new IllegalArgumentException("workspace_file_download_identity_mismatch");
        }
        return activeDownload;
    }

    private void clearActiveDownload() {
        ActiveDownload transfer;
        synchronized (downloadLock) {
            transfer = activeDownload;
            if (transfer != null) transfer.cancel();
            activeDownload = null;
        }
        if (transfer != null) deleteDestination(transfer.destination);
    }

    private void clearActiveDownload(ActiveDownload transfer) {
        synchronized (downloadLock) {
            if (activeDownload == transfer) activeDownload = null;
        }
        HttpURLConnection connection = transfer.connection;
        if (connection != null) connection.disconnect();
    }

    private void deleteDestination(Uri destination) {
        if (destination == null) return;
        try {
            Context context = getContext();
            if (context != null && DocumentsContract.isDocumentUri(context, destination)) {
                DocumentsContract.deleteDocument(context.getContentResolver(), destination);
            }
        } catch (Exception ignored) {}
    }

    private void showSavedToastBestEffort() {
        try {
            Activity activity = getActivity();
            Context context = getContext();
            if (activity == null || context == null) return;
            activity.runOnUiThread(() -> {
                try {
                    Toast.makeText(context, "File saved", Toast.LENGTH_SHORT).show();
                } catch (RuntimeException ignored) {}
            });
        } catch (RuntimeException ignored) {}
    }

    private static String canonicalTransferId(String value) {
        if (value == null || !UUID.fromString(value).toString().equals(value)) {
            throw new IllegalArgumentException("workspace_file_download_transfer_id_invalid");
        }
        return value;
    }

    private static void resolveAction(PluginCall call, String action) {
        JSObject result = new JSObject();
        result.put("action", action);
        call.resolve(result);
    }

    private static final class ActiveDownload {
        private final String transferId;
        private final URI requestUri;
        private final long expectedByteSize;
        private final String expectedContentDisposition;
        private final String expectedRevision;
        private final String profileId;
        private final String serverOrigin;
        private volatile boolean cancelled;
        private volatile HttpURLConnection connection;
        private volatile OutputStream output;
        private volatile Uri destination;

        private ActiveDownload(
            String transferId,
            URI requestUri,
            long expectedByteSize,
            String expectedContentDisposition,
            String expectedRevision,
            String profileId,
            String serverOrigin
        ) {
            this.transferId = transferId;
            this.requestUri = requestUri;
            this.expectedByteSize = expectedByteSize;
            this.expectedContentDisposition = expectedContentDisposition;
            this.expectedRevision = expectedRevision;
            this.profileId = profileId;
            this.serverOrigin = serverOrigin;
        }

        private void cancel() {
            cancelled = true;
            HttpURLConnection activeConnection = connection;
            if (activeConnection != null) activeConnection.disconnect();
            OutputStream activeOutput = output;
            if (activeOutput != null) {
                try {
                    activeOutput.close();
                } catch (IOException ignored) {}
            }
        }
    }

    private static final class DownloadCancelledException extends IOException {}
}
