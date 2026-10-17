// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startBrowserDownload } from "./browser-download.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  document.querySelectorAll(".sedes-download-frame").forEach((frame) => frame.remove());
  vi.useRealTimers();
});

const download = (signal?: AbortSignal) => {
  const onFailure = vi.fn();
  startBrowserDownload({
    url: "/api/download", signal, onFailure,
    failureMessage: "Could not download HTML.",
    redirectMessage: "Unexpected redirect.",
  });
  return { onFailure, frame: document.querySelector<HTMLIFrameElement>(".sedes-download-frame")! };
};

it("uses a hidden, streamed attachment navigation and removes it on cancellation", () => {
  const controller = new AbortController();
  const { frame, onFailure } = download(controller.signal);
  expect(frame.hidden).toBe(true);
  expect(frame).toHaveAttribute("aria-hidden", "true");
  expect(frame.src).toBe(new URL("/api/download", window.location.href).href);
  controller.abort();
  expect(frame.isConnected).toBe(false);
  frame.dispatchEvent(new Event("load"));
  expect(onFailure).not.toHaveBeenCalled();
});

it("does not initiate a cancelled navigation", () => {
  const controller = new AbortController();
  controller.abort();
  const { frame } = download(controller.signal);
  expect(frame).toBeNull();
});

it("reports an unexpected redirect without inspecting its document", () => {
  const { frame, onFailure } = download();
  Object.defineProperty(frame, "contentWindow", { value: { location: { href: "https://other.example/download" } } });
  frame.dispatchEvent(new Event("load"));
  expect(onFailure).toHaveBeenCalledWith("Unexpected redirect.");
  expect(frame.isConnected).toBe(false);
});

it("reports a stable error for an opaque failure document", () => {
  const { frame, onFailure } = download();
  Object.defineProperty(frame, "contentWindow", { get: () => { throw new DOMException("opaque", "SecurityError"); } });
  frame.dispatchEvent(new Event("load"));
  expect(onFailure).toHaveBeenCalledWith("Could not download HTML.");
  expect(frame.isConnected).toBe(false);
});
