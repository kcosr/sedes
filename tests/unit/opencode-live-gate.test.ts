import { describe, expect, it, vi } from "vitest";
import type { OpenCodeNativeMessage } from "../../src/server/backends/opencode/opencode-native-api.js";
import { assertLiveGateBudget, cleanupLiveGate, LIVE_GATE_LIMITS, liveConfiguration, parseLiveInput, readLiveCredential, settledCanaryPeriod, within } from "../support/opencode-live-gate.js";

const settings = () => ({
  SEDES_RUN_LIVE_OPENCODE: "1",
  SEDES_REAL_OPENCODE_EXECUTABLE: "/reviewed/opencode2",
  SEDES_LIVE_OPENCODE_PROVIDER_ID: "reviewed-provider",
  SEDES_LIVE_OPENCODE_MODEL_ID: "exact/model",
  SEDES_LIVE_OPENCODE_BASE_URL: "https://provider.example/v1",
  SEDES_LIVE_OPENCODE_API_KEY_ENV: "MY_PROVIDER_KEY",
});
const user = (id: string): OpenCodeNativeMessage => ({ id, type: "user", text: "canary", time: { created: 1 } });
const idle = (id: string): Extract<OpenCodeNativeMessage, { type: "idle" }> => ({ id, type: "idle", outcome: "succeeded", time: { created: 2 } });

describe("live OpenCode preflight", () => {
  it("rejects absent opt-in before reading configuration or credentials", () => {
    const read = vi.fn(() => { throw new Error("must not inspect other settings"); });
    const env = new Proxy({}, { get: (_target, key) => key === "SEDES_RUN_LIVE_OPENCODE" ? undefined : read() });
    expect(() => parseLiveInput(env)).toThrow("explicit opt-in");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["SEDES_REAL_OPENCODE_EXECUTABLE", "opencode2"],
    ["SEDES_LIVE_OPENCODE_PROVIDER_ID", "provider/alias"],
    ["SEDES_LIVE_OPENCODE_MODEL_ID", ""],
    ["SEDES_LIVE_OPENCODE_MODEL_ID", "model\nother"],
    ["SEDES_LIVE_OPENCODE_BASE_URL", "http://provider.example/v1"],
    ["SEDES_LIVE_OPENCODE_BASE_URL", "invalid-url"],
    ["SEDES_LIVE_OPENCODE_BASE_URL", "https://user:secret@provider.example/v1"],
    ["SEDES_LIVE_OPENCODE_BASE_URL", "https://provider.example/v1?key=value"],
    ["SEDES_LIVE_OPENCODE_BASE_URL", "https://provider.example/v1#other"],
    ["SEDES_LIVE_OPENCODE_TOKEN_FIELD", "max_output_tokens"],
    ["SEDES_LIVE_OPENCODE_API_KEY_ENV", "not-a-variable"],
  ])("rejects unqualified %s input before any credential lookup", (key, value) => {
    expect(() => parseLiveInput({ ...settings(), [key]: value })).toThrow();
  });

  it("reads only the explicit credential reference after pure preflight", () => {
    const env = { ...settings(), MY_PROVIDER_KEY: "synthetic-key" };
    const input = parseLiveInput(new Proxy(env, { get: (target, name) => {
      if (name === "MY_PROVIDER_KEY") throw new Error("preflight read a credential");
      return target[name as keyof typeof target];
    } }));
    const read = vi.fn((name: string) => env[name as keyof typeof env]);
    expect(readLiveCredential(input, read)).toBe("synthetic-key");
    expect(read).toHaveBeenCalledExactlyOnceWith("MY_PROVIDER_KEY");
    expect(() => readLiveCredential(input, () => "rejected\nsecret")).toThrow("Provider credential is unavailable");
    expect(() => readLiveCredential(input, () => undefined)).toThrow("Provider credential is unavailable");
  });

  it.each(["max_tokens", "max_completion_tokens"])("bounds native logical steps and the configured %s wire field", tokenField => {
    const input = parseLiveInput({ ...settings(), SEDES_LIVE_OPENCODE_TOKEN_FIELD: tokenField });
    const config = liveConfiguration(input, "/isolated/canary.txt");
    expect(config.model).toBe("reviewed-provider/exact/model");
    expect(config.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: "canary.txt", effect: "allow" }]);
    expect(config.agents.build.steps).toBe(2);
    expect(config.compaction.auto).toBe(false);
    expect(config.providers[input.provider]!.settings).toMatchObject({ apiKey: "{env:OPENCODE_LIVE_GATE_API_KEY}", timeout: 20_000, chunkTimeout: 10_000 });
    expect(config.providers[input.provider]!.models[input.model]!.body).toEqual({ [tokenField]: LIVE_GATE_LIMITS.outputTokens });
  });
});

