import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect, vi } from "vitest";
import type { ConversationHandle, SubmitTurnInput } from "../../src/server/backends/contracts.js";
import type { SidecarRuntimeChannel } from "../../src/server/sidecar/runtime-channel.js";
import type { SidecarRuntimeBody } from "../../src/server/sidecar/runtime-body-channel.js";
import type { PiNativeHostCommand } from "../../src/server/backends/pi/native/sidecar/wire.js";

export interface StreamingReply { readonly text: string; readonly finish: Promise<void> }
interface Trace {
  started: number;
  dispatch?: number;
  beforePrompt: string[];
  prePromptOffers: number;
  exchanges: number;
  pending: Set<string>;
}

export async function measureWarmSend(input: {
  channel: SidecarRuntimeChannel;
  handle: ConversationHandle;
  submission(text: string): SubmitTurnInput;
  setReply(reply: StreamingReply | undefined): void;
  roundTripMs: number;
  historyBytes: number;
  verifiedAt: ReadonlyMap<string, number>;
  modelRequestCount(): number;
}): Promise<void> {
  // An observer on the same carrier can fetch history while Send is in flight.
  // Only the calls made by this queue capture and submit are on its critical path.
  const sender = new AsyncLocalStorage<Trace>();
  const original = input.channel.call;
  const call = original.bind(input.channel);
  input.channel.call = async function (definition, request, options) {
    const body = request as SidecarRuntimeBody;
    const cmd = body.type === "inline" ? body.value as PiNativeHostCommand : undefined;
    const name = cmd?.action === "request" ? String(cmd.input.command.command.type) : cmd?.action;
    const trace = sender.getStore();
    const prePrompt = trace !== undefined && trace.dispatch === undefined && name !== "prompt";
    if (trace) trace.exchanges++;
    if (trace && name === "prompt") {
      expect(trace.dispatch).toBeUndefined();
      trace.dispatch = performance.now() - trace.started;
    }
    if (prePrompt) {
      trace.beforePrompt.push(name ?? "streamed request");
      if (cmd?.action === "outcome") expect(trace.pending.has(cmd.input.operationId)).toBe(true);
    }
    // Every streamed runtime body first exchanges a body.offer with its receiver.
    if (body.type === "stream") {
      if (trace) trace.exchanges++;
      if (prePrompt) trace.prePromptOffers++;
      if (input.roundTripMs) await delay(input.roundTripMs);
    }
    if (input.roundTripMs) await delay(input.roundTripMs / 2);
    const result = await call(definition, request, options);
    const response = result as SidecarRuntimeBody;
    if (response.type === "stream") {
      if (trace) trace.exchanges++;
      if (prePrompt) trace.prePromptOffers++;
      if (input.roundTripMs) await delay(input.roundTripMs);
    }
    if (prePrompt && cmd?.action === "request" && response.type === "inline" &&
      (response.value as { value?: { status?: string } }).value?.status === "pending") {
      trace.pending.add(cmd.input.operationId);
    }
    if (input.roundTripMs) await delay(input.roundTripMs / 2);
    return result;
  };

  const samples = [];
  const acceptedTurns = new Set<string>();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const text = "test progress " + randomUUID();
      const previousModelRequests = input.modelRequestCount();
      let finish!: () => void;
      const completion = new Promise<void>(resolve => { finish = resolve; });
      let firstItem: { turn: string; ms: number } | undefined;
      const trace: Trace = { started: performance.now(), beforePrompt: [], prePromptOffers: 0, exchanges: 0, pending: new Set() };
      const unsubscribe = input.handle.subscribe(event => {
        if ((event.type !== "item_started" && event.type !== "item_updated") || firstItem) return;
        if (event.item.semanticKind === "assistant_message" && event.item.status === "streaming" && event.item.markdown.text === text) {
          firstItem = { turn: event.item.backendTurnId, ms: performance.now() - trace.started };
          finish();
        }
      });
      input.setReply({ text, finish: completion });
      try {
        const message = input.submission("warm Send");
        const send = sender.run(trace, async () => {
          await input.handle.captureSubmissionRetryAnchor();
          const receipt = await input.handle.submit(message);
          return { receipt, exchangesAtReturn: trace.exchanges };
        });
        const [{ receipt, exchangesAtReturn }] = await Promise.all([send,
          vi.waitFor(() => expect(firstItem).toBeDefined(), { timeout: 15_000, interval: 25 })]);
        expect(receipt).toMatchObject({ accepted: true, reconciliationToken: message.reconciliationToken, backendTurnId: firstItem!.turn });
        const turnId = firstItem!.turn;
        expect(acceptedTurns.has(turnId)).toBe(false);
        acceptedTurns.add(turnId);
        await vi.waitFor(async () => {
          const page = await input.handle.history({ limit: 1 });
          const turn = page.turnsById[turnId];
          expect(turn?.status).toBe("completed");
          const items = turn!.orderedBackendItemIds.map(id => page.itemsById[id]);
          expect(items).toEqual(expect.arrayContaining([
            expect.objectContaining({ backendTurnId: turnId, semanticKind: "user_message",
              content: [{ kind: "text", text: { text: message.text } }] }),
            expect.objectContaining({ backendTurnId: turnId, semanticKind: "assistant_message", markdown: { text } }),
          ]));
        }, { timeout: 15_000, interval: 25 });
        expect(input.modelRequestCount()).toBe(previousModelRequests + 1);
        expect(trace.beforePrompt.filter(name => name !== "outcome")).toEqual(["session_status", "prepare_submission"]);
        expect(trace.prePromptOffers).toBe(0);
        expect(trace.dispatch).toBeDefined();
        const verifiedAt = input.verifiedAt.get(message.applicationOperationId);
        expect(verifiedAt).toBeDefined();
        samples.push({ prePromptExchanges: trace.beforePrompt.length + trace.prePromptOffers, exchangesAtReturn, dispatchMs: Math.round(trace.dispatch!),
          receiptMs: Math.round(verifiedAt! - trace.started), firstItemMs: Math.round(firstItem!.ms) });
      } finally {
        finish();
        input.setReply(undefined);
        unsubscribe();
      }
    }
    // A loaded host can occasionally exceed its bounded inline wait. A host
    // that *always* returns pending must still fail the no-latency regression.
    if (input.roundTripMs === 0) {
      expect(samples.some(sample => sample.prePromptExchanges === 2)).toBe(true);
    }
    process.stdout.write(JSON.stringify({ roundTripMs: input.roundTripMs, historyBytes: input.historyBytes, samples }) + "\n");
  } finally {
    input.channel.call = original;
    sender.disable();
  }
}
