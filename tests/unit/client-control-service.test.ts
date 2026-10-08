import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ClientControlService, MAX_POLL_RESPONSE_BYTES } from "../../src/server/domain/client-control-service.js";
import type { AuthenticationClient } from "../../src/shared/authentication.js";
import type { ClientCommand, ClientState } from "../../src/shared/protocol/client-controls.js";
import { serializedUtf8Bytes } from "../../src/shared/protocol/payload.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const state: ClientState = { runtime: { foreground: true, voiceReady: false, interactionActive: false }, settings: null };
const registration = { platform: "browser" as const, capabilities: { navigate: true, voice: false, voiceSettings: false }, state };
const services: ClientControlService[] = [];
const fixture = (now?: () => number) => { const service = new ClientControlService(now); services.push(service); return service; };
afterEach(() => { for (const service of services.splice(0)) service.close(); vi.useRealTimers(); });
const poll = (service: ClientControlService, connectionToken: string, acknowledgements: Array<{ id: string; result: { status: "accepted" | "applied"; reason?: string; state: ClientState } }> = [], signal = new AbortController().signal) =>
  service.poll(scope, connectionToken, undefined, { state, acknowledgements }, signal);
const aborted = () => { const abort = new AbortController(); abort.abort(); return abort.signal; };
const replayTurn = (text: string, turnId = "ended-turn"): Omit<ClientCommand, "id" | "expiresAt"> => ({
  action: "replay_turn", sourceThreadId: "thread", sourceTurnId: "turn", threadId: randomUUID(), threadTitle: "Replay", turnId,
  assistantResult: { unclassified: { text } },
});

