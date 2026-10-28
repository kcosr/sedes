import { authenticationStatusSchema } from "../../shared/authentication.js";
import { normalizedApplicationSessionSchema } from "../../shared/protocol/application.js";
import {
  clientActionResultSchema, clientPollResultSchema, registeredClientSchema,
  type ClientActionResult, type ClientCommand, type ClientState, type RegisteredClient,
} from "../../shared/protocol/client-controls.js";
import { notificationPolicySchema, voiceNotificationSchema } from "../../shared/protocol/notification.js";
import { configuredSedesServer, type SedesServerEndpoint } from "../app/server-endpoint.js";
import { authenticatedFetch, getEndpointCredential, getEndpointProfile } from "../authentication/auth-transport.js";

export interface ElectronVoiceBinding { profileId: string; serverOrigin: string; identity: string }
export interface ElectronVoiceConnectionCallbacks {
  state(): ClientState;
  command(command: ClientCommand): Promise<ClientActionResult>;
  registered(registration: RegisteredClient | null): void;
  frame(event: "notification_policy" | "notification", value: unknown, voiceStreamId: string): void;
  notificationsChanged(connected: boolean): void;
  failed(code: string): void;
}
export interface ElectronVoiceConnectionLike {
  readonly registration: RegisteredClient | null;
  readonly voiceStreamId: string | null;
  connect(): Promise<void>;
  request(path: string, init?: RequestInit): Promise<Response>;
  notifications(enabled: boolean): void;
  close(): void;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const READ_TIMEOUT_MS = 50_000;
const POLICY_AFTER_LIVE_MS = 2_000;

/** One authenticated registration. Its runtime owns replacement; requests are never replayed. */
export class ElectronVoiceConnection implements ElectronVoiceConnectionLike {
  registration: RegisteredClient | null = null;
  voiceStreamId: string | null = null;
  readonly #endpoint: SedesServerEndpoint;
  readonly #credential: string | undefined;
  readonly #resumeToken: string | undefined;
  readonly #abort = new AbortController();
  #csrf: string | undefined;
  #connecting: Promise<void> | undefined;
  #notificationsEnabled = false;
  #stream: AbortController | undefined;
  #notificationsConnected = false;

  constructor(readonly scope: ElectronVoiceBinding, readonly callbacks: ElectronVoiceConnectionCallbacks, resumeToken?: string) {
    this.#endpoint = configuredSedesServer(scope.serverOrigin);
    this.#credential = getEndpointCredential(this.#endpoint);
    this.#resumeToken = resumeToken;
  }

  connect(): Promise<void> {
    return this.#connecting ??= this.#connect();
  }

  async #connect(): Promise<void> {
    try {
      const status = authenticationStatusSchema.parse(await this.#json("/api/auth/status"));
      this.#check();
      if (status.required && !status.authenticated) throw new Error("authentication_required");
      if (status.navigationNamespace !== this.scope.identity) throw new Error("connection_identity_changed");
      const session = normalizedApplicationSessionSchema.parse(await this.#json("/api/application/session"));
      this.#check();
      this.#csrf = session.csrfToken;
      const registration = registeredClientSchema.parse(await this.#json("/api/client-registration", {
        ...(this.#resumeToken ? { resumeToken: this.#resumeToken } : {}),
        platform: "electron", capabilities: { navigate: true, voice: true, voiceSettings: true }, state: this.callbacks.state(),
      }));
      this.#check();
      this.registration = registration;
      this.callbacks.registered(registration);
      this.#check();
      if (this.#notificationsEnabled) this.#startNotifications();
      void this.#poll();
    } catch (error) {
      this.#fail(connectionError(error));
      throw error;
    }
  }

  async #poll(): Promise<void> {
    let acknowledgements: Array<{ id: string; result: ClientActionResult }> = [];
    try {
      while (!this.#abort.signal.aborted) {
        const result = clientPollResultSchema.parse(await this.#json("/api/client-controls/poll", {
          state: this.callbacks.state(), acknowledgements,
        }));
        this.#check();
        acknowledgements = [];
        for (const command of result.commands) {
          this.#check();
          const response = command.expiresAt <= Date.now()
            ? { status: "noop" as const, reason: "expired", state: this.callbacks.state() }
            : await this.callbacks.command(command);
          this.#check();
          acknowledgements.push({ id: command.id, result: clientActionResultSchema.parse(response) });
        }
      }
    } catch (error) { this.#fail(connectionError(error)); }
  }

