import { USAGE_TOKEN_KINDS, type UsageReport, type UsageSummary } from "../../shared/protocol/usage-accounting.js";
export function usageReport(overrides: Partial<UsageReport> = {}): UsageReport {
  const metrics = Object.fromEntries(USAGE_TOKEN_KINDS.map(key => [key, { value: null, quality: "unreported", basis: [], providerPresence: "unknown" }])) as unknown as UsageSummary["metrics"];
  return { threadId: "thread-1", turnId: "turn-1", revision: "1", support: "supported", state: "partial", captureState: "active",
    measurementScope: "partial_interval", turnState: "completed", lastRecordedAt: "2026-09-22T00:00:00.000Z", inherited: false,
    summary: { metrics, costs: [], costQuality: "unreported", models: [], reasons: [] }, legacy: null, legacyRecordedAt: null, ...overrides };
}
