import { registerPlugin } from "@capacitor/core";

export type PackagedWorkspaceFileDownloadCompletion = "saved" | "cancelled";

interface NativeWorkspaceFileDownload {
  readonly transferId: string;
  readonly profileId: string;
  readonly serverOrigin: string;
  readonly url: string;
  readonly suggestedFileName: string;
  readonly expectedContentDisposition: string;
  readonly expectedContentLength: number;
  readonly expectedRevision: string;
}

interface WorkspaceFileDownloadPlugin {
  downloadFile(input: NativeWorkspaceFileDownload): Promise<{
    readonly action: PackagedWorkspaceFileDownloadCompletion;
  }>;
  cancelDownload(input: { readonly transferId: string }): Promise<void>;
}

export const workspaceFileDownload =
  registerPlugin<WorkspaceFileDownloadPlugin>("WorkspaceFileDownload");
