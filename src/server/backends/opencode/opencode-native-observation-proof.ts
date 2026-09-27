import { createHash } from "node:crypto";
import { OpenCodeNativeProtocolError, type OpenCodeNativeEvent } from "./opencode-native-codecs.js";
import type { OpenCodeNativeProof, OpenCodeNativeProofBaseline } from "./opencode-native-port.js";

export const OPENCODE_NATIVE_PROOF_RECORDS = 100_000;
export const OPENCODE_NATIVE_PROOF_BYTES = 32 * 1_024 * 1_024;

/** Native facts only. No application receipts, database, policy or transcript. */
export class OpenCodeNativeObservationProof {
  readonly #proofs = new Map<number, OpenCodeNativeProof>();
  readonly #pending = new Map<string, number | null>();
  readonly #work = new Map<string, string>();
  #retentionRevision = 0;
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
    this.#retentionRevision++; this.#epoch++; this.#current = null; this.#frontier = null;
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
    if (event.type === "permission.asked") this.#addWork(`permission:${event.data.id}`, event.data.sessionID);
    else if (event.type === "permission.replied") this.#removeWork(`permission:${event.data.requestID}`);
    else if (event.type === "form.created" && event.data.form.sessionID !== "global") this.#addWork(`form:${event.data.form.id}`, event.data.form.sessionID);
    else if (event.type === "form.replied" || event.type === "form.cancelled") this.#removeWork(`form:${event.data.id}`);
    else if (event.type === "shell.created" && event.data.info.status === "running") {
      if (typeof event.data.info.metadata.sessionID !== "string") throw new OpenCodeNativeProtocolError();
      this.#addWork(`shell:${event.data.info.id}`, event.data.info.metadata.sessionID);
    }
    else if (event.type === "shell.exited" || event.type === "shell.deleted") this.#removeWork(`shell:${event.data.id}`);
    else if (event.type === "session.execution.started") this.#addWork(`execution:${event.data.sessionID}`, event.data.sessionID);
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
  /** Lifecycle-only cut: this never grants input/approval or receipt authority. */
  retentionCut() {
    return { revision: this.#retentionRevision, epoch: this.#epoch,
      pending: [...this.#pending].filter((entry): entry is [string, number] => entry[1] !== null),
      work: [...this.#work].map(([id, sessionID]) => ({ id, sessionID })), unknownExecution: this.#unknownExecution };
  }
  reconcileRetention(cut: ReturnType<OpenCodeNativeObservationProof["retentionCut"]>, inventory: {
    pending: ReadonlySet<string>; checkedOwners: ReadonlySet<string>; work: ReadonlyMap<string, string>;
  }): boolean {
    // An event/dispatch racing any read invalidates the whole cut. Null pins
    // were never natively observed and cannot be settled by missing inventory.
    if (cut.revision !== this.#retentionRevision || cut.epoch !== this.#epoch) return false;
    if (inventory.checkedOwners.has(this.sessionID)) {
      for (const [id] of cut.pending) if (!inventory.pending.has(id)) this.#removePending(id);
      if (cut.unknownExecution && !inventory.work.has(`execution:${this.sessionID}`)) {
        this.#unknownExecution = false; this.#retentionRevision++;
      }
    }
    for (const { id, sessionID } of cut.work) {
      if (inventory.checkedOwners.has(sessionID) && !inventory.work.has(id)) this.#removeWork(id);
    }
    // Positive activity observed after the inbox read can replace an input pin
    // whose consumption occurred during lost SSE continuity. It remains only
    // lifecycle authority, never current-input or approval evidence.
    for (const [id, sessionID] of inventory.work) this.#addWork(id, sessionID);
    // Collapsed overflow inventories stay unknown: their exact IDs were lost.
    return true;
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
    this.#retentionRevision++; this.#unknownWork = true; this.#pending.clear(); this.#work.clear(); this.#workBytes = 0; this.#current = null;
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
  #addWork(id: string, sessionID: string): void {
    this.#retentionRevision++;
    const previous = this.#work.get(id);
    if (previous === undefined) this.#workBytes += Buffer.byteLength(id) + Buffer.byteLength(sessionID) + 32;
    else this.#workBytes += Buffer.byteLength(sessionID) - Buffer.byteLength(previous);
    this.#work.set(id, sessionID);
  }
  #removeWork(id: string): void {
    // A terminal observed after an inventory read fences that read even if the
    // corresponding start was lost and no resident marker exists yet.
    this.#retentionRevision++;
    const sessionID = this.#work.get(id);
    if (sessionID === undefined) return;
    this.#work.delete(id);
    this.#workBytes -= Buffer.byteLength(id) + Buffer.byteLength(sessionID) + 32;
  }
  #addPending(id: string, sequence: number | null): void {
    if (!this.#pending.has(id)) this.#workBytes += Buffer.byteLength(id) + 32;
    this.#retentionRevision++; this.#pending.set(id, sequence);
  }
  #removePending(id: string): void { if (this.#pending.delete(id)) { this.#retentionRevision++; this.#workBytes -= Buffer.byteLength(id) + 32; } }
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
