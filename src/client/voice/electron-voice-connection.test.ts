import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientControlService } from "../../server/domain/client-control-service.js";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../shared/protocol/application.js";
import { registerClientSchema, type ClientActionResult, type ClientCommand, type ClientState } from "../../shared/protocol/client-controls.js";
import { defaultNotificationDelivery } from "../../shared/protocol/notification.js";
import { setEndpointCredential, setEndpointProfile } from "../authentication/auth-transport.js";
import { ElectronVoiceConnection } from "./electron-voice-connection.js";

const endpoint = { baseUrl: "https://sedes.example" };
const binding = { profileId: "desktop", serverOrigin: endpoint.baseUrl, identity: "a".repeat(64) };
const registration = { clientId: "11111111-1111-4111-8111-111111111111", connectionToken: "c".repeat(43), resumeToken: "r".repeat(43) };
const state: ClientState = { runtime: { foreground: true, voiceReady: true, interactionActive: false }, settings: null };
const command: ClientCommand = { id: "22222222-2222-4222-8222-222222222222", action: "settings.get",
  sourceThreadId: "source", sourceTurnId: "turn", expiresAt: Date.now() + 120_000 };
const policy = { generation: 1, settings: { enabled: true, silenced: false, revision: 0, assistantResultPhases: ["final"],
  scriptPath: "", arguments: [], timeoutSeconds: 30, delivery: defaultNotificationDelivery() } };
const notification = { generation: 1, sourceEventId: "notice", voice: "speak", payload: { schemaVersion: 5,
  notificationId: "notice", event: "notification.test", occurredAt: "2026-10-27T00:00:00Z", title: "Test", message: "Héllo" } };
const connections: ElectronVoiceConnection[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function pending(init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (init.signal!.aborted) reject(init.signal!.reason);
    else init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  });
}

