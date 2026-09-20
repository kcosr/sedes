export type TerminalInputOutcome =
  | "accepted"
  | "duplicate"
  | "not_sent"
  | "sent_outcome_unknown"
  | "rejected";

export interface SequencedTerminalInput {
  readonly incarnationId: string;
  readonly controllerEpoch: number;
  readonly producerId: string;
  readonly inputSeq: number;
  readonly bytes: Uint8Array;
}

export type TerminalInputBlockReason =
  | "not_controller"
  | "not_reconciled"
  | "window_full"
  | "delivery_uncertain";

export type SequenceInputResult =
  | { readonly accepted: true; readonly input: SequencedTerminalInput }
  | { readonly accepted: false; readonly reason: TerminalInputBlockReason };

type PendingState = "sent" | "replay" | "replayed" | "retryable";
interface PendingInput {
  input: SequencedTerminalInput;
  state: PendingState;
}

/** Leaves carrier headroom for output acknowledgements, resize, and control. */
export const MAX_IN_FLIGHT_INPUT_ENTRIES = 24;
export const MAX_IN_FLIGHT_INPUT_BYTES = 128 * 1024;

/**
 * Controller-local ordered input ledger. Input is pipelined within a bounded
 * window. Retained bytes let an attach high-water retire the accepted prefix
 * and replay only the suffix which the fenced old epoch cannot later accept.
 */
export class TerminalInputSequencer {
  readonly producerId: string;
  #incarnationId?: string;
  #controllerEpoch?: number;
  #nextInputSeq?: number;
  readonly #pending = new Map<number, PendingInput>();
  #pendingBytes = 0;
  #uncertainInputSeq?: number;

  constructor(producerId: string) {
    if (!producerId) throw new Error("terminal_producer_id_required");
    this.producerId = producerId;
  }

  get inputAvailable(): boolean {
    return this.#authorityAvailable &&
      this.#uncertainInputSeq === undefined &&
      !this.retryAvailable &&
      this.#pending.size < MAX_IN_FLIGHT_INPUT_ENTRIES &&
      this.#pendingBytes < MAX_IN_FLIGHT_INPUT_BYTES;
  }

  get queueingAvailable(): boolean {
    return this.#authorityAvailable &&
      this.#uncertainInputSeq === undefined &&
      !this.retryAvailable;
  }

  get pendingInput(): SequencedTerminalInput | undefined {
    return this.#pending.values().next().value?.input;
  }

  get pendingInputCount(): number {
    return this.#pending.size;
  }

  get pendingInputBytes(): number {
    return this.#pendingBytes;
  }

  get uncertainInputSeq(): number | undefined {
    return this.#uncertainInputSeq;
  }

  get retryAvailable(): boolean {
    return this.#pending.values().next().value?.state === "retryable";
  }

  adoptController(input: {
    readonly incarnationId: string;
    readonly controllerEpoch: number;
    readonly lastAcceptedInputSeq: number;
  }): void {
    assertNonnegativeSafeInteger(input.controllerEpoch, "controller_epoch");
    assertNonnegativeSafeInteger(input.lastAcceptedInputSeq, "last_accepted_input_seq");
    this.#retireThrough(input.lastAcceptedInputSeq);
    this.#incarnationId = input.incarnationId;
    this.#controllerEpoch = input.controllerEpoch;
    const pendingSequences = [...this.#pending.keys()];
    this.#nextInputSeq = Math.max(
      input.lastAcceptedInputSeq + 1,
      (pendingSequences.at(-1) ?? input.lastAcceptedInputSeq) + 1,
    );
    if (
      this.#uncertainInputSeq !== undefined &&
      this.#uncertainInputSeq <= input.lastAcceptedInputSeq
    ) {
      this.#uncertainInputSeq = undefined;
    }
    for (const [sequence, entry] of this.#pending) {
      entry.input = Object.freeze({
        ...entry.input,
        incarnationId: input.incarnationId,
        controllerEpoch: input.controllerEpoch,
      });
      if (this.#uncertainInputSeq === undefined || sequence < this.#uncertainInputSeq) {
        entry.state = "replay";
      }
    }
  }

  loseControl(lastAcceptedInputSeq?: number): void {
    if (lastAcceptedInputSeq !== undefined) {
      assertNonnegativeSafeInteger(lastAcceptedInputSeq, "last_accepted_input_seq");
      this.#retireThrough(lastAcceptedInputSeq);
    }
    this.#incarnationId = undefined;
    this.#controllerEpoch = undefined;
    this.#nextInputSeq = undefined;
  }

