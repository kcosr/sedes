import { afterEach, describe, expect, it, vi } from "vitest";
import * as deliveryOutput from "../../src/server/diagnostics/delivery-diagnostic-output.js";
import {
  recordVoiceDiagnostic,
  type VoiceDiagnosticEvent,
  type VoiceDiagnosticFields,
} from "../../src/server/diagnostics/voice-diagnostics.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

const threadId = "11111111-1111-4111-8111-111111111111";
const turnId = `turn_${"a".repeat(32)}`;
const sourceEventId = "b".repeat(64);

describe("recordVoiceDiagnostic", () => {
  it("does not inspect fields while the delivery gate is disabled", () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const inspect = vi.fn(() => { throw new Error("private getter failure"); });
    expect(() => recordVoiceDiagnostic("voice_decision", { get threadId() { return inspect(); } })).not.toThrow();
    expect(inspect).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("writes content-free metadata to stderr without using the optional file sink", () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T12:00:00.000Z"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fileOutput = vi.spyOn(deliveryOutput, "writeDeliveryDiagnostic");
    recordVoiceDiagnostic("voice_decision", {
      threadId, turnId, sourceEventId, provenance: "recovered", outcome: "completed",
      claimed: true, action: "speakThenListen", scriptQueued: true,
      applicationStreamCount: 3, recipientCount: 0, suppressionReason: "recovered",
    });
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]![0])).toMatch(/^\[delivery-voice\] /u);
    expect(JSON.parse(String(log.mock.calls[0]![0]).slice("[delivery-voice] ".length))).toEqual({
      event: "voice_decision", timestamp: "2026-10-10T12:00:00.000Z",
      threadId, turnId, sourceEventId, provenance: "recovered", outcome: "completed",
      action: "speakThenListen", suppressionReason: "recovered", claimed: true, scriptQueued: true,
      applicationStreamCount: 3, recipientCount: 0,
    });
    expect(fileOutput).not.toHaveBeenCalled();
  });

  it("omits malformed identifiers, arbitrary strings and unrecognized fields", () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const extra = {
      threadId: "private-thread-title", turnId: "/private/provider/path", sourceEventId: "private-event-key",
      provenance: "private-provenance", outcome: "private-error", action: "private-action",
      suppressionReason: "private-reason", reason: "private-message",
      payload: { text: "private speech" }, error: new Error("private error"),
      get toJSON() { throw new Error("must not inspect"); },
    };
    recordVoiceDiagnostic("voice_decision", extra as unknown as VoiceDiagnosticFields);
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0]![0]);
    expect(JSON.parse(line.slice("[delivery-voice] ".length))).toEqual({
      event: "voice_decision", timestamp: expect.any(String),
    });
    expect(line).not.toMatch(/private|payload|error|toJSON/u);
  });

  it("bounds numeric fields and keeps false and zero observations", () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    recordVoiceDiagnostic("voice_published", {
      sourceEventId, claimed: false, staleGeneration: false, attemptedCount: 0, deliveredCount: 0,
      durationMs: 12.346, applicationStreamCount: -1, recipientCount: 1.5,
      pendingBytes: Number.POSITIVE_INFINITY, pendingEventCount: Number.NaN,
      transientBytes: Number.MAX_SAFE_INTEGER + 1,
    });
    expect(JSON.parse(String(log.mock.calls[0]![0]).slice("[delivery-voice] ".length))).toEqual({
      event: "voice_published", timestamp: expect.any(String), sourceEventId,
      claimed: false, staleGeneration: false, attemptedCount: 0, deliveredCount: 0, durationMs: 12.35,
    });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "omits an invalid duration %s", (durationMs) => {
      vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      recordVoiceDiagnostic("voice_published", { durationMs });
      expect(String(log.mock.calls[0]![0])).not.toContain("durationMs");
    },
  );

  it("rejects unknown events before inspecting diagnostic fields", () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const inspect = vi.fn(() => { throw new Error("private getter failure"); });
    recordVoiceDiagnostic("private-event" as VoiceDiagnosticEvent, { get threadId() { return inspect(); } });
    expect(inspect).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("never changes delivery when field inspection or stderr fails", () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "error").mockImplementation(() => { throw new Error("stderr unavailable"); });
    expect(() => recordVoiceDiagnostic("voice_lane_subscribed", { applicationStreamCount: 1 })).not.toThrow();
    expect(log).toHaveBeenCalledOnce();
    expect(() => recordVoiceDiagnostic("voice_decision", {
      get threadId(): string { throw new Error("private getter failure"); },
    })).not.toThrow();
    expect(log).toHaveBeenCalledOnce();
  });
});
