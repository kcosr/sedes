// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneResizeHandle } from "./PaneResizeHandle.js";

let animationFrames: Array<FrameRequestCallback | undefined>;

beforeEach(() => {
  animationFrames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    animationFrames[id - 1] = undefined;
  });
  Object.assign(window.HTMLElement.prototype, {
    hasPointerCapture: vi.fn(() => true),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  document.body.style.removeProperty("cursor");
  document.body.style.removeProperty("user-select");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function flushAnimationFrame(index = animationFrames.length - 1): void {
  animationFrames[index]?.(performance.now());
  animationFrames[index] = undefined;
}

function handle(
  options: Partial<React.ComponentProps<typeof PaneResizeHandle>> = {},
) {
  const onPreview = vi.fn();
  const onCommit = vi.fn();
  const view = render(
    <PaneResizeHandle
      orientation="row"
      value={100}
      min={80}
      max={140}
      resetValue={110}
      ariaLabel="Resize test pane"
      testId="resize-handle"
      onPreview={onPreview}
      onCommit={onCommit}
      {...options}
    />,
  );
  return {
    element: screen.getByTestId("resize-handle"),
    onPreview,
    onCommit,
    ...view,
  };
}

describe("PaneResizeHandle", () => {
  it("previews row movement through rAF and commits once on pointerup", () => {
    const onInteractionChange = vi.fn();
    const { element, onPreview, onCommit } = handle({ onInteractionChange });

    expect(element).toHaveAttribute("role", "separator");
    expect(element).toHaveAttribute("aria-orientation", "vertical");
    expect(element).toHaveAttribute("aria-valuemin", "80");
    expect(element).toHaveAttribute("aria-valuemax", "140");
    expect(element).toHaveAttribute("aria-valuenow", "100");

    fireEvent.pointerDown(element, {
      button: 0,
      isPrimary: true,
      pointerId: 7,
      clientX: 20,
    });
    expect(element).toHaveAttribute("data-dragging", "true");
    expect(onInteractionChange).toHaveBeenLastCalledWith(true);
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerMove(element, { pointerId: 7, clientX: 90 });
    expect(onPreview).not.toHaveBeenCalled();
    flushAnimationFrame();
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenLastCalledWith(140);
    expect(element).toHaveAttribute("aria-valuenow", "140");

    fireEvent.pointerUp(element, { pointerId: 7, clientX: 90 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(140);
    expect(element).not.toHaveAttribute("data-dragging");
    expect(onInteractionChange).toHaveBeenLastCalledWith(false);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("uses column geometry and rolls an unexpected capture loss back", () => {
    document.body.style.cursor = "wait";
    document.body.style.userSelect = "text";
    const { element, onPreview, onCommit } = handle({
      orientation: "column",
    });
    expect(element).toHaveAttribute("aria-orientation", "horizontal");

    fireEvent.pointerDown(element, {
      button: 0,
      isPrimary: true,
      pointerId: 3,
      clientY: 40,
    });
    expect(document.body.style.cursor).toBe("row-resize");
    fireEvent.pointerMove(element, { pointerId: 3, clientY: 65 });
    flushAnimationFrame();
    expect(onPreview).toHaveBeenLastCalledWith(125);

    fireEvent.lostPointerCapture(element, { pointerId: 3 });
    expect(onPreview).toHaveBeenLastCalledWith(100);
    expect(onCommit).not.toHaveBeenCalled();
    expect(element).toHaveAttribute("aria-valuenow", "100");
    expect(document.body.style.cursor).toBe("wait");
    expect(document.body.style.userSelect).toBe("text");
  });

  it("supports orientation-specific keys, clamping, and reset", () => {
    const { element, onCommit } = handle({
      orientation: "column",
      keyboardStep: 16,
    });

    fireEvent.keyDown(element, { key: "ArrowLeft" });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(element, { key: "ArrowUp" });
    expect(onCommit).toHaveBeenLastCalledWith(84);
    fireEvent.keyDown(element, { key: "ArrowUp" });
    expect(onCommit).toHaveBeenLastCalledWith(80);
    fireEvent.doubleClick(element);
    expect(onCommit).toHaveBeenLastCalledWith(110);
  });

  it("reverses pointer and keyboard movement for a right-anchored pane", () => {
    const { element, onPreview, onCommit } = handle({ reverse: true });

    fireEvent.pointerDown(element, {
      button: 0,
      isPrimary: true,
      pointerId: 9,
      clientX: 100,
    });
    fireEvent.pointerMove(element, { pointerId: 9, clientX: 70 });
    flushAnimationFrame();
    expect(onPreview).toHaveBeenLastCalledWith(130);
    fireEvent.pointerUp(element, { pointerId: 9, clientX: 70 });
    expect(onCommit).toHaveBeenLastCalledWith(130);

    fireEvent.keyDown(element, { key: "ArrowLeft" });
    expect(onCommit).toHaveBeenLastCalledWith(140);
    fireEvent.keyDown(element, { key: "ArrowRight" });
    expect(onCommit).toHaveBeenLastCalledWith(124);
  });

  it("rolls back and restores body interaction styles when unmounted", () => {
    const { element, onPreview, onCommit, unmount } = handle();
    fireEvent.pointerDown(element, {
      button: 0,
      isPrimary: true,
      pointerId: 11,
      clientX: 10,
    });
    fireEvent.pointerMove(element, { pointerId: 11, clientX: 30 });
    flushAnimationFrame();
    expect(onPreview).toHaveBeenLastCalledWith(120);

    unmount();
    expect(onPreview).toHaveBeenLastCalledWith(100);
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });
});
