import { deliveryDiagnosticsEnabled, writeDeliveryDiagnostic } from "../../diagnostics/delivery-diagnostic-output.js";

export type CodexSpeedEligibilityReason = "eligible" | "native_idle" | "closed" |
  "connection_not_ready" | "activation_generation_changed" | "native_control_missing" |
  "native_generation_changed" | "native_turn_changed" | "desired_model_changed" |
  "managed_tui" | "step_switching_disabled" | "step_switching_rejected" |
  "uncertain_connection_changed" | "no_activation";
export type CodexSpeedActivationLoss = "new_handle" | "other_turn" | "completed" |
  "native_idle" | "invalidated" | "rerouted" | "connection_changed";

type Fields = Readonly<{
  applicationThreadId: string;
  handleId?: string;
  backendInstanceId?: string;
  applicationTurnId?: string | null;
  nativeControlApplicationTurnId?: string | null;
  activationId?: string | null;
  generation?: number;
  activationGeneration?: number | null;
  nativeControlGeneration?: number | null;
  lifecycle?: string;
  reason: CodexSpeedEligibilityReason | "draft" | "settings_missing" | "backing_unavailable" |
    "no_offered_tiers" | "controller_missing" | "policy_unavailable" | "current_run_unavailable";
  activationLoss?: CodexSpeedActivationLoss | null;
  availability?: "hidden" | "available" | "read_only";
  policyAvailability?: "available" | "unavailable" | "missing";
  stepSwitchingEnabled?: boolean;
  nativeTurnMatches?: boolean;
  desiredModelMatches?: boolean;
  managedTui?: boolean;
  uncertainContinuityMatches?: boolean;
  activationPresent?: boolean;
  controllerPresent?: boolean;
  fastEnabled?: boolean;
  ultrafastEnabled?: boolean;
}>;

const identifiers = ["applicationThreadId", "handleId", "backendInstanceId", "applicationTurnId",
  "nativeControlApplicationTurnId", "activationId"] as const;
const numbers = ["generation", "activationGeneration", "nativeControlGeneration"] as const;
const booleans = ["stepSwitchingEnabled", "nativeTurnMatches", "desiredModelMatches", "managedTui",
  "uncertainContinuityMatches", "activationPresent", "controllerPresent", "fastEnabled", "ultrafastEnabled"] as const;
const codes = ["reason", "activationLoss", "lifecycle", "availability", "policyAvailability"] as const;

/** One last observation per live handle, or per bounded presentation entry.
 * No native identifiers, configuration, model names or arbitrary errors enter
 * the sink. Failed output never changes provider or presentation behavior. */
export class CodexSpeedDiagnostic {
  #previous: string | undefined;

  record(event: "codex_speed_eligibility" | "codex_speed_presentation", fields: Fields): void {
    try {
      if (!deliveryDiagnosticsEnabled()) return;
      const record: Record<string, unknown> = { event };
      for (const key of identifiers) {
        const value = fields[key];
        if (value !== undefined) record[key] = value === null || /^[a-zA-Z0-9_-]{1,160}$/u.test(value) ? value : "redacted";
      }
      for (const key of codes) {
        const value = fields[key];
        if (value !== undefined) record[key] = value === null || /^[a-z_]{1,64}$/u.test(value) ? value : "redacted";
      }
      for (const key of numbers) {
        const value = fields[key];
        if (value === null || (Number.isSafeInteger(value) && value! >= 0)) record[key] = value;
      }
      for (const key of booleans) if (typeof fields[key] === "boolean") record[key] = fields[key];
      const fingerprint = JSON.stringify(record);
      if (fingerprint === this.#previous) return;
      this.#previous = fingerprint;
      writeDeliveryDiagnostic(`[delivery-attachment] ${JSON.stringify({ ...record, timestamp: new Date().toISOString() })}`);
    } catch { /* Diagnostics are observational. */ }
  }
}

const presentationDiagnostics = new Map<string, CodexSpeedDiagnostic>();
export function codexSpeedPresentationDiagnostic(scope: { tenantId: string; principalId: string }, fields: Fields): void {
  if (!deliveryDiagnosticsEnabled()) return;
  const key = JSON.stringify([scope.tenantId, scope.principalId, fields.applicationThreadId]);
  let diagnostic = presentationDiagnostics.get(key);
  if (!diagnostic) diagnostic = new CodexSpeedDiagnostic();
  presentationDiagnostics.delete(key);
  presentationDiagnostics.set(key, diagnostic);
  if (presentationDiagnostics.size > 4096) presentationDiagnostics.delete(presentationDiagnostics.keys().next().value!);
  diagnostic.record("codex_speed_presentation", fields);
}
