import { randomBytes, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AuthenticationClient } from "../../shared/authentication.js";
import {
  clientActionResultSchema, type ClientActionResult, type ClientCommand, type ClientState,
  type clientPollRequestSchema, type registerClientSchema,
} from "../../shared/protocol/client-controls.js";
import { serializedUtf8Bytes } from "../../shared/protocol/payload.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { DomainError } from "./errors.js";
import type { VoiceNotificationPublication } from "./notification-service.js";

type Registration = {
  session: ClientSession;
  scope: RequestScope; clientId: string; name: string; paired: boolean;
  platform: z.infer<typeof registerClientSchema>["platform"];
  capabilities: z.infer<typeof registerClientSchema>["capabilities"];
  token: string; state: ClientState; seen: number; commands: ClientCommand[];
  wake?: () => void;
  pending: Map<string, { command: ClientCommand; delivered: boolean; resolve: (result?: ClientActionResult) => void }>;
  retired: Map<string, { command: ClientCommand; expiresAt: number }>;
  deferred: Map<string, ClientCommand>;
};
type ClientSession = { scope: RequestScope; clientId: string; paired: boolean; token: string; seen: number; replaced: boolean };
const scopeKey = (scope: RequestScope) => JSON.stringify([scope.tenantId, scope.principalId]);
const sameScope = (a: RequestScope, b: RequestScope) => scopeKey(a) === scopeKey(b);
const turnKey = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);
const unavailable = () => new DomainError("runtime_unavailable", "The selected client is not connected. Reopen that client and try again.");
const MAX_CLIENTS = 128;
/** Serialized `{ commands }` limit of one poll response, well under native's 1 MiB response limit. */
export const MAX_POLL_RESPONSE_BYTES = 768 * 1_024;
const MAX_POLL_COMMANDS = 64;
const MAX_RETIRED_REQUESTS = 128;
const RETIRED_REQUEST_TTL_MS = 300_000;
const EMPTY_POLL_RESPONSE_BYTES = serializedUtf8Bytes({ commands: [] });

/** Principal-owned live registrations. Tokens fence connection replacement; commands are never persisted or replayed. */
export class ClientControlService {
  readonly #clients = new Map<string, Registration>();
  readonly #sessions = new Map<string, ClientSession>();
  readonly #replaced = new Map<string, number>();
  readonly #notifications = new Map<string, Promise<VoiceNotificationPublication | undefined>>();
  readonly #timer: ReturnType<typeof setInterval>;
  constructor(readonly now: () => number = Date.now) {
    this.#timer = setInterval(() => this.#prune(), 5_000);
    this.#timer.unref();
  }

  register(scope: RequestScope, authenticated: AuthenticationClient | undefined, input: z.infer<typeof registerClientSchema>) {
    this.#prune();
    let session = input.resumeToken ? this.#sessions.get(input.resumeToken) : undefined;
    if (input.resumeToken && (!session || !sameScope(session.scope, scope) || session.paired !== !!authenticated || authenticated && session.clientId !== authenticated.id)) {
      throw new DomainError("not_found", "This client session expired. Register a new session.");
    }
    if (session?.replaced) throw new DomainError("conflict", "This client session was replaced by another application window.");
    if (!session) {
      if (this.#sessions.size >= 256) throw new DomainError("runtime_unavailable", "Too many client sessions. Retry shortly.", true);
      session = { scope: { ...scope }, clientId: authenticated?.id ?? randomUUID(), paired: !!authenticated,
        token: randomBytes(32).toString("base64url"), seen: this.now(), replaced: false };
      this.#sessions.set(session.token, session);
    }
    const clientId = session.clientId;
    for (const client of this.#clients.values()) {
      if (sameScope(client.scope, scope) && client.clientId === clientId) {
        if (client.session !== session) client.session.replaced = true;
        this.#replaced.set(client.token, this.now()); this.#remove(client);
      }
    }
    if (this.#clients.size >= MAX_CLIENTS) throw new DomainError("runtime_unavailable", "Too many connected clients. Retry shortly.", true);
    const token = randomBytes(32).toString("base64url");
    this.#clients.set(token, {
      scope: { ...scope }, session, clientId, token, paired: !!authenticated,
      name: authenticated?.name ?? `Anonymous ${input.platform}`,
      platform: input.platform, capabilities: { ...input.capabilities }, state: input.state,
      seen: this.now(), commands: [], pending: new Map(), retired: new Map(), deferred: new Map(),
    });
    session.seen = this.now();
    return { clientId, connectionToken: token, resumeToken: session.token };
  }

