import { describe, expect, it, vi } from "vitest";
import { OpenCodeNativeApi, parseOpenCodeNativeEvent, type OpenCodeNativeEvent, type OpenCodeNativeObservationEnd } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";
import { monitorLiveGate } from "../support/opencode-live-monitor.js";

function event(type: string, data: Record<string, unknown>, sessionID = "ses_fixture"): OpenCodeNativeEvent {
  return parseOpenCodeNativeEvent({ id: "evt_fixture", type, created: 1,
    durable: { aggregateID: sessionID, seq: 1, version: 1 }, data: { sessionID, ...data } });
}
const retry = () => event("session.retry.scheduled", {
  assistantMessageID: "msg_assistant", attempt: 3, at: 1, error: { type: "ProviderError", message: "synthetic retry" },
});
const step = () => event("session.step.started", {
  assistantMessageID: "msg_assistant", agent: "build", model: { providerID: "fixture", id: "fixture" }, started: 1,
});
const text = (length: number, sessionID?: string) => event("session.synthetic", { text: "x".repeat(length) }, sessionID);

function controlledObservation() {
  let include!: (event: OpenCodeNativeEvent) => boolean;
  let end!: (value: OpenCodeNativeObservationEnd) => void;
  let release!: () => void;
  const ended = new Promise<OpenCodeNativeObservationEnd>(resolve => { end = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const close = vi.fn(async () => { await held; end({ reason: "closed" }); });
  const onFailure = vi.fn();
  const lifetime = new AbortController();
  const monitor = monitorLiveGate({
    observe: options => {
      include = options!.include!;
      return { ready: Promise.resolve(), ended, close };
    },
    sessionID: "ses_fixture", signal: lifetime.signal, onFailure,
  });
  return { monitor, emit: (value: OpenCodeNativeEvent) => include(value), end, release, close, onFailure, lifetime };
}

describe("live OpenCode monitor finalization", () => {
  it("waits for close to settle before returning success without aborting the caller lifetime", async () => {
    const current = controlledObservation();
    const finished = vi.fn();
    const result = current.monitor.finish().then(finished);
    await Promise.resolve();
    expect(current.close).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();
    expect(current.lifetime.signal.aborted).toBe(false);
    current.release();
    await result;
    expect(finished).toHaveBeenCalledOnce();
    await current.monitor.close();
    expect(current.close).toHaveBeenCalledOnce();
    expect(current.onFailure).not.toHaveBeenCalled();
  });

  it("rejects a retry delivered while finalizing and retains its attempt-specific cause", async () => {
    const current = controlledObservation();
    const result = current.monitor.finish();
    expect(current.emit(retry())).toBe(false);
    current.release();
    await expect(result).rejects.toMatchObject({
      message: "Live-gate native observation failed: Native provider retry attempt 3 is outside this smoke gate",
      cause: expect.objectContaining({ message: "Native provider retry attempt 3 is outside this smoke gate" }),
    });
    expect(current.onFailure).toHaveBeenCalledOnce();
  });

  it.each(["steps", "bytes"] as const)("includes late %s in the same cumulative budget", async kind => {
    const current = controlledObservation();
    if (kind === "steps") { current.emit(step()); current.emit(step()); }
    else current.emit(text(131_000));
    const result = current.monitor.finish();
    current.emit(kind === "steps" ? step() : text(131_000));
    current.release();
    await expect(result).rejects.toThrow(kind === "steps" ? "step limit exceeded" : "event limit exceeded");
  });

  it("does not count unrelated session activity or retain a queue", async () => {
    const current = controlledObservation();
    expect(current.emit(text(262_145, "ses_other"))).toBe(false);
    expect(current.emit(step())).toBe(false);
    expect(current.emit(step())).toBe(false);
    current.release();
    await expect(current.monitor.finish()).resolves.toBeUndefined();
    expect(current.onFailure).not.toHaveBeenCalled();
  });

  it.each(["disconnected", "overflow", "malformed"] as const)("preserves %s reported during finalization as the original cause", async reason => {
    const current = controlledObservation();
    const cause = new OpenCodeRuntimeError(`opencode_event_${reason}`);
    const result = current.monitor.finish();
    current.end({ reason, error: cause });
    current.release();
    await expect(result).rejects.toMatchObject({ cause, message: `Live-gate native observation failed: opencode_event_${reason}` });
    expect(current.onFailure.mock.calls[0]![0].cause).toBe(cause);
  });

  it("preserves a detected retry after the failure callback aborts the lifetime", async () => {
    const current = controlledObservation();
    current.onFailure.mockImplementation(error => current.lifetime.abort(error));
    current.emit(retry());
    current.end({ reason: "aborted", error: new OpenCodeRuntimeError("opencode_event_aborted") });
    current.release();
    await expect(current.monitor.finish()).rejects.toThrow("retry attempt 3");
    expect(current.onFailure).toHaveBeenCalledOnce();
  });

  it("inspects real decoded events before the native observation can queue and discard them", async () => {
    const fixture = createOpenCodeApiFixture();
    const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture-only", fetch: fixture.fetch });
    const api = new OpenCodeNativeApi(client), lifetime = new AbortController(), onFailure = vi.fn();
    const observation = vi.spyOn(api, "observe");
    const monitor = monitorLiveGate({ observe: options => api.observe(options), sessionID: fixture.sessionID, signal: lifetime.signal, onFailure });
    try {
      await monitor.ready;
      fixture.send(retry());
      await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce());
      expect(observation.mock.results[0]!.value.drain()).toEqual([]);
      await expect(monitor.finish()).rejects.toThrow("retry attempt 3");
    } finally { await monitor.close(); client.close(); }
  });
});
