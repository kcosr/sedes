import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BackendError } from "../../../contracts.js";
import { PiNativeError } from "../port.js";
import type { PiNativeAttachment, PiNativeCommand, PiNativeFailure, PiNativeOutcome, PiNativePort } from "../port.js";
import { parsePiManagedCommand } from "../rpc/pi-managed-protocol.js";
import { piNativeRecoveryMessage } from "../diagnostics.js";
import { piNativeCommandIsReadOnly } from "../command-policy.js";

interface NativeObservation {
  id: string;
  cancellation?: AbortSignal;
  uncertain: boolean;
  releasing?: Promise<boolean>;
}

/** Only small session-status reads can run alongside ordinary history and state reads. */
class NativeObservationReader {
  #serial: Record<"ordinary" | "status", Promise<unknown>> = { ordinary: Promise.resolve(), status: Promise.resolve() };
  #reads = new Set<NativeObservation>();
  #callers = 0;
  constructor(readonly port: PiNativePort, readonly attachment: PiNativeAttachment) {}
  get pending(): boolean { return this.#callers > 0 || this.#reads.size > 0; }
  read(command: PiNativeCommand, signal?: AbortSignal, deadlineAt?: number | null): Promise<unknown> {
    const lane = command.channel === "companion" && command.command.type === "session_status" ? "status" : "ordinary";
    this.#callers++;
    const operation = this.#serial[lane].then(() => this.#read(command, signal, deadlineAt)).finally(() => { this.#callers--; });
    this.#serial[lane] = operation.catch(() => undefined);
    return operation;
  }
  #release(read: NativeObservation): Promise<boolean> {
    return read.releasing ??= this.port.abandonObservation({ handleId: this.attachment.handleId, operationId: read.id }, AbortSignal.timeout(5_000))
      .then(result => {
        if (result === "released") this.#reads.delete(read);
        return !this.#reads.has(read);
      }).finally(() => { read.releasing = undefined; });
  }
  async #read(command: PiNativeCommand, signal?: AbortSignal, deadlineAt?: number | null): Promise<unknown> {
    signal?.throwIfAborted();
    // An aborted transfer may still be draining locally. Gate both lanes until
    // its operation terminates or the host confirms that late delivery is fenced.
    for (;;) {
      const prior = [...this.#reads].find(read => read.uncertain || read.cancellation?.aborted);
      if (!prior) break;
      if (!prior.uncertain || !await this.#release(prior)) throw new BackendError({ category: "unavailable", retryable: true, crossedSubmissionBoundary: false,
        backendCode: "pi_native_observation_pending", safeMessage: "A previous Pi state read is still completing." });
      signal?.throwIfAborted();
    }
    const read: NativeObservation = { id: randomUUID(), cancellation: nativeCancellation(signal, deadlineAt), uncertain: false };
    this.#reads.add(read);
    try {
      const outcome = await requestTerminalOutcome(this.port, this.attachment, command, read.id, read.cancellation, false);
      // A terminal envelope proves the host consumed this transient operation.
      this.#reads.delete(read);
      return nativeResult(outcome);
    } catch (cause) {
      if (cause instanceof BackendError && !cause.crossedSubmissionBoundary) this.#reads.delete(read);
      else if (this.#reads.has(read)) {
        read.uncertain = true;
        await this.#release(read).catch(() => undefined);
      }
      throw cause;
    }
  }
}
const observations = new WeakMap<PiNativePort, Map<string, NativeObservationReader>>();
function observationReader(port: PiNativePort, attachment: PiNativeAttachment): NativeObservationReader {
  let handles = observations.get(port);
  if (!handles) { handles = new Map(); observations.set(port, handles); }
  // A successor generation proves that the old process and its observations
  // are no longer available. Mere handle release does not prove that.
  for (const [id, prior] of handles) {
    if (prior.attachment.sessionId === attachment.sessionId && prior.attachment.sessionFile === attachment.sessionFile &&
      prior.attachment.cwd === attachment.cwd && prior.attachment.generation !== attachment.generation)
      handles.delete(id);
  }
  let reader = handles.get(attachment.handleId);
  if (!reader) { reader = new NativeObservationReader(port, attachment); handles.set(attachment.handleId, reader); }
  return reader;
}
/** Host release abandons reads; keep unfinished ones as gates on reattachment. */
export function forgetNativeObservations(port: PiNativePort, handleId: string): void {
  const handles = observations.get(port);
  if (!handles?.get(handleId)?.pending) handles?.delete(handleId);
}

