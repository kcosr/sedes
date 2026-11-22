import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { command, newSession, observer, quiescent, untilNative, waitOutcome } from "./qualification.js";
import { sshFixture } from "./ssh-fixture.js";

it.skipIf(process.env.SEDES_LIVE_ANTIGRAVITY_SSH !== "1")("preserves the same native owner, operation and durable history across actual SSH loss and controller replacement", async () => {
  const f = await sshFixture(); let port = f.newPort();
  try {
    const { identity, attachment } = await newSession(port, f.cwd, f.setIdentity);
    const incarnation = f.incarnation, observe = observer(port, attachment, new Set(["sleep 8"]));
    const operationId = randomUUID();
    await port.request({ handleId: attachment.handleId, operationId, command: { type: "prompt", prompt: [{ type: "text", text:
      "Use run_command to run exactly sleep 8, WaitMsBeforeAsync 500, IsDaemon false in the current temporary directory. Immediately say SSH_STARTED without waiting or command_status. When the native completion notification arrives respond SSH_DONE. Use no other tools." }] } });
    await untilNative(port, identity, observe, history => history.native.steps.some(step => step.command && step.status === 2));
    await f.disconnect(); await f.reconnect(); expect(f.incarnation).toBe(incarnation);
    const restored = await port.attachExisting(identity); expect(restored?.handleId).toBe(attachment.handleId); expect(restored?.generation).toBe(attachment.generation);
    const recovered = observer(port, restored!, new Set(["sleep 8"]));
    const history = await untilNative(port, identity, recovered, value => quiescent(value) && value.native.steps.some(step => step.continuation));
    expect((await waitOutcome(port, attachment.handleId, operationId)).status).toBe("completed");
    await port.acknowledgeOperation({ handleId: attachment.handleId, operationId });
    await port.close(); port = f.newPort();
    const afterRestart = await port.attachExisting(identity); expect(afterRestart?.handleId).toBe(attachment.handleId);
    expect((await port.readHistory(identity)).native).toEqual(history.native);
    expect((await port.outcome({ handleId: attachment.handleId, operationId })).status).toBe("completed");
    await command(port, attachment.handleId, { type: "prompt", prompt: [{ type: "text", text: "Respond exactly SSH_REATTACHED. Use no tools." }] });
    expect((await port.readHistory(identity)).native.steps.some(step => step.response?.text.includes("SSH_REATTACHED"))).toBe(true);
  } finally { await f.close(); }
});
