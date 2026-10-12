// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZoomablePreview } from "./ZoomablePreview.js";

afterEach(cleanup);

describe("ZoomablePreview", () => {
  it("reports natural-pixel scale and uses 1:1 for actual image size", () => {
    const { container } = render(
      <ZoomablePreview
        controlsLabel="Image controls"
        interactionMode="popup"
        resetLabel="Reset image"
        title="Image"
        viewportLabel="Image viewport"
      >
        <img alt="Natural size image" />
      </ZoomablePreview>,
    );
    const viewport = screen.getByRole("region", { name: "Image viewport" });
    const image = screen.getByRole("img", { name: "Natural size image" });
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 200 },
    });
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 1000 },
      naturalHeight: { configurable: true, value: 500 },
    });
    fireEvent.load(image);
    expect(
      screen.getByRole("button", { name: "Zoom percentage: 20%" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Actual size (100%)" }));
    expect(
      screen.getByRole("button", { name: "Zoom percentage: 100%" }),
    ).toBeVisible();
    expect(container.querySelector(".zoomable-preview-content")).toHaveStyle({
      width: "1000px",
      height: "500px",
    });
    fireEvent.click(screen.getByRole("button", { name: "Fit to view" }));
    expect(
      screen.getByRole("button", { name: "Zoom percentage: 20%" }),
    ).toBeVisible();
    expect(container.querySelector("header")).toBeNull();
  });

  it("restores a natural-size image view even when it is more than four times fit", () => {
    render(
      <ZoomablePreview
        controlsLabel="Image controls"
        interactionMode="popup"
        initialViewState={{
          zoom: 5,
          horizontalCenter: 0.5,
          verticalCenter: 0.5,
        }}
        resetLabel="Reset image"
        title="Image"
        viewportLabel="Restored image"
      >
        <img alt="Restored" />
      </ZoomablePreview>,
    );
    const viewport = screen.getByRole("region", { name: "Restored image" });
    const image = screen.getByRole("img", { name: "Restored" });
    Object.defineProperties(viewport, {
      clientWidth: { value: 200 },
      clientHeight: { value: 200 },
    });
    Object.defineProperties(image, {
      naturalWidth: { value: 1000 },
      naturalHeight: { value: 500 },
    });
    fireEvent.load(image);
    expect(
      screen.getByRole("button", { name: "Zoom percentage: 100%" }),
    ).toBeVisible();
  });

  it("routes a single-finger inline swipe to chat, pinches to zoom, and then drags without clicking", () => {
    const gesture = vi.fn();
    const { container } = render(
      <ZoomablePreview
        controlsLabel="Image controls"
        interactionMode="inline"
        onGestureStart={gesture}
        resetLabel="Reset image"
        title="Image"
        viewportLabel="Inline image"
      >
        <img alt="" />
      </ZoomablePreview>,
    );
    const viewport = screen.getByRole("region", { name: "Inline image" });
    expect(screen.queryByRole("group", { name: "Image controls" })).toBeNull();
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 500 },
    });
    Object.assign(viewport, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn(),
    });
    const pointer = (
      type: "pointerDown" | "pointerMove" | "pointerUp",
      pointerId: number,
      x: number,
      y = 0,
    ) =>
      fireEvent[type](viewport, {
        pointerId,
        pointerType: "touch",
        clientX: x,
        clientY: y,
        button: 0,
      });
    expect(pointer("pointerDown", 1, 0)).toBe(false);
    expect(pointer("pointerMove", 1, 0, 30)).toBe(false);
    pointer("pointerDown", 2, 100, 30);
    pointer("pointerMove", 2, 150, 30);
    expect(
      screen.getByRole("button", { name: "Zoom percentage: 150%" }),
    ).toBeVisible();
    expect(gesture).toHaveBeenCalled();
    pointer("pointerUp", 2, 150, 30);
    const before = viewport.scrollLeft;
    pointer("pointerMove", 1, -20, 30);
    expect(viewport.scrollLeft).toBeGreaterThan(before);
    expect(fireEvent.click(viewport)).toBe(false);
    expect(container.querySelector(".zoomable-preview-shell")).toHaveAttribute(
      "data-mode",
      "inline",
    );
    pointer("pointerUp", 1, -20, 30);
    Object.defineProperties(viewport, {
      scrollWidth: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 200 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fit to view" }));
    // Controls stay until an explicit tap; returning to fit is not a dismissal.
    expect(screen.getByRole("group", { name: "Image controls" })).toBeVisible();
    fireEvent.click(viewport);
    expect(screen.queryByRole("group", { name: "Image controls" })).toBeNull();
  });

  it("toggles inline controls on deliberate taps and owns touch gestures from fit", () => {
    render(<ZoomablePreview controlsLabel="Inline controls" interactionMode="inline" resetLabel="Reset" title="Image" viewportLabel="Inline"><img alt="" /></ZoomablePreview>);
    const viewport = screen.getByRole("region", { name: "Inline" });
    expect(viewport).toHaveAttribute("data-gesture-zoom", "true");
    expect(screen.queryByRole("group", { name: "Inline controls" })).toBeNull();
    fireEvent.click(viewport);
    expect(screen.getByRole("group", { name: "Inline controls" })).toBeVisible();
    fireEvent.click(viewport);
    expect(screen.queryByRole("group", { name: "Inline controls" })).toBeNull();
  });

  it("zooms below 100% without shrinking the popup viewport", () => {
    const { container } = render(
      <ZoomablePreview
        controlsLabel="Preview controls"
        interactionMode="popup"
        resetLabel="Reset preview"
        title="Preview"
        viewportLabel="Preview viewport"
      >
        <img alt="" />
      </ZoomablePreview>,
    );

    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    fireEvent.click(zoomOut);
    expect(
      screen.getByRole("button", { name: /^Zoom percentage:/ }),
    ).toHaveTextContent("75%");
    expect(container.querySelector(".zoomable-preview-canvas")).toHaveStyle({
      "--zoomable-preview-content-padding": "12px",
      height: "75%",
      width: "75%",
    });
    expect(container.querySelector(".zoomable-preview-canvas")).toHaveAttribute(
      "data-reduced",
      "true",
    );
    expect(screen.getByRole("button", { name: "Fit to view" })).toBeEnabled();

    fireEvent.click(zoomOut);
    fireEvent.click(zoomOut);
    expect(
      screen.getByRole("button", { name: /^Zoom percentage:/ }),
    ).toHaveTextContent("25%");
    expect(zoomOut).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Fit to view" }));
    expect(
      screen.getByRole("button", { name: /^Zoom percentage:/ }),
    ).toHaveTextContent("100%");
  });

  it("keeps popup trackpad zoom contained and accumulates wheel deltas", () => {
    render(
      <ZoomablePreview
        controlsLabel="Preview controls"
        interactionMode="popup"
        resetLabel="Reset preview"
        title="Preview"
        viewportLabel="Preview viewport"
      >
        <img alt="" />
      </ZoomablePreview>,
    );
    const viewport = screen.getByRole("region", {
      name: "Preview viewport",
    });

    expect(fireEvent.wheel(viewport, { deltaY: -25 })).toBe(true);
    expect(
      screen.getByRole("button", { name: /^Zoom percentage:/ }),
    ).toHaveTextContent("100%");

    for (let index = 0; index < 2; index += 1) {
      const pinch = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -40,
      });
      fireEvent(viewport, pinch);
      expect(pinch.defaultPrevented).toBe(true);
    }
    expect(
      screen.getByRole("button", { name: /^Zoom percentage:/ }),
    ).toHaveTextContent("122%");
  });

  it("leaves trackpad and sub-100% zoom disabled outside popup mode", () => {
    render(
      <ZoomablePreview
        controlsLabel="Preview controls"
        resetLabel="Reset preview"
        title="Preview"
        viewportLabel="Preview viewport"
      >
        <img alt="" />
      </ZoomablePreview>,
    );
    const viewport = screen.getByRole("region", {
      name: "Preview viewport",
    });
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -40,
    });

    fireEvent(viewport, wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(
      screen.getByRole("button", { name: /^Zoom percentage:/ }),
    ).toHaveTextContent("100%");
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
  });

  it("zooms from a two-pointer touch pinch inside the preview", () => {
    render(
      <ZoomablePreview
        controlsLabel="Preview controls"
        interactionMode="popup"
        resetLabel="Reset preview"
        title="Preview"
        viewportLabel="Preview viewport"
      >
        <img alt="" />
      </ZoomablePreview>,
    );
    const viewport = screen.getByRole("region", {
      name: "Preview viewport",
    });
    Object.assign(viewport, {
      hasPointerCapture: () => true,
      releasePointerCapture: () => undefined,
      setPointerCapture: () => undefined,
    });

    fireEvent.pointerDown(viewport, {
      button: 0,
      clientX: 0,
      clientY: 0,
      pointerId: 1,
      pointerType: "touch",
    });
    fireEvent.pointerDown(viewport, {
      button: 0,
      clientX: 100,
      clientY: 0,
      pointerId: 2,
      pointerType: "touch",
    });
    fireEvent.pointerMove(viewport, {
      clientX: 150,
      clientY: 0,
      pointerId: 2,
      pointerType: "touch",
    });

    expect(
      screen.getByRole("button", { name: /^Zoom percentage:/ }),
    ).toHaveTextContent("150%");
  });

  it("keeps a two-finger pinch active across a third touch and promotes a remaining finger after cancellation", () => {
    render(
      <ZoomablePreview
        controlsLabel="Preview controls"
        interactionMode="popup"
        resetLabel="Reset preview"
        title="Preview"
        viewportLabel="Preview viewport"
      >
        <img alt="" />
      </ZoomablePreview>,
    );
    const viewport = screen.getByRole("region", {
      name: "Preview viewport",
    });
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 200 },
      clientWidth: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 600 },
      scrollWidth: { configurable: true, value: 600 },
    });
    Object.assign(viewport, {
      hasPointerCapture: () => true,
      releasePointerCapture: () => undefined,
      setPointerCapture: () => undefined,
    });
    const pointer = (
      type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel",
      pointerId: number,
      clientX: number,
    ) =>
      fireEvent[type](viewport, {
        button: 0,
        clientX,
        clientY: 0,
        pointerId,
        pointerType: "touch",
      });

    pointer("pointerDown", 1, 0);
    pointer("pointerDown", 2, 100);
    pointer("pointerMove", 2, 150);
    expect(
      screen.getByRole("button", { name: /^Zoom percentage:/ }),
    ).toHaveTextContent("150%");

    pointer("pointerDown", 3, 220);
    pointer("pointerUp", 3, 220);
    pointer("pointerMove", 2, 180);
    expect(
      screen.getByRole("button", { name: /^Zoom percentage:/ }),
    ).toHaveTextContent("180%");

    pointer("pointerCancel", 1, 0);
    expect(viewport).toHaveAttribute("data-dragging", "true");
  });

  it("resets a panned, overflowing preview at base zoom with the button and 0 shortcut", () => {
    render(
      <ZoomablePreview
        controlsLabel="Preview controls"
        resetLabel="Reset preview"
        title="Tall preview"
        viewportLabel="Tall preview viewport"
      >
        <img alt="" />
      </ZoomablePreview>,
    );

    const viewport = screen.getByRole("region", {
      name: "Tall preview viewport",
    });
    const reset = screen.getByRole("button", { name: "Fit to view" });
    expect(
      screen.getByRole("button", { name: /^Zoom percentage:/ }),
    ).toHaveTextContent("100%");
    expect(reset).toBeEnabled();

    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 900 },
      scrollWidth: { configurable: true, value: 400 },
    });
    viewport.scrollTop = 240;
    fireEvent.scroll(viewport);
    expect(reset).toBeEnabled();

    fireEvent.click(reset);
    expect(viewport.scrollTop).toBe(0);
    expect(reset).toBeEnabled();

    viewport.scrollTop = 180;
    fireEvent.scroll(viewport);
    fireEvent.keyDown(viewport, { key: "0" });
    expect(viewport.scrollTop).toBe(0);
    expect(reset).toBeEnabled();
  });
});