describe("registered client authority", () => {
  it("registers anonymous clients independently without pairing and denies foreign principals and tokens", () => {
    const service = fixture();
    const first = service.register(scope, undefined, registration);
    const second = service.register(scope, undefined, registration);
    expect(first.clientId).not.toBe(second.clientId);
    expect(service.origin(scope, first.connectionToken, undefined)).toEqual({ clientId: first.clientId });
    expect(() => service.origin({ ...scope, principalId: "foreign" }, first.connectionToken, undefined)).toThrow();
    expect(() => service.origin({ ...scope, tenantId: "foreign" }, first.connectionToken, undefined)).toThrow();
    expect(() => service.origin(scope, first.clientId, undefined)).toThrow();
    expect(service.list(scope)).toHaveLength(2);
    expect(service.list({ ...scope, principalId: "foreign" })).toEqual([]);
  });

  it("uses the authenticated paired ID and invalidates the previous connection without changing the ID", () => {
    const service = fixture();
    const paired = { id: randomUUID(), name: "Phone", kind: "management", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10000).toISOString() } as AuthenticationClient;
    const first = service.register(scope, paired, registration);
    expect(first.clientId).toBe(paired.id);
    expect(() => service.origin(scope, first.connectionToken, undefined)).toThrow();
    expect(() => service.origin(scope, first.connectionToken, "other-client")).toThrow();
    const second = service.register(scope, paired, registration);
    expect(second.clientId).toBe(first.clientId);
    expect(second.connectionToken).not.toBe(first.connectionToken);
    expect(() => service.origin(scope, first.connectionToken, paired.id)).toThrow();
    expect(service.origin(scope, second.connectionToken, paired.id)).toEqual({ clientId: paired.id });
  });

  it("expires silent clients and never falls back to another connected client", () => {
    let now = 0;
    const service = fixture(() => now);
    const old = service.register(scope, undefined, registration);
    now = 46_000;
    const current = service.register(scope, undefined, registration);
    expect(() => service.target(scope, old.clientId)).toThrow();
    expect(() => service.target(scope, undefined)).toThrow();
    expect(service.list(scope).map(item => item.clientId)).toEqual([current.clientId]);
  });

  it("reports registration capacity as retryable unavailability rather than replacement", () => {
    const service = fixture();
    for (let index = 0; index < 128; index++) service.register(scope, undefined, registration);
    try { service.register(scope, undefined, registration); expect.fail("Expected a capacity rejection"); }
    catch (error) { expect(error).toMatchObject({ code: "runtime_unavailable", retryable: true }); }
  });

  it("resumes anonymous identity with a fresh connection and rejects foreign or replaced sessions", async () => {
    const service = fixture();
    const first = service.register(scope, undefined, registration);
    const waiting = poll(service, first.connectionToken);
    const stopped = expect(waiting).rejects.toMatchObject({ code: "conflict" });
    expect(() => service.register({ ...scope, principalId: "foreign" }, undefined,
      { ...registration, resumeToken: first.resumeToken })).toThrow();
    const next = service.register(scope, undefined, { ...registration, resumeToken: first.resumeToken });
    await stopped;
    expect(next.clientId).toBe(first.clientId);
    expect(next.connectionToken).not.toBe(first.connectionToken);
    expect(service.list(scope)).toHaveLength(1);
    const paired = { id: randomUUID(), name: "Browser" } as AuthenticationClient;
    const tab = service.register(scope, paired, registration);
    service.register(scope, paired, registration);
    expect(() => service.register(scope, paired, { ...registration, resumeToken: tab.resumeToken })).toThrow(/replaced/);
  });

  it("reports a timed-out write as uncertain instead of implying it did not happen", async () => {
    vi.useFakeTimers();
    const service = fixture();
    const registered = service.register(scope, undefined, registration);
    const request = service.request(service.target(scope, registered.clientId), {
      action: "settings.update", sourceThreadId: "thread", sourceTurnId: "turn", expectedRevision: 0, patch: { audioMode: "off" },
    }, new AbortController().signal);
    await poll(service, registered.connectionToken);
    const result = expect(request).rejects.toMatchObject({ code: "operation_outcome_uncertain" });
    await vi.advanceTimersByTimeAsync(25_000); await result;
  });

  it("delivers a command once, waits for its client acknowledgement, and identifies its target", async () => {
    const service = fixture();
    const registered = service.register(scope, undefined, registration);
    const waiting = poll(service, registered.connectionToken);
    const requested = service.request(service.target(scope, registered.clientId), {
      action: "settings.get", sourceThreadId: "thread", sourceTurnId: "turn",
    }, new AbortController().signal);
    const { commands } = await waiting;
    expect(commands).toHaveLength(1);
    const abort = new AbortController(); abort.abort();
    await poll(service, registered.connectionToken, [{ id: commands[0]!.id, result: { status: "applied", state } }], abort.signal);
    expect(await requested).toMatchObject({ client: { clientId: registered.clientId }, status: "applied", state });
    expect(await poll(service, registered.connectionToken, [], abort.signal)).toEqual({ commands: [] });
  });

  it("settles only the captured turn after publication, keeping the playback event identity", async () => {
    const service = fixture();
    const registered = service.register(scope, undefined, registration);
    const requested = service.request(service.target(scope, registered.clientId), {
      action: "switch_thread", sourceThreadId: "thread", sourceTurnId: "turn", threadId: randomUUID(), listen: true,
    }, new AbortController().signal);
    const { commands } = await poll(service, registered.connectionToken);
    const abort = new AbortController(); abort.abort();
    await poll(service, registered.connectionToken, [{ id: commands[0]!.id, result: { status: "accepted", state } }], abort.signal);
    await requested;
    await service.complete(scope, "thread", "another-turn");
    expect(await poll(service, registered.connectionToken, [], abort.signal)).toEqual({ commands: [] });
    let publish!: (id: string) => void;
    service.observeNotification(scope, "thread", "turn", new Promise(resolve => { publish = resolve; }));
    const completing = service.complete(scope, "thread", "turn");
    const settled = poll(service, registered.connectionToken);
    publish("reply-event"); await completing;
    expect((await settled).commands).toEqual([{ ...commands[0], action: "turn_settled", replyEventId: "reply-event", expiresAt: expect.any(Number) }]);
  });

  it("retains deferred actions across long turns and starts a separate playback deadline at settlement", async () => {
    let now = 0;
    const service = fixture(() => now);
    const registered = service.register(scope, undefined, registration);
    const request = service.request(service.target(scope, registered.clientId), {
      action: "end_interaction", sourceThreadId: "thread", sourceTurnId: "turn",
    }, new AbortController().signal);
    const { commands } = await poll(service, registered.connectionToken);
    const abort = new AbortController(); abort.abort();
    await poll(service, registered.connectionToken, [{ id: commands[0]!.id, result: { status: "accepted", state } }], abort.signal);
    await request;
    // Keep the real connection alive while model work continues for ten minutes.
    for (now = 20_000; now <= 600_000; now += 20_000) await poll(service, registered.connectionToken, [], abort.signal);
    await service.complete(scope, "thread", "turn");
    const settled = await poll(service, registered.connectionToken);
    expect(settled.commands[0]).toMatchObject({ id: commands[0]!.id, action: "turn_settled", expiresAt: now + 3_600_000 });
  });

  it("does not replay accepted actions into a replacement connection", async () => {
    const service = fixture();
    const registered = service.register(scope, undefined, registration);
    const requested = service.request(service.target(scope, registered.clientId), {
      action: "end_interaction", sourceThreadId: "thread", sourceTurnId: "turn",
    }, new AbortController().signal);
    const { commands } = await poll(service, registered.connectionToken);
    const abort = new AbortController(); abort.abort();
    await poll(service, registered.connectionToken, [{ id: commands[0]!.id, result: { status: "accepted", state } }], abort.signal);
    await requested;
    service.close();
    const next = service.register(scope, undefined, registration);
    await service.complete(scope, "thread", "turn");
    expect(await poll(service, next.connectionToken, [], abort.signal)).toEqual({ commands: [] });
  });

  it("delivers replay_turn at once with the immediate expiry and never defers it to turn completion", async () => {
    let now = 1_000;
    const service = fixture(() => now);
    const registered = service.register(scope, undefined, registration);
    const requested = service.request(service.target(scope, registered.clientId), replayTurn("Done."), new AbortController().signal);
    const { commands } = await poll(service, registered.connectionToken);
    expect(commands).toEqual([{ ...replayTurn("Done."), threadId: expect.any(String), id: expect.any(String), expiresAt: 121_000 }]);
    // Even an accepted acknowledgement settles the request without waiting for the source turn.
    await poll(service, registered.connectionToken, [{ id: commands[0]!.id, result: { status: "accepted", state } }], aborted());
    expect(await requested).toMatchObject({ status: "accepted" });
    await service.complete(scope, "thread", "turn");
    expect(await poll(service, registered.connectionToken, [], aborted())).toEqual({ commands: [] });
  });

  it("does not deliver a pending replay to a replacement connection and reports its outcome as uncertain", async () => {
    const service = fixture();
    const registered = service.register(scope, undefined, registration);
    const requested = service.request(service.target(scope, registered.clientId), replayTurn("Done."), new AbortController().signal);
    const uncertain = expect(requested).rejects.toMatchObject({ code: "operation_outcome_uncertain" });
    const next = service.register(scope, undefined, { ...registration, resumeToken: registered.resumeToken });
    await uncertain;
    expect(await poll(service, next.connectionToken, [], aborted())).toEqual({ commands: [] });
  });

  it("caps one poll response by serialized bytes and leaves the rest pending in order", async () => {
    const service = fixture();
    const registered = service.register(scope, undefined, registration);
    const target = service.target(scope, registered.clientId);
    // Twenty replays near the 64 KiB command limit need two polls under the 768 KiB response budget.
    const requests = Array.from({ length: 20 }, (_, index) =>
      service.request(target, replayTurn("x".repeat(64_000), `turn-${index}`), new AbortController().signal));
    const first = await poll(service, registered.connectionToken);
    const second = await poll(service, registered.connectionToken);
    for (const response of [first, second]) expect(serializedUtf8Bytes(response)).toBeLessThanOrEqual(MAX_POLL_RESPONSE_BYTES);
    expect(first.commands.length).toBe(Math.floor((MAX_POLL_RESPONSE_BYTES - 15) / (serializedUtf8Bytes(first.commands[0]) + 1)));
    expect([...first.commands, ...second.commands].map(command => command.turnId))
      .toEqual(Array.from({ length: 20 }, (_, index) => `turn-${index}`));
    await poll(service, registered.connectionToken, [...first.commands, ...second.commands]
      .map(({ id }) => ({ id, result: { status: "applied" as const, reason: "replay_queued", state } })), aborted());
    await expect(Promise.all(requests)).resolves.toHaveLength(20);
  });

  it("always delivers one oversized command alone instead of stalling the queue", async () => {
    const service = fixture();
    const registered = service.register(scope, undefined, registration);
    const target = service.target(scope, registered.clientId);
    // Control characters serialize as six-byte escapes: one such command exceeds the whole response budget.
    const oversized = { ...replayTurn(""), assistantResult: Object.fromEntries((["provisional", "final", "unclassified"] as const)
      .map(phase => [phase, { text: "\u0001".repeat(65_536) }])) };
    const requests = [service.request(target, oversized, new AbortController().signal),
      service.request(target, replayTurn("Next.", "next-turn"), new AbortController().signal)];
    const first = await poll(service, registered.connectionToken);
    expect(first.commands).toHaveLength(1);
    expect(serializedUtf8Bytes(first)).toBeGreaterThan(MAX_POLL_RESPONSE_BYTES);
    const second = await poll(service, registered.connectionToken);
    expect(second.commands.map(command => command.turnId)).toEqual(["next-turn"]);
    await poll(service, registered.connectionToken, [...first.commands, ...second.commands]
      .map(({ id }) => ({ id, result: { status: "applied" as const, state } })), aborted());
    await Promise.all(requests);
  });
});