  sequence(bytes: Uint8Array): SequenceInputResult {
    if (this.#incarnationId === undefined || this.#controllerEpoch === undefined) {
      return { accepted: false, reason: "not_controller" };
    }
    if (this.#nextInputSeq === undefined) {
      return { accepted: false, reason: "not_reconciled" };
    }
    if (this.#uncertainInputSeq !== undefined) {
      return { accepted: false, reason: "delivery_uncertain" };
    }
    if (
      bytes.byteLength === 0 ||
      this.#pending.size >= MAX_IN_FLIGHT_INPUT_ENTRIES ||
      this.#pendingBytes + bytes.byteLength > MAX_IN_FLIGHT_INPUT_BYTES
    ) {
      return { accepted: false, reason: "window_full" };
    }
    const input: SequencedTerminalInput = Object.freeze({
      incarnationId: this.#incarnationId,
      controllerEpoch: this.#controllerEpoch,
      producerId: this.producerId,
      inputSeq: this.#nextInputSeq++,
      bytes: bytes.slice(),
    });
    this.#pending.set(input.inputSeq, { input, state: "sent" });
    this.#pendingBytes += input.bytes.byteLength;
    return { accepted: true, input };
  }

  resolve(
    inputSeq: number,
    outcome: TerminalInputOutcome,
    lastAcceptedInputSeq = outcome === "accepted" || outcome === "duplicate"
      ? inputSeq
      : inputSeq - 1,
    message?: string,
  ): void {
    const entry = this.#pending.get(inputSeq);
    if (!entry && inputSeq > lastAcceptedInputSeq) return;
    this.#retireThrough(lastAcceptedInputSeq);
    switch (outcome) {
      case "accepted":
      case "duplicate":
        return;
      case "not_sent":
        if (entry) entry.state = "retryable";
        return;
      case "sent_outcome_unknown":
        this.#uncertainInputSeq = inputSeq;
        if (entry) entry.state = "sent";
        return;
      case "rejected":
        if (message === "input_gap") {
          for (const [sequence, pending] of this.#pending) {
            if (
              sequence > lastAcceptedInputSeq &&
              pending.state !== "retryable"
            ) pending.state = "replay";
          }
        }
    }
  }

  /** Returns a provably unaccepted attach/gap suffix entry for automatic replay. */
  nextReplay(): SequencedTerminalInput | undefined {
    if (!this.#authorityAvailable || this.#uncertainInputSeq !== undefined) return undefined;
    for (const entry of this.#pending.values()) {
      if (entry.state === "replayed") continue;
      if (entry.state !== "replay") return undefined;
      entry.state = "replayed";
      return entry.input;
    }
    return undefined;
  }

  retryNotSent(): SequencedTerminalInput | undefined {
    if (!this.#authorityAvailable || this.#uncertainInputSeq !== undefined) return undefined;
    const entry = this.#pending.values().next().value;
    if (!entry || entry.state !== "retryable") return undefined;
    entry.state = "sent";
    return entry.input;
  }

  /**
   * Abandons an ambiguous write and its dependent suffix after explicit user
   * acknowledgement. The bytes are never replayed; the sequence may be reused
   * for subsequent input because the server did not advance its high-water.
   */
  discardUncertain(): boolean {
    const uncertainInputSeq = this.#uncertainInputSeq;
    if (uncertainInputSeq === undefined || !this.#authorityAvailable) return false;
    for (const [sequence, entry] of this.#pending) {
      if (sequence < uncertainInputSeq) continue;
      this.#pending.delete(sequence);
      this.#pendingBytes -= entry.input.bytes.byteLength;
    }
    this.#uncertainInputSeq = undefined;
    this.#nextInputSeq = uncertainInputSeq;
    return true;
  }

  markNotSent(inputSeq: number): void {
    const entry = this.#pending.get(inputSeq);
    if (entry) entry.state = "retryable";
  }

  get #authorityAvailable(): boolean {
    return this.#incarnationId !== undefined &&
      this.#controllerEpoch !== undefined &&
      this.#nextInputSeq !== undefined;
  }

  #retireThrough(highWater: number): void {
    for (const [sequence, entry] of this.#pending) {
      if (sequence > highWater) break;
      this.#pending.delete(sequence);
      this.#pendingBytes -= entry.input.bytes.byteLength;
    }
  }
}

function assertNonnegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`terminal_${name}_invalid`);
  }
}
