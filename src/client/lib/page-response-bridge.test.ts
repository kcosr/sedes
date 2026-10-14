import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_RESPONSE_MAX_BYTES } from "../../shared/protocol/pages.js";
import { PageResponseBridge, PAGE_RESPONSE_CAPTURE_TIMEOUT_MS } from "./page-response-bridge.js";

const channel = "1234567890123456";

function setup() {
  const postMessage = vi.fn();
  const source = { postMessage } as unknown as Window;
  const onReady = vi.fn();
  const bridge = new PageResponseBridge({ source, channel, onReady });
  const send = (data: Record<string, unknown>, from: MessageEventSource | null = source) =>
    bridge.handleMessage({ source: from, data: { channel, ...data } });
  const ready = () => send({ type: "sedes:page-submit-ready" });
  const requestId = () => (postMessage.mock.lastCall?.[0] as { requestId: string }).requestId;
  const reply = (data: Record<string, unknown>) => send({ type: "sedes:page-submit-response", requestId: requestId(), ...data });
  return { bridge, postMessage, source, send, ready, reply, requestId, onReady };
}

afterEach(() => vi.useRealTimers());

describe("PageResponseBridge", () => {
  it("requires registration from the bound wrapper and an explicit capture", async () => {
    const h = setup();
    h.send({ type: "sedes:page-submit-ready" }, {} as Window);
    h.send({ type: "sedes:page-submit-ready", channel: "another-channel" });
    await expect(h.bridge.capture()).rejects.toThrow("not ready");
    expect(h.onReady).not.toHaveBeenCalled();
    h.ready();
    h.ready();
    h.send({ type: "sedes:page-submit-response", requestId: "unsolicited", text: "Injected" });
    expect(h.onReady).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.postMessage).not.toHaveBeenCalled();
    const captured = h.bridge.capture();
    expect(h.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "sedes:page-submit-request", channel, requestId: expect.any(String),
    }, "*");
    h.reply({ text: "  Selected option\n" });
    await expect(captured).resolves.toBe("  Selected option\n");
    h.bridge.dispose();
  });

  it("ignores foreign, stale, duplicate and unsolicited responses", async () => {
    const h = setup();
    h.ready();
    const captured = h.bridge.capture(), resolved = vi.fn();
    void captured.then(resolved);
    const oldRequestId = h.requestId();
    const response = { type: "sedes:page-submit-response", requestId: oldRequestId, text: "Wrong" };
    h.send(response, {} as Window);
    h.send({ ...response, channel: "wrong-channel" });
    h.send({ ...response, requestId: "wrong-request" });
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    await expect(h.bridge.capture()).rejects.toThrow("already being captured");
    h.reply({ text: "First" });
    await expect(captured).resolves.toBe("First");
    h.reply({ text: "Duplicate" });
    const next = h.bridge.capture();
    expect(h.requestId()).not.toBe(oldRequestId);
    h.send({ ...response, text: "Late old response" });
    h.reply({ text: "Second" });
    await expect(next).resolves.toBe("Second");
    expect(resolved).toHaveBeenCalledExactlyOnceWith("First");
    h.bridge.dispose();
  });

  it("times out without accepting a late response into a later capture", async () => {
    vi.useFakeTimers();
    const h = setup();
    h.ready();
    const first = h.bridge.capture(), requestId = h.requestId();
    const rejected = expect(first).rejects.toThrow("did not respond");
    vi.advanceTimersByTime(PAGE_RESPONSE_CAPTURE_TIMEOUT_MS);
    await rejected;
    const second = h.bridge.capture();
    h.send({ type: "sedes:page-submit-response", requestId, text: "Late" });
    h.reply({ text: "Current" });
    await expect(second).resolves.toBe("Current");
    h.bridge.dispose();
  });

  it.each(["dispose", "frame error"])("invalidates pending capture and registration on %s", async (action) => {
    vi.useFakeTimers();
    const h = setup();
    h.ready();
    const captured = h.bridge.capture();
    const rejected = expect(captured).rejects.toThrow("Page changed");
    if (action === "dispose") h.bridge.dispose();
    else h.send({ type: "sedes:page-error" });
    await rejected;
    h.reply({ text: "After removal" });
    h.ready();
    expect(h.onReady.mock.calls).toEqual([[true], [false]]);
    await expect(h.bridge.capture()).rejects.toThrow("not ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [{ text: " \n\t" }, "nonblank"],
    [{ text: 42 }, "nonblank"],
    [{ text: "😀".repeat(PAGE_RESPONSE_MAX_BYTES / 4 + 1) }, "UTF-8"],
    [{ error: "producer_failed" }, "could not prepare"],
    [{ error: "invalid_response" }, "synchronous"],
    [{ error: "secret callback exception" }, "could not prepare"],
  ])("rejects invalid text and producer errors", async (data, message) => {
    const h = setup();
    h.ready();
    const captured = h.bridge.capture();
    h.reply(data as Record<string, unknown>);
    await expect(captured).rejects.toThrow(message as string);
    h.bridge.dispose();
  });

  it("accepts exactly the UTF-8 limit", async () => {
    const h = setup();
    h.ready();
    const captured = h.bridge.capture(), text = "😀".repeat(PAGE_RESPONSE_MAX_BYTES / 4);
    h.reply({ text });
    await expect(captured).resolves.toBe(text);
    h.bridge.dispose();
  });

  it("rejects transport failure and permits a fresh explicit attempt", async () => {
    const h = setup();
    h.ready();
    h.postMessage.mockImplementationOnce(() => { throw new Error("detached"); });
    await expect(h.bridge.capture()).rejects.toThrow("could not prepare");
    const retry = h.bridge.capture();
    h.reply({ text: "Retry" });
    await expect(retry).resolves.toBe("Retry");
    h.bridge.dispose();
  });
});
