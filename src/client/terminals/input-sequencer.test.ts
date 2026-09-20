import { describe, expect, it } from "vitest";
import {
  MAX_IN_FLIGHT_INPUT_ENTRIES,
  TerminalInputSequencer,
} from "./input-sequencer.js";

const encoder = new TextEncoder();

describe("TerminalInputSequencer", () => {
  it("pipelines a bounded window without waiting for individual results", () => {
    const sequencer = controller();
    for (let index = 1; index <= MAX_IN_FLIGHT_INPUT_ENTRIES; index += 1) {
      expect(sequencer.sequence(encoder.encode(String(index)))).toMatchObject({
        accepted: true,
        input: { inputSeq: index, controllerEpoch: 2 },
      });
    }
    expect(sequencer.sequence(encoder.encode("full"))).toEqual({
      accepted: false,
      reason: "window_full",
    });

    sequencer.resolve(1, "accepted", 1);
    expect(sequencer.sequence(encoder.encode("refill"))).toMatchObject({
      accepted: true,
      input: { inputSeq: MAX_IN_FLIGHT_INPUT_ENTRIES + 1 },
    });
  });

  it("uses cumulative high-water outcomes to retire the accepted prefix", () => {
    const sequencer = controller();
    sequence(sequencer, "one");
    sequence(sequencer, "two");
    sequence(sequencer, "three");
    expect(sequencer.pendingInputCount).toBe(3);
    sequencer.resolve(3, "accepted", 3);
    expect(sequencer.pendingInputCount).toBe(0);
    expect(sequence(sequencer, "four").inputSeq).toBe(4);
  });

  it("reconciles an accepted prefix and replays only the fenced suffix", () => {
    const sequencer = controller();
    sequence(sequencer, "one");
    const second = sequence(sequencer, "two");
    const third = sequence(sequencer, "three");
    sequencer.loseControl();
    sequencer.adoptController({
      incarnationId: "incarnation-a",
      controllerEpoch: 4,
      lastAcceptedInputSeq: 1,
    });

    expect(sequencer.nextReplay()).toEqual({ ...second, controllerEpoch: 4 });
    expect(sequencer.nextReplay()).toEqual({ ...third, controllerEpoch: 4 });
    expect(sequencer.nextReplay()).toBeUndefined();
    expect(sequence(sequencer, "four")).toMatchObject({ inputSeq: 4, controllerEpoch: 4 });
  });

  it("keeps not-sent bytes for an explicit same-identity retry", () => {
    const sequencer = controller();
    const sent = sequence(sequencer, "secret");
    const suffix = sequence(sequencer, "later");
    sequencer.resolve(sent.inputSeq, "not_sent", 0);
    sequencer.resolve(suffix.inputSeq, "rejected", 0, "input_gap");
    expect(sequencer.nextReplay()).toBeUndefined();
    expect(sequencer.retryNotSent()).toEqual(sent);
    sequencer.resolve(sent.inputSeq, "accepted", 1);
    expect(sequencer.nextReplay()).toEqual(suffix);
  });

  it("halts the whole suffix after an unknown delivery outcome", () => {
    const sequencer = controller();
    const first = sequence(sequencer, "deploy");
    sequence(sequencer, "later");
    sequencer.resolve(first.inputSeq, "sent_outcome_unknown", 0);
    expect(sequencer.uncertainInputSeq).toBe(1);
    expect(sequencer.nextReplay()).toBeUndefined();
    expect(sequencer.sequence(encoder.encode("again"))).toEqual({
      accepted: false,
      reason: "delivery_uncertain",
    });

    sequencer.adoptController({
      incarnationId: "incarnation-a",
      controllerEpoch: 3,
      lastAcceptedInputSeq: 0,
    });
    expect(sequencer.uncertainInputSeq).toBe(1);
    expect(sequencer.nextReplay()).toBeUndefined();

    sequencer.adoptController({
      incarnationId: "incarnation-a",
      controllerEpoch: 3,
      lastAcceptedInputSeq: 1,
    });
    expect(sequencer.uncertainInputSeq).toBeUndefined();
    expect(sequencer.nextReplay()).toMatchObject({ inputSeq: 2, controllerEpoch: 3 });
  });

  it("discards an uncertain suffix only after explicit reconciliation", () => {
    const sequencer = controller();
    const uncertain = sequence(sequencer, "maybe sent");
    sequence(sequencer, "dependent suffix");
    sequencer.resolve(uncertain.inputSeq, "sent_outcome_unknown", 0);
    sequencer.adoptController({
      incarnationId: "incarnation-a",
      controllerEpoch: 3,
      lastAcceptedInputSeq: 0,
    });

    expect(sequencer.discardUncertain()).toBe(true);
    expect(sequencer.uncertainInputSeq).toBeUndefined();
    expect(sequencer.pendingInputCount).toBe(0);
    expect(sequence(sequencer, "fresh input")).toMatchObject({
      inputSeq: 1,
      controllerEpoch: 3,
    });
    expect(sequencer.discardUncertain()).toBe(false);
  });

  it("turns an input-gap suffix into ordered automatic replay", () => {
    const sequencer = controller();
    sequence(sequencer, "one");
    const second = sequence(sequencer, "two");
    const third = sequence(sequencer, "three");
    sequencer.resolve(2, "rejected", 1, "input_gap");
    expect(sequencer.nextReplay()).toEqual(second);
    expect(sequencer.nextReplay()).toEqual(third);
  });
});

function controller(): TerminalInputSequencer {
  const sequencer = new TerminalInputSequencer("panel-a");
  sequencer.adoptController({
    incarnationId: "incarnation-a",
    controllerEpoch: 2,
    lastAcceptedInputSeq: 0,
  });
  return sequencer;
}

function sequence(sequencer: TerminalInputSequencer, value: string) {
  const result = sequencer.sequence(encoder.encode(value));
  if (!result.accepted) throw new Error(`expected input: ${result.reason}`);
  return result.input;
}
