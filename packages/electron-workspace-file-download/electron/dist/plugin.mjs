import { nativeCredentialStore } from "@sedes/electron-client-credentials/electron/dist/plugin.mjs";
import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BrowserWindow, dialog, net } from "electron";

const ELECTRON_ORIGIN = "capacitor-electron://localhost";
const MAXIMUM_DOWNLOAD_BYTES = 1_024 * 1_024 * 1_024;

function pluginError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function requiredString(value, name, maximumLength = 4_096) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw pluginError(
      "workspace_file_download_input_invalid",
      `${name} is invalid.`,
    );
  }
  return value;
}

function exactByteCounter(expectedByteSize) {
  let receivedByteSize = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      receivedByteSize += chunk.byteLength;
      callback(
        receivedByteSize <= expectedByteSize
          ? null
          : pluginError(
              "workspace_file_download_byte_size_exceeded",
              "The workspace file exceeded its expected size.",
            ),
        chunk,
      );
    },
    flush(callback) {
      callback(
        receivedByteSize === expectedByteSize
          ? null
          : pluginError(
              "workspace_file_download_byte_size_mismatch",
              "The workspace file did not match its expected size.",
            ),
      );
    },
  });
}

function validatedInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw pluginError(
      "workspace_file_download_input_invalid",
      "Download input is invalid.",
    );
  }
  const transferId = requiredString(input.transferId, "transferId", 160);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      transferId,
    )
  ) {
    throw pluginError(
      "workspace_file_download_input_invalid",
      "transferId is invalid.",
    );
  }
  const serverOrigin = new URL(
    requiredString(input.serverOrigin, "serverOrigin"),
  );
  const requestUrl = new URL(requiredString(input.url, "url", 16_384));
  if (
    (serverOrigin.protocol !== "http:" && serverOrigin.protocol !== "https:") ||
    serverOrigin.origin !== input.serverOrigin ||
    serverOrigin.pathname !== "/" ||
    serverOrigin.username ||
    serverOrigin.password ||
    requestUrl.origin !== serverOrigin.origin ||
    requestUrl.username ||
    requestUrl.password ||
    !requestUrl.pathname.startsWith("/api/")
  ) {
    throw pluginError(
      "workspace_file_download_input_invalid",
      "The download URL is outside the configured server origin.",
    );
  }
  const suggestedFileName = requiredString(
    input.suggestedFileName,
    "suggestedFileName",
    255,
  );
  if (
    path.basename(suggestedFileName) !== suggestedFileName ||
    suggestedFileName === "." ||
    suggestedFileName === ".."
  ) {
    throw pluginError(
      "workspace_file_download_input_invalid",
      "The suggested file name is invalid.",
    );
  }
  if (
    !Number.isSafeInteger(input.expectedContentLength) ||
    input.expectedContentLength < 0 ||
    input.expectedContentLength > MAXIMUM_DOWNLOAD_BYTES
  ) {
    throw pluginError(
      "workspace_file_download_input_invalid",
      "The expected content length is invalid.",
    );
  }
  return {
    transferId,
    profileId: requiredString(input.profileId, "profileId", 160),
    serverOrigin: serverOrigin.origin,
    requestUrl: requestUrl.href,
    suggestedFileName,
    expectedContentDisposition: requiredString(
      input.expectedContentDisposition,
      "expectedContentDisposition",
      1_024,
    ),
    expectedContentLength: input.expectedContentLength,
    expectedRevision: requiredString(
      input.expectedRevision,
      "expectedRevision",
      512,
    ),
  };
}

class WorkspaceFileDownloadImpl {
  activeDownloads = new Map();

  async downloadFile(input) {
    const download = validatedInput(input);
    if (this.activeDownloads.size !== 0) {
      throw pluginError(
        "workspace_file_download_busy",
        "Another workspace file download is active.",
      );
    }
    const window =
      BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed()) {
      throw pluginError(
        "workspace_file_download_destination_unavailable",
        "The download window is unavailable.",
      );
    }
    const controller = new AbortController();
    this.activeDownloads.set(download.transferId, controller);
    let selectedPath;
    let temporaryPath;
    let completed = false;
    try {
      const selected = await dialog.showSaveDialog(window, {
        defaultPath: download.suggestedFileName,
        properties: ["showOverwriteConfirmation", "createDirectory"],
      });
      if (selected.canceled || !selected.filePath) {
        return { action: "cancelled" };
      }
      selectedPath = selected.filePath;
      temporaryPath = path.join(
        path.dirname(selectedPath),
        `.${path.basename(selectedPath)}.sedes-${download.transferId}.part`,
      );
      controller.signal.throwIfAborted();
      // The server decides whether this download requires authentication. An
      // unavailable keyring must not block an explicitly public server, and
      // reading failure never changes the saved encrypted credential.
      const { credential } = await nativeCredentialStore()
        .getCredential({ profileId: download.profileId, serverUrl: download.serverOrigin })
        .catch(() => ({ credential: null }));
      const response = await net.fetch(download.requestUrl, {
        method: "GET",
        headers: { Origin: ELECTRON_ORIGIN, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status !== 200) {
        throw pluginError(
          "download_http_status_invalid",
          "The server refused the workspace file download.",
        );
      }
      if (
        response.headers.get("content-type") !== "application/octet-stream" ||
        response.headers.get("content-disposition") !==
          download.expectedContentDisposition
      ) {
        throw pluginError(
          "download_content_disposition_mismatch",
          "The server returned invalid workspace file metadata.",
        );
      }
      if (
        response.headers.get("x-sedes-workspace-file-revision") !==
        download.expectedRevision
      ) {
        throw pluginError(
          "download_revision_mismatch",
          "The workspace file changed before download.",
        );
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (
        !Number.isSafeInteger(contentLength) ||
        contentLength !== download.expectedContentLength
      ) {
        throw pluginError(
          "download_content_length_mismatch",
          "The workspace file length changed before download.",
        );
      }
      if (!response.body) {
        throw pluginError(
          "workspace_file_download_unavailable",
          "The workspace file response has no body.",
        );
      }
      await pipeline(
        Readable.fromWeb(response.body),
        exactByteCounter(download.expectedContentLength),
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
        { signal: controller.signal },
      );
      try {
        await rename(temporaryPath, selectedPath);
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          (error.code !== "EEXIST" && error.code !== "EPERM")
        ) {
          throw error;
        }
        await unlink(selectedPath);
        await rename(temporaryPath, selectedPath);
      }
      completed = true;
      return { action: "saved" };
    } catch (error) {
      if (controller.signal.aborted) {
        throw pluginError(
          "workspace_file_download_cancelled",
          "The workspace file download was cancelled.",
          error,
        );
      }
      if (error && typeof error === "object" && "code" in error) throw error;
      throw pluginError(
        "workspace_file_download_destination_unavailable",
        "The workspace file could not be written to the selected destination.",
        error,
      );
    } finally {
      this.activeDownloads.delete(download.transferId);
      if (!completed && temporaryPath) {
        await unlink(temporaryPath).catch(() => undefined);
      }
    }
  }

  async cancelDownload(input) {
    const transferId = requiredString(input?.transferId, "transferId", 160);
    this.activeDownloads.get(transferId)?.abort();
  }
}

WorkspaceFileDownloadImpl.__capacitorElectronPlugin = {
  name: "WorkspaceFileDownload",
  methods: ["downloadFile", "cancelDownload"],
};

export { WorkspaceFileDownloadImpl as WorkspaceFileDownload };
