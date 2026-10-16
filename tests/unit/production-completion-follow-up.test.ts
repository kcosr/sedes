import { describe, expect, it, vi } from "vitest";
import { performCompletionFollowUp } from "../../src/server/conversations/authoritative-completion-follow-up.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("production completion follow-up", () => {
  it("delivers callbacks before waiting for a blocked authoritative publication", async () => {
    const publication = deferred();
    const entered = deferred();
    const order: string[] = [];
    const followUp = performCompletionFollowUp({
      deliverCallbacks: () => { order.push("callbacks"); },
      publishCompletion: async () => {
        order.push("publication");
        entered.resolve();
        await publication.promise;
      },
      recoverThread: () => { order.push("recovery"); },
      wakeThread: () => { order.push("wake"); },
    });
    await entered.promise;
    expect(order).toEqual(["callbacks", "publication"]);
    publication.resolve();
    await followUp;
    expect(order).toEqual(["callbacks", "publication", "recovery", "wake"]);
  });

  it("attempts every obligation in order and preserves their failures", async () => {
    const callbackFailure = new Error("callback failed");
    const publicationFailure = new Error("publication failed");
    const recoveryFailure = new Error("recovery failed");
    const order: string[] = [];
    const wake = vi.fn(() => { order.push("wake"); });
    const followUp = performCompletionFollowUp({
      deliverCallbacks: () => { order.push("callbacks"); throw callbackFailure; },
      publishCompletion: async () => { order.push("publication"); throw publicationFailure; },
      recoverThread: () => { order.push("recovery"); throw recoveryFailure; },
      wakeThread: wake,
    });
    await expect(followUp).rejects.toMatchObject({
      message: "Authoritative completion follow-up did not finish cleanly.",
      errors: [callbackFailure, publicationFailure, recoveryFailure],
    });
    expect(order).toEqual(["callbacks", "publication", "recovery", "wake"]);
    expect(wake).toHaveBeenCalledOnce();
  });
});
