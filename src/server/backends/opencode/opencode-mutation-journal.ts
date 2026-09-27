import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import { snapshotBoundedJson } from "../../provider-protocol/json/bounded-json-snapshot.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";
import { decodeOpenCodeNativeFailure, encodeOpenCodeNativeFailure } from "./opencode-native-codecs.js";
import { OPENCODE_CONTROL_MUTATIONS, type OpenCodeMutationControl, type OpenCodeMutationIdentity,
  type OpenCodeMutationInput, type OpenCodeMutationMethod, type OpenCodeMutationOutcome,
  type OpenCodeMutationOutput, type OpenCodeNativeAuthority, type OpenCodeApplicationOperationIdentity } from "./opencode-native-port.js";

const MAXIMUM_REQUEST_BYTES = 128 * 1_024 * 1_024;
const MAXIMUM_RESULT_BYTES = 32 * 1_024 * 1_024;
// Void and interrupt responses have fixed small shapes. Their reservation also
// covers every bounded classified failure, without consuming bulk-read space.
function resultBytes(method: OpenCodeMutationMethod): number {
  return method === "createSession" || method === "prompt" || method === "compact" ? MAXIMUM_RESULT_BYTES : 4_096;
}
const limits = { maximumDepth: 64, maximumObjectProperties: 100_000, maximumArrayItems: 1_000_000,
  maximumTotalNodes: 1_000_000, maximumStringBytes: MAXIMUM_RESULT_BYTES, maximumEncodedBytes: MAXIMUM_RESULT_BYTES };
type Outcome = OpenCodeMutationOutcome<unknown>;
interface Entry {
  readonly authority: OpenCodeNativeAuthority;
  readonly identity: OpenCodeMutationIdentity;
  readonly method: OpenCodeMutationMethod;
  readonly controlLane: boolean;
  readonly fingerprint: string;
  readonly deadlineAt: number | null;
  readonly settled: Promise<Outcome>;
  readonly settle: (outcome: Outcome) => void;
  outcome: Outcome;
  dispatched: boolean;
  releaseWhenSettled: boolean;
  bytes: number;
}

/** Exact write receipts belong to the native owner, independent of caller waits.
 * This retains no transcript. ACK follows main's durable operation receipt; the
 * bounded tombstone window supplements that durable duplicate-admission fence. */
export class OpenCodeMutationJournal {
  readonly #entries = new Map<string, Entry>();
  readonly #acknowledged = new Map<string, string>();
  readonly #ordinary: RequestQueue;
  readonly #control: RequestQueue;
  readonly #maximumOperations: number;
  readonly #maximumBytes: number;
  readonly #maximumControlOperations: number;
  readonly #controlReserveBytes: number;
  readonly #onReleased: ((authority: OpenCodeNativeAuthority) => void) | undefined;
  #bytes = 0;
  #revision = 0;
  #closed = false;
  #frozen = false;

