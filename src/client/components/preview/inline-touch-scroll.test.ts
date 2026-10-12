// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { scrollPreviewAncestors } from "./inline-touch-scroll.js";

afterEach(() => document.body.replaceChildren());
function scrollContainer(maximum: number) {
  const element = document.createElement("div");
  element.style.overflowY = "auto";
  Object.defineProperties(element, { clientHeight: { value: 100 }, scrollHeight: { value: 100 + maximum } });
  return element;
}
it("moves the conversation instead of the media and clamps at the edge", () => {
  const conversation = scrollContainer(300), media = document.createElement("div");
  document.body.append(conversation); conversation.append(media);
  expect(scrollPreviewAncestors(media, 30)).toBe(30);
  expect(conversation.scrollTop).toBe(30);
  expect(media.scrollTop).toBe(0);
  expect(scrollPreviewAncestors(media, 500)).toBe(270);
  expect(conversation.scrollTop).toBe(300);
});
it("hands unconsumed scroll to an ancestor unless overscroll is contained", () => {
  const outer = scrollContainer(500), inner = scrollContainer(10), media = document.createElement("div");
  document.body.append(outer); outer.append(inner); inner.append(media);
  expect(scrollPreviewAncestors(media, 30)).toBe(30);
  expect(inner.scrollTop).toBe(10); expect(outer.scrollTop).toBe(20);
  inner.style.overscrollBehaviorY = "contain";
  expect(scrollPreviewAncestors(media, 30)).toBe(0);
  expect(outer.scrollTop).toBe(20);
});
