import { deliveryDiagnosticsEnabled, writeDeliveryDiagnostic } from "./delivery-diagnostic-output.js";

/** Observational main/sidecar diagnostics. All callers supply identifiers or
 * code-owned tokens, never native thread IDs, request bodies, or configuration. */
export interface AttachmentDiagnosticFields {
  readonly backendInstanceId?: string;
  readonly executionEnvironmentId?: string;
  readonly generation?: number;
  readonly controllerEpoch?: number;
  readonly carrierGeneration?: number;
  readonly attachmentAttempt?: number;
  readonly attachmentId?: string;
  readonly role?: string;
  readonly requestId?: string;
  readonly operationId?: string;
  readonly method?: string;
  readonly stage?: string;
  readonly durationMs?: number;
  readonly outcome?: string;
  readonly transportKind?: string;
  readonly reason?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly pendingOperationRequests?: number;
  readonly pendingOperationSends?: number;
  readonly inboundIdleMs?: number;
  readonly outboundIdleMs?: number;
  readonly requestedClose?: boolean;
  readonly deferred?: boolean;
  readonly outcomeCount?: number;
  readonly pendingRequestCount?: number;
  readonly queuedWriteBytes?: number;
  readonly queuedWriteFrames?: number;
  readonly activeWriteBytes?: number;
  readonly frameBytes?: number;
}

const names = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "AbortError", "TimeoutError",
  "SqliteError", "BackendError", "CodexRpcDeliveryError", "CodexRpcRemoteError", "CodexRpcProtocolError",
  "SidecarOperationError", "SidecarProtocolError", "SidecarProtocolDeliveryError", "SidecarFrameWriteError",
  "SidecarTransportCleanupError", "SidecarSessionCleanupError", "ZodError"]);
const token = /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,159}$/u;
const machineCode = /^(?:(?:codex|sidecar|ssh|execution|provider|transport|runtime)_[a-z0-9_]+|SQLITE_[A-Z_]+|ERR_[A-Z0-9_]+|E(?:CONNRESET|CONNREFUSED|PIPE|TIMEDOUT|NOENT|ACCES|IO|NOMEM|NOSPC))$/u;
const closureReasons = new Set(["exit", "spawn_error", "stderr_overflow", "end", "closed", "lease_closed", "lease_rejected", "idle_release", "operator_restart", "supervisor_close", "connection_failed", "receipt_record", "receipt_acknowledge", "thread_evict"]);
const textFields = ["backendInstanceId", "executionEnvironmentId", "attachmentId", "role", "requestId", "operationId", "method", "stage", "outcome", "transportKind", "reason", "signal"] as const;
const numberFields = ["generation", "controllerEpoch", "carrierGeneration", "attachmentAttempt", "durationMs", "exitCode", "pendingOperationRequests", "pendingOperationSends", "inboundIdleMs", "outboundIdleMs", "outcomeCount", "pendingRequestCount", "queuedWriteBytes", "queuedWriteFrames", "activeWriteBytes", "frameBytes"] as const;

/** Bounded classes/codes only; even arbitrary exception names/messages, paths,
 * stacks, custom properties and toJSON methods are never serialized. */
export function attachmentDiagnosticError(error: unknown): readonly { name: string; code?: string | number }[] {
  try {
    const seen = new Set<unknown>();
    const result: { name: string; code?: string | number }[] = [];
    const visit = (value: unknown, depth: number): void => {
      if (depth >= 4 || result.length >= 8 || seen.has(value)) return;
      seen.add(value);
      if (!(value instanceof Error)) { result.push({ name: "NonError" }); return; }
      const name = names.has(value.name) ? value.name : "Error";
      const propertyCode = (value as Error & { code?: unknown }).code;
      const candidates = [propertyCode, value.message];
      const code = candidates.find(candidate => typeof candidate === "number" ? Number.isSafeInteger(candidate)
        : typeof candidate === "string" && candidate.length <= 120 && machineCode.test(candidate));
      result.push({ name, ...(typeof code === "string" || typeof code === "number" ? { code } : {}) });
      if (value.cause !== undefined) visit(value.cause, depth + 1);
      if (value instanceof AggregateError && Array.isArray(value.errors)) {
        for (let index = 0; index < Math.min(3, value.errors.length); index++) visit(value.errors[index], depth + 1);
      }
    };
    visit(error, 0);
    return result;
  } catch { return [{ name: "DiagnosticUnavailable" }]; }
}

export function attachmentDiagnostic(event: string, fields: AttachmentDiagnosticFields, error?: unknown): void {
  try {
    if (!deliveryDiagnosticsEnabled()) return;
    const record: Record<string, unknown> = { event: token.test(event) ? event : "invalid", timestamp: new Date().toISOString() };
    for (const key of textFields) {
      const value = fields[key];
      if (value !== undefined) {
        const safe = value === null || (key === "reason" ? value.length <= 120 && (machineCode.test(value) || closureReasons.has(value))
          : key === "signal" ? /^SIG[A-Z0-9]{1,16}$/u.test(value) : token.test(value));
        record[key] = safe ? value : "redacted";
      }
    }
    for (const key of numberFields) {
      const value = fields[key];
      if (value !== undefined && (value === null || Number.isFinite(value))) record[key] = value === null ? null : Math.round(value * 100) / 100;
    }
    for (const key of ["requestedClose", "deferred"] as const) if (typeof fields[key] === "boolean") record[key] = fields[key];
    if (error !== undefined) record.errors = attachmentDiagnosticError(error);
    writeDeliveryDiagnostic(`[delivery-attachment] ${JSON.stringify(record)}`);
  } catch { /* Diagnostics must never change attachment or delivery behavior. */ }
}
