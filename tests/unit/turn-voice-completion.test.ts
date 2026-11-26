import { expect, it, vi } from "vitest";
import { TurnVoiceCompletion } from "../../src/server/domain/turn-voice-completion.js";
import type { ClientControlService } from "../../src/server/domain/client-control-service.js";
import type { VoiceNotificationPublication } from "../../src/server/domain/notification-service.js";

const scope = {tenantId: "tenant", principalId: "owner"}, threadId = "thread", turnId = "turn";
function input(backendCorrelation: string) {
  return {backendCorrelation, backendCorrelations: ["missing", "winner", "duplicate"], backendTurnId: "backend",
    applicationTurnId: turnId, completionIdentity: "backend:completed", provenance: "live" as const,
    outcome: "completed" as const, result: {text: "Done"}, classifiedResult: null};
}
function coordinator() {
  const finishEarlyReply = vi.fn(), observeNotification = vi.fn<ClientControlService["observeNotification"]>();
  const complete = vi.fn<ClientControlService["complete"]>().mockResolvedValue(undefined);
  const service = new TurnVoiceCompletion({finishEarlyReply}, {observeNotification, complete});
  return {observe: (id: string) => service.observe(scope, threadId, input(id)), finishEarlyReply, observeNotification, complete};
}

it("joins duplicate and unclaimed correlations behind the one pending terminal receipt", async () => {
  const c = coordinator();
  c.observe("missing")();
  expect(c.observeNotification).not.toHaveBeenCalled();
  let resolvePublication!: (result: VoiceNotificationPublication) => void;
  const result = new Promise<VoiceNotificationPublication>(resolve => { resolvePublication = resolve; });
  const publish = vi.fn(() => result);
  const losing = vi.fn();
  c.observe("winner")(publish);
  c.observe("duplicate")(losing);
  // All original observations returned. A replacement projection arrives before settlement.
  c.observe("missing")(losing);
  c.observe("winner")(losing);
  c.observe("duplicate")(losing);
  expect(losing).not.toHaveBeenCalled();
  expect(c.finishEarlyReply).not.toHaveBeenCalled();
  expect(c.complete).toHaveBeenCalledExactlyOnceWith(scope, threadId, turnId, "completed", false);
  expect(c.observeNotification).toHaveBeenCalledOnce();
  const receipt = {sourceEventId: "reply", voiceStreamIds: ["recipient"]};
  resolvePublication(receipt);
  expect(await c.observeNotification.mock.calls[0]![3]).toEqual(receipt);
  expect(c.finishEarlyReply).toHaveBeenCalledExactlyOnceWith(scope, threadId, turnId, receipt);
  c.observe("winner")(losing);
  expect(losing).not.toHaveBeenCalled();
});

it("reports one definitive miss only after every distinct correlation returns", async () => {
  const c = coordinator();
  c.observe("missing")();
  c.observe("missing")();
  c.observe("winner")(() => { throw new Error("unavailable"); });
  expect(c.observeNotification).not.toHaveBeenCalled();
  c.observe("duplicate")(() => undefined);
  expect(await c.observeNotification.mock.calls[0]![3]).toBeUndefined();
  expect(c.finishEarlyReply).toHaveBeenCalledExactlyOnceWith(scope, threadId, turnId, undefined);
  expect(c.complete).toHaveBeenCalledExactlyOnceWith(scope, threadId, turnId, "completed", false);
});

it("keeps ordinary publication available for a later anchored observation after a miss, while completing controls once", async () => {
  const c = coordinator();
  for (const id of ["missing", "winner", "duplicate"]) c.observe(id)();
  await c.observeNotification.mock.calls[0]![3];
  const receipt = {sourceEventId: "reply", voiceStreamIds: ["ordinary-recipient"]};
  const publish = vi.fn(async () => receipt);
  c.observe("missing")(publish);
  c.observe("winner")();
  c.observe("duplicate")();
  await vi.waitFor(() => expect(c.finishEarlyReply).toHaveBeenLastCalledWith(scope, threadId, turnId, receipt));
  expect(publish).toHaveBeenCalledOnce();
  expect(c.complete).toHaveBeenCalledOnce();
});
