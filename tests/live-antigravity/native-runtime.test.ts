import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { command, localFixture, observer, untilNative, waitOutcome, quiescent } from "./qualification.js";
import { antigravityNativeActivity } from "../../src/server/backends/antigravity/host/native-activity.js";

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
    const first = await f.host.readHistory(f.identity), second = await f.host.readHistory(f.identity);
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
    const history = await f.host.readHistory(f.identity);
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
    expect((await f.host.readHistory(f.identity)).native.steps.some(step => step.response?.text.includes("STOP_REUSED"))).toBe(true);
  } finally { await f.close(); }
});