  authenticate(scope: RequestScope, token: string | undefined, authenticatedId: string | undefined) {
    if (token && this.#replaced.has(token)) throw new DomainError("conflict", "This client connection was replaced by another application window.");
    const client = token ? this.#clients.get(token) : undefined;
    if (!client || !sameScope(client.scope, scope) || client.paired && client.clientId !== authenticatedId ||
        client.seen + 45_000 < this.now()) throw unavailable();
    return client;
  }

  origin(scope: RequestScope, token: string | undefined, authenticatedId: string | undefined) {
    return { clientId: this.authenticate(scope, token, authenticatedId).clientId };
  }

  async poll(scope: RequestScope, token: string | undefined, authenticatedId: string | undefined,
    input: z.infer<typeof clientPollRequestSchema>, signal: AbortSignal) {
    const client = this.authenticate(scope, token, authenticatedId);
    if (client.wake) throw new DomainError("conflict", "This client already has an active connection.");
    client.seen = this.now(); client.session.seen = client.seen; client.state = input.state;
    this.#expireRetired(client);
    for (const ack of input.acknowledgements) {
      const pending = client.pending.get(ack.id);
      if (!pending) {
        const retired = client.retired.get(ack.id);
        // The device may have accepted after its caller gave up. Retain the
        // original source identity until the device confirms cancellation.
        if (retired && ack.result.status === "accepted") this.#cancel(client, retired.command);
        else if (retired) client.retired.delete(ack.id);
        continue;
      }
      client.pending.delete(ack.id);
      const result = clientActionResultSchema.parse(ack.result);
      if (result.status === "accepted" && (pending.command.action === "end_interaction" || pending.command.action === "switch_thread")) {
        client.deferred.set(turnKey(pending.command.sourceThreadId, pending.command.sourceTurnId), pending.command);
      }
      pending.resolve(result);
    }
    if (!client.commands.length) await new Promise<void>(resolve => {
      const timer = setTimeout(done, 20_000);
      function done() { clearTimeout(timer); signal.removeEventListener("abort", done); client.wake = undefined; resolve(); }
      client.wake = done;
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
    if (this.#clients.get(client.token) !== client) {
      if (this.#replaced.has(client.token)) throw new DomainError("conflict", "This client connection was replaced by another application window.");
      throw unavailable();
    }
    client.seen = this.now();
    client.session.seen = client.seen;
    // A disconnected waiter cannot consume work intended for its next live poll.
    if (signal.aborted) return { commands: [] };
    return { commands: this.#take(client) };
  }

  /** Unexpired commands in order, up to the poll's count and byte limits; the rest wait for the next poll. */
  #take(client: Registration): ClientCommand[] {
    const now = this.now();
    client.commands = client.commands.filter(command => command.expiresAt > now);
    let bytes = EMPTY_POLL_RESPONSE_BYTES, count = 0;
    for (const command of client.commands) {
      if (count === MAX_POLL_COMMANDS) break;
      const size = serializedUtf8Bytes(command) + (count > 0 ? 1 : 0);
      // The first command always goes, so even an oversized one cannot stall the queue; real commands stay within 64 KiB.
      if (count > 0 && bytes + size > MAX_POLL_RESPONSE_BYTES) break;
      bytes += size; count += 1;
    }
    const commands = client.commands.splice(0, count);
    for (const command of commands) {
      const pending = client.pending.get(command.id);
      if (pending) pending.delivered = true;
    }
    return commands;
  }

  list(scope: RequestScope) {
    this.#prune();
    return [...this.#clients.values()].filter(client => sameScope(scope, client.scope)).map(client => this.describe(client));
  }

  target(scope: RequestScope, clientId: string | undefined) {
    this.#prune();
    const client = [...this.#clients.values()].find(client => sameScope(scope, client.scope) && client.clientId === clientId);
    if (!client) throw unavailable();
    return client;
  }

  describe(client: Registration) {
    return { clientId: client.clientId, name: client.name, platform: client.platform, paired: client.paired,
      online: true as const, capabilities: client.capabilities, ...client.state };
  }

  async request(client: Registration, input: Omit<ClientCommand, "id" | "expiresAt">, signal: AbortSignal) {
    if (this.#clients.get(client.token) !== client) throw unavailable();
    if (client.pending.size + client.deferred.size >= 32 || client.commands.length >= 64) throw new DomainError("conflict", "The client is busy.");
    signal.throwIfAborted();
    // Only these wait for their turn's completion; settings and replay_turn act at once and are never deferred.
    const deferred = input.action === "end_interaction" || input.action === "switch_thread";
    const command: ClientCommand = { ...input, id: randomUUID(), expiresAt: this.now() + (deferred ? 86_400_000 : 120_000) };
    const result = await new Promise<ClientActionResult>((resolve, reject) => {
      const pending = { command, delivered: false, resolve: (result?: ClientActionResult) => done(result) };
      const timer = setTimeout(() => done(undefined), 25_000);
      const abort = () => done(undefined);
      const done = (result: ClientActionResult | undefined) => {
        clearTimeout(timer); signal.removeEventListener("abort", abort); client.pending.delete(command.id);
        if (!result) {
          client.commands = client.commands.filter(queued => queued.id !== command.id);
          if (deferred && pending.delivered && this.#clients.get(client.token) === client) {
            // An issued command can still arrive or be acknowledged after the
            // caller aborts. Cancel now, and again if its acceptance arrives late.
            this.#expireRetired(client);
            client.retired.set(command.id, { command, expiresAt: Math.min(command.expiresAt, this.now() + RETIRED_REQUEST_TTL_MS) });
            while (client.retired.size > MAX_RETIRED_REQUESTS) client.retired.delete(client.retired.keys().next().value!);
            this.#cancel(client, command);
          }
          reject(new DomainError(input.action === "settings.get" ? "runtime_unavailable" : "operation_outcome_uncertain",
            "The client did not acknowledge the request; its outcome is unknown."));
        } else resolve(result);
      };
      client.pending.set(command.id, pending);
      signal.addEventListener("abort", abort, { once: true });
      client.commands.push(command); client.wake?.();
    });
    return { client: this.describe(client), ...result };
  }

  observeNotification(scope: RequestScope, threadId: string, turnId: string, publication: Promise<VoiceNotificationPublication | undefined>) {
    const key = scopeKey(scope) + turnKey(threadId, turnId);
    this.#notifications.set(key, publication);
    // This map only bridges synchronous lifecycle notification and completion observation.
    void publication.finally(() => { if (this.#notifications.get(key) === publication) this.#notifications.delete(key); });
  }

  async complete(scope: RequestScope, threadId: string, turnId: string, outcome = "completed", superseded = false) {
    const cancelled = outcome !== "completed" || superseded;
    const publication = cancelled ? undefined : await this.#notifications.get(scopeKey(scope) + turnKey(threadId, turnId));
    for (const client of this.#clients.values()) {
      if (!sameScope(scope, client.scope)) continue;
      const key = turnKey(threadId, turnId);
      const deferred = client.deferred.get(key);
      client.deferred.delete(key);
      if (!deferred || deferred.expiresAt <= this.now()) continue;
      if (cancelled) {
        this.#cancel(client, deferred);
        continue;
      }
      // Native streams outlive control reconnects. Each voice client matches its
      // current stream locally against the complete same-principal recipient set.
      const replyStreamIds = client.capabilities.voice ? [...publication?.voiceStreamIds ?? []] : [];
      client.commands.push({ ...deferred, action: "turn_settled", replyEventId: replyStreamIds.length ? publication!.sourceEventId : null,
        replyStreamIds, expiresAt: this.now() + 3_600_000 });
      client.wake?.();
    }
  }

  #cancel(client: Registration, command: ClientCommand) {
    if (command.expiresAt <= this.now() || client.commands.some(queued => queued.id === command.id && queued.action === "turn_cancelled")) return;
    client.commands.push({ ...command, action: "turn_cancelled", expiresAt: this.now() + 3_600_000 });
    client.wake?.();
  }

  #expireRetired(client: Registration) {
    for (const [id, retired] of client.retired) if (retired.expiresAt <= this.now()) client.retired.delete(id);
  }

  close() { clearInterval(this.#timer); for (const client of this.#clients.values()) this.#remove(client); this.#sessions.clear(); }
  #remove(client: Registration) {
    this.#clients.delete(client.token); client.wake?.();
    for (const pending of client.pending.values()) pending.resolve();
    client.pending.clear(); client.retired.clear(); client.deferred.clear(); client.commands = [];
  }
  #prune() {
    for (const [token, session] of this.#sessions) if (session.seen + 300_000 < this.now()) this.#sessions.delete(token);
    for (const [token, replacedAt] of this.#replaced) if (replacedAt + 300_000 < this.now()) this.#replaced.delete(token);
    while (this.#replaced.size > 1024) this.#replaced.delete(this.#replaced.keys().next().value!);
    for (const client of this.#clients.values()) {
      this.#expireRetired(client);
      if (client.seen + 45_000 < this.now()) this.#remove(client);
      else for (const [key, command] of client.deferred) if (command.expiresAt <= this.now()) client.deferred.delete(key);
    }
  }
}
