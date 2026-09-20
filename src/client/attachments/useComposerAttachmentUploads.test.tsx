// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerAttachmentDescriptor } from "../../shared/index.js";
import { useComposerAttachmentUploads } from "./useComposerAttachmentUploads.js";

afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const descriptor: ComposerAttachmentDescriptor = {
  id: "attachment-1",
  fileName: "notes.bin",
  kind: "file",
  mediaType: "application/octet-stream",
  byteSize: 4,
};

describe("useComposerAttachmentUploads", () => {
  it("ignores a late successful upload after X aborts and removes its slot", async () => {
    const pending = deferred<ComposerAttachmentDescriptor>();
    const upload = vi.fn(
      (_id: string, _file: File, _signal: AbortSignal) => pending.promise,
    );
    const onUploaded = vi.fn(
      (_attachment: ComposerAttachmentDescriptor) => true,
    );
    const { result } = renderHook(() =>
      useComposerAttachmentUploads({ upload, onUploaded }),
    );

    act(() => result.current.add([new File(["data"], "notes.bin")]));
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    const id = result.current.uploads[0]!.id;
    const signal = upload.mock.calls[0]![2];
    act(() => result.current.remove(id));

    expect(signal.aborted).toBe(true);
    expect(result.current.uploads).toEqual([]);
    await act(async () => pending.resolve({ ...descriptor, id }));
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("links only the successful live slot and removes its local upload card", async () => {
    const upload = vi.fn(async (id: string) => ({ ...descriptor, id }));
    const onUploaded = vi.fn(
      (_attachment: ComposerAttachmentDescriptor) => true,
    );
    const { result } = renderHook(() =>
      useComposerAttachmentUploads({ upload, onUploaded }),
    );

    const file = new File(["data"], "notes.bin");
    act(() => result.current.add([file]));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
    expect(result.current.uploads).toEqual([]);
    const id = upload.mock.calls[0]![0];
    expect(onUploaded.mock.calls[0]![0].id).toBe(id);
    expect(result.current.localFiles.get(id)).toBe(file);

    act(() => result.current.retainLocalFiles(new Set()));
    expect(result.current.localFiles.size).toBe(0);
  });

  it("does not retain the File when the composer rejects the descriptor", async () => {
    const upload = vi.fn(async (id: string) => ({ ...descriptor, id }));
    const onUploaded = vi.fn(
      (_attachment: ComposerAttachmentDescriptor) => false,
    );
    const { result } = renderHook(() =>
      useComposerAttachmentUploads({ upload, onUploaded }),
    );

    act(() => result.current.add([new File(["data"], "notes.bin")]));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
    expect(result.current.uploads).toEqual([]);
    expect(result.current.localFiles.size).toBe(0);
  });

  it("retains a failed file for an explicit retry", async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockImplementationOnce(async (id: string) => ({ ...descriptor, id }));
    const onUploaded = vi.fn(
      (_attachment: ComposerAttachmentDescriptor) => true,
    );
    const { result } = renderHook(() =>
      useComposerAttachmentUploads({ upload, onUploaded }),
    );

    act(() => result.current.add([new File(["data"], "notes.bin")]));
    await waitFor(() => expect(result.current.uploads[0]?.phase).toBe("error"));
    const id = result.current.uploads[0]!.id;
    act(() => result.current.retry(id));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
    expect(upload.mock.calls[1]![0]).toBe(id);
  });
});
