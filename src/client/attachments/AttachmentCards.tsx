import { useEffect, useRef, useState } from "react";
import { AlertCircle, File, LoaderCircle, RotateCcw, X } from "lucide-react";
import type { ComposerAttachmentDescriptor } from "../../shared/index.js";
import { Button } from "../components/ui/button.js";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentState,
  AttachmentTitle,
  AttachmentTrigger,
} from "../components/ui/attachment.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog.js";
import { WorkspaceImagePreview } from "../workspace-files/WorkspaceImagePreview.js";
import type { LocalAttachmentUpload } from "./useComposerAttachmentUploads.js";
import { canSafelyPreviewRaster } from "./safeRasterPreview.js";

export type ComposerAttachmentContentLoader = (
  attachmentId: string,
  signal: AbortSignal,
) => Promise<Blob>;

function byteSize(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_024 * 1_024) return `${Math.ceil(value / 1_024)} KiB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function PreviewableImage({
  fileName,
  onError,
  onLoad,
  source,
}: {
  readonly fileName: string;
  readonly onError?: (failedSource: string) => void;
  readonly onLoad?: () => void;
  readonly source: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <AttachmentTrigger aria-label={`Preview image: ${fileName}`}>
          <AttachmentMedia>
            <img
              key={source}
              alt=""
              src={source}
              onError={() => onError?.(source)}
              onLoad={onLoad}
            />
          </AttachmentMedia>
        </AttachmentTrigger>
      </DialogTrigger>
      <DialogContent className="attachment-image-dialog sm:max-w-4xl">
        <DialogTitle className="sr-only">Image preview: {fileName}</DialogTitle>
        <WorkspaceImagePreview
          interactionMode="popup"
          path={fileName}
          source={source}
        />
      </DialogContent>
    </Dialog>
  );
}

const DURABLE_IMAGE_RETRY_DELAYS_MS = [250, 1_000] as const;

function DurableImage({
  attachment,
  loadContent,
  localFile,
}: {
  readonly attachment: ComposerAttachmentDescriptor;
  readonly loadContent?: ComposerAttachmentContentLoader;
  readonly localFile?: File;
}) {
  const [source, setSource] = useState<string>();
  const timer = useRef<number | undefined>(undefined);
  const objectUrl = useRef<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setSource(undefined);

    const load = async (attempt: number): Promise<void> => {
      let content: Blob;
      try {
        if (!localFile && !loadContent) return;
        content =
          localFile ?? (await loadContent!(attachment.id, controller.signal));
      } catch {
        if (
          disposed ||
          controller.signal.aborted ||
          localFile ||
          attempt >= DURABLE_IMAGE_RETRY_DELAYS_MS.length
        ) {
          return;
        }
        timer.current = window.setTimeout(() => {
          timer.current = undefined;
          void load(attempt + 1);
        }, DURABLE_IMAGE_RETRY_DELAYS_MS[attempt]);
        return;
      }

      if (
        disposed ||
        controller.signal.aborted ||
        content.size !== attachment.byteSize ||
        (!localFile && content.type !== attachment.mediaType)
      ) {
        return;
      }
      let safe = false;
      try {
        safe = await canSafelyPreviewRaster(content, attachment.mediaType);
      } catch {
        return;
      }
      if (!safe || disposed || controller.signal.aborted) return;
      const url = URL.createObjectURL(content);
      objectUrl.current = url;
      setSource(url);
    };

    void load(0);
    return () => {
      disposed = true;
      controller.abort();
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = undefined;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = undefined;
    };
  }, [
    attachment.byteSize,
    attachment.id,
    attachment.mediaType,
    loadContent,
    localFile,
  ]);

  return source ? (
    <PreviewableImage
      fileName={attachment.fileName}
      source={source}
      onError={(failedSource) => {
        if (objectUrl.current !== failedSource) return;
        URL.revokeObjectURL(failedSource);
        objectUrl.current = undefined;
        setSource((current) =>
          current === failedSource ? undefined : current,
        );
      }}
    />
  ) : (
    <AttachmentMedia>
      <File aria-hidden="true" size={18} strokeWidth={1.7} />
    </AttachmentMedia>
  );
}

function LocalImage({ file }: { readonly file: File }) {
  const [source, setSource] = useState<string>();
  const objectUrl = useRef<string | undefined>(undefined);
  useEffect(() => {
    let disposed = false;
    setSource(undefined);
    void canSafelyPreviewRaster(file)
      .then((safe) => {
        if (disposed || !safe) return;
        const url = URL.createObjectURL(file);
        objectUrl.current = url;
        setSource(url);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = undefined;
    };
  }, [file]);
  return source ? (
    <PreviewableImage
      fileName={file.name}
      source={source}
      onError={(failedSource) => {
        if (objectUrl.current !== failedSource) return;
        URL.revokeObjectURL(failedSource);
        objectUrl.current = undefined;
        setSource((current) =>
          current === failedSource ? undefined : current,
        );
      }}
    />
  ) : (
    <AttachmentMedia>
      <File aria-hidden="true" size={18} strokeWidth={1.7} />
    </AttachmentMedia>
  );
}

function FileMedia() {
  return (
    <AttachmentMedia>
      <File aria-hidden="true" size={18} strokeWidth={1.7} />
    </AttachmentMedia>
  );
}

export function DurableAttachmentCard({
  attachment,
  loadContent,
  localFile,
  onRemove,
}: {
  readonly attachment: ComposerAttachmentDescriptor;
  readonly loadContent?: ComposerAttachmentContentLoader;
  readonly localFile?: File;
  readonly onRemove?: () => void;
}) {
  return (
    <Attachment data-attachment-id={attachment.id}>
      {attachment.kind === "image" && (localFile || loadContent) ? (
        <DurableImage
          attachment={attachment}
          loadContent={loadContent}
          localFile={localFile}
        />
      ) : (
        <FileMedia />
      )}
      <AttachmentContent>
        <AttachmentTitle title={attachment.fileName}>
          {attachment.fileName}
        </AttachmentTitle>
        <AttachmentDescription>
          {attachment.kind === "image" ? "Image" : "File"} ·{" "}
          {byteSize(attachment.byteSize)}
        </AttachmentDescription>
      </AttachmentContent>
      {onRemove && (
        <AttachmentActions>
          <AttachmentAction>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove attachment: ${attachment.fileName}`}
              onClick={onRemove}
            >
              <X aria-hidden="true" />
            </Button>
          </AttachmentAction>
        </AttachmentActions>
      )}
    </Attachment>
  );
}