  /** Requests use the credential captured for this exact connection, including caller cancellation. */
  request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.#fetch(path, init, true);
  }

  async #fetch(path: string, init: RequestInit, timeout: boolean): Promise<Response> {
    this.#check();
    const url = new URL(path, this.#endpoint.baseUrl!);
    if (!path.startsWith("/api/") || url.origin !== this.#endpoint.baseUrl || !url.pathname.startsWith("/api/") || url.hash) {
      throw new Error("voice_api_path_invalid");
    }
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    headers.delete("X-CSRF-Token");
    headers.delete("X-Sedes-Client");
    if (!["GET", "HEAD", "OPTIONS"].includes((init.method ?? "GET").toUpperCase())) {
      if (!this.#csrf) throw new Error("client_session_unavailable");
      headers.set("X-CSRF-Token", this.#csrf);
    }
    if (this.registration) headers.set("X-Sedes-Client", this.registration.connectionToken);
    const signal = AbortSignal.any([
      this.#abort.signal, ...(init.signal ? [init.signal] : []), ...(timeout ? [AbortSignal.timeout(30_000)] : []),
    ]);
    signal.throwIfAborted();
    const response = await authenticatedFetch(this.#endpoint, path, { ...init, headers, signal, cache: "no-store" }, this.#credential ?? null);
    if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
    // Check status first: authenticatedFetch clears rejected credentials on a 401.
    if (response.status === 401) {
      await response.body?.cancel();
      this.#fail("authentication_required");
      throw new Error("authentication_required");
    }
    try { this.#check(); }
    catch (error) { await response.body?.cancel(); throw error; }
    return response;
  }

  async #json(path: string, body?: unknown): Promise<unknown> {
    const response = await this.request(path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      if (path === "/api/client-registration" && this.#resumeToken && response.status === 404) throw new Error("client_session_expired");
      throw new Error(response.status === 409 ? "client_connection_replaced" : "client_connection_unavailable");
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let bytes = 0, text = "";
    try {
      while (true) {
        const item = await reader.read();
        this.#check();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw new Error("client_connection_unavailable");
        text += decoder.decode(item.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode()) as unknown;
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }

  notifications(enabled: boolean): void {
    if (this.#abort.signal.aborted || enabled === this.#notificationsEnabled) return;
    this.#notificationsEnabled = enabled;
    this.#closeNotifications();
    if (enabled && this.registration) this.#startNotifications();
  }

  #startNotifications(): void {
    if (this.#stream || this.#abort.signal.aborted) return;
    const stream = new AbortController();
    this.#stream = stream;
    this.voiceStreamId = crypto.randomUUID();
    void this.#readNotifications(stream, this.voiceStreamId);
  }

  async #readNotifications(stream: AbortController, voiceStreamId: string): Promise<void> {
    let readTimer: ReturnType<typeof setTimeout> | undefined, policyTimer: ReturnType<typeof setTimeout> | undefined;
    let policyKnown = false, failure = "notification_stream_unavailable";
    const current = () => this.#stream === stream && !stream.signal.aborted && !this.#abort.signal.aborted;
    const armReadTimeout = () => {
      clearTimeout(readTimer);
      readTimer = setTimeout(() => stream.abort(), READ_TIMEOUT_MS);
    };
    const receive = (event: string, data: string) => {
      if (!current()) return;
      this.#check();
      if (event === "application-live") {
        if (!policyKnown && !policyTimer) policyTimer = setTimeout(() => {
          failure = "notification_policy_unavailable"; stream.abort();
        }, POLICY_AFTER_LIVE_MS);
      } else if (event === "notification_policy") {
        failure = "notification_policy_unavailable";
        const value = notificationPolicySchema.parse(JSON.parse(data));
        this.callbacks.frame(event, value, voiceStreamId);
        if (!current()) return;
        policyKnown = true;
        clearTimeout(policyTimer);
        failure = "notification_stream_unavailable";
        this.#setNotificationsConnected(true);
      } else if (event === "notification") {
        this.callbacks.frame(event, voiceNotificationSchema.parse(JSON.parse(data)), voiceStreamId);
      }
    };
    armReadTimeout();
    try {
      const response = await this.#fetch(`/api/application/events?voiceStreamId=${voiceStreamId}`, {
        signal: stream.signal, headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
      }, false);
      if (!current()) { await response.body?.cancel(); return; }
      if (!response.ok || !response.body || response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
        await response.body?.cancel(); throw new Error("stream_rejected");
      }
      const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
      const abortRead = () => { void reader.cancel().catch(() => undefined); };
      stream.signal.addEventListener("abort", abortRead, { once: true });
      const parser = new VoiceEventParser(receive);
      try {
        while (current()) {
          const item = await reader.read();
          if (!current() || item.done) break;
          armReadTimeout();
          parser.accept(decoder.decode(item.value, { stream: true }));
        }
        if (current()) parser.accept(decoder.decode());
      } finally {
        stream.signal.removeEventListener("abort", abortRead);
        await reader.cancel().catch(() => undefined); reader.releaseLock();
      }
    } catch { /* Report only a stable, credential-free failure code below. */ }
    finally { clearTimeout(readTimer); clearTimeout(policyTimer); }
    if (this.#stream !== stream || this.#abort.signal.aborted) return;
    this.#closeNotifications();
    this.callbacks.failed(failure);
  }

  #check(): void {
    this.#abort.signal.throwIfAborted();
    if (getEndpointCredential(this.#endpoint) !== this.#credential || getEndpointProfile(this.#endpoint) !== this.scope.profileId) {
      this.#fail("connection_identity_changed");
      throw new Error("connection_identity_changed");
    }
  }

  #setNotificationsConnected(connected: boolean): void {
    if (this.#notificationsConnected === connected) return;
    this.#notificationsConnected = connected;
    this.callbacks.notificationsChanged(connected);
  }

  #closeNotifications(): void {
    const stream = this.#stream;
    this.#stream = undefined;
    this.voiceStreamId = null;
    stream?.abort();
    this.#setNotificationsConnected(false);
  }

  #fail(code: string): void {
    if (this.#abort.signal.aborted) return;
    this.close();
    this.callbacks.failed(code);
  }

  close(): void {
    if (this.#abort.signal.aborted) return;
    this.#abort.abort();
    this.#closeNotifications();
    this.#csrf = undefined;
    if (this.registration) { this.registration = null; this.callbacks.registered(null); }
  }
}

function connectionError(error: unknown): string {
  return error instanceof Error && ["authentication_required", "connection_identity_changed", "client_connection_replaced", "client_session_expired"].includes(error.message)
    ? error.message : "client_connection_unavailable";
}

/** Live transient frames only. Inventory IDs and retry hints never become replay state. */
class VoiceEventParser {
  #line = "";
  #lineLength = 0;
  #data: string[] = [];
  #event = "message";
  #characters = 0;
  #oversized = false;
  #afterCr = false;
  constructor(readonly receive: (event: string, data: string) => void) {}
  accept(text: string): void {
    const endings = /[\r\n]/g;
    let position = 0;
    while (position < text.length) {
      if (this.#afterCr) {
        this.#afterCr = false;
        if (text[position] === "\n") { position++; continue; }
      }
      endings.lastIndex = position;
      const ending = endings.exec(text), end = ending?.index ?? text.length;
      this.#characters += end - position + (ending ? 1 : 0);
      this.#lineLength += end - position;
      if (this.#characters > MAX_RESPONSE_BYTES) this.#oversized = true;
      // Keep a bounded prefix even after an oversized inventory frame so an
      // event field arriving after its data cannot hide an oversized voice frame.
      const remaining = Math.max(0, (this.#oversized ? 128 : MAX_RESPONSE_BYTES) - this.#line.length);
      this.#line += text.slice(position, Math.min(end, position + remaining));
      if (ending) {
        this.#consumeLine();
        this.#afterCr = ending[0] === "\r";
      }
      position = ending ? end + 1 : end;
    }
  }
  #consumeLine(): void {
    const line = this.#line;
    this.#line = "";
    const empty = this.#lineLength === 0;
    this.#lineLength = 0;
    if (empty) {
      const relevant = ["notification", "notification_policy", "application-live"].includes(this.#event);
      if (relevant && this.#oversized) throw new Error("stream_too_large");
      if (relevant && this.#data.length) this.receive(this.#event, this.#data.join("\n"));
      this.#event = "message"; this.#data = []; this.#characters = 0; this.#oversized = false;
    } else if (!line.startsWith(":")) {
      const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") this.#event = value;
      else if (field === "data" && !this.#oversized) this.#data.push(value);
    }
  }
}
