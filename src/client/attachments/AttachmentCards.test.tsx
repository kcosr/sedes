// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DurableAttachmentCard,
  LocalAttachmentCard,
} from "./AttachmentCards.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function safePngBytes(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x48,
    0x44, 0x52, 0, 0, 0x02, 0x80, 0, 0, 0x01, 0xe0,
  ]);
}

function safePngBlob(): Blob {
  return new Blob([safePngBytes().buffer as ArrayBuffer], {
    type: "image/png",
  });
}

describe("attachment cards", () => {
  it("owns and revokes the blob URL used for an immediate raster preview", async () => {
    const createObjectURL = vi.fn(() => "blob:local-preview");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const { container, unmount } = render(
      <LocalAttachmentCard
        upload={{
          id: "upload-1",
          file: new File(
            [
              new Uint8Array([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
                0x49, 0x48, 0x44, 0x52, 0, 0, 0x02, 0x80, 0, 0, 0x01, 0xe0,
              ]),
            ],
            "photo.png",
            { type: "image/png" },
          ),
          phase: "uploading",
        }}
        onRemove={() => undefined}
        onRetry={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "blob:local-preview",
      );
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Preview image: photo.png" }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Image preview for photo.png")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:local-preview");
  });

  it.each([
    [
      "image/jpeg",
      new Uint8Array([
        0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 0x0b, 8, 0, 1, 0, 1,
        3, 1, 0x11, 0, 2, 0x11,
      ]),
    ],
    [
      "image/gif",
      new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]),
    ],
    [
      "image/webp",
      new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
        0x38, 0x58, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]),
    ],
  ])(
    "creates a local preview only after validating a bounded %s header",
    async (mediaType, bytes) => {
      const createObjectURL = vi.fn(() => `blob:${mediaType}`);
      vi.stubGlobal("URL", {
        ...URL,
        createObjectURL,
        revokeObjectURL: vi.fn(),
      });
      render(
        <LocalAttachmentCard
          upload={{
            id: `upload-${mediaType}`,
            file: new File([bytes], `photo.${mediaType.slice(6)}`, {
              type: mediaType,
            }),
            phase: "uploading",
          }}
          onRemove={() => undefined}
          onRetry={() => undefined}
        />,
      );
      await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    },
  );

  it("renders a durable generic file without an active preview", () => {
    render(
      <DurableAttachmentCard
        attachment={{
          id: "attachment-1",
          fileName: "archive.zip",
          kind: "file",
          mediaType: "application/octet-stream",
          byteSize: 2_048,
        }}
      />,
    );
    expect(screen.getByText("archive.zip")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("opens a durable safe image preview while keeping remove independent", async () => {
    const onRemove = vi.fn();
    const content = safePngBlob();
    const loadContent = vi.fn(async () => content);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:durable-preview"),
      revokeObjectURL: vi.fn(),
    });
    const { container } = render(
      <DurableAttachmentCard
        attachment={{
          id: "attachment-image",
          fileName: "durable.png",
          kind: "image",
          mediaType: "image/png",
          byteSize: content.size,
        }}
        loadContent={loadContent}
        onRemove={onRemove}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "blob:durable-preview",
      ),
    );
    expect(loadContent).toHaveBeenCalledWith(
      "attachment-image",
      expect.any(AbortSignal),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Remove attachment: durable.png" }),
    );
    expect(onRemove).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Preview image: durable.png" }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("retries a failed durable content fetch without rendering a broken URL", async () => {
    vi.useFakeTimers();
    const content = safePngBlob();
    const loadContent = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValue(content);
    const createObjectURL = vi.fn(() => "blob:retried-preview");
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });
    const { container } = render(
      <DurableAttachmentCard
        attachment={{
          id: "attachment-race",
          fileName: "linked-later.png",
          kind: "image",
          mediaType: "image/png",
          byteSize: content.size,
        }}
        loadContent={loadContent}
      />,
    );
    await act(async () => Promise.resolve());
    expect(container.querySelector("img")).toBeNull();
    expect(loadContent).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "blob:retried-preview",
    );
    expect(createObjectURL).toHaveBeenCalledWith(content);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a pending durable content fetch on unmount", async () => {
    let signal: AbortSignal | undefined;
    const loadContent = vi.fn(async (_id: string, candidate: AbortSignal) => {
      signal = candidate;
      return await new Promise<Blob>(() => undefined);
    });
    const { unmount } = render(
      <DurableAttachmentCard
        attachment={{
          id: "attachment-unmount",
          fileName: "unmounted.png",
          kind: "image",
          mediaType: "image/png",
          byteSize: safePngBlob().size,
        }}
        loadContent={loadContent}
      />,
    );
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("ignores a stale image error after a newer object URL is active", async () => {
    const content = safePngBlob();
    const createObjectURL = vi
      .fn()
      .mockReturnValueOnce("blob:first-preview")
      .mockReturnValueOnce("blob:second-preview");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const loadContent = vi.fn(async () => content);
    const { container, rerender } = render(
      <DurableAttachmentCard
        attachment={{
          id: "attachment-first",
          fileName: "first.png",
          kind: "image",
          mediaType: "image/png",
          byteSize: content.size,
        }}
        loadContent={loadContent}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "blob:first-preview",
      ),
    );
    const staleImage = container.querySelector("img")!;

    rerender(
      <DurableAttachmentCard
        attachment={{
          id: "attachment-second",
          fileName: "second.png",
          kind: "image",
          mediaType: "image/png",
          byteSize: content.size,
        }}
        loadContent={loadContent}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "blob:second-preview",
      ),
    );

    fireEvent.error(staleImage);
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "blob:second-preview",
    );
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:second-preview");
  });

  it("prefers the verified local file while the uploaded attachment remains in the composer", async () => {
    const localFile = new File(
      [safePngBytes().buffer as ArrayBuffer],
      "local.png",
      { type: "image/png" },
    );
    const loadContent = vi.fn(async () => safePngBlob());
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:retained-local-preview"),
      revokeObjectURL: vi.fn(),
    });
    const { container } = render(
      <DurableAttachmentCard
        attachment={{
          id: "attachment-local",
          fileName: "local.png",
          kind: "image",
          mediaType: "image/png",
          byteSize: localFile.size,
        }}
        loadContent={loadContent}
        localFile={localFile}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        "blob:retained-local-preview",
      ),
    );
    expect(loadContent).not.toHaveBeenCalled();
  });

  it("does not create a blob preview for an oversized raster header", async () => {
    const createObjectURL = vi.fn(() => "blob:oversized-preview");
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    new DataView(bytes.buffer).setUint32(16, 16_385);
    new DataView(bytes.buffer).setUint32(20, 1);
    const { container } = render(
      <LocalAttachmentCard
        upload={{
          id: "upload-oversized",
          file: new File([bytes], "oversized.png", { type: "image/png" }),
          phase: "uploading",
        }}
        onRemove={() => undefined}
        onRetry={() => undefined}
      />,
    );
    await waitFor(() => expect(createObjectURL).not.toHaveBeenCalled());
    expect(container.querySelector("img")).toBeNull();
  });

  it("does not create a blob preview from an unverified raster declaration", async () => {
    const createObjectURL = vi.fn(() => "blob:unsafe-preview");
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });
    const { container } = render(
      <LocalAttachmentCard
        upload={{
          id: "upload-unsafe",
          file: new File(["<svg></svg>"], "claimed.png", {
            type: "image/png",
          }),
          phase: "uploading",
        }}
        onRemove={() => undefined}
        onRetry={() => undefined}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
  });
});
