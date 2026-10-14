// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "parse5";
import { capturePageDocument, renderPageDocument } from "../../src/server/pages/html-policy.js";
import { PAGE_RESPONSE_MAX_BYTES } from "../../src/shared/protocol/pages.js";

const channel = "1234567890123456";
const requestId = "capture-request-0001";
const frames: HTMLIFrameElement[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const frame of frames.splice(0)) frame.remove();
});

function targetFrame() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frames.push(frame);
  const target = frame.contentWindow as Window & typeof globalThis;
  target.TextEncoder = TextEncoder;
  target.location.hash = `channel=${channel}`;
  target.name = channel;
  const messages: Array<Record<string, unknown>> = [];
  vi.spyOn(target.parent, "postMessage").mockImplementation(value => messages.push(value));
  const listeners = new Map<string, EventListener>();
  vi.spyOn(target, "addEventListener").mockImplementation((name, handler) => {
    listeners.set(name, handler as EventListener);
  });
  const emit = (type: string, event: object) => listeners.get(type)?.(event as Event);
  return { target, messages, emit };
}

function bootstrap() {
  const h = targetFrame();
  const wrapper = new DOMParser().parseFromString(
    renderPageDocument(capturePageDocument(parse("<p>Arbitrary controls</p>"))), "text/html",
  );
  const html = JSON.parse(wrapper.querySelector("#sedes-page-document")!.textContent!) as string;
  h.target.document.documentElement.innerHTML = html;
  h.target.eval(h.target.document.querySelector("script")!.textContent!);
  const api = (h.target as typeof h.target & { sedes: { onSubmit: (producer: unknown) => void } }).sedes;
  const request = (data: Record<string, unknown> = {}, options: object = {}) => h.emit("message", {
    source: h.target.parent, isTrusted: true,
    data: { type: "sedes:page-submit-request", channel, requestId, ...data }, ...options,
  });
  return { ...h, api, request };
}

function wrapper(withHostChannel = true) {
  const h = targetFrame();
  if (!withHostChannel) h.target.location.hash = "";
  h.target.document.documentElement.innerHTML = renderPageDocument(capturePageDocument(parse("<p>Page</p>")));
  const frameListeners = new Map<string, EventListener>();
  vi.spyOn(h.target.HTMLIFrameElement.prototype, "addEventListener").mockImplementation((name, handler) => {
    frameListeners.set(name, handler as EventListener);
  });
  h.target.eval(h.target.document.querySelectorAll("script")[1]!.textContent!);
  const child = h.target.document.querySelector("iframe")!;
  const childPost = vi.spyOn(child.contentWindow!, "postMessage").mockImplementation(() => {});
  const fromChild = (data: Record<string, unknown>, source: unknown = child.contentWindow) =>
    h.emit("message", { source, data: { channel, ...data } });
  const fromHost = (data: Record<string, unknown> = {}, source: unknown = h.target.parent) =>
    h.emit("message", { source, data: { type: "sedes:page-submit-request", channel, requestId, ...data } });
  const load = () => frameListeners.get("load")?.(new Event("load"));
  return { ...h, child, childPost, fromChild, fromHost, load };
}

describe("page response bootstrap", () => {
  it("installs a frozen registration API and evaluates only a host capture once", () => {
    const h = bootstrap(), producer = vi.fn(() => "  User selections\n");
    expect(Object.isFrozen(h.api)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(h.target, "sedes")).toMatchObject({ writable: false, configurable: false });
    expect(() => h.api.onSubmit("text")).toThrow("synchronous text producer");
    h.api.onSubmit(producer);
    expect(producer).not.toHaveBeenCalled();
    expect(h.messages).toEqual([{ type: "sedes:page-submit-ready", channel }]);
    h.request({}, { source: h.target });
    h.request({ channel: "forged-channel" });
    h.request({ requestId: "bad" });
    h.request({}, { isTrusted: false });
    expect(producer).not.toHaveBeenCalled();
    h.request();
    h.request();
    expect(producer).toHaveBeenCalledOnce();
    expect(h.messages.at(-1)).toEqual({ type: "sedes:page-submit-response", channel, requestId, text: "  User selections\n" });
  });

  it("uses the current registered producer and captures text before later edits", () => {
    const h = bootstrap(), old = vi.fn(() => "Old");
    let selection = "Selected";
    h.api.onSubmit(old);
    h.api.onSubmit(() => selection);
    h.request();
    selection = "Edited later";
    expect(old).not.toHaveBeenCalled();
    expect(h.messages.at(-1)?.text).toBe("Selected");
    h.request({ requestId: "capture-request-0002" });
    expect(h.messages.at(-1)?.text).toBe("Edited later");
  });

  it.each([
    [() => " \n\t", "invalid_response"],
    [() => 42, "invalid_response"],
    [() => Promise.resolve("async"), "invalid_response"],
    [() => { throw new Error("private page error"); }, "producer_failed"],
    [() => "😀".repeat(PAGE_RESPONSE_MAX_BYTES / 4 + 1), "response_too_large"],
    [() => "a".repeat(PAGE_RESPONSE_MAX_BYTES + 1), "response_too_large"],
  ])("rejects invalid producers with bounded error codes", (producer, error) => {
    const h = bootstrap();
    h.api.onSubmit(producer);
    h.request();
    expect(h.messages.at(-1)).toEqual({ type: "sedes:page-submit-response", channel, requestId, error });
  });

  it("accepts the exact UTF-8 limit using captured intrinsics", () => {
    const h = bootstrap(), text = "😀".repeat(PAGE_RESPONSE_MAX_BYTES / 4);
    h.api.onSubmit(() => text);
    h.target.String.prototype.trim = () => { throw new Error("authored override"); };
    h.target.TextEncoder = class {} as typeof TextEncoder;
    h.request();
    expect(h.messages.at(-1)?.text).toBe(text);
  });

  it("invalidates the producer on unload", () => {
    const h = bootstrap(), producer = vi.fn(() => "Late");
    h.api.onSubmit(producer);
    h.emit("pagehide", {});
    h.request();
    h.api.onSubmit(producer);
    expect(producer).not.toHaveBeenCalled();
    expect(h.messages.at(-1)).toEqual({ type: "sedes:page-submit-unavailable", channel });
  });
});