function fixture(override?: (path: string, init: RequestInit) => Promise<Response> | Response | undefined, resumeToken?: string) {
  setEndpointCredential(endpoint, "secret");
  setEndpointProfile(endpoint, binding.profileId);
  const streams: Array<{ url: URL; controller: ReadableStreamDefaultController<Uint8Array>; cancelled: ReturnType<typeof vi.fn> }> = [];
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const callbacks = { state: vi.fn(() => state), command: vi.fn(async (): Promise<ClientActionResult> => ({ status: "applied", state })),
    registered: vi.fn(), frame: vi.fn(), notificationsChanged: vi.fn(), failed: vi.fn() };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input), path = url.pathname;
    calls.push({ path, init });
    const custom = override?.(path, init);
    if (custom) return custom;
    if (path === "/api/auth/status") return Response.json({ required: true, authenticated: true, navigationNamespace: binding.identity });
    if (path === "/api/application/session") return Response.json({ csrfToken: "csrf", version: "0.1.0",
      clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION, providerPulseEnabled: false, experimentalUsageEnabled: false });
    if (path === "/api/client-registration") return Response.json(registration);
    if (path === "/api/client-controls/poll") return pending(init);
    if (path === "/api/application/events") {
      const cancelled = vi.fn();
      const body = new ReadableStream<Uint8Array>({ start(controller) { streams.push({ url, controller, cancelled }); }, cancel: cancelled });
      return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
    }
    return Response.json({ ok: true });
  }));
  const client = new ElectronVoiceConnection(binding, callbacks, resumeToken);
  connections.push(client);
  const send = (text: string, index = streams.length - 1) => streams[index]!.controller.enqueue(new TextEncoder().encode(text));
  const event = (name: string, value: unknown, index?: number) => send(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`, index);
  return { client, callbacks, calls, streams, send, event };
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  setEndpointCredential(endpoint, null); setEndpointProfile(endpoint, null);
  vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("Electron voice application connection", () => {
  it("binds authentication, CSRF and creates a fresh voice-capable registration when no session token is supplied", async () => {
    const { client, calls, callbacks } = fixture();
    await client.connect();
    expect(calls.map(call => call.path)).toEqual(["/api/auth/status", "/api/application/session", "/api/client-registration", "/api/client-controls/poll"]);
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ platform: "electron", capabilities: { navigate: true, voice: true, voiceSettings: true }, state });
    expect(callbacks.registered).toHaveBeenCalledExactlyOnceWith(registration);
    for (const call of calls) {
      expect(new Headers(call.init.headers).get("Authorization")).toBe("Bearer secret");
      expect(call.init.credentials).toBe("omit");
      expect(call.init.redirect).toBe("error");
    }
    expect(new Headers(calls[2]!.init.headers).get("X-CSRF-Token")).toBe("csrf");
    expect(new Headers(calls[2]!.init.headers).has("X-Sedes-Client")).toBe(false);
    expect(new Headers(calls[3]!.init.headers).get("X-Sedes-Client")).toBe(registration.connectionToken);
    await client.connect();
    expect(calls).toHaveLength(4);
  });

  it("resumes the same anonymous client identity with a new connection token and no action replay", async () => {
    const service = new ClientControlService();
    const principal = { tenantId: "tenant", principalId: "principal" };
    try {
      const { client, callbacks, calls } = fixture((path, init) => {
        if (path === "/api/auth/status") return Response.json({ required: false, authenticated: false, navigationNamespace: binding.identity });
        if (path === "/api/client-registration") return Response.json(service.register(principal, undefined,
          registerClientSchema.parse(JSON.parse(init.body as string))));
        return undefined;
      });
      await client.connect();
      const first = client.registration!;
      client.close();
      const replacement = new ElectronVoiceConnection(binding, callbacks, first.resumeToken);
      connections.push(replacement);
      await replacement.connect();
      expect(replacement.registration).toMatchObject({ clientId: first.clientId, resumeToken: first.resumeToken });
      expect(replacement.registration!.connectionToken).not.toBe(first.connectionToken);
      expect(service.list(principal)).toHaveLength(1);
      const registrations = calls.filter(call => call.path === "/api/client-registration");
      expect(JSON.parse(registrations[0]!.init.body as string)).not.toHaveProperty("resumeToken");
      expect(JSON.parse(registrations[1]!.init.body as string)).toHaveProperty("resumeToken", first.resumeToken);
      const polls = calls.filter(call => call.path === "/api/client-controls/poll");
      expect(polls).toHaveLength(2);
      for (const poll of polls) expect(JSON.parse(poll.init.body as string)).toEqual({ state, acknowledgements: [] });
      expect(calls.filter(call => !["/api/auth/status", "/api/application/session", "/api/client-registration", "/api/client-controls/poll"].includes(call.path))).toEqual([]);
      expect(callbacks.command).not.toHaveBeenCalled();
    } finally { service.close(); }
  });

  it.each([
    [registration.resumeToken, 404, "client_session_expired"],
    [undefined, 404, "client_connection_unavailable"],
    [registration.resumeToken, 409, "client_connection_replaced"],
    [registration.resumeToken, 401, "authentication_required"],
  ])("reports registration status %s/%s once so its runtime can retire the correct session token", async (resumeToken, status, code) => {
    vi.useFakeTimers();
    const { client, callbacks, calls } = fixture(path => path === "/api/client-registration"
      ? new Response("{}", { status }) : undefined, resumeToken);
    await expect(client.connect()).rejects.toThrow(code);
    expect(callbacks.failed).toHaveBeenCalledExactlyOnceWith(code);
    expect(client.registration).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(3);
    expect(callbacks.registered).not.toHaveBeenCalled();
  });

  it("does not classify a missing control route as an expired resume session", async () => {
    const { client, callbacks } = fixture(path => path === "/api/client-controls/poll"
      ? new Response("{}", { status: 404 }) : undefined, registration.resumeToken);
    await client.connect();
    await vi.waitFor(() => expect(callbacks.failed).toHaveBeenCalledExactlyOnceWith("client_connection_unavailable"));
  });

  it("does not send a resume token before the server identity is verified", async () => {
    const { client, callbacks, calls } = fixture(path => path === "/api/auth/status"
      ? Response.json({ required: false, authenticated: false, navigationNamespace: "b".repeat(64) }) : undefined, registration.resumeToken);
    await expect(client.connect()).rejects.toThrow("connection_identity_changed");
    expect(callbacks.failed).toHaveBeenCalledExactlyOnceWith("connection_identity_changed");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it.each([
    [{ required: true, authenticated: false }, "authentication_required"],
    [{ required: true, authenticated: true, navigationNamespace: "b".repeat(64) }, "connection_identity_changed"],
    [{ required: false, authenticated: false }, "connection_identity_changed"],
    [{ required: "false", authenticated: true }, "client_connection_unavailable"],
  ])("rejects an unauthenticated or mismatched server before registration (%j)", async (status, code) => {
    const { client, calls, callbacks } = fixture(path => path === "/api/auth/status" ? Response.json(status) : undefined);
    await expect(client.connect()).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(callbacks.failed).toHaveBeenCalledExactlyOnceWith(code);
    expect(client.registration).toBeNull();
  });

  it("allows an explicitly auth-disabled server only with the verified identity", async () => {
    const { client } = fixture(path => path === "/api/auth/status"
      ? Response.json({ required: false, authenticated: false, navigationNamespace: binding.identity }) : undefined);
    await client.connect();
    expect(client.registration).toEqual(registration);
  });

  it("fences registration arriving after close or an endpoint credential replacement", async () => {
    const delayed = deferred<Response>();
    const { client, callbacks, calls } = fixture(path => path === "/api/client-registration" ? delayed.promise : undefined);
    const connecting = client.connect();
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    setEndpointCredential(endpoint, "new-secret");
    delayed.resolve(Response.json(registration));
    await expect(connecting).rejects.toThrow("connection_identity_changed");
    expect(callbacks.registered).not.toHaveBeenCalled();
    expect(callbacks.failed).toHaveBeenCalledExactlyOnceWith("connection_identity_changed");
    expect(calls).toHaveLength(3);
  });

  it("awaits commands before acknowledging them once and suppresses expired actions", async () => {
    const result = deferred<ClientActionResult>();
    let polls = 0;
    const { client, calls, callbacks } = fixture((path, init) => path === "/api/client-controls/poll"
      ? ++polls === 1 ? Response.json({ commands: [command, { ...command, id: "33333333-3333-4333-8333-333333333333", expiresAt: 0 }] }) : pending(init)
      : undefined);
    callbacks.command.mockReturnValue(result.promise);
    await client.connect();
    await vi.waitFor(() => expect(callbacks.command).toHaveBeenCalledOnce());
    expect(polls).toBe(1);
    result.resolve({ status: "applied", state });
    await vi.waitFor(() => expect(polls).toBe(2));
    expect(JSON.parse(calls.at(-1)!.init.body as string).acknowledgements).toEqual([
      { id: command.id, result: { status: "applied", state } },
      { id: "33333333-3333-4333-8333-333333333333", result: { status: "noop", reason: "expired", state } },
    ]);
  });

  it("does not acknowledge an action that finishes after close", async () => {
    const result = deferred<ClientActionResult>();
    let polls = 0;
    const { client, callbacks } = fixture(path => path === "/api/client-controls/poll"
      ? (++polls, Response.json({ commands: [command] })) : undefined);
    callbacks.command.mockReturnValue(result.promise);
    await client.connect();
    await vi.waitFor(() => expect(callbacks.command).toHaveBeenCalledOnce());
    client.close(); result.resolve({ status: "applied", state });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(polls).toBe(1);
    expect(callbacks.failed).not.toHaveBeenCalled();
    expect(callbacks.registered).toHaveBeenLastCalledWith(null);
  });

  it.each([409, 500, "malformed"])("stops controls once on %s without retry or replay", async failure => {
    vi.useFakeTimers();
    const { client, callbacks, calls } = fixture(path => path === "/api/client-controls/poll"
      ? failure === "malformed" ? Response.json({ commands: [{}] }) : new Response("{}", { status: failure as number }) : undefined);
    await client.connect();
    await vi.waitFor(() => expect(callbacks.failed).toHaveBeenCalledOnce());
    expect(callbacks.failed).toHaveBeenCalledWith(failure === 409 ? "client_connection_replaced" : "client_connection_unavailable");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(4);
    expect(client.registration).toBeNull();
  });

  it("restricts API requests to its origin and overwrites caller authority headers", async () => {
    const { client, calls } = fixture();
    await client.connect();
    for (const path of ["https://other.example/api/test", "//other.example/api/test", "/api/../../private", "/api/..\\private", "/api/test#fragment"]) {
      await expect(client.request(path)).rejects.toThrow("voice_api_path_invalid");
    }
    await client.request("/api/threads/id/inputs", { method: "POST", body: "{}",
      headers: { Authorization: "Bearer other", "X-CSRF-Token": "other", "X-Sedes-Client": "other" } });
    const headers = new Headers(calls.at(-1)!.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret");
    expect(headers.get("X-CSRF-Token")).toBe("csrf");
    expect(headers.get("X-Sedes-Client")).toBe(registration.connectionToken);
    expect(calls).toHaveLength(5);
  });

  it("propagates caller cancellation and never retries a failed input submission", async () => {
    const { client, calls, callbacks } = fixture((path, init) => path.endsWith("/inputs") ? pending(init) : undefined);
    await client.connect();
    const abort = new AbortController();
    const input = client.request("/api/threads/id/inputs", { method: "POST", body: "{}", signal: abort.signal });
    abort.abort();
    await expect(input).rejects.toThrow();
    expect(calls.filter(call => call.path.endsWith("/inputs"))).toHaveLength(1);
    expect(client.registration).toEqual(registration);
    expect(callbacks.failed).not.toHaveBeenCalled();
  });

  it("fails the connection on a rejected credential without registering again", async () => {
    const { client, callbacks, calls } = fixture(path => path === "/api/client-controls/poll" ? new Response("{}", { status: 401 }) : undefined);
    await client.connect();
    await vi.waitFor(() => expect(callbacks.failed).toHaveBeenCalledExactlyOnceWith("authentication_required"));
    expect(client.registration).toBeNull();
    expect(calls).toHaveLength(4);
  });
});

describe("Electron voice live notification stream", () => {
  it("opens only one stream when registration enables notifications synchronously", async () => {
    const { client, callbacks, streams } = fixture();
    callbacks.registered.mockImplementation(value => { if (value) client.notifications(true); });
    await client.connect();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    expect(streams[0]!.url.searchParams.get("voiceStreamId")).toBe(client.voiceStreamId);
  });

  it("reads fragmented UTF-8 and CRLF frames while ignoring inventory IDs and retry hints", async () => {
    const { client, callbacks, streams, event, send } = fixture();
    await client.connect(); client.notifications(true);
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    expect(client.voiceStreamId).toMatch(/^[a-f0-9-]{36}$/);
    send("id: inventory-cursor\nretry: 1\nevent: application-snapshot\ndata: invalid-json-ignored\n\n");
    event("notification_policy", policy);
    send("event: notification\r"); send("\ndata: ");
    const bytes = new TextEncoder().encode(JSON.stringify(notification) + "\r\n\r\n");
    const accent = bytes.indexOf(0xc3);
    streams[0]!.controller.enqueue(bytes.subarray(0, accent + 1));
    streams[0]!.controller.enqueue(bytes.subarray(accent + 1));
    await vi.waitFor(() => expect(callbacks.frame).toHaveBeenCalledTimes(2));
    expect(callbacks.frame).toHaveBeenNthCalledWith(1, "notification_policy", policy, client.voiceStreamId);
    expect(callbacks.frame).toHaveBeenNthCalledWith(2, "notification", notification, client.voiceStreamId);
    expect(callbacks.notificationsChanged).toHaveBeenCalledExactlyOnceWith(true);
    expect(callbacks.failed).not.toHaveBeenCalled();
  });

  it("creates a new live-only identity after an explicit disable/enable without replaying", async () => {
    const { client, callbacks, streams, calls, event } = fixture();
    await client.connect(); client.notifications(true);
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    event("notification_policy", policy);
    await vi.waitFor(() => expect(callbacks.notificationsChanged).toHaveBeenCalledWith(true));
    const first = client.voiceStreamId;
    client.notifications(false); client.notifications(true);
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(streams[0]!.cancelled).toHaveBeenCalledOnce();
    expect(client.voiceStreamId).not.toBe(first);
    expect(callbacks.notificationsChanged).toHaveBeenLastCalledWith(false);
    for (const stream of streams) expect([...stream.url.searchParams.keys()]).toEqual(["voiceStreamId"]);
    for (const call of calls.filter(call => call.path.endsWith("/events"))) {
      expect(new Headers(call.init.headers).has("Last-Event-ID")).toBe(false);
    }
    expect(callbacks.failed).not.toHaveBeenCalled();
  });

  it("requires a policy within two seconds after application-live, then leaves controls running", async () => {
    vi.useFakeTimers();
    const { client, callbacks, streams, event } = fixture();
    await client.connect(); client.notifications(true);
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    event("application-live", {});
    await vi.advanceTimersByTimeAsync(1_999);
    expect(callbacks.failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.failed).toHaveBeenCalledExactlyOnceWith("notification_policy_unavailable");
    expect(client.registration).toEqual(registration);
    expect(client.voiceStreamId).toBeNull();
    client.notifications(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(streams).toHaveLength(1);
  });

  it("cancels the missing-policy deadline when policy arrives after application-live", async () => {
    vi.useFakeTimers();
    const { client, callbacks, event, streams } = fixture();
    await client.connect(); client.notifications(true);
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    event("application-live", {});
    await vi.advanceTimersByTimeAsync(1_500);
    event("notification_policy", policy);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(callbacks.notificationsChanged).toHaveBeenCalledWith(true);
    expect(callbacks.failed).not.toHaveBeenCalled();
  });

  it("times out a silent stream but keeps heartbeat traffic alive", async () => {
    vi.useFakeTimers();
    const { client, callbacks, event, streams, send } = fixture();
    await client.connect(); client.notifications(true);
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    event("notification_policy", policy);
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(20_000); send(": heartbeat\n\n"); }
    await vi.advanceTimersByTimeAsync(49_999);
    expect(callbacks.failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.failed).toHaveBeenCalledExactlyOnceWith("notification_stream_unavailable");
    expect(callbacks.notificationsChanged).toHaveBeenLastCalledWith(false);
    expect(client.registration).toEqual(registration);
  });

  it.each([
    ["notification_policy", "not-json", "notification_policy_unavailable"],
    ["notification_policy", "{}", "notification_policy_unavailable"],
    ["notification", "{}", "notification_stream_unavailable"],
  ])("rejects malformed %s frames without retry", async (name, data, failure) => {
    const { client, callbacks, streams, send } = fixture();
    await client.connect(); client.notifications(true);
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    send(`event: ${name}\ndata: ${data}\n\n`);
    await vi.waitFor(() => expect(callbacks.failed).toHaveBeenCalledExactlyOnceWith(failure));
    expect(callbacks.frame).not.toHaveBeenCalled();
    expect(streams[0]!.cancelled).toHaveBeenCalledOnce();
    expect(client.registration).toEqual(registration);
  });

  it("discards oversized inventory frames but fails oversized voice frames", async () => {
    const { client, callbacks, streams, send, event } = fixture();
    await client.connect(); client.notifications(true);
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    send(`event: application-snapshot\ndata: ${"x".repeat(1024 * 1024 + 1)}\n\n`);
    event("notification_policy", policy);
    await vi.waitFor(() => expect(callbacks.frame).toHaveBeenCalledOnce());
    // SSE permits the event field after data; the byte bound must still apply.
    send(`data: ${"x".repeat(1024 * 1024 + 1)}\nevent: notification\n\n`);
    await vi.waitFor(() => expect(callbacks.failed).toHaveBeenCalledExactlyOnceWith("notification_stream_unavailable"));
  });

  it("closes a late stream response without sending callbacks to a replaced connection", async () => {
    const delayed = deferred<Response>(), cancelled = vi.fn();
    const { client, callbacks, calls } = fixture(path => path === "/api/application/events" ? delayed.promise : undefined);
    await client.connect(); client.notifications(true);
    await vi.waitFor(() => expect(calls.at(-1)!.path).toBe("/api/application/events"));
    client.close();
    delayed.resolve(new Response(new ReadableStream({ cancel: cancelled }), { headers: { "Content-Type": "text/event-stream" } }));
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(callbacks.failed).not.toHaveBeenCalled();
    expect(callbacks.frame).not.toHaveBeenCalled();
  });
});
