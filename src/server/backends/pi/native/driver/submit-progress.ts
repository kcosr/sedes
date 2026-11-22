import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_SESSION_EVENT_BYTES, MAXIMUM_SESSION_EVENTS, PiNativeError } from "../port.js";
import { piManagedOperationSchema, type PiManagedInput, type PiManagedOperation } from "../rpc/pi-managed-protocol.js";

type Identity = Pick<PiManagedInput, "operationId" | "mutationId" | "reconciliationToken" | "mode" | "fingerprint">;

/** Bound to one dispatch on one handle. The event can arrive before complete_submission returns. */
export class PiNativePendingSubmission {
  readonly #settled: Promise<PiManagedOperation>;
  #resolve!: (operation: PiManagedOperation) => void;
  terminal?: PiManagedOperation;
  readonly streams = new Map<string, { payload: Record<string, unknown>; bytes: number }>();
  #streamBytes = 0;

  constructor(readonly expected: Identity) {
    this.#settled = new Promise(resolve => { this.#resolve = resolve; });
  }

  verify(value: unknown): PiManagedOperation {
    const result = piManagedOperationSchema.safeParse(value);
    if (!result.success || result.data.input.operationId !== this.expected.operationId ||
      result.data.input.mutationId !== this.expected.mutationId || result.data.input.reconciliationToken !== this.expected.reconciliationToken ||
      result.data.input.mode !== this.expected.mode || result.data.input.fingerprint !== this.expected.fingerprint ||
      (result.data.phase === "accepted" && !result.data.userEntryId)) {
      throw new PiNativeError("pi_native_submission_evidence_mismatch", "sent_outcome_unknown");
    }
    const operation = result.data;
    if (operation.phase === "accepted" || operation.phase === "lost" || operation.phase === "rejected") {
      if (this.terminal && (this.terminal.phase !== operation.phase || this.terminal.userEntryId !== operation.userEntryId))
        throw new PiNativeError("pi_native_submission_evidence_mismatch", "sent_outcome_unknown");
      this.terminal = operation;
      this.#resolve(operation);
    }
    return this.terminal ?? operation;
  }

  async wait(signal: AbortSignal): Promise<PiManagedOperation | undefined> {
    const timer = new AbortController();
    try {
      return await Promise.race([this.#settled,
        delay(500, undefined, { signal: AbortSignal.any([signal, timer.signal]) })]);
    } catch (cause) {
      if (signal.aborted) throw new PiNativeError("pi_native_handle_closed", "sent_outcome_unknown");
      throw cause;
    } finally { timer.abort(); }
  }

  clearStreams(): void { this.streams.clear(); this.#streamBytes = 0; }

  retain(key: string, payload: Record<string, unknown>): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    const total = this.#streamBytes + bytes - (this.streams.get(key)?.bytes ?? 0);
    if (total > DEFAULT_SESSION_EVENT_BYTES || (!this.streams.has(key) && this.streams.size >= MAXIMUM_SESSION_EVENTS)) return false;
    this.#streamBytes = total;
    this.streams.set(key, { payload, bytes });
    return true;
  }
}
