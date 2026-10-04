import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConversationInputRuntimeObservation } from "../../src/server/conversations/conversation-actor-manager.js";
import { ThreadActivityService } from "../../src/server/conversations/thread-activity-service.js";
import { DirectInputRepository } from "../../src/server/db/repositories/direct-input-repository.js";
import { createInMemoryThreadRuntimeHarness } from "../support/in-memory-thread-runtime-harness.js";

type Harness = Awaited<ReturnType<typeof createInMemoryThreadRuntimeHarness>>;
type Observation = ConversationInputRuntimeObservation | undefined;

describe("thread activity authority", { timeout: 30_000 }, () => {
  let h: Harness;
  let threadId: string;
  let settled: ConversationInputRuntimeObservation;

  beforeAll(async () => {
    h = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    const created = await h.lifecycle.createServerDraft(h.scope, {
      workspaceId: h.workspaceRecord.id, connectionProfileId: h.connection.id,
      title: "Activity authority", initialText: "",
    });
    threadId = created.applicationThreadId;
    await h.mutations.admitInput(h.scope, threadId, {
      mutationId: randomUUID(), text: "Start", origin: { clientId: randomUUID() }, runningPolicy: { mode: "queue" },
    });
    await vi.waitFor(() => expect(h.actors.observeInputRuntime(h.scope, threadId)?.settled).toBe(true), { timeout: 15_000 });
    await Promise.all(h.completionFollowUps.splice(0));
    settled = h.actors.observeInputRuntime(h.scope, threadId)!;
  });
  afterAll(async () => { await h?.close(); });

  function service(read: () => Observation, now?: () => number) {
    let listener: ((scope: { tenantId: string; principalId: string }, id: string) => void) | undefined;
    const activity = new ThreadActivityService({
      database: h.database,
      actors: { observeInputRuntime: () => read(), subscribeInputActivity: next => { listener = next; return () => { listener = undefined; }; } },
      presentation: h.mutations.input.presentation,
      ...(now ? { now } : {}),
    });
    return { activity, publish: () => listener?.(h.scope, threadId) };
  }
  const terminalUnsettled = (): ConversationInputRuntimeObservation =>
    ({ ...settled, runState: "running", settled: false, sourceTurnStatus: "completed" });
  // Retained facts reported while a replacement snapshot is installed.
  const reestablishing = (from: ConversationInputRuntimeObservation): ConversationInputRuntimeObservation =>
    ({ ...from, authoritative: false, reestablishing: true });
  const replaced = (from: ConversationInputRuntimeObservation, generation: string): ConversationInputRuntimeObservation =>
    ({ ...from, authoritative: true, reestablishing: false, generation: `${from.ownerGeneration}:${generation}` });

  it("keeps the completion target through a replacement snapshot between the terminal bookend and idle", async () => {
    let observation: Observation = terminalUnsettled();
    const { activity, publish } = service(() => observation);
    try {
      const terminal = await activity.capture(h.scope, threadId);
      const context = activity.notificationContext(h.scope, threadId, settled.sourceTurnId);
      expect(context.recognitionTarget).toMatchObject({ activityToken: terminal.activityToken, sourceTurnId: settled.sourceTurnId });
      observation = reestablishing(observation);
      publish();
      // Pending authority never resolves the waiter, and a re-check waits for the outcome.
      let answered = false;
      const recheck = activity.capture(h.scope, threadId).finally(() => { answered = true; });
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(answered).toBe(false);
      observation = replaced({ ...settled }, "replacement");
      publish();
      await expect(context.settlement).resolves.toEqual(context.recognitionTarget);
      expect(await recheck).toMatchObject({
        activityToken: terminal.activityToken, authority: "current", automaticListenEligible: true,
      });
    } finally { activity.close(); }
  });

  it("waits through re-establishment when the completion is observed while the replacement is installed", async () => {
    let observation: Observation = reestablishing(terminalUnsettled());
    const { activity, publish } = service(() => observation);
    try {
      const context = activity.notificationContext(h.scope, threadId, settled.sourceTurnId);
      expect(context.settlement).toBeDefined();
      observation = replaced({ ...settled }, "after-window");
      publish();
      const target = await context.settlement;
      expect(target).toEqual(context.recognitionTarget);
      expect(await activity.capture(h.scope, threadId)).toMatchObject({ activityToken: target!.activityToken, automaticListenEligible: true });
    } finally { activity.close(); }
  });

  it("keeps an idle token across a replacement snapshot before the listener re-check", async () => {
    let observation: Observation = { ...settled };
    const { activity, publish } = service(() => observation);
    try {
      const context = activity.notificationContext(h.scope, threadId, settled.sourceTurnId);
      expect(context.settlement).toBeUndefined();
      const token = context.recognitionTarget!.activityToken;
      observation = reestablishing(observation);
      publish();
      // Native re-checks exactly once; that single read answers after the replacement.
      const recheck = activity.capture(h.scope, threadId);
      await new Promise(resolve => setTimeout(resolve, 30));
      observation = replaced(observation, "next");
      publish();
      expect(await recheck).toMatchObject({ activityToken: token, authority: "current", automaticListenEligible: true });
      // A replacement owner with identical facts is new authority, as are different facts.
      observation = { ...observation, ownerGeneration: "another-owner", generation: "another-owner:projection" };
      const owner = (await activity.capture(h.scope, threadId)).activityToken;
      expect(owner).not.toBe(token);
      observation = { ...observation, sourceTurnId: "turn_replacement", sourceTurnStatus: "in_progress", runState: "running", settled: false };
      expect((await activity.capture(h.scope, threadId)).activityToken).not.toBe(owner);
    } finally { activity.close(); }
  });

  it("treats a failed replacement as lost authority and never revives the token", async () => {
    let observation: Observation = terminalUnsettled();
    const { activity, publish } = service(() => observation);
    try {
      const context = activity.notificationContext(h.scope, threadId, settled.sourceTurnId);
      observation = reestablishing(observation);
      publish();
      observation = { ...observation, reestablishing: false, settled: false };
      publish();
      await expect(context.settlement).resolves.toBeUndefined();
      observation = replaced({ ...settled }, "recovered");
      expect((await activity.capture(h.scope, threadId)).activityToken).not.toBe(context.recognitionTarget!.activityToken);
    } finally { activity.close(); }
  });

  it("bounds an input-context read during a replacement and reports a failed replacement as unavailable", async () => {
    let clock = 1_000_000;
    let observation: Observation = reestablishing({ ...settled });
    const { activity, publish } = service(() => observation, () => clock);
    try {
      const bounded = activity.capture(h.scope, threadId);
      clock += 5_000;
      expect(await bounded).toMatchObject({ authority: "unavailable", automaticListenEligible: false });
      const failing = activity.capture(h.scope, threadId);
      observation = { ...observation, reestablishing: false, settled: false };
      publish();
      expect(await failing).toMatchObject({ authority: "unavailable", automaticListenEligible: false });
      // Wrong scope is rejected before any wait.
      observation = reestablishing({ ...settled });
      await expect(activity.capture({ ...h.scope, principalId: randomUUID() }, threadId)).rejects.toMatchObject({ code: "not_found" });
      const closing = activity.capture(h.scope, threadId);
      activity.close();
      expect(await closing).toMatchObject({ automaticListenEligible: false });
    } finally { activity.close(); }
  });

  it("releases announce-only speech at the five-second settlement deadline", async () => {
    let clock = 1_000_000;
    const observation = terminalUnsettled();
    const { activity } = service(() => observation, () => clock);
    try {
      const context = activity.notificationContext(h.scope, threadId, settled.sourceTurnId);
      let resolved = false;
      void context.settlement!.then(() => { resolved = true; });
      clock += 4_999;
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(resolved).toBe(false);
      clock += 1;
      await expect(context.settlement).resolves.toBeUndefined();
    } finally { activity.close(); }
  });

  it("bounds settlement waiters and resolves every waiter on close", async () => {
    const observation = terminalUnsettled();
    const { activity } = service(() => observation);
    const contexts = Array.from({ length: 256 }, () => activity.notificationContext(h.scope, threadId, settled.sourceTurnId));
    expect(contexts.every(context => context.settlement !== undefined)).toBe(true);
    // The 257th completion cannot reserve a waiter, so it is announce-only.
    const overflow = activity.notificationContext(h.scope, threadId, settled.sourceTurnId);
    expect(overflow.recognitionTarget).toBeUndefined();
    expect(overflow.settlement).toBeUndefined();
    activity.close();
    await expect(Promise.all(contexts.map(context => context.settlement))).resolves.toEqual(contexts.map(() => undefined));
    expect(activity.notificationContext(h.scope, threadId, settled.sourceTurnId).recognitionTarget).toBeUndefined();
  });

  it("gives no target when a newer turn started before the completion notification", async () => {
    const observation: ConversationInputRuntimeObservation = {
      ...settled, runState: "running", settled: false, sourceTurnId: "turn_newer", sourceTurnStatus: "in_progress", activeTurnId: "turn_newer",
    };
    const { activity } = service(() => observation);
    try {
      const context = activity.notificationContext(h.scope, threadId, settled.sourceTurnId);
      expect(context.recognitionTarget).toBeUndefined();
      expect(context.settlement).toBeUndefined();
    } finally { activity.close(); }
  });

  it("never throws from notification context, keeping announce-only delivery", async () => {
    const observation = { ...settled };
    const { activity } = service(() => observation);
    const turnOrigin = vi.spyOn(DirectInputRepository.prototype, "turnOrigin").mockImplementation(() => { throw new Error("database_busy"); });
    try {
      expect(activity.notificationContext(h.scope, threadId, settled.sourceTurnId)).toMatchObject({
        recognitionTarget: { threadId, sourceTurnId: settled.sourceTurnId },
      });
      expect(activity.notificationContext(h.scope, randomUUID(), settled.sourceTurnId)).toEqual({});
      expect(activity.notificationContext({ ...h.scope, principalId: randomUUID() }, threadId)).toEqual({});
    } finally { turnOrigin.mockRestore(); activity.close(); }
  });
});
