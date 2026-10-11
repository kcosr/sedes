import { deliveryDiagnosticsEnabled } from "./delivery-diagnostic-output.js";

const events = [
  "completion_published", "voice_decision", "voice_published",
  "voice_lane_subscribed", "voice_lane_unsubscribed", "application_stream_closed",
] as const;
export type VoiceDiagnosticEvent = typeof events[number];

const suppressionReasons = [
  "not_claimed", "service_closed", "invalid_event", "disabled", "silenced",
  "recovered", "voice_disabled", "no_recipients", "payload_unavailable", "processing_failed", "policy_changed",
] as const;
export type VoiceDiagnosticSuppressionReason = typeof suppressionReasons[number];

const reasons = [
  "client_closed", "hub_closed", "drain_timeout", "overflow", "transient_overflow",
  "stream_error", "handshake_error", "unsubscribed", "listener_failed", "service_closed",
] as const;
export type VoiceDiagnosticReason = typeof reasons[number];

/** Content-free observations only. Stream counts include browser, Electron and
 * native application streams; listener delivery does not prove receipt or playback. */
export interface VoiceDiagnosticFields {
  readonly threadId?: string;
  readonly turnId?: string;
  readonly sourceEventId?: string;
  readonly provenance?: "live" | "recovered";
  readonly outcome?: "completed" | "failed" | "interrupted";
  readonly claimed?: boolean;
  readonly action?: "none" | "speak" | "speakThenListen";
  readonly scriptQueued?: boolean;
  readonly applicationStreamCount?: number;
  readonly recipientCount?: number;
  readonly attemptedCount?: number;
  readonly deliveredCount?: number;
  readonly durationMs?: number;
  readonly staleGeneration?: boolean;
  readonly suppressionReason?: VoiceDiagnosticSuppressionReason;
  readonly reason?: VoiceDiagnosticReason;
  readonly live?: boolean;
  readonly pendingEventCount?: number;
  readonly pendingBytes?: number;
  readonly transientEventCount?: number;
  readonly transientBytes?: number;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const turnId = /^turn_[A-Za-z0-9_-]{32}$/u;
const sourceEventId = /^[0-9a-f]{64}$/u;
const enumFields = {
  provenance: ["live", "recovered"],
  outcome: ["completed", "failed", "interrupted"],
  action: ["none", "speak", "speakThenListen"],
  suppressionReason: suppressionReasons,
  reason: reasons,
} as const;
const counts = [
  "applicationStreamCount", "recipientCount", "attemptedCount", "deliveredCount",
  "pendingEventCount", "pendingBytes", "transientEventCount", "transientBytes",
] as const;

/** Stderr-only by design: the optional delivery file sink has a separate,
 * deliberately narrow marker allowlist. Logging cannot change delivery. */
export function recordVoiceDiagnostic(event: VoiceDiagnosticEvent, fields: VoiceDiagnosticFields): void {
  try {
    if (!deliveryDiagnosticsEnabled() || !(events as readonly unknown[]).includes(event)) return;
    const record: Record<string, string | number | boolean> = { event, timestamp: new Date().toISOString() };
    for (const key of ["threadId", "turnId", "sourceEventId"] as const) {
      const value = fields[key];
      if (typeof value !== "string") continue;
      const valid = key === "sourceEventId" ? sourceEventId.test(value)
        : key === "turnId" ? turnId.test(value) || uuid.test(value) : uuid.test(value);
      if (valid) record[key] = value;
    }
    for (const key of Object.keys(enumFields) as (keyof typeof enumFields)[]) {
      const value = fields[key];
      if (typeof value === "string" && (enumFields[key] as readonly string[]).includes(value)) record[key] = value;
    }
    for (const key of ["claimed", "scriptQueued", "staleGeneration", "live"] as const) {
      const value = fields[key];
      if (typeof value === "boolean") record[key] = value;
    }
    for (const key of counts) {
      const value = fields[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) record[key] = value;
    }
    const duration = fields.durationMs;
    if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0 && duration <= Number.MAX_SAFE_INTEGER) {
      record.durationMs = Math.round(duration * 100) / 100;
    }
    console.error(`[delivery-voice] ${JSON.stringify(record)}`);
  } catch { /* Optional diagnostics must never change notification or stream behavior. */ }
}
