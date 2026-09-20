import { getEndpointProfile } from "../authentication/auth-transport.js";
import { configuredSedesServer } from "./server-endpoint.js";
import { isAndroidClient, isElectronClient } from "./client-platform.js";
import {
  workspaceFileDownload,
  type PackagedWorkspaceFileDownloadCompletion,
} from "./workspace-file-download-plugin.js";

export function supportsPackagedWorkspaceFileDownloads(): boolean {
  return isAndroidClient() || isElectronClient();
}

export async function downloadWorkspaceFileInPackagedClient(input: {
  readonly serverOrigin: string;
  readonly url: string;
  readonly suggestedFileName: string;
  readonly expectedContentDisposition: string;
  readonly expectedContentLength: number;
  readonly expectedRevision: string;
  readonly signal?: AbortSignal;
}): Promise<PackagedWorkspaceFileDownloadCompletion> {
  if (!supportsPackagedWorkspaceFileDownloads()) return "cancelled";
  if (input.signal?.aborted) throw input.signal.reason;

  const profileId = getEndpointProfile(configuredSedesServer(input.serverOrigin));
  if (!profileId) throw new Error("Pair this server connection before downloading files.");
  const transferId = crypto.randomUUID();
  const cancel = (): void => {
    void workspaceFileDownload
      .cancelDownload({ transferId })
      .catch(() => undefined);
  };
  input.signal?.addEventListener("abort", cancel, { once: true });
  try {
    let result: {
      readonly action: PackagedWorkspaceFileDownloadCompletion;
    };
    try {
      result = await workspaceFileDownload.downloadFile({
        transferId,
        profileId,
        serverOrigin: input.serverOrigin,
        url: input.url,
        suggestedFileName: input.suggestedFileName,
        expectedContentDisposition: input.expectedContentDisposition,
        expectedContentLength: input.expectedContentLength,
        expectedRevision: input.expectedRevision,
      });
    } catch (error) {
      throw friendlyPackagedDownloadError(error);
    }
    if (input.signal?.aborted) throw input.signal.reason;
    return result.action;
  } finally {
    input.signal?.removeEventListener("abort", cancel);
  }
}

function friendlyPackagedDownloadError(error: unknown): unknown {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  switch (code) {
    case "download_revision_mismatch":
      return new Error(
        "The file changed before it could be downloaded. Refresh and try again.",
      );
    case "download_content_length_mismatch":
    case "workspace_file_download_byte_size_exceeded":
    case "workspace_file_download_byte_size_mismatch":
      return new Error(
        "The downloaded file did not match the expected size. Refresh and try again.",
      );
    case "download_content_type_invalid":
    case "download_content_disposition_mismatch":
      return new Error("The server returned invalid file download metadata.");
    case "download_http_status_invalid":
      return new Error("The file is no longer available to download.");
    case "workspace_file_download_destination_unavailable":
      return new Error("The selected download destination is unavailable.");
    default:
      return error;
  }
}
