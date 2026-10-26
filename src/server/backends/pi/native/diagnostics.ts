import { attachmentDiagnostic, attachmentDiagnosticError, type AttachmentDiagnosticFields } from "../../../diagnostics/attachment-diagnostics.js";
import { deliveryDiagnosticsEnabled } from "../../../diagnostics/delivery-diagnostic-output.js";

type ReadStage = "observe" | "control";

/** At most one safe failure signature per read path; never retain exceptions or
 * provider payloads. Repeated polling failures produce one transition record. */
export class PiNativeReadDiagnostics {
  readonly #failures = new Map<ReadStage, string>();
  constructor(readonly fields: AttachmentDiagnosticFields) {}

  failed(stage: ReadStage, cause: unknown): void {
    try {
      if (!deliveryDiagnosticsEnabled()) return;
      const signature = JSON.stringify(attachmentDiagnosticError(cause));
      if (this.#failures.get(stage) === signature) return;
      this.#failures.set(stage, signature);
      attachmentDiagnostic("pi_native_read_failed", { ...this.fields, stage }, cause);
    } catch { /* Diagnostics cannot affect the observer. */ }
  }

  succeeded(stage: ReadStage): void {
    if (!this.#failures.delete(stage)) return;
    attachmentDiagnostic("pi_native_read_recovered", { ...this.fields, stage });
  }
}

/** Safe recovery guidance; native paths and transport details stay private. */
export function piNativeRecoveryMessage(code: string): string | undefined {
  if (code === "pi_session_native_writer_cleanup_required")
    return "A previous Pi writer has not been proven stopped. On the execution host, verify that the old Pi process and its descendants have exited before removing that session's stale .sedes-native-writer marker. See the Pi backend recovery guide.";
  if (code === "pi_native_session_configuration_conflict")
    return "Pi is retaining a session with earlier environment settings. Release its retained work before applying the new settings.";
  if (code === "pi_native_session_ended")
    return "The Pi process ended. Release its retained session before reconnecting; unresolved operation outcomes remain available for recovery.";
  return undefined;
}
