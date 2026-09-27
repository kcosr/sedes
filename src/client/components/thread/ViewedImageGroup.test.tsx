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
  origin: { kind: "viewed", capture: "file_snapshot" },
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
    stubIntersectionObserver();
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

  it("shows a running read as working, disclosing an image that already exists", () => {
    const streaming: ViewedImageItem = { ...viewed, status: "streaming" };
    const { container, rerender } = render(<ViewedImageGroup item={streaming} />);
    const row = screen.getByTestId("viewed-image-group");
    expect(row).toHaveAttribute("data-viewed-image-status", "working");
    expect(row).toHaveTextContent(/^Viewed image · screen\.png · Working…$/);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector(".viewed-image-chevron-space")).not.toBeNull();

    stubIntersectionObserver();
    rerender(<ViewedImageGroup item={streaming} image={image} />);
    const disclosure = screen.getByRole("button", {
      name: "Viewed image · screen.png · Working…",
    });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector('[data-item-kind="image"]')).toBeNull();
    fireEvent.click(disclosure);
    expect(container.querySelector('[data-item-kind="image"]')).not.toBeNull();
  });

  it("discloses a failed read's error in place of an image", () => {
    const failed: ViewedImageItem = {
      ...viewed,
      status: "failed",
      error: { category: "not_found", message: { text: "File does not exist." } },
    };
    const { container } = render(<ViewedImageGroup item={failed} />);
    const row = screen.getByTestId("viewed-image-group");
    expect(row).toHaveAttribute("data-viewed-image-status", "failed");
    const disclosure = screen.getByRole("button", {
      name: "Viewed image · screen.png · Failed",
    });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure).toHaveAccessibleDescription("File does not exist.");
    expect(screen.queryByText("File does not exist.")).not.toBeVisible();
    expect(container.querySelector(".op-error")).toBeNull();

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    const error = container.querySelector(".op-error");
    expect(error).toHaveTextContent("File does not exist.");
    expect(error).toBeVisible();
    expect(
      container.querySelector(`#${CSS.escape(disclosure.getAttribute("aria-controls")!)}`),
    ).toContainElement(error as HTMLElement);
    expect(container.querySelector('[data-item-kind="image"]')).toBeNull();
  });

  it("keeps a failed read without an error static", () => {
    const failed: ViewedImageItem = { ...viewed, status: "failed" };
    const { container } = render(<ViewedImageGroup item={failed} />);
    const row = screen.getByTestId("viewed-image-group");
    expect(row).toHaveAttribute("data-viewed-image-status", "failed");
    expect(row).toHaveTextContent(/^Viewed image · screen\.png · Failed$/);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector(".viewed-image-chevron-space")).not.toBeNull();
  });

  it("marks an interrupted read, disclosing an image that already exists", () => {
    const interrupted: ViewedImageItem = { ...viewed, status: "interrupted" };
    const { container, rerender } = render(<ViewedImageGroup item={interrupted} />);
    const row = screen.getByTestId("viewed-image-group");
    expect(row).toHaveAttribute("data-viewed-image-status", "interrupted");
    expect(row).toHaveTextContent(/^Viewed image · screen\.png · Interrupted$/);
    expect(screen.queryByRole("button")).toBeNull();

    stubIntersectionObserver();
    rerender(<ViewedImageGroup item={interrupted} image={image} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Viewed image · screen.png · Interrupted" }),
    );
    expect(container.querySelector('[data-item-kind="image"]')).not.toBeNull();
    expect(container.querySelector(".op-error")).toBeNull();
  });

  it("keeps a completed read's label free of status", () => {
    const { rerender } = render(<ViewedImageGroup item={viewed} />);
    const row = screen.getByTestId("viewed-image-group");
    expect(row).toHaveAttribute("data-viewed-image-status", "completed");
    expect(row).toHaveTextContent(/^Viewed image · screen\.png$/);

    rerender(<ViewedImageGroup item={viewed} image={image} />);
    expect(
      screen.getByRole("button", { name: "Viewed image · screen.png" }),
    ).not.toHaveAccessibleDescription();
  });
});

function stubIntersectionObserver(): void {
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  });
}