describe("trusted page response wrapper", () => {
  it("keeps screenshot preview registration inert without a host channel", () => {
    const h = wrapper(false);
    expect(h.child.name).toBe("");
    h.fromChild({ type: "sedes:page-submit-ready", channel: "" });
    h.fromHost({ channel: "" });
    h.fromChild({ type: "sedes:page-submit-response", channel: "", requestId, text: "Preview response" });
    expect(h.childPost).not.toHaveBeenCalled();
    expect(h.messages).toEqual([]);
  });

  it("relays only the bound child's response to an outstanding host capture", () => {
    const h = wrapper();
    expect(h.child.name).toBe(channel);
    h.fromHost();
    expect(h.childPost).not.toHaveBeenCalled();
    h.fromChild({ type: "sedes:page-submit-ready" }, {});
    h.fromChild({ type: "sedes:page-submit-ready", channel: "wrong-channel" });
    expect(h.messages).toHaveLength(1);
    h.fromChild({ type: "sedes:page-submit-ready" });
    expect(h.messages.at(-1)).toEqual({ type: "sedes:page-submit-ready", channel });
    const count = h.messages.length;
    h.fromChild({ type: "sedes:page-submit-response", requestId, text: "Unsolicited" });
    h.fromHost({}, h.child.contentWindow);
    h.fromHost({ channel: "wrong-channel" });
    expect(h.messages).toHaveLength(count);
    expect(h.childPost).not.toHaveBeenCalled();
    h.fromHost();
    h.fromHost();
    expect(h.childPost).toHaveBeenCalledExactlyOnceWith({ type: "sedes:page-submit-request", channel, requestId }, "*");
    h.fromChild({ type: "sedes:page-submit-response", requestId, text: "Spoof" }, {});
    h.fromChild({ type: "sedes:page-submit-response", requestId: "wrong-request", text: "Wrong" });
    h.fromChild({ type: "sedes:page-submit-response", requestId, text: "Captured" });
    h.fromChild({ type: "sedes:page-submit-response", requestId, text: "Duplicate" });
    expect(h.messages.slice(count)).toEqual([{ type: "sedes:page-submit-response", channel, requestId, text: "Captured" }]);
  });

  it("allows a fresh capture after a timed-out request and ignores late replies", () => {
    const h = wrapper();
    h.fromChild({ type: "sedes:page-submit-ready" });
    h.fromHost();
    const nextId = "capture-request-0002";
    h.fromHost({ requestId: nextId });
    const count = h.messages.length;
    h.fromChild({ type: "sedes:page-submit-response", requestId, text: "Late" });
    expect(h.messages).toHaveLength(count);
    h.fromChild({ type: "sedes:page-submit-response", requestId: nextId, text: "Current" });
    expect(h.messages.at(-1)?.text).toBe("Current");
  });

  it.each([
    [{ text: " \n" }, "invalid_response"],
    [{ text: 123 }, "invalid_response"],
    [{ text: "😀".repeat(PAGE_RESPONSE_MAX_BYTES / 4 + 1) }, "response_too_large"],
    [{ error: "producer_failed" }, "producer_failed"],
  ])("validates child content before forwarding", (content, error) => {
    const h = wrapper();
    h.fromChild({ type: "sedes:page-submit-ready" });
    h.fromHost();
    h.fromChild({ type: "sedes:page-submit-response", requestId, ...content });
    expect(h.messages.at(-1)).toEqual({ type: "sedes:page-submit-response", channel, requestId, error });
  });

  it.each(["unload", "navigation"])("retains the frame guard and invalidates capture on %s", (reason) => {
    const h = wrapper();
    h.fromChild({ type: "sedes:page-submit-ready" });
    h.fromHost();
    const childSource = h.child.contentWindow;
    if (reason === "unload") h.fromChild({ type: "sedes:page-submit-unavailable" });
    else { h.load(); h.load(); }
    expect(h.child.isConnected).toBe(false);
    expect(h.messages.at(-1)).toEqual({ type: "sedes:page-error", channel });
    const count = h.messages.length;
    h.fromChild({ type: "sedes:page-submit-response", requestId, text: "Late" }, childSource);
    h.fromHost({ requestId: "capture-request-0002" });
    expect(h.messages).toHaveLength(count);
    expect(h.childPost).toHaveBeenCalledOnce();
  });
});
