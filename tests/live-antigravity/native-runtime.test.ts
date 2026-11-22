import { randomBytes, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { command, readPortHistory, localFixture, observer, untilNative, waitOutcome, quiescent } from "./qualification.js";
import { antigravityNativeActivity } from "../../src/server/backends/antigravity/host/native-activity.js";
import { antigravitySteerConsumed, projectAntigravityHistory } from "../../src/server/backends/antigravity/history.js";
import { buildAntigravityPrompt, inspectAntigravityInput, type AntigravitySubmissionScope } from "../../src/server/backends/antigravity/submission.js";
import { antigravityTerminatedExecutionHeads } from "../../src/server/backends/antigravity/native-execution.js";

it("recovers a rejected permission and queued steer using exact native disposition or explicit Stop", async () => {
  const f = await localFixture();
  try {
    await command(f.host, f.attachment.handleId, { type: "set_mode", modeId: "default" });
    const operationId = randomUUID(), steerId = randomUUID();
    const scope: AntigravitySubmissionScope = { key: randomBytes(32), binding: {
      version: 1, sessionId: f.identity.sessionId, canonicalWorkspacePath: f.cwd,
      tenantId: f.configuration.tenantId, principalId: f.configuration.principalId,
      backendInstanceId: f.configuration.backendInstanceId, executionEnvironmentId: f.configuration.executionEnvironmentId,
      connectionProfileId: "live-qualification", nativeNamespaceKey: "live-qualification",
    } };
    const prompt = (id: string, text: string, delivery: "submit" | "steer") => buildAntigravityPrompt(scope, {
      applicationOperationId: id, mutationId: id, reconciliationToken: randomUUID(), source: { kind: "user" },
      text, contextExcerpts: [], taskContexts: [], attachments: [],
    }, "", delivery);
    const steerPrompt = await prompt(steerId, "Keep the pending bounded run_command permission probe unchanged. After its permission decision, reply SEDES_STEER_PROBE. Use no additional tools.", "steer");
    await f.host.request({ handleId: f.attachment.handleId, operationId, command: { type: "prompt", prompt: await prompt(operationId,
      "This is a bounded permission cancellation test. First output every integer from 1 to 600 on its own line, then use run_command exactly once to run printf SEDES_PERMISSION_PROBE in the current temporary directory. Do not use any other tools. Stop if permission is denied.", "submit") } });
    let afterSequence = f.attachment.retainedAfterSequence;
    let cancelledPermission = false, steeredDuringGeneration = false;
    const deadline = Date.now() + 90_000;
    while (!cancelledPermission && Date.now() < deadline) {
      const observed = await f.host.observe({ handleId: f.attachment.handleId, afterSequence });
      afterSequence = observed.throughSequence;
      if (!steeredDuringGeneration && !observed.events.some(event => event.kind === "permission") &&
          observed.events.some(event => event.kind === "update" && ["agent_message_chunk", "agent_thought_chunk"].includes(event.notification.update.sessionUpdate))) {
        await f.host.request({ handleId: f.attachment.handleId, operationId: steerId, command: { type: "steer", prompt: steerPrompt } });
        steeredDuringGeneration = true;
      }
      for (const event of observed.events) if (event.kind === "permission") {
        await command(f.host, f.attachment.handleId, { type: "permission", requestId: event.requestId,
          response: { outcome: { outcome: "cancelled" } } });
        cancelledPermission = true;
      }
      await f.host.acknowledge({ handleId: f.attachment.handleId, throughSequence: afterSequence });
    }
    expect(steeredDuringGeneration).toBe(true);
    expect(cancelledPermission).toBe(true);
    const evidence = async () => {
      const history = await readPortHistory(f.host, f.identity);
      const outcome = await f.host.outcome({ handleId: f.attachment.handleId, operationId: steerId });
      const input = history.native.steps.find(step => step.user && inspectAntigravityInput(scope, step.user.text).operationId === steerId);
      const primaryInput = history.native.steps.find(step => step.user && inspectAntigravityInput(scope, step.user.text).operationId === operationId);
      const primaryCancelled = primaryInput?.executionId !== undefined && antigravityTerminatedExecutionHeads(history.native).get(primaryInput.executionId)?.outcome === "interrupted";
      const consumed = input !== undefined && antigravitySteerConsumed(history.native, input.index);
      const stopReason = outcome.status === "completed" ? (outcome.result as { stopReason?: string }).stopReason : undefined;
      const disposition = consumed && stopReason === "end_turn" ? "accepted" : stopReason === "cancelled" &&
        outcome.status === "completed" && typeof outcome.cancelledAtNativeRevision === "string" ? "cancelled" : "unproven";
      return { disposition, outcome, consumed, inputIndex: input?.index, primaryCancelled,
        primaryOutcome: await f.host.outcome({ handleId: f.attachment.handleId, operationId }),
        activity: antigravityNativeActivity(history.native), blockers: f.host.snapshot().blockers,
        executions: history.native.executions.slice(-16),
        steps: history.native.steps.slice(-16).map(step => ({ index: step.index, type: step.type, status: step.status,
          executionId: step.executionId, startedAt: step.startedAt, toolId: step.tool?.id,
          user: Boolean(step.user), response: step.response && { stopReason: step.response.stopReason, toolCalls: step.response.toolCalls.map(call => call.id) } })) };
    };
    // agy may consume a concurrent prompt before opening permission. Its normal
    // end_turn callback is accepted only with the authenticated consumed row;
    // a cancelled callback still needs the exact drained-native receipt.
    let resolved = await evidence(), pendingProviderSteer = false;
    try {
      await expect.poll(async () => resolved = await evidence(), { timeout: 5_000 })
        .toMatchObject({ disposition: expect.stringMatching(/^(accepted|cancelled)$/u) });
    } catch (cause) {
      resolved = await evidence();
      // Stock agy 1.5.14 can omit the queued prompt's callback after rejecting
      // permission. The deadline merely bounds observation; exact native
      // cancellation plus the still-pending receipt proves this remains
      // unresolved, never accepted or cancelled by elapsed quiet time.
      if (resolved.primaryCancelled && resolved.primaryOutcome.status === "completed" &&
          resolved.outcome.status === "pending" && resolved.inputIndex === undefined) pendingProviderSteer = true;
      else throw new Error(`LIVE_ANTIGRAVITY_BLOCKER: rejected permission disposition ${JSON.stringify(resolved)}`, { cause });
    }
    const history = await readPortHistory(f.host, f.identity);
    expect(history.native.executions.some(execution => execution.terminationReason === 2)).toBe(true);
    const projection = projectAntigravityHistory(history.native, scope);
    expect(projection.snapshot.runState).toBe("idle");
    const turns = Object.values(projection.snapshot.turnsById);
    const primaryTurn = turns.find(turn => turn.completionCorrelations?.includes(operationId));
    expect(primaryTurn?.status).toBe("interrupted");
    if (resolved.disposition === "accepted") {
      const steerTurn = turns.find(turn => turn.completionCorrelations?.includes(steerId));
      expect(steerTurn).toBeDefined();
      // A consumed Steer can share the interrupted original execution or run
      // as its own completed turn after the permission decision.
      expect(steerTurn?.status).toBe(steerTurn?.backendTurnId === primaryTurn?.backendTurnId ? "interrupted" : "completed");
    } else expect(turns.at(-1)?.status).toBe("interrupted");
    expect(quiescent(history)).toBe(true);
    expect(history.native.steps.filter(step => step.command).every(step => step.command?.output === "")).toBe(true);
    if (pendingProviderSteer) {
      expect(resolved.outcome).toEqual({ status: "pending" });
      expect(resolved.outcome).not.toHaveProperty("cancelledAtNativeRevision");
      expect(resolved.consumed).toBe(false);
      expect(turns.some(turn => turn.completionCorrelations?.includes(steerId))).toBe(false);
      expect(f.host.snapshot().blockers).toContain("unsettled_outcome");
      await expect(f.host.request({ handleId: f.attachment.handleId, operationId: randomUUID(), command: { type: "prompt",
        prompt: [{ type: "text", text: "Must not be delivered while the queued input is unresolved." }] } }))
        .rejects.toMatchObject({ code: "antigravity_session_busy", delivery: "not_sent" });
      const stopId = randomUUID();
      await f.host.request({ handleId: f.attachment.handleId, operationId: stopId, command: { type: "cancel" } });
      const stop = await waitOutcome(f.host, f.attachment.handleId, stopId);
      if (stop.status !== "completed") throw new Error(`LIVE_ANTIGRAVITY_BLOCKER: explicit Stop after rejected permission ${JSON.stringify({ stop, evidence: await evidence() })}`);
      const proof = stop.result as { settledOperationIds: string[]; nativeRevision: string };
      expect(proof.settledOperationIds).toContain(steerId);
      expect(await f.host.outcome({ handleId: f.attachment.handleId, operationId: steerId })).toMatchObject({
        status: "completed", result: { stopReason: "cancelled" }, cancelledAtNativeRevision: proof.nativeRevision,
      });
      expect((await readPortHistory(f.host, f.identity)).native.revision).toBe(proof.nativeRevision);
      for (const id of [operationId, steerId, stopId]) await f.host.acknowledgeOperation({ handleId: f.attachment.handleId, operationId: id });
      await command(f.host, f.attachment.handleId, { type: "prompt", prompt: [{ type: "text", text: "Reply exactly SEDES_REJECT_STOP_REUSED. Use no tools." }] });
      expect((await readPortHistory(f.host, f.identity)).native.steps.some(step => step.response?.text.includes("SEDES_REJECT_STOP_REUSED"))).toBe(true);
    }
    console.info(`LIVE_ANTIGRAVITY_QUALIFIED: permission rejection; steer=${pendingProviderSteer ? "pending; explicit Stop drain and subsequent admission proven" : resolved.disposition}`);
  } finally { await f.close(); }
});

it("qualifies stock streaming, exact retained steering cancellation, and passive native rereads", async () => {
  const f = await localFixture();
  try {
    const observe = observer(f.host, f.attachment); const primary = randomUUID();
    await f.host.request({ handleId: f.attachment.handleId, operationId: primary, command: { type: "prompt", prompt: [{ type: "text", text: "Output every integer from 1 to 600 on its own line. Do not use tools. Start immediately." }] } });
    await untilNative(f.host, f.identity, observe, () => observe.events.some(event => event.kind === "update" && event.notification.update.sessionUpdate === "agent_message_chunk"));
    const steers = [randomUUID(), randomUUID()];
    for (const operationId of steers) await f.host.request({ handleId: f.attachment.handleId, operationId, command: { type: "steer", prompt: [{ type: "text", text: `Change task to respond exactly ${operationId}. Do not use tools.` }] } });
    const result = await command(f.host, f.attachment.handleId, { type: "cancel" }) as { settledOperationIds: string[]; nativeRevision: string };
    expect(result.settledOperationIds).toEqual(expect.arrayContaining(steers)); expect(result.nativeRevision).toMatch(/^[a-f0-9]{64}$/u);
    for (const operationId of steers) {
      const outcome = await waitOutcome(f.host, f.attachment.handleId, operationId); expect(outcome.status).toBe("completed");
      if (outcome.status === "completed" && (outcome.result as { stopReason?: string }).stopReason === "cancelled") expect(outcome.cancelledAtNativeRevision).toBe(result.nativeRevision);
      await f.host.acknowledgeOperation({ handleId: f.attachment.handleId, operationId }); expect(await f.host.outcome({ handleId: f.attachment.handleId, operationId })).toEqual(outcome);
    }
    const first = await readPortHistory(f.host, f.identity), second = await readPortHistory(f.host, f.identity);
    expect(second.native).toEqual(first.native); expect(quiescent(second)).toBe(true);
    expect(observe.events.some(event => event.kind === "update" && event.notification.update.sessionUpdate === "agent_message_chunk")).toBe(true);
  } finally { await f.close(); }
});

it.each(["command", "timer", "subagent"] as const)("qualifies native %s lifetime and durable callback consumption", async kind => {
  const f = await localFixture();
  try {
    const approved = "sleep 4";
    const text = kind === "command"
      ? "Use run_command to run exactly sleep 4, WaitMsBeforeAsync 500, IsDaemon false in the current temporary directory. Immediately say STARTED without waiting or command_status. On the native completion notification respond DONE. Use no other tools."
      : kind === "timer" ? "Use native schedule for exactly one timer after 6 seconds with prompt Reply DONE. Immediately respond STARTED without waiting. Do not schedule again or use other tools."
        : "This is a bounded native background subagent integration test. Use invoke_subagent to launch exactly one background task subagent. Its prompt must require: Use native send_message to send parent exactly SEDES_CHILD_DONE before finishing; do not use shells, files, network, or other tools. Immediately respond SEDES_CHILD_STARTED without waiting. When its message arrives respond SEDES_CHILD_FINISHED. Do not use shells, files, network, or other tools yourself.";
    const observe = observer(f.host, f.attachment, new Set([approved])); const operationId = randomUUID(); let sawActive = false;
    await f.host.request({ handleId: f.attachment.handleId, operationId, command: { type: "prompt", prompt: [{ type: "text", text }] } });
    const history = await untilNative(f.host, f.identity, observe, history => {
      const activity = antigravityNativeActivity(history.native); sawActive ||= activity.active;
      const expected = history.native.steps.some(step => kind === "subagent" ? Boolean(step.subagents?.length) : kind === "timer" ? Boolean(step.schedule) : Boolean(step.command));
      return expected && sawActive && quiescent(history) && history.native.steps.some(step => step.continuation);
    });
    expect(sawActive).toBe(true); expect(history.native.steps.some(step => step.continuation && (kind === "subagent" ? step.continuation.kind === "agent_message" : step.continuation.kind === "task_notification"))).toBe(true);
    expect((await waitOutcome(f.host, f.attachment.handleId, operationId)).status).toBe("completed");
  } finally { await f.close(); }
});

it.each(["command", "timer", "subagent"] as const)("qualifies native %s Stop evidence and subsequent admission", async kind => {
  const f = await localFixture();
  try {
    const text = kind === "command"
      ? "Use run_command to run exactly sleep 30, WaitMsBeforeAsync 500, IsDaemon false in the current temporary directory. Immediately respond STARTED without waiting or command_status. Use no other tools."
      : kind === "timer" ? "Use native schedule for exactly one timer after 30 seconds with prompt Reply DONE. Immediately respond STARTED without waiting. Do not schedule again or use other tools."
        : "Use invoke_subagent to launch exactly one background task subagent. Ask it to output every integer from 1 to 1500 on a separate line, use no tools, and then send its result to parent. Immediately respond STARTED without waiting. Use no other tools yourself.";
    const observe = observer(f.host, f.attachment, new Set(["sleep 30"]));
    const operationId = randomUUID();
    await f.host.request({ handleId: f.attachment.handleId, operationId, command: { type: "prompt", prompt: [{ type: "text", text }] } });
    await untilNative(f.host, f.identity, observe, history => history.native.steps.some(step => kind === "subagent"
      ? step.subagents?.some(child => child.state === "active") : kind === "timer" ? step.schedule && step.status === 2 : step.command && step.status === 2));
    if (kind === "subagent") await waitOutcome(f.host, f.attachment.handleId, operationId);
    const cancelId = randomUUID(); await f.host.request({ handleId: f.attachment.handleId, operationId: cancelId, command: { type: "cancel" } });
    await waitOutcome(f.host, f.attachment.handleId, cancelId);
    const history = await readPortHistory(f.host, f.identity);
    const outcome = await f.host.outcome({ handleId: f.attachment.handleId, operationId: cancelId });
    await f.host.acknowledgeOperation({ handleId: f.attachment.handleId, operationId: cancelId });
    if (kind === "subagent" && outcome.status === "failed") {
      // agy1.5.14 does not reliably cancel child token generation. Qualify the
      // truthful failure branch instead of treating parent cancellation as proof.
      expect(outcome.failure).toEqual({ code: "antigravity_cancel_unproven", delivery: "sent_outcome_unknown" });
      expect(antigravityNativeActivity(history.native).agents).toBeGreaterThan(0);
      await expect(f.host.request({ handleId: f.attachment.handleId, operationId: randomUUID(), command: { type: "prompt", prompt: [{ type: "text", text: "Must not be delivered." }] } })).rejects.toMatchObject({ code: "antigravity_cancel_in_progress", delivery: "not_sent" });
      await f.host.stop({ expectedRevision: f.host.snapshot().revision, force: true }); expect(f.host.snapshot().retainedSessions).toEqual([]);
      return;
    }
    expect(outcome.status).toBe("completed"); if (outcome.status !== "completed") throw new Error("LIVE_ANTIGRAVITY_BLOCKER: Stop did not complete");
    const result = outcome.result as { nativeRevision: string };
    expect(history.native.revision).toBe(result.nativeRevision); expect(quiescent(history)).toBe(true);
    if (kind === "subagent") expect(history.native.steps.flatMap(step => step.subagents ?? []).every(child => child.state === "cancelled" || child.state === "terminal")).toBe(true);
    if (kind === "timer") expect(history.native.steps.some(step => step.schedule?.outcome === "cancelled")).toBe(true);
    await command(f.host, f.attachment.handleId, { type: "prompt", prompt: [{ type: "text", text: "Reply exactly STOP_REUSED. Use no tools." }] });
    expect((await readPortHistory(f.host, f.identity)).native.steps.some(step => step.response?.text.includes("STOP_REUSED"))).toBe(true);
  } finally { await f.close(); }
});