export function nativeFailure(failure: PiNativeFailure): BackendError {
  return new BackendError({
    category: failure.delivery === "sent_outcome_unknown" ? "submission_unknown" : failure.delivery === "rejected" ? "rejected" : "unavailable",
    retryable: failure.delivery === "not_sent", crossedSubmissionBoundary: failure.delivery === "sent_outcome_unknown",
    safeMessage: piNativeRecoveryMessage(failure.code) ?? (failure.delivery === "sent_outcome_unknown" ? "Pi could not confirm the operation outcome." : "Pi could not complete the requested operation."),
    backendCode: failure.code,
  });
}
export function nativeUnknownFailure(cause: unknown): BackendError {
  return new BackendError({ category: "submission_unknown", retryable: false, crossedSubmissionBoundary: true,
    safeMessage: "The Pi operation is still awaiting an authoritative outcome.",
    backendCode: cause instanceof PiNativeError ? cause.code : cause instanceof BackendError ? cause.backendCode ?? "pi_native_operation_unknown" : "pi_native_operation_unknown" }, { cause });
}

/** Durable operation IDs remain owned until the application commits and acknowledges them. */
export async function requestNative(port: PiNativePort, attachment: PiNativeAttachment, command: PiNativeCommand,
  operationId: string = randomUUID(), signal?: AbortSignal, retainOutcome = true, deadlineAt: number | null = Date.now() + 60_000): Promise<unknown> {
  return nativeResult(await requestTerminalOutcome(port, attachment, command, operationId, nativeCancellation(signal, deadlineAt), retainOutcome));
}

function nativeCancellation(signal?: AbortSignal, deadlineAt: number | null = Date.now() + 60_000) {
  const deadline = deadlineAt === null ? undefined : AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()));
  return signal && deadline ? AbortSignal.any([signal, deadline]) : signal ?? deadline;
}

async function requestTerminalOutcome(port: PiNativePort, attachment: PiNativeAttachment, command: PiNativeCommand,
  operationId: string, cancellation: AbortSignal | undefined, retainOutcome: boolean) {
  cancellation?.throwIfAborted();
  let outcome: PiNativeOutcome;
  let requestReturned = false;
  try {
    outcome = await port.request({ handleId: attachment.handleId, operationId, command, retainOutcome }, cancellation);
    requestReturned = true;
    while (outcome.status === "pending") {
      await delay(20, undefined, { signal: cancellation });
      outcome = await port.outcome({ handleId: attachment.handleId, operationId }, cancellation);
    }
  } catch (cause) {
    // Refusing an outcome poll says nothing about the original operation's
    // delivery. Only an initial refusal or terminal host outcome can prove it.
    if (!requestReturned) {
      if (cause instanceof BackendError) throw cause;
      if (cause instanceof PiNativeError) throw nativeFailure(cause);
    }
    throw nativeUnknownFailure(cause);
  }
  return outcome;
}

function nativeResult(outcome: Exclude<PiNativeOutcome, { status: "pending" }>): unknown {
  if (outcome.status === "failed") throw nativeFailure(outcome.failure);
  return outcome.result;
}

export function rpc(port: PiNativePort, attachment: PiNativeAttachment, command: Readonly<Record<string, unknown>>, operationId?: string, signal?: AbortSignal, deadlineAt?: number | null) {
  return invoke(port, attachment, { channel: "rpc", command }, operationId, signal, deadlineAt);
}
export function companion(port: PiNativePort, attachment: PiNativeAttachment, command: Readonly<Record<string, unknown>>, operationId?: string, signal?: AbortSignal) {
  return invoke(port, attachment, { channel: "companion", command: parsePiManagedCommand(command) }, operationId, signal);
}
async function invoke(port: PiNativePort, attachment: PiNativeAttachment, command: PiNativeCommand, operationId?: string, signal?: AbortSignal, deadlineAt?: number | null) {
  if (!operationId && piNativeCommandIsReadOnly(command)) return observationReader(port, attachment).read(command, signal, deadlineAt)
    .catch(cause => { if (cause instanceof PiNativeError) throw nativeFailure(cause); throw cause; });
  return requestNative(port, attachment, command, operationId, signal, operationId !== undefined, deadlineAt);
}
