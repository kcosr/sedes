import { BackendRuntimeControlRejectedError } from "../../runtime-control.js";
import { PiNativeError, type PiNativePort } from "./port.js";

const stopRefusals = new Map<string, BackendRuntimeControlRejectedError["reason"]>([
  ["pi_native_confirmation_stale", "confirmation_stale"],
  ["pi_native_restart_blocked", "blocked"],
  ["pi_native_cleanup_unproven", "cleanup_unproven"],
]);

/** Both live and retained administration consume the same host refusal evidence. */
export async function stopPiNativeRuntime(port: Pick<PiNativePort, "stop">,
  input: Parameters<PiNativePort["stop"]>[0]): Promise<void> {
  try { await port.stop(input); }
  catch (error) {
    if (!(error instanceof PiNativeError)) throw error;
    const reason = stopRefusals.get(error.code);
    // The host positively reports cleanup failure with sent_outcome_unknown:
    // ownership is retained because cleanup was not proven. Remote transport
    // failures have a distinct pi_native_sidecar_unavailable code, so neither
    // arbitrary error text nor delivery uncertainty alone establishes refusal.
    if (reason && (reason === "cleanup_unproven" || error.delivery === "not_sent"))
      throw new BackendRuntimeControlRejectedError(reason, { cause: error });
    throw error;
  }
}
