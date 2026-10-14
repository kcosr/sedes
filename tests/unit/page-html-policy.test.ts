// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { parse, serialize } from "parse5";
import { capturePageDocument, renderPageDocument } from "../../src/server/pages/html-policy.js";
import { PAGE_MEASUREMENT_INSTALL_SOURCE, PAGE_SETTLE_EXPRESSION } from "../../src/shared/page-sizing.js";

describe("generated page bootstrap", () => {
  it("inserts before user scripts despite misleading markup inside comments", () => {
    const captured = capturePageDocument(parse('<!doctype html><!-- <head> --><html><head><script>window.userCode=true</script></head><body></body></html>'));
    expect(captured.authoredHtml).not.toContain('sedes:page-size');
    expect(captured.escapedHtml).not.toContain('sedes:page-size');
    const wrapper = renderPageDocument(captured);
    const parsed = new DOMParser().parseFromString(wrapper, "text/html");
    const html = JSON.parse(parsed.querySelector("#sedes-page-document")!.textContent!) as string;
    expect(html.indexOf("const document=host.document")).toBeLessThan(html.indexOf("window.userCode"));
    expect(html).toContain("<!-- <head> -->");
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
  });

  it("keeps closing-script content inside inert JSON instead of the wrapper context", () => {
    const source = '</script><script>globalThis.wrapperEscape=true</script>';
    const captured = capturePageDocument(parse(source));
    const wrapper = renderPageDocument(captured);
    const parsed = new DOMParser().parseFromString(wrapper, "text/html");
    expect(parsed.querySelectorAll("script")).toHaveLength(2);
    expect(JSON.parse(parsed.querySelector("#sedes-page-document")!.textContent!)).toContain("globalThis.wrapperEscape=true");
    expect(wrapper).not.toContain(source);
  });


  it("records a stable authored payload and an exact UTF-16 insertion boundary", () => {
    const document = parse('<!doctype html><!-- 😀 \\ " --><html><head><title>🪴</title></head><body>hello</body></html>');
    const original = serialize(document);
    const first = capturePageDocument(document);
    const second = capturePageDocument(document);
    expect(first).toEqual(second);
    expect(first.authoredHtml).toBe(original);
    expect(serialize(document)).toBe(original);
    expect(first.escapedHtml).not.toContain("<");
    expect(JSON.parse(`"${first.escapedHtml}"`)).toBe(original);
    const wrapper = new DOMParser().parseFromString(renderPageDocument(first), "text/html");
    const rendered = JSON.parse(wrapper.querySelector("#sedes-page-document")!.textContent!) as string;
    expect(rendered.indexOf("const document=host.document")).toBeLessThan(rendered.indexOf("<title>"));
    for (const bootstrapOffset of [-1, NaN, first.escapedHtml.length + 1]) {
      expect(() => renderPageDocument({ ...first, bootstrapOffset })).toThrow("page_document_offset_invalid");
    }
  });

  it("announces the complete wrapper before admitting the child document", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const target = frame.contentWindow as Window & typeof globalThis;
    target.TextEncoder = TextEncoder;
    target.location.hash = "channel=1234567890123456";
    const messages: unknown[] = [];
    const postMessage = vi.spyOn(target.parent, "postMessage").mockImplementation(value => { messages.push(value); });
    const wrapper = renderPageDocument(capturePageDocument(parse("<p>Ready document</p>")));
    target.document.documentElement.innerHTML = wrapper;
    const append = vi.spyOn(target.document.body, "append").mockImplementation((...nodes) => {
      expect(messages).toEqual([{ type: "sedes:page-wrapper-ready", channel: "1234567890123456" }]);
      expect((nodes[0] as HTMLIFrameElement).srcdoc).toContain("Ready document");
    });
    try {
      target.eval(target.document.querySelectorAll("script")[1]!.textContent!);
      expect(append).toHaveBeenCalledOnce();
    } finally { postMessage.mockRestore(); frame.remove(); }
  });

  it("reports intrinsic height and shrinkage despite authored globals shadowing browser names", async () => {
    const messages: unknown[] = [];
    const frames: FrameRequestCallback[] = [];
    const observers: ResizeObserverCallback[] = [];
    const frame = document.createElement("iframe");
    frame.src = "about:blank";
    document.body.append(frame);
    const target = frame.contentWindow as Window & typeof globalThis;
    target.TextEncoder = TextEncoder;
    target.location.hash = "channel=1234567890123456";
    const postMessage = vi.spyOn(target.parent, "postMessage").mockImplementation((value: unknown) => { messages.push(value); });
    target.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
    Object.defineProperty(target, "innerHeight", { value: 240 });
    Object.defineProperty(target.HTMLElement.prototype, "scrollHeight", { get: () => 240 });
    target.HTMLElement.prototype.getBoundingClientRect = function () {
      return { bottom: Number(this.getAttribute("data-bottom") ?? 0), top: 0, left: 0, right: 100, width: 100, height: 0, x: 0, y: 0, toJSON() { return {}; } };
    };
    Object.defineProperty(target, "ResizeObserver", { value: class {
      constructor(callback: ResizeObserverCallback) { observers.push(callback); }
      observe() {}
      disconnect() {}
      unobserve() {}
    } });
    Object.defineProperty(target, "MutationObserver", { value: class {
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    } });
    try {
      const innerDocument = parse('<!doctype html><html><head></head><body style="margin-bottom:8px" data-bottom="40"><div data-bottom="80"></div></body></html>');
      const wrapped = new DOMParser().parseFromString(renderPageDocument(capturePageDocument(innerDocument)), "text/html");
      const innerHtml = JSON.parse(wrapped.querySelector("#sedes-page-document")!.textContent!) as string;
      target.document.documentElement.innerHTML = innerHtml;
      target.eval(`${PAGE_MEASUREMENT_INSTALL_SOURCE}(this);`);
      target.eval(`${target.document.querySelector("script")!.textContent!}
        const parent={},innerHeight=9999,innerWidth=7,Math={},Number={};
        const getComputedStyle=()=>{throw new Error("shadowed");},requestAnimationFrame=null,Promise=null;
        let scrollY=99999;`);
      target.dispatchEvent(new target.Event("DOMContentLoaded"));
      expect(target.location.hash).toBe("#channel=1234567890123456");
      expect(observers).toHaveLength(1);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames.splice(0)) frame(0);
      expect(messages.at(-1)).toEqual({ type: "sedes:page-size", height: 88 });
      target.document.body.setAttribute("data-bottom", "15");
      target.document.querySelector("div")!.setAttribute("data-bottom", "20");
      observers[0]!([], {} as ResizeObserver);
      for (const frame of frames.splice(0)) frame(0);
      expect(messages.at(-1)).toEqual({ type: "sedes:page-size", height: 28 });
      const settling = target.eval(PAGE_SETTLE_EXPRESSION) as Promise<void>;
      for (const callback of frames.splice(0)) callback(0);
      for (const callback of frames.splice(0)) callback(0);
      await settling;
      expect(Object.getOwnPropertyDescriptor(target, "__sedesMeasurePage")).toMatchObject({ writable: false, configurable: false });
      expect(Object.getOwnPropertyDescriptor(target, "RTCPeerConnection")).toMatchObject({ value: undefined, writable: false, configurable: false });
    } finally { postMessage.mockRestore(); frame.remove(); }
  });
});
