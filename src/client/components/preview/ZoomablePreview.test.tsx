// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ZoomablePreview } from "./ZoomablePreview.js";

afterEach(cleanup);

describe("ZoomablePreview", () => {
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
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("75%");
    expect(container.querySelector(".zoomable-preview-canvas")).toHaveStyle({
      "--zoomable-preview-content-padding": "12px",
      height: "75%",
      width: "75%",
    });
    expect(container.querySelector(".zoomable-preview-canvas")).toHaveAttribute(
      "data-reduced",
      "true",
    );
    expect(screen.getByRole("button", { name: "Reset preview" })).toBeEnabled();

    fireEvent.click(zoomOut);
    fireEvent.click(zoomOut);
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("25%");
    expect(zoomOut).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Reset preview" }));
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");
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
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");

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
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("122%");
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
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");
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

    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("150%");
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
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("150%");

    pointer("pointerDown", 3, 220);
    pointer("pointerUp", 3, 220);
    pointer("pointerMove", 2, 180);
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("180%");

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
    const reset = screen.getByRole("button", { name: "Reset preview" });
    expect(screen.getByLabelText("Zoom level")).toHaveTextContent("100%");
    expect(reset).toBeDisabled();

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
    expect(reset).toBeDisabled();

    viewport.scrollTop = 180;
    fireEvent.scroll(viewport);
    fireEvent.keyDown(viewport, { key: "0" });
    expect(viewport.scrollTop).toBe(0);
    expect(reset).toBeDisabled();
  });
});