  constructor(options: { readonly maximumOperations?: number; readonly maximumBytes?: number;
    readonly concurrency?: number; readonly controlConcurrency?: number; readonly maximumControlOperations?: number; readonly controlReserveBytes?: number;
    readonly onReleased?: (authority: OpenCodeNativeAuthority) => void } = {}) {
    this.#onReleased = options.onReleased;
    this.#maximumOperations = options.maximumOperations ?? 128;
    this.#maximumBytes = options.maximumBytes ?? 512 * 1_024 * 1_024;
    this.#maximumControlOperations = options.maximumControlOperations ?? 16;
    this.#controlReserveBytes = options.controlReserveBytes ?? 64 * 1_024 * 1_024;
    this.#ordinary = new RequestQueue(options.concurrency ?? 4);
    this.#control = new RequestQueue(options.controlConcurrency ?? 4);
    if (!Number.isSafeInteger(this.#maximumOperations) || this.#maximumOperations < 1 ||
        !Number.isSafeInteger(this.#maximumBytes) || this.#maximumBytes < 1 ||
        !Number.isSafeInteger(this.#maximumControlOperations) || this.#maximumControlOperations < 1 ||
        !Number.isSafeInteger(this.#controlReserveBytes) || this.#controlReserveBytes < 1) throw new Error("opencode_journal_limits_invalid");
  }

  async mutate<K extends OpenCodeMutationMethod>(authority: OpenCodeNativeAuthority, method: K,
    input: OpenCodeMutationInput<K>, control: OpenCodeMutationControl,
    dispatch: (input: OpenCodeMutationInput<K>, signal: AbortSignal) => Promise<OpenCodeMutationOutput<K>>,
    signal?: AbortSignal): Promise<OpenCodeMutationOutput<K>> {
    if (control.deadlineAt !== null && (!Number.isSafeInteger(control.deadlineAt) || control.deadlineAt < 0)) throw refused("opencode_mutation_deadline_invalid");
    // Capture before admission: later caller mutation cannot change native input
    // or bypass the immutable request fingerprint. Resolved secrets never enter
    // this catalog: environment requests contain frozen definitions only.
    const captured = snapshotBoundedJson(input, { ...limits, maximumStringBytes: MAXIMUM_REQUEST_BYTES, maximumEncodedBytes: MAXIMUM_REQUEST_BYTES }) as OpenCodeMutationInput<K>;
    const owner = snapshotBoundedJson(authority, limits) as unknown as OpenCodeNativeAuthority;
    const identity = snapshotBoundedJson(control.identity, limits) as unknown as OpenCodeMutationIdentity;
    const key = operationKey(owner, identity);
    const fingerprint = configurationFingerprint({ method, input: captured, deadlineAt: control.deadlineAt });
    const acknowledged = this.#acknowledged.get(key);
    if (acknowledged !== undefined) {
      if (acknowledged !== fingerprint) throw refused("opencode_mutation_identity_conflict");
      throw unknown("opencode_mutation_acknowledged");
    }
    let entry = this.#entries.get(key);
    if (entry && entry.fingerprint !== fingerprint) throw refused("opencode_mutation_identity_conflict");
    if (!entry) {
      if (signal?.aborted) throw refused("opencode_mutation_cancelled_before_admission");
      if (this.#closed || this.#frozen) throw refused("opencode_mutation_admission_closed");
      if (control.deadlineAt !== null && control.deadlineAt <= Date.now()) throw refused("opencode_mutation_deadline_expired");
      // Reserve the full bounded response before dispatch so concurrently
      // finishing calls cannot push retained evidence beyond its byte budget.
      const bytes = Buffer.byteLength(JSON.stringify(captured)) + Buffer.byteLength(JSON.stringify(owner)) +
        Buffer.byteLength(JSON.stringify(identity)) + resultBytes(method) + 2_048;
      const controlLane = OPENCODE_CONTROL_MUTATIONS.has(method);
      const count = [...this.#entries.values()].filter(entry => entry.controlLane === controlLane).length;
      if (count >= (controlLane ? this.#maximumControlOperations : this.#maximumOperations) ||
          this.#bytes + bytes > this.#maximumBytes + (controlLane ? this.#controlReserveBytes : 0)) {
        throw refused("opencode_mutation_retention_full");
      }
      const completion = deferred<Outcome>();
      entry = { authority: owner, identity, method, controlLane, fingerprint, deadlineAt: control.deadlineAt,
        settled: completion.promise, settle: completion.resolve, outcome: { status: "pending" }, dispatched: false, releaseWhenSettled: false, bytes };
      this.#entries.set(key, entry); this.#bytes += bytes; this.#revision++;
      const admitted = entry;
      // Carrier cancellation only ends the caller's wait. The retained owner
      // executes once under the original deadline, including queued dispatch.
      void (OPENCODE_CONTROL_MUTATIONS.has(method) ? this.#control : this.#ordinary).run(async () => {
        if (this.#closed || admitted.outcome.status !== "pending") throw refused("opencode_mutation_admission_closed");
        const remaining = admitted.deadlineAt === null ? null : admitted.deadlineAt - Date.now();
        if (remaining !== null && remaining <= 0) throw refused("opencode_mutation_deadline_expired");
        // Its capacity was reserved at admission. Later control work can use
        // the extra reserve without revoking already-admitted ordinary work.
        admitted.dispatched = true;
        return dispatch(captured, remaining === null ? new AbortController().signal : AbortSignal.timeout(Math.min(remaining, 2_147_483_647)));
      }).then(result => {
        try {
          this.#settle(admitted, { status: "completed", result: snapshotBoundedJson(result, { ...limits, maximumEncodedBytes: resultBytes(method) }) });
        } catch (error) { this.#settle(admitted, { status: "failed", failure: encodeOpenCodeNativeFailure(error, true) }); }
      }, error => this.#settle(admitted, { status: "failed", failure: encodeOpenCodeNativeFailure(error, admitted.dispatched) }));
    }
    const outcome = await waitFor(entry.settled, signal);
    if (outcome.status === "failed") throw decodeOpenCodeNativeFailure(outcome.failure);
    if (outcome.status !== "completed") throw unknown("opencode_mutation_outcome_unknown");
    return snapshotBoundedJson(outcome.result, limits) as OpenCodeMutationOutput<K>;
  }

  outcome<K extends OpenCodeMutationMethod>(authority: OpenCodeNativeAuthority, method: K,
    identity: OpenCodeMutationIdentity): OpenCodeMutationOutcome<OpenCodeMutationOutput<K>> {
    const entry = this.#entries.get(operationKey(authority, identity));
    if (!entry) throw unknown("opencode_mutation_outcome_unknown");
    if (entry.method !== method) throw refused("opencode_mutation_identity_conflict");
    return snapshotBoundedJson(entry.outcome, { ...limits, maximumEncodedBytes: MAXIMUM_RESULT_BYTES + 1_024 }) as OpenCodeMutationOutcome<OpenCodeMutationOutput<K>>;
  }

  acknowledge(authority: OpenCodeNativeAuthority, method: OpenCodeMutationMethod, identity: OpenCodeMutationIdentity): void {
    const key = operationKey(authority, identity);
    const entry = this.#entries.get(key);
    if (!entry) {
      if (this.#acknowledged.has(key)) return;
      throw unknown("opencode_mutation_outcome_unknown");
    }
    if (entry.method !== method) throw refused("opencode_mutation_identity_conflict");
    if (entry.outcome.status === "pending") {
      // A durable terminal main receipt can release its eventual native result,
      // but never releases in-flight owner responsibility or retained evidence.
      entry.releaseWhenSettled = true; this.#revision++; return;
    }
    this.#release(key, entry);
  }

  hasRetainedAuthority(authority: OpenCodeNativeAuthority): boolean {
    const fingerprint = configurationFingerprint(authority);
    return [...this.#entries.values()].some(entry => configurationFingerprint(entry.authority) === fingerprint);
  }

  acknowledgeOperation(authority: OpenCodeNativeAuthority, identity: OpenCodeApplicationOperationIdentity): void {
    const owner = configurationFingerprint(authority);
    for (const entry of this.#entries.values()) {
      if (entry.identity.origin !== "application" || entry.identity.applicationOperationId !== identity.applicationOperationId ||
          entry.identity.operationKind !== identity.operationKind || configurationFingerprint(entry.authority) !== owner) continue;
      this.acknowledge(authority, entry.method, entry.identity);
    }
  }

  #release(key: string, entry: Entry): void {
    this.#acknowledged.set(key, entry.fingerprint);
    if (this.#acknowledged.size > 4_096) this.#acknowledged.delete(this.#acknowledged.keys().next().value!);
    this.#entries.delete(key); this.#bytes -= entry.bytes; this.#revision++;
    this.#onReleased?.(entry.authority);
  }

  freeze(): void { this.#frozen = true; }
  restore(): void { if (!this.#closed) this.#frozen = false; }
  /** Explicit confirmed abandonment never rewrites unknown effects as refusal. */
  close(): void {
    this.#closed = true; this.#frozen = true;
    for (const entry of this.#entries.values()) if (entry.outcome.status === "pending") {
      this.#settle(entry, { status: "failed", failure: encodeOpenCodeNativeFailure(
        entry.dispatched ? unknown("opencode_mutation_owner_closed") : refused("opencode_mutation_admission_closed"), entry.dispatched) });
    }
  }
  snapshot() {
    return { revision: this.#revision, retainedBytes: this.#bytes, operations: [...this.#entries.values()].map(entry => ({
      authority: structuredClone(entry.authority), identity: { ...entry.identity }, method: entry.method, deadlineAt: entry.deadlineAt,
      status: entry.outcome.status, dispatched: entry.dispatched, releaseWhenSettled: entry.releaseWhenSettled,
      ...(entry.outcome.status === "failed" ? { failure: { ...entry.outcome.failure } } : {}),
    })) };
  }
  #settle(entry: Entry, outcome: Outcome): void {
    if (entry.outcome.status !== "pending") return;
    this.#bytes -= entry.bytes;
    entry.bytes = Buffer.byteLength(JSON.stringify(outcome)) + Buffer.byteLength(JSON.stringify(entry.authority)) +
      Buffer.byteLength(JSON.stringify(entry.identity)) + 1_024;
    this.#bytes += entry.bytes; entry.outcome = outcome; this.#revision++;
    entry.settle(outcome);
    if (entry.releaseWhenSettled) this.#release(operationKey(entry.authority, entry.identity), entry);
  }
}

function operationKey(authority: OpenCodeNativeAuthority, identity: OpenCodeMutationIdentity): string {
  return configurationFingerprint({ authority, identity });
}
function refused(code: string): Error { return decodeOpenCodeNativeFailure({ kind: "mutation_refused", delivery: "not_sent", code }); }
function unknown(code: string): Error { return decodeOpenCodeNativeFailure({ kind: "mutation_unknown", delivery: "sent_outcome_unknown", code }); }
async function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw unknown("opencode_mutation_wait_cancelled");
  const cancellation = deferred<never>();
  const abort = () => cancellation.reject(unknown("opencode_mutation_wait_cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  try { return await Promise.race([promise, cancellation.promise]); }
  finally { signal.removeEventListener("abort", abort); }
}
class RequestQueue {
  #running = 0;
  readonly #waiting: (() => void)[] = [];
  constructor(readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16) throw new OpenCodeRuntimeError("opencode_journal_limits_invalid");
  }
  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const start = () => {
        this.#running++;
        void Promise.resolve().then(work).then(resolve, reject).finally(() => { this.#running--; this.#waiting.shift()?.(); });
      };
      if (this.#running < this.maximum) start(); else this.#waiting.push(start);
    });
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}
