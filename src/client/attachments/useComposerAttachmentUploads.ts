import { useCallback, useEffect, useRef, useState } from "react";
import type { ComposerAttachmentDescriptor } from "../../shared/index.js";

export type LocalAttachmentUpload = {
  readonly id: string;
  readonly file: File;
  readonly phase: "queued" | "uploading" | "error";
  readonly error?: string;
};

export function useComposerAttachmentUploads({
  upload,
  onUploaded,
}: {
  readonly upload: (
    id: string,
    file: File,
    signal: AbortSignal,
  ) => Promise<ComposerAttachmentDescriptor>;
  readonly onUploaded: (attachment: ComposerAttachmentDescriptor) => boolean;
}) {
  const [uploads, setUploads] = useState<readonly LocalAttachmentUpload[]>([]);
  const [localFiles, setLocalFiles] = useState<ReadonlyMap<string, File>>(
    () => new Map(),
  );
  const controllers = useRef(new Map<string, AbortController>());
  const liveIds = useRef(new Set<string>());
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const add = useCallback((files: readonly File[]) => {
    const additions = files.map((file) => {
      const id = crypto.randomUUID();
      liveIds.current.add(id);
      return { id, file, phase: "queued" as const };
    });
    setUploads((current) => [...current, ...additions]);
  }, []);

  const remove = useCallback((id: string) => {
    liveIds.current.delete(id);
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    setUploads((current) => current.filter((item) => item.id !== id));
    setLocalFiles((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);

  const retainLocalFiles = useCallback((attachmentIds: ReadonlySet<string>) => {
    setLocalFiles((current) => {
      if ([...current.keys()].every((id) => attachmentIds.has(id))) {
        return current;
      }
      return new Map([...current].filter(([id]) => attachmentIds.has(id)));
    });
  }, []);

  const retry = useCallback((id: string) => {
    setUploads((current) =>
      current.map((item) =>
        item.id === id
          ? { id: item.id, file: item.file, phase: "queued" }
          : item,
      ),
    );
  }, []);

  // Upload one file at a time. Besides bounding memory/network pressure, this
  // preserves the user's selection order in the durable draft regardless of
  // server latency.
  useEffect(() => {
    if (uploads.some(({ phase }) => phase === "uploading")) return;
    const next = uploads[0];
    if (!next || next.phase !== "queued") return;
    const controller = new AbortController();
    controllers.current.set(next.id, controller);
    setUploads((current) =>
      current.map((item) =>
        item.id === next.id ? { ...item, phase: "uploading" } : item,
      ),
    );
    void upload(next.id, next.file, controller.signal).then(
      (attachment) => {
        if (!liveIds.current.delete(next.id)) return;
        controllers.current.delete(next.id);
        setUploads((current) => current.filter((item) => item.id !== next.id));
        if (onUploadedRef.current(attachment)) {
          // Retain the immutable browser File only after the composer accepts
          // the descriptor. Draft persistence is separate and may still be
          // delayed, so this exact file remains the preview authority until
          // the attachment leaves the local composer.
          setLocalFiles((current) => {
            const updated = new Map(current);
            updated.set(next.id, next.file);
            return updated;
          });
        }
      },
      (error: unknown) => {
        if (!liveIds.current.has(next.id) || controller.signal.aborted) return;
        controllers.current.delete(next.id);
        setUploads((current) =>
          current.map((item) =>
            item.id === next.id
              ? {
                  ...item,
                  phase: "error",
                  error:
                    error instanceof Error
                      ? error.message
                      : "Attachment upload failed.",
                }
              : item,
          ),
        );
      },
    );
  }, [uploads, upload]);

  useEffect(
    () => () => {
      liveIds.current.clear();
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
    },
    [],
  );

  return {
    uploads,
    localFiles,
    add,
    remove,
    retry,
    retainLocalFiles,
  } as const;
}
