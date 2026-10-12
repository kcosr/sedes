// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  scrollPreviewAncestors,
  startPreviewScrollMomentum,
} from "./inline-touch-scroll.js";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function scrollContainer(maximum: number) {
  const element = document.createElement("div");
  element.style.overflowY = "auto";
  Object.defineProperties(element, {
    clientHeight: { value: 100 },
    scrollHeight: { value: 100 + maximum },
  });
  return element;
}
it("moves the conversation instead of the media and clamps at the edge", () => {
  const conversation = scrollContainer(300),
    media = document.createElement("div");
  document.body.append(conversation);
  conversation.append(media);
  expect(scrollPreviewAncestors(media, 30)).toBe(30);
  expect(conversation.scrollTop).toBe(30);
  expect(media.scrollTop).toBe(0);
  expect(scrollPreviewAncestors(media, 500)).toBe(270);
  expect(conversation.scrollTop).toBe(300);
});
it("hands unconsumed scroll to an ancestor unless overscroll is contained", () => {
  const outer = scrollContainer(500),
    inner = scrollContainer(10),
    media = document.createElement("div");
  document.body.append(outer);
  outer.append(inner);
  inner.append(media);
  expect(scrollPreviewAncestors(media, 30)).toBe(30);
  expect(inner.scrollTop).toBe(10);
  expect(outer.scrollTop).toBe(20);
  inner.style.overscrollBehaviorY = "contain";
  expect(scrollPreviewAncestors(media, 30)).toBe(0);
  expect(outer.scrollTop).toBe(20);
});

let now = 0;
let nextFrameId = 0;
const frames = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  now = 0;
  nextFrameId = 0;
  frames.clear();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrameId, callback);
    return nextFrameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

function advanceFrame() {
  now += 16;
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(now);
}

it.each(["pointerdown", "wheel", "keydown"])(
  "stops a preview fling on %s elsewhere without consuming the new input",
  (eventType) => {
    const conversation = scrollContainer(500);
    const media = document.createElement("div");
    const text = document.createElement("p");
    document.body.append(conversation);
    conversation.append(media, text);
    const stop = startPreviewScrollMomentum(media, 1);
    advanceFrame();
    expect(conversation.scrollTop).toBe(16);

    const event = new Event(eventType, { bubbles: true, cancelable: true });
    expect(text.dispatchEvent(event)).toBe(true);
    advanceFrame();
    expect(conversation.scrollTop).toBe(16);
    expect(frames.size).toBe(0);
    stop();
  },
);

it("allows a second preview to take over scrolling without competing momentum", () => {
  const conversation = scrollContainer(500);
  const first = document.createElement("div");
  const second = document.createElement("div");
  document.body.append(conversation);
  conversation.append(first, second);
  const stopFirst = startPreviewScrollMomentum(first, 1);
  advanceFrame();
  second.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  const stopSecond = startPreviewScrollMomentum(second, -0.5);
  advanceFrame();
  expect(conversation.scrollTop).toBe(8);
  expect(frames.size).toBe(1);
  stopFirst();
  stopSecond();
  advanceFrame();
  expect(conversation.scrollTop).toBe(8);
});

it("releases a fling at the scroll boundary or when its view is removed", () => {
  const conversation = scrollContainer(20);
  const media = document.createElement("div");
  document.body.append(conversation);
  conversation.append(media);
  startPreviewScrollMomentum(media, 1);
  advanceFrame();
  advanceFrame();
  advanceFrame();
  expect(conversation.scrollTop).toBe(20);
  expect(frames.size).toBe(0);

  conversation.scrollTop = 0;
  startPreviewScrollMomentum(media, 1);
  media.remove();
  advanceFrame();
  expect(conversation.scrollTop).toBe(0);
  expect(frames.size).toBe(0);
});