describe("live OpenCode exact-period completion", () => {
  it("never treats a historic idle or another input as completion", () => {
    expect(settledCanaryPeriod([idle("msg_old_idle"), user("msg_canary")], "msg_canary")).toBeUndefined();
    expect(settledCanaryPeriod([user("msg_other"), idle("msg_old_idle")], "msg_canary")).toBeUndefined();
  });
  it("returns the busy period opening, including preceding native synthetic content", () => {
    const synthetic: OpenCodeNativeMessage = { id: "msg_opening", type: "synthetic", text: "native context", time: { created: 1 } };
    const period = [synthetic, user("msg_canary")];
    expect(settledCanaryPeriod([idle("msg_previous"), ...period, idle("msg_end"), user("msg_future")], "msg_canary"))
      .toEqual({ openingId: "msg_opening", messages: period });
  });
  it("fails a foreign input, duplicate input, or unsuccessful terminal boundary", () => {
    expect(() => settledCanaryPeriod([user("msg_canary"), user("msg_foreign"), idle("msg_end")], "msg_canary")).toThrow("Foreign input");
    expect(() => settledCanaryPeriod([user("msg_canary"), user("msg_canary"), idle("msg_end")], "msg_canary")).toThrow("Duplicate");
    expect(() => settledCanaryPeriod([user("msg_canary"), { ...idle("msg_end"), outcome: "failed" }], "msg_canary")).toThrow("did not succeed");
  });
});

describe("live OpenCode bounded waits and cleanup", () => {
  it("rejects submission after setup consumed the deadline even before the timer callback", () => {
    const lifetime = new AbortController();
    expect(() => assertLiveGateBudget(100, lifetime.signal, 99)).not.toThrow();
    expect(() => assertLiveGateBudget(100, lifetime.signal, 100)).toThrow("deadline");
    lifetime.abort();
    expect(() => assertLiveGateBudget(100, lifetime.signal, 99)).toThrow("deadline");
  });
  it("ends the caller wait on abort and consumes a later read failure", async () => {
    const lifetime = new AbortController();
    let reject!: (reason: Error) => void;
    const pending = new Promise<never>((_resolve, failure) => { reject = failure; });
    const result = within(pending, lifetime.signal);
    lifetime.abort();
    await expect(result).rejects.toThrow("deadline or observation failure");
    reject(new Error("late native response"));
    await Promise.resolve();
  });

  it("attempts runtime shutdown despite synchronous observer failure and handle rejection", async () => {
    const stopped = vi.fn(async () => undefined), disposed = vi.fn(async () => undefined), removed = vi.fn(async () => undefined);
    const result = await cleanupLiveGate({
      observer: () => { throw new Error("observer failed"); }, handle: async () => { throw new Error("handle failed"); },
      stopRuntime: stopped, pendingReads: async () => { expect(stopped).toHaveBeenCalledOnce(); }, disposeSqlite: disposed, removeRoot: removed,
    });
    expect(result.failures.map(error => error.message)).toEqual(["Live-gate observation cleanup failed", "Live-gate handle cleanup failed"]);
    expect(result.rootRetained).toBe(false);
    expect(disposed).toHaveBeenCalledOnce(); expect(removed).toHaveBeenCalledOnce();
  });

  it("disposes SQLite after unproved runtime cleanup and failed readers, retaining isolated native state", async () => {
    const disposed = vi.fn(async () => undefined), removed = vi.fn(async () => undefined);
    const result = await cleanupLiveGate({
      observer: async () => undefined, handle: async () => undefined, stopRuntime: async () => { throw new Error("ownership unproved"); },
      pendingReads: async () => { throw new Error("read failed"); }, disposeSqlite: disposed, removeRoot: removed,
    });
    expect(result.failures).toHaveLength(2); expect(result.rootRetained).toBe(true);
    expect(disposed).toHaveBeenCalledOnce(); expect(removed).not.toHaveBeenCalled();
  });

  it("still removes a stopped runtime's root if SQLite disposal fails", async () => {
    const removed = vi.fn(async () => undefined);
    const result = await cleanupLiveGate({ observer: async () => undefined, handle: async () => undefined,
      stopRuntime: async () => undefined, pendingReads: async () => undefined, disposeSqlite: async () => { throw new Error("database failed"); }, removeRoot: removed });
    expect(result.failures[0]?.message).toBe("Live-gate SQLite cleanup failed");
    expect(removed).toHaveBeenCalledOnce();
  });

  it("reports retention if the final directory removal fails", async () => {
    const result = await cleanupLiveGate({ observer: async () => undefined, handle: async () => undefined,
      stopRuntime: async () => undefined, pendingReads: async () => undefined, disposeSqlite: async () => undefined,
      removeRoot: async () => { throw new Error("filesystem failed"); } });
    expect(result.rootRetained).toBe(true);
    expect(result.failures[0]?.message).toBe("Live-gate root cleanup failed");
  });
});