export function LocalAttachmentCard({
  upload,
  onRemove,
  onRetry,
}: {
  readonly upload: LocalAttachmentUpload;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
}) {
  const raster = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ].includes(upload.file.type);
  return (
    <Attachment data-upload-id={upload.id} aria-busy={upload.phase !== "error"}>
      {raster ? (
        <LocalImage file={upload.file} />
      ) : (
        <AttachmentMedia>
          {upload.phase === "error" ? (
            <AlertCircle aria-hidden="true" size={18} />
          ) : (
            <File aria-hidden="true" size={18} />
          )}
        </AttachmentMedia>
      )}
      <AttachmentContent>
        <AttachmentTitle title={upload.file.name}>
          {upload.file.name}
        </AttachmentTitle>
        <AttachmentDescription>
          <AttachmentState role={upload.phase === "error" ? "alert" : "status"}>
            {upload.phase === "queued"
              ? "Waiting to upload…"
              : upload.phase === "uploading"
                ? "Uploading…"
                : (upload.error ?? "Upload failed.")}
          </AttachmentState>
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        {upload.phase === "error" && (
          <AttachmentAction>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Retry attachment: ${upload.file.name}`}
              onClick={onRetry}
            >
              <RotateCcw aria-hidden="true" />
            </Button>
          </AttachmentAction>
        )}
        {upload.phase === "uploading" && (
          <LoaderCircle className="attachment-spinner" aria-hidden="true" />
        )}
        <AttachmentAction>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove attachment: ${upload.file.name}`}
            onClick={onRemove}
          >
            <X aria-hidden="true" />
          </Button>
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  );
}
