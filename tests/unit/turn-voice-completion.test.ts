import { expect, it, vi } from "vitest";
import { TurnVoiceCompletion } from "../../src/server/domain/turn-voice-completion.js";
import { ClientControlService } from "../../src/server/domain/client-control-service.js";
import { MAX_DEFERRED_VOICE_PUBLICATIONS, type VoiceNotificationPublication } from "../../src/server/domain/notification-service.js";

const scope = {tenantId: "tenant", principalId: "owner"}, threadId = "thread", turnId = "turn";
function input(backendCorrelation: string) {
  return {backendCorrelation, backendCorrelations: ["missing", "winner", "duplicate"], backendTurnId: "backend",
    applicationTurnId: turnId, completionIdentity: "backend:completed", provenance: "live" as const,
    outcome: "completed" as const, result: {text: "Done"}, classifiedResult: null};
}
function coordinator() {
  const finishEarlyReply = vi.fn(), observeNotification = vi.fn<ClientControlService["observeNotification"]>();
  const complete = vi.fn<ClientControlService["complete"]>().mockResolvedValue(undefined);
  const pending = new Map<string, Promise<VoiceNotificationPublication | undefined>>();
  observeNotification.mockImplementation((_scope, _threadId, turn, publication) => {
    pending.set(turn, publication);
    void publication.then(() => { if (pending.get(turn) === publication) pending.delete(turn); });
  });
  const hasPendingNotification = (_scope: typeof scope, _threadId: string, turn: string) => pending.has(turn);
  const service = new TurnVoiceCompletion({finishEarlyReply}, {observeNotification, complete, hasPendingNotification});
  return {observe: (id: string) => service.observe(scope, threadId, input(id)), service, finishEarlyReply, observeNotification, complete};
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

it("expires incomplete groups without reporting a miss and lets a delayed admissible callback retain its barrier", async () => {
  vi.useFakeTimers();
  try {
    const c = coordinator();
    const late = c.observe("winner");
    c.observe("missing")();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(c.finishEarlyReply).not.toHaveBeenCalled();
    const receipt = {sourceEventId: "reply", voiceStreamIds: ["recipient"]};
    late(() => Promise.resolve(receipt));
    // A different expected callback never returns.
    expect(await c.observeNotification.mock.calls[0]![3]).toEqual(receipt);
    expect(c.complete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    const duplicate = vi.fn();
    c.observe("duplicate")(duplicate);
    expect(duplicate).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("bounds abandoned correlation sets and protects the winning receipt through repeated oldest-entry reclamation", async () => {
  vi.useFakeTimers();
  try {
    const c = coordinator();
    const late = c.observe("winner");
    c.observe("missing")();
    const extra = (n: number) => c.service.observe(scope, threadId, {...input("missing"), applicationTurnId: String(n), completionIdentity: String(n)});
    for (let index = 0; index <= MAX_DEFERRED_VOICE_PUBLICATIONS; index++) extra(index)();
    expect(vi.getTimerCount()).toBe(MAX_DEFERRED_VOICE_PUBLICATIONS);
    expect(c.observeNotification).not.toHaveBeenCalled();

    let finish!: (receipt: VoiceNotificationPublication) => void;
    late(() => new Promise<VoiceNotificationPublication>(resolve => { finish = resolve; }));
    // Even active ownership evicted from the recent-decision window is fenced
    // by the actual unresolved publication held by the deferred controls.
    for (let index = 0; index <= 4096; index++) {
      c.service.observe(scope, threadId, {...input("one"), backendCorrelations: ["one"], applicationTurnId: "churn-" + index, completionIdentity: String(index)})(() => Promise.resolve(undefined));
      await Promise.resolve();
    }
    vi.advanceTimersByTime(60_000);
    const duplicate = vi.fn();
    c.observe("winner")(duplicate);
    expect(duplicate).not.toHaveBeenCalled();
    const receipt = {sourceEventId: "reply", voiceStreamIds: ["recipient"]};
    finish(receipt);
    const calls = c.observeNotification.mock.calls.filter(call => call[2] === turnId);
    expect(calls).toHaveLength(1);
    expect(await calls[0]![3]).toEqual(receipt);
    expect(c.finishEarlyReply.mock.calls.filter(call => call[2] === turnId)).toEqual([[scope, threadId, turnId, receipt]]);
    c.observe("winner")(duplicate);
    expect(duplicate).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

it("discards incomplete observers on shutdown and fences their delayed callbacks", () => {
  vi.useFakeTimers();
  try {
    const c = coordinator();
    const queued = c.observe("winner");
    c.observe("missing")();
    expect(vi.getTimerCount()).toBe(1);
    c.service.close();
    expect(vi.getTimerCount()).toBe(0);
    const publish = vi.fn();
    queued(publish);
    c.observe("winner")(publish);
    expect(publish).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});


it.each([
  {case: "no accepted correlation", anchored: false, recovered: false, superseded: false, action: "turn_cancelled"},
  {case: "recovered history without an accepted correlation", anchored: false, recovered: true, superseded: false, action: "turn_cancelled"},
  {case: "superseded accepted source", anchored: true, recovered: false, superseded: true, action: "turn_cancelled"},
  {case: "confirmed live source with silent voice", anchored: true, recovered: false, superseded: false, action: "turn_settled"},
  {case: "confirmed recovered source with a staged action", anchored: true, recovered: true, superseded: false, action: "turn_settled"},
] as const)("settles an accepted switch/listen by source authority for $case", async ({anchored, recovered, superseded, action}) => {
  const controls = new ClientControlService();
  const coordinator = new TurnVoiceCompletion({finishEarlyReply: vi.fn()}, controls);
  const state = {runtime: {foreground: true, voiceReady: true, interactionActive: false}, settings: null};
  const client = controls.register(scope, undefined, {platform: "android",
    capabilities: {navigate: true, voice: true, voiceSettings: true}, state});
  const signal = new AbortController().signal;
  try {
    const request = controls.request(controls.target(scope, client.clientId), {action: "switch_thread",
      sourceThreadId: threadId, sourceTurnId: turnId, threadId: "another-thread", listen: true}, signal);
    const poll = () => controls.poll(scope, client.connectionToken, undefined, {state, acknowledgements: []}, signal);
    const command = (await poll()).commands[0]!;
    await controls.poll(scope, client.connectionToken, undefined, {state,
      acknowledgements: [{id: command.id, result: {status: "accepted", state}}]}, AbortSignal.abort());
    await request;
    const result = poll();
    for (const id of ["missing", "winner", "duplicate"]) {
      const observation = {...input(id), provenance: recovered ? "recovered" as const : "live" as const,
        ...(recovered ? {} : {responseVoice: {userInputRevision: 3, superseded}})};
      // Even without a renderable payload, the accepted source record persists.
      coordinator.observe(scope, threadId, observation)(anchored && id === "winner" ? () => undefined : undefined);
    }
    expect((await result).commands).toEqual([expect.objectContaining({id: command.id, action,
      ...(action === "turn_settled" ? {replyEventId: null, replyStreamIds: []} : {})})]);
  } finally {
    coordinator.close();
    controls.close();
  }
});

it("keeps the receipt from an in-flight winner and fences early-stream writes after shutdown", async () => {
  const c = coordinator();
  let finish!: (receipt: VoiceNotificationPublication) => void;
  c.observe("winner")(() => new Promise(resolve => { finish = resolve; }));
  c.service.close();
  const receipt = {sourceEventId: "reply", voiceStreamIds: ["recipient"]};
  finish(receipt);
  expect(await c.observeNotification.mock.calls[0]![3]).toEqual(receipt);
  expect(c.finishEarlyReply).not.toHaveBeenCalled();
});
