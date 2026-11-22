import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BackendError } from "../../../contracts.js";
import { PiNativeError } from "../port.js";
import type { PiNativeAttachment, PiNativeCommand, PiNativeFailure, PiNativeOutcome, PiNativePort } from "../port.js";
import { parsePiManagedCommand } from "../rpc/pi-managed-protocol.js";
import { piNativeRecoveryMessage } from "../diagnostics.js";
import { piNativeCommandIsReadOnly } from "../command-policy.js";

/** One abandoned observation gates later reads until its host ownership ends. */
class NativeObservationReader {
  #pending?: string;
  #serial: Promise<unknown> = Promise.resolve();
  constructor(readonly port: PiNativePort, readonly attachment: PiNativeAttachment) {}
  get pending(): boolean { return this.#pending !== undefined; }
  read(command: PiNativeCommand, signal?: AbortSignal, deadlineAt?: number | null): Promise<unknown> {
    const operation = this.#serial.then(() => this.#read(command, signal, deadlineAt));
    this.#serial = operation.catch(() => undefined);
    return operation;
  }
  async #release(): Promise<boolean> {
    if (!this.#pending) return true;
    const result = await this.port.abandonObservation({ handleId: this.attachment.handleId, operationId: this.#pending }, AbortSignal.timeout(5_000));
    if (result === "pending") return false;
    this.#pending = undefined;
    return true;
  }
  async #read(command: PiNativeCommand, signal?: AbortSignal, deadlineAt?: number | null): Promise<unknown> {
    signal?.throwIfAborted();
    if (!await this.#release()) throw new BackendError({ category: "unavailable", retryable: true, crossedSubmissionBoundary: false,
      backendCode: "pi_native_observation_pending", safeMessage: "A previous Pi state read is still completing." });
    signal?.throwIfAborted();
    const id = randomUUID(); this.#pending = id;
    try {
      const outcome = await requestTerminalOutcome(this.port, this.attachment, command, id, signal, false, deadlineAt);
      // The host consumed this transient operation before returning its
      // terminal envelope, including when the native read itself failed.
      this.#pending = undefined;
      return nativeResult(outcome);
    } catch (cause) {
      // An authoritative refusal proves no late frame can be admitted. Do not
      // spend a permanent unknown-read cancellation marker on that operation.
      if (cause instanceof BackendError && !cause.crossedSubmissionBoundary) this.#pending = undefined;
      else await this.#release().catch(() => undefined);
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
  return nativeResult(await requestTerminalOutcome(port, attachment, command, operationId, signal, retainOutcome, deadlineAt));
}

async function requestTerminalOutcome(port: PiNativePort, attachment: PiNativeAttachment, command: PiNativeCommand,
  operationId: string, signal: AbortSignal | undefined, retainOutcome: boolean, deadlineAt: number | null = Date.now() + 60_000) {
  signal?.throwIfAborted();
  const deadline = deadlineAt === null ? undefined : AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()));
  const cancellation = signal && deadline ? AbortSignal.any([signal, deadline]) : signal ?? deadline;
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
