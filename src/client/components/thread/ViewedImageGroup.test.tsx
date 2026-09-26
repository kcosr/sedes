// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageItem, ViewedImageItem } from "../../../shared/index.js";
import { ViewedImageGroup } from "./ViewedImageGroup.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const viewed: ViewedImageItem = {
  id: "viewed-1",
  turnId: "turn-1",
  kind: "viewed_image",
  revision: 1,
  status: "completed",
  fileName: { text: "screen.png" },
};

const image: ImageItem = {
  id: "image-1",
  turnId: "turn-1",
  kind: "image",
  revision: 1,
  status: "completed",
  image: {
    representation: "artifact",
    artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    mimeType: "image/png",
    byteSize: 24,
    sha256: "a".repeat(64),
    fileName: { text: "screen.png" },
  },
};

describe("ViewedImageGroup", () => {
  it("stays a static activity-style row until its captured image arrives", () => {
    const { container, rerender } = render(<ViewedImageGroup item={viewed} />);
    expect(screen.getByText("Viewed image · screen.png")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector(".viewed-image-chevron-space")).not.toBeNull();

    const loadOutputArtifactContent = vi.fn(async () => new Blob());
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      disconnect() {}
    });
    rerender(
      <ViewedImageGroup
        item={viewed}
        image={image}
        context={{ assistantLabel: "Assistant", loadOutputArtifactContent }}
      />,
    );
    const disclosure = screen.getByRole("button", { name: "Viewed image · screen.png" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector('[data-item-kind="image"]')).toBeNull();

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector('[data-item-kind="image"]')).not.toBeNull();
    // The row already names the file, so the figure has no caption.
    expect(container.querySelector("figcaption")).toBeNull();
    expect(loadOutputArtifactContent).not.toHaveBeenCalled();

    fireEvent.click(disclosure);
    expect(container.querySelector('[data-item-kind="image"]')).toBeNull();
  });

  it("labels a view without a usable file name generically", () => {
    const { fileName: _fileName, ...unnamed } = viewed;
    render(<ViewedImageGroup item={unnamed} />);
    expect(screen.getByText("Viewed image")).toBeVisible();
  });
});
