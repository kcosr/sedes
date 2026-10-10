import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ConversationInputRuntimeObservation } from "../../src/server/conversations/conversation-actor-manager.js";
import { ThreadActivityService } from "../../src/server/conversations/thread-activity-service.js";
import { DirectInputRepository } from "../../src/server/db/repositories/direct-input-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { threadInputContextSchema } from "../../src/shared/protocol/thread-input.js";
import { PAYLOAD_LIMITS } from "../../src/shared/protocol/payload.js";
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
      actors: { observeInputRuntime: () => read(), isInputRuntimeDormant: () => read() === undefined,
        subscribeInputActivity: next => { listener = next; return () => { listener = undefined; }; } },
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

  it("allows fresh input to a dormant thread without treating it as current automatic-listen authority or attaching it", async () => {
    const { activity } = service(() => undefined);
    const acquire = vi.spyOn(h.actors, "acquire");
    const catalog = vi.spyOn(h.driver, "catalog");
    try {
      const context = await activity.capture(h.scope, threadId);
      expect(context).toMatchObject({ threadTitle: "Activity authority", authority: "unavailable", runState: null,
        automaticListenEligible: false, manualListenEligible: true });
      expect(threadInputContextSchema.parse(context)).toEqual(context);
      const { manualListenEligible: _eligibility, ...missingManual } = context;
      expect(threadInputContextSchema.safeParse(missingManual).success).toBe(false);
      expect(threadInputContextSchema.safeParse({ ...context, manualListenEligible: "true" }).success).toBe(false);
      expect(acquire).not.toHaveBeenCalled();
      expect(catalog).not.toHaveBeenCalled();
      for (const scope of [{ ...h.scope, tenantId: randomUUID() }, { ...h.scope, principalId: randomUUID() }]) {
        await expect(activity.capture(scope, threadId)).rejects.toMatchObject({ code: "not_found" });
      }
      await expect(activity.capture(h.scope, randomUUID())).rejects.toMatchObject({ code: "not_found" });
      activity.close();
      expect(await activity.capture(h.scope, threadId)).toMatchObject({ manualListenEligible: false });
    } finally { acquire.mockRestore(); catalog.mockRestore(); activity.close(); }
  });

  it("requires current title text with the same bounds and empty-text semantics as thread summaries", async () => {
    const { activity } = service(() => undefined);
    try {
      const context = await activity.capture(h.scope, threadId);
      const { threadTitle: _title, ...missingTitle } = context;
      expect(threadInputContextSchema.safeParse(missingTitle).success).toBe(false);
      for (const threadTitle of [null, 7, {}, "x".repeat(PAYLOAD_LIMITS.displayTextCharacters + 1)]) {
        expect(threadInputContextSchema.safeParse({ ...context, threadTitle }).success).toBe(false);
      }
      for (const threadTitle of ["", " \t\u2003 ", "🐙 thread", "x".repeat(PAYLOAD_LIMITS.displayTextCharacters)]) {
        expect(threadInputContextSchema.parse({ ...context, threadTitle }).threadTitle).toBe(threadTitle);
      }
    } finally { activity.close(); }
  });

  it.each(["unbound", "dormant", "current", "refused"] as const)("refreshes the scoped %s thread title without changing input authority or attaching a provider", async state => {
    const id = state === "unbound" ? (await h.lifecycle.createServerDraft(h.scope, {
      workspaceId: h.workspaceRecord.id, connectionProfileId: h.connection.id,
      title: "Unbound title", initialText: "",
    })).applicationThreadId : threadId;
    const observation = state === "current" ? settled : state === "refused"
      ? { ...settled, authoritative: false, reestablishing: false, runState: "disconnected" as const } : undefined;
    const { activity } = service(() => observation);
    const acquire = vi.spyOn(h.actors, "acquire"), catalog = vi.spyOn(h.driver, "catalog");
    h.database.exec("SAVEPOINT input_context_title");
    try {
      const before = await activity.capture(h.scope, id);
      expect(before).toMatchObject({ threadTitle: h.inventoryRepository.getThread(h.scope, id).thread.title,
        authority: state === "unbound" ? "unbound" : state === "current" ? "current" : "unavailable",
        manualListenEligible: state !== "refused" });
      for (const title of ["Renamed source 🐙", " \t\u2003 "]) {
        h.inventoryRepository.renameThread(h.scope, id, {
          title, expectedRevision: h.inventoryRepository.getThread(h.scope, id).thread.revision,
          mutationId: randomUUID(), now: Date.now(),
        });
        // No title-only change may invalidate an otherwise identical recording preflight.
        expect(await activity.capture(h.scope, id)).toEqual({ ...before, threadTitle: title });
      }
      expect(acquire).not.toHaveBeenCalled();
      expect(catalog).not.toHaveBeenCalled();
    } finally {
      h.database.exec("ROLLBACK TO input_context_title; RELEASE input_context_title");
      acquire.mockRestore(); catalog.mockRestore(); activity.close();
    }
  });

  it("returns the fresh title when a rename happens during an awaited cached-policy read", async () => {
    const { activity } = service(() => settled);
    const before = await activity.capture(h.scope, threadId);
    const presentation = h.mutations.input.presentation;
    const current = await presentation.readCached(h.scope, threadId);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cached = vi.spyOn(presentation, "readCached").mockImplementationOnce(async () => {
      await gate;
      return current;
    });
    h.database.exec("SAVEPOINT input_context_title_race");
    try {
      const pending = activity.capture(h.scope, threadId);
      expect(cached).toHaveBeenCalledOnce();
      h.inventoryRepository.renameThread(h.scope, threadId, {
        title: "Renamed while reading policy", expectedRevision: h.inventoryRepository.getThread(h.scope, threadId).thread.revision,
        mutationId: randomUUID(), now: Date.now(),
      });
      release();
      expect(await pending).toEqual({ ...before, threadTitle: "Renamed while reading policy" });
    } finally {
      release(); cached.mockRestore();
      h.database.exec("ROLLBACK TO input_context_title_race; RELEASE input_context_title_race");
      activity.close();
    }
  });

  it("refuses capture throughout retirement of a loaded runtime and permits a fresh dormant attempt afterward", async () => {
    const current = await createInMemoryThreadRuntimeHarness({ retentionMilliseconds: 60_000 });
    try {
      const { applicationThreadId: id } = await current.lifecycle.createServerDraft(current.scope, {
        workspaceId: current.workspaceRecord.id, connectionProfileId: current.connection.id,
        title: "Retirement readiness", initialText: "",
      });
      await current.mutations.admitInput(current.scope, id, {
        mutationId: randomUUID(), text: "Start", origin: { clientId: randomUUID() }, runningPolicy: { mode: "queue" },
      });
      await vi.waitFor(() => expect(current.actors.observeInputRuntime(current.scope, id)?.settled).toBe(true), { timeout: 15_000 });
      await Promise.all(current.completionFollowUps.splice(0));
      const before = await current.mutations.inputContext(current.scope, id);
      expect(before).toMatchObject({ authority: "current", manualListenEligible: true });
      const acquire = vi.spyOn(current.actors, "acquire");
      const catalog = vi.spyOn(current.driver, "catalog");
      const checkReserved = async () => {
        expect(current.actors.observeInputRuntime(current.scope, id)).toBeUndefined();
        expect(current.actors.isInputRuntimeDormant(current.scope, id)).toBe(false);
        const context = await current.mutations.inputContext(current.scope, id);
        expect(context).toMatchObject({ authority: "unavailable", manualListenEligible: false, automaticListenEligible: false });
        expect(context.activityToken).not.toBe(before.activityToken);
      };
      await current.runtimes.runWithRuntimeRetired(current.scope, id, checkReserved);
      expect(current.actors.isInputRuntimeDormant(current.scope, id)).toBe(true);
      const after = await current.mutations.inputContext(current.scope, id);
      expect(after).toMatchObject({ authority: "unavailable", manualListenEligible: true, automaticListenEligible: false });
      expect(after.activityToken).not.toBe(before.activityToken);
      expect(acquire).not.toHaveBeenCalled();
      expect(catalog).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); await current.close(); }
  });

  it.each(["retirement", "explicit stop"] as const)("publishes %s fences even without an actor, preventing dormant ABA", async kind => {
    const current = await createInMemoryThreadRuntimeHarness();
    try {
      const { applicationThreadId: id } = await current.lifecycle.createServerDraft(current.scope, {
        workspaceId: current.workspaceRecord.id, connectionProfileId: current.connection.id,
        title: "Dormant maintenance", initialText: "",
      });
      const before = await current.mutations.inputContext(current.scope, id);
      expect(before.manualListenEligible).toBe(true);
      const notifications = vi.fn();
      const unsubscribe = current.actors.subscribeInputActivity(notifications);
      const maintain = (operation: () => Promise<void>) => kind === "retirement"
        ? current.actors.runWithRuntimeRetired({ scope: current.scope, applicationThreadId: id,
          disposition: { kind: "idle" }, detachCoordinatorRuntime: async () => {}, operation })
        : current.actors.runWithRuntimesStopped({ scope: current.scope, applicationThreadIds: [id],
          stopOwnedResources: async () => {}, detachCoordinatorRuntimes: async () => {}, retireLocalRuntime: operation });
      await maintain(async () => {
        expect(current.actors.isInputRuntimeDormant(current.scope, id)).toBe(false);
        expect(await current.mutations.inputContext(current.scope, id)).toMatchObject({ manualListenEligible: false });
        await expect(current.mutations.inputContext({ ...current.scope, principalId: randomUUID() }, id))
          .rejects.toMatchObject({ code: "not_found" });
      });
      expect(notifications).toHaveBeenCalledTimes(2);
      expect(notifications).toHaveBeenNthCalledWith(1, current.scope, id);
      expect(notifications).toHaveBeenNthCalledWith(2, current.scope, id);
      const after = await current.mutations.inputContext(current.scope, id);
      expect(after.manualListenEligible).toBe(true);
      expect(after.activityToken).not.toBe(before.activityToken);
      // No read inside this next maintenance cycle: publication must still fence
      // a voice cue spanning the complete dormant -> reserved -> dormant cycle.
      await maintain(async () => {});
      expect((await current.mutations.inputContext(current.scope, id)).activityToken).not.toBe(after.activityToken);
      unsubscribe();
    } finally { await current.close(); }
  });

  it.each(["retirement", "explicit stop"] as const)("keeps a rejected %s fence ineligible after the operation returns", async kind => {
    const current = await createInMemoryThreadRuntimeHarness();
    try {
      const { applicationThreadId: id } = await current.lifecycle.createServerDraft(current.scope, {
        workspaceId: current.workspaceRecord.id, connectionProfileId: current.connection.id,
        title: "Unproven retirement", initialText: "",
      });
      expect((await current.mutations.inputContext(current.scope, id)).manualListenEligible).toBe(true);
      const notifications = vi.fn();
      const unsubscribe = current.actors.subscribeInputActivity(notifications);
      const failedCleanup = async () => { throw new Error("test_cleanup_unproven"); };
      const operation = vi.fn(async () => {});
      const maintenance = kind === "retirement"
        ? current.actors.runWithRuntimeRetired({ scope: current.scope, applicationThreadId: id,
          disposition: { kind: "idle" }, detachCoordinatorRuntime: failedCleanup, operation })
        : current.actors.runWithRuntimesStopped({ scope: current.scope, applicationThreadIds: [id],
          stopOwnedResources: async () => {}, detachCoordinatorRuntimes: failedCleanup, retireLocalRuntime: operation });
      await expect(maintenance).rejects.toMatchObject({ name: "ConversationActorRetirementUnprovenError" });
      expect(operation).not.toHaveBeenCalled();
      expect(notifications).toHaveBeenCalledTimes(2);
      expect(current.actors.observeInputRuntime(current.scope, id)).toBeUndefined();
      expect(current.actors.isInputRuntimeDormant(current.scope, id)).toBe(false);
      expect(await current.mutations.inputContext(current.scope, id)).toMatchObject({ manualListenEligible: false });
      expect(await current.mutations.inputContext(current.scope, id)).toMatchObject({ manualListenEligible: false });
      unsubscribe();
    } finally { await current.close(); }
  });

  // The five providers' normalized dispositions: Queue is shared application
  // delivery wherever Submit is supported, and never requires native Steer.
  it.each([
    { backend: "Pi", steerTarget: "turn" },
    { backend: "Codex", steerTarget: "turn" },
    { backend: "Claude", steerTarget: "conversation" },
    { backend: "Grok", steerTarget: null },
    { backend: "OpenCode", steerTarget: "conversation" },
  ] as const)("uses $backend's current Submit capability for fresh input, including running Queue", async ({ steerTarget }) => {
    let observation: ConversationInputRuntimeObservation = { ...settled, backendCapabilities: { ...settled.backendCapabilities,
      deliveryModes: steerTarget === null ? ["submit" as const] : ["submit" as const, "steer" as const], steerTarget } };
    const { activity } = service(() => observation);
    try {
      expect(await activity.capture(h.scope, threadId)).toMatchObject({ automaticListenEligible: true, manualListenEligible: true });
      for (const runState of ["running", "waiting_for_input", "waiting_for_approval"] as const) {
        observation = { ...observation, settled: false, runState, sourceTurnStatus: "in_progress" };
        expect(await activity.capture(h.scope, threadId)).toMatchObject({ automaticListenEligible: false, manualListenEligible: true });
      }
      observation = { ...observation, backendCapabilities: { ...observation.backendCapabilities, deliveryModes: [] } };
      expect(await activity.capture(h.scope, threadId)).toMatchObject({ manualListenEligible: false });
      observation = { ...settled, backendCapabilities: { ...observation.backendCapabilities, deliveryModes: [] } };
      expect(await activity.capture(h.scope, threadId)).toMatchObject({ automaticListenEligible: false, manualListenEligible: false });
    } finally { activity.close(); }
  });

  it.each(["starting", "stopping", "reconciling", "disconnected"] as const)("refuses fresh capture during a retained %s runtime", async runState => {
    const { activity } = service(() => ({ ...settled, runState, settled: false }));
    try { expect(await activity.capture(h.scope, threadId)).toMatchObject({ manualListenEligible: false }); }
    finally { activity.close(); }
  });

  it("refuses stale cached target policy and read-only or incomplete settings for dormant input", async () => {
    const { activity } = service(() => undefined);
    const presentation = h.mutations.input.presentation;
    const current = await presentation.readCached(h.scope, threadId);
    const cached = vi.spyOn(presentation, "readCached");
    try {
      for (const policy of [
        { ...current, inputTargetAvailable: false },
        { ...current, interactionMode: "read_only" as const },
        { ...current, settingDescriptors: [{ id: "model" as const, label: { text: "Model" },
          requiredForFirstSubmission: true, available: true, options: [] }] },
      ]) {
        cached.mockResolvedValueOnce(policy);
        expect(await activity.capture(h.scope, threadId)).toMatchObject({ manualListenEligible: false });
      }
      let release!: (value: typeof current) => void;
      cached.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
      const pending = activity.capture(h.scope, threadId);
      h.database.prepare("UPDATE application_threads SET input_activity_revision = input_activity_revision + 1 WHERE id = ?").run(threadId);
      release(current);
      expect(await pending).toMatchObject({ manualListenEligible: false });
      expect(await activity.capture(h.scope, threadId)).toMatchObject({ manualListenEligible: true });
    } finally { cached.mockRestore(); activity.close(); }
  });

  it.each([
    ["archived", "UPDATE thread_principal_state SET inventory_state = 'archived' WHERE thread_id = ?", "thread"],
    ["snoozed", "UPDATE thread_principal_state SET inventory_state = 'snoozed', snoozed_at = 1, snoozed_until = 2 WHERE thread_id = ?", "thread"],
    ["missing", "UPDATE application_threads SET availability = 'missing' WHERE id = ?", "thread"],
    ["creating", "UPDATE application_threads SET backing_state = 'creating' WHERE id = ?", "thread"],
    ["creation recovery", "UPDATE application_threads SET backing_state = 'creation_unknown' WHERE id = ?", "thread"],
    ["workspace unavailable", "UPDATE workspaces SET availability = 'unavailable' WHERE id = ?", "workspace"],
    ["workspace removed", "UPDATE workspaces SET removed_at = 1 WHERE id = ?", "workspace"],
    ["project removed", "UPDATE projects SET removed_at = 1 WHERE id = (SELECT project_id FROM workspaces WHERE id = ?)", "workspace"],
    ["backend disabled", "UPDATE agent_backend_instances SET enabled = 0 WHERE id = ?", "backend"],
    ["backend configuration changed", "UPDATE agent_backend_instances SET configuration_revision = configuration_revision + 1 WHERE id = ?", "backend"],
    ["connection disabled", "UPDATE agent_connection_profiles SET enabled = 0 WHERE id = ?", "connection"],
    ["environment unavailable", "UPDATE execution_environments SET availability = 'unavailable', diagnostic_code = 'test_unavailable' WHERE id = ?", "environment"],
  ] as const)("refuses dormant capture when %s", async (_name, sql, target) => {
    const id = target === "thread" ? threadId : target === "workspace" ? h.workspaceRecord.id
      : target === "backend" ? h.driver.instance.id : target === "connection" ? h.connection.id : h.connection.executionEnvironmentId;
    const { activity } = service(() => undefined);
    h.database.exec("SAVEPOINT manual_readiness");
    try {
      if (_name === "project removed") h.database.prepare("UPDATE workspaces SET removed_at = 1 WHERE id = ?").run(h.workspaceRecord.id);
      h.database.prepare(sql).run(id);
      expect(await activity.capture(h.scope, threadId)).toMatchObject({ manualListenEligible: false });
    } finally { h.database.exec("ROLLBACK TO manual_readiness; RELEASE manual_readiness"); activity.close(); }
  });

  it("allows queue backlog but refuses the same capacity limit as admission", async () => {
    const { activity } = service(() => ({ ...settled, runState: "running", settled: false }));
    const queue = new QueuedInputRepository(h.database);
    h.database.exec("SAVEPOINT manual_queue_capacity");
    const enqueue = () => queue.enqueue(h.scope, threadId, { mutationId: randomUUID(), text: "Queued input",
      contextExcerpts: [], attachmentIds: [], taskReferences: [], source: { kind: "direct_input",
        expectedThreadRevision: h.inventoryRepository.getThread(h.scope, threadId).thread.revision,
        resolvedDeliveryMode: "queue" }, now: Date.now() });
    try {
      h.database.transaction(() => { for (let index = 0; index < 499; index++) enqueue(); })();
      expect(await activity.capture(h.scope, threadId)).toMatchObject({ automaticListenEligible: false, manualListenEligible: true });
      enqueue();
      expect(await activity.capture(h.scope, threadId)).toMatchObject({ manualListenEligible: false });
      expect(enqueue).toThrow("active-item limit");
    } finally { h.database.exec("ROLLBACK TO manual_queue_capacity; RELEASE manual_queue_capacity"); activity.close(); }
  });

  it.each([
    { result: "uncertain", source: "queued_input", eligible: false },
    { result: "pending_materialization", source: "draft", eligible: false },
    { result: "pending_materialization", source: "queued_input", eligible: true },
  ])("distinguishes $source $result from new-input admission recovery", async ({ result, source, eligible }) => {
    const { activity } = service(() => ({ ...settled, runState: "running", settled: false }));
    const mutationId = randomUUID();
    try {
      h.database.prepare(`INSERT INTO mutation_receipts
        (tenant_id, principal_id, thread_id, mutation_id, operation_kind, request_fingerprint, result_code, result_json, replayable, created_at)
        VALUES (?, ?, ?, ?, 'conversation_steer', ?, ?, ?, 0, ?)`)
        .run(h.scope.tenantId, h.scope.principalId, threadId, mutationId, "a".repeat(64), result, JSON.stringify({ source }), Date.now());
      expect(await activity.capture(h.scope, threadId)).toMatchObject({ manualListenEligible: eligible });
    } finally {
      h.database.prepare("DELETE FROM mutation_receipts WHERE mutation_id = ?").run(mutationId);
      activity.close();
    }
  });

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
