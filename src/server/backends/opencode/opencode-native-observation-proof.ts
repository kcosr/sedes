import { createHash } from "node:crypto";
import { OpenCodeNativeProtocolError, type OpenCodeNativeEvent } from "./opencode-native-codecs.js";
import type { OpenCodeNativeProof, OpenCodeNativeProofBaseline } from "./opencode-native-port.js";

export const OPENCODE_NATIVE_PROOF_RECORDS = 100_000;
export const OPENCODE_NATIVE_PROOF_BYTES = 32 * 1_024 * 1_024;

/** Native facts only. No application receipts, database, policy or transcript. */
export class OpenCodeNativeObservationProof {
  readonly #proofs = new Map<number, OpenCodeNativeProof>();
  readonly #pending = new Map<string, number | null>();
  readonly #work = new Set<string>();
  #unknownWork = false;
  #unknownExecution = false;
  #workBytes = 0;
  #frontier: number | null = null;
  #highestSeen = -1;
  #current: string | null = null;
  #epoch = 0;
  #bytes = 0;
  constructor(readonly sessionID: string) {}
  get bytes(): number { return this.#bytes + 1_024 + this.#workBytes; }
  get hasWork(): boolean { return this.#unknownWork || this.#unknownExecution || this.#current !== null || this.#pending.size !== 0 || this.#work.size !== 0; }
  get currentInputId(): string | null { return this.#current; }
  prepareInput(id: string, maximumBytes: number): boolean {
    if (this.#pending.has(id)) return true;
    const bytes = Buffer.byteLength(id) + 32;
    while (this.#proofs.size && this.bytes + bytes > maximumBytes) this.#dropFirstProof();
    if (this.#pending.size + this.#work.size >= OPENCODE_NATIVE_PROOF_RECORDS || this.bytes + bytes > maximumBytes) return false;
    this.#addPending(id, null); return true;
  }
  refuseInput(id: string): void { if (this.#pending.get(id) === null) this.#removePending(id); }
  discontinuity(): void {
    // Known pending inputs and work IDs survive the break and can be settled by
    // their exact later events. Only the current input loses its execution fence.
    this.#unknownExecution ||= this.#current !== null;
    this.#epoch++; this.#current = null; this.#frontier = null;
  }
  isDuplicate(event: OpenCodeNativeEvent): boolean {
    return "durable" in event && !!event.durable && event.durable.aggregateID === this.sessionID &&
      this.#proofs.get(event.durable.seq)?.fingerprint === openCodeNativeFactFingerprint(event);
  }
  isConflict(event: OpenCodeNativeEvent): boolean {
    return "durable" in event && !!event.durable && event.durable.aggregateID === this.sessionID &&
      event.durable.seq <= this.#highestSeen && !this.isDuplicate(event);
  }
  isGap(event: OpenCodeNativeEvent): boolean {
    return "durable" in event && !!event.durable && event.durable.aggregateID === this.sessionID &&
      this.#frontier !== null && event.durable.seq !== this.#frontier + 1;
  }
  accept(event: OpenCodeNativeEvent): void {
    if (event.type === "permission.asked") this.#addWork(`permission:${event.data.id}`);
    else if (event.type === "permission.replied") this.#removeWork(`permission:${event.data.requestID}`);
    else if (event.type === "form.created" && event.data.form.sessionID !== "global") this.#addWork(`form:${event.data.form.id}`);
    else if (event.type === "form.replied" || event.type === "form.cancelled") this.#removeWork(`form:${event.data.id}`);
    else if (event.type === "shell.created" && event.data.info.status === "running") this.#addWork(`shell:${event.data.info.id}`);
    else if (event.type === "shell.exited" || event.type === "shell.deleted") this.#removeWork(`shell:${event.data.id}`);
    else if (event.type === "session.execution.started") this.#addWork(`execution:${event.data.sessionID}`);
    else if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted" || event.type === "session.deleted") this.#removeWork(`execution:${event.data.sessionID}`);
    if (!("durable" in event) || !event.durable || event.durable.aggregateID !== this.sessionID ||
        !("sessionID" in event.data) || event.data.sessionID !== this.sessionID) return;
    const nativeSequence = event.durable.seq;
    const inputId = "inboxID" in event.data ? event.data.inboxID : null;
    const boundaryId = event.type === "session.revert.committed" ? event.data.to
      : event.type === "session.step.started" ? event.data.assistantMessageID : null;
    if (!Number.isSafeInteger(nativeSequence) || nativeSequence < 0 ||
      [inputId, boundaryId].some(id => id !== null && (id.length === 0 || id.length > 256 || /[\x00-\x1f\x7f]/u.test(id)))) {
      throw new OpenCodeNativeProtocolError();
    }
    const proof = { nativeSequence, fingerprint: openCodeNativeFactFingerprint(event), type: event.type, inputId, boundaryId };
    this.#proofs.set(nativeSequence, proof); this.#bytes += Buffer.byteLength(JSON.stringify(proof)) + 1;
    this.#frontier = nativeSequence; this.#highestSeen = nativeSequence;
    if (event.type === "session.inbox.enqueued") this.#addPending(event.data.inboxID, nativeSequence);
    if (event.type === "session.inbox.cancelled") this.#removePending(event.data.inboxID);
    if (event.type === "session.inbox.delivered") {
      this.#removePending(event.data.inboxID); this.#current = event.data.inboxID; this.#epoch++;
    } else if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
      "session.revert.committed", "session.revert.staged", "session.deleted"].includes(event.type)) {
      this.#current = null; this.#epoch++;
      if (event.type === "session.deleted") { for (const id of this.#pending.keys()) this.#removePending(id); this.#unknownWork = false; this.#unknownExecution = false; }
      if (event.type === "session.revert.committed") this.#revert(event.data.to, nativeSequence);
      // A root terminal settles the lost current execution. Other pending input
      // and child/shell/interaction markers independently continue retaining it.
      if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type)) this.#unknownExecution = false;
    }
  }
  /** Density fingerprints are reconstructible; lifecycle markers are not. */
  reclaimCachedProofBytes(bytes: number): number {
    const before = this.#bytes;
    while (this.#proofs.size && before - this.#bytes < bytes) this.#dropFirstProof();
    return before - this.#bytes;
  }
  trim(maximumBytes: number): boolean {
    while (this.#proofs.size && (this.#proofs.size > OPENCODE_NATIVE_PROOF_RECORDS || this.bytes > maximumBytes)) {
      this.#dropFirstProof();
    }
    if (this.bytes <= maximumBytes && this.#pending.size + this.#work.size <= OPENCODE_NATIVE_PROOF_RECORDS) return true;
    // A bounded unknown marker preserves lifecycle uncertainty without keeping
    // an unbounded inventory of IDs or asserting that dropped work completed.
    this.#unknownWork = true; this.#pending.clear(); this.#work.clear(); this.#workBytes = 0; this.#current = null;
    return false;
  }
  #revert(boundary: string, through: number): void {
    const start = [...this.#proofs.values()].find(proof => proof.type === "session.inbox.delivered" && proof.inputId === boundary ||
      proof.type === "session.step.started" && proof.boundaryId === boundary)?.nativeSequence;
    if (start === undefined || through - start > OPENCODE_NATIVE_PROOF_RECORDS) return;
    for (let sequence = start; sequence < through; sequence++) {
      const proof = this.#proofs.get(sequence);
      if (!proof || ["session.revert.committed", "session.deleted", "session.created", "session.forked"].includes(proof.type)) return;
    }
    for (const [id, sequence] of this.#pending) if (sequence !== null && sequence >= start && sequence < through) this.#removePending(id);
  }
  #dropFirstProof(): void {
    const first = this.#proofs.entries().next().value!;
    this.#proofs.delete(first[0]); this.#bytes -= Buffer.byteLength(JSON.stringify(first[1])) + 1;
  }
  #addWork(id: string): void { if (!this.#work.has(id)) { this.#work.add(id); this.#workBytes += Buffer.byteLength(id) + 32; } }
  #removeWork(id: string): void { if (this.#work.delete(id)) this.#workBytes -= Buffer.byteLength(id) + 32; }
  #addPending(id: string, sequence: number | null): void {
    if (!this.#pending.has(id)) this.#workBytes += Buffer.byteLength(id) + 32;
    this.#pending.set(id, sequence);
  }
  #removePending(id: string): void { if (this.#pending.delete(id)) this.#workBytes -= Buffer.byteLength(id) + 32; }
  snapshot(): OpenCodeNativeProofBaseline {
    return { nativeFrontier: this.#frontier, coverageFloor: this.#proofs.keys().next().value ?? null,
      currentInputId: this.#current, authorityEpoch: this.#epoch, proofs: [...this.#proofs.values()].map(proof => ({ ...proof })) };
  }
}

export function openCodeNativeFactFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .filter(([, value]) => value !== undefined).map(([key, value]) => [key, canonical(value)])) : item;
  return createHash("sha256").update("sedes-opencode-operation-v1\n").update(JSON.stringify(canonical(value))).digest("hex");
}
