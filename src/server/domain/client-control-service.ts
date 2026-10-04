import { randomBytes, randomUUID } from "node:crypto";
import type { z } from "zod";
import type { AuthenticationClient } from "../../shared/authentication.js";
import {
  clientActionResultSchema, type ClientActionResult, type ClientCommand, type ClientState,
  type clientPollRequestSchema, type registerClientSchema,
} from "../../shared/protocol/client-controls.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { DomainError } from "./errors.js";

type Registration = {
  session: ClientSession;
  scope: RequestScope; clientId: string; name: string; paired: boolean;
  platform: z.infer<typeof registerClientSchema>["platform"];
  capabilities: z.infer<typeof registerClientSchema>["capabilities"];
  token: string; state: ClientState; seen: number; commands: ClientCommand[];
  wake?: () => void;
  pending: Map<string, { command: ClientCommand; resolve: (result?: ClientActionResult) => void }>;
  deferred: Map<string, ClientCommand>;
};
type ClientSession = { scope: RequestScope; clientId: string; paired: boolean; token: string; seen: number; replaced: boolean };
const scopeKey = (scope: RequestScope) => JSON.stringify([scope.tenantId, scope.principalId]);
const sameScope = (a: RequestScope, b: RequestScope) => scopeKey(a) === scopeKey(b);
const turnKey = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);
const unavailable = () => new DomainError("runtime_unavailable", "The selected client is not connected. Reopen that client and try again.");
const MAX_CLIENTS = 128;

/** Principal-owned live registrations. Tokens fence connection replacement; commands are never persisted or replayed. */
export class ClientControlService {
  readonly #clients = new Map<string, Registration>();
  readonly #sessions = new Map<string, ClientSession>();
  readonly #replaced = new Map<string, number>();
  readonly #notifications = new Map<string, Promise<string | undefined>>();
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
      if (this.#sessions.size >= 256) throw new DomainError("conflict", "Too many client sessions.");
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
    if (this.#clients.size >= MAX_CLIENTS) throw new DomainError("conflict", "Too many connected clients.");
    const token = randomBytes(32).toString("base64url");
    this.#clients.set(token, {
      scope: { ...scope }, session, clientId, token, paired: !!authenticated,
      name: authenticated?.name ?? `Anonymous ${input.platform}`,
      platform: input.platform, capabilities: { ...input.capabilities }, state: input.state,
      seen: this.now(), commands: [], pending: new Map(), deferred: new Map(),
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
    for (const ack of input.acknowledgements) {
      const pending = client.pending.get(ack.id);
      if (!pending) continue;
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
    return { commands: client.commands.splice(0, 64).filter(command => command.expiresAt > this.now()) };
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
    const deferred = input.action === "end_interaction" || input.action === "switch_thread";
    const command: ClientCommand = { ...input, id: randomUUID(), expiresAt: this.now() + (deferred ? 86_400_000 : 120_000) };
    const result = await new Promise<ClientActionResult>((resolve, reject) => {
      const timer = setTimeout(() => done(undefined), 25_000);
      const abort = () => done(undefined);
      const done = (result: ClientActionResult | undefined) => {
        clearTimeout(timer); signal.removeEventListener("abort", abort); client.pending.delete(command.id);
        if (!result) {
          client.commands = client.commands.filter(queued => queued.id !== command.id);
          reject(new DomainError(input.action === "settings.get" ? "runtime_unavailable" : "operation_outcome_uncertain",
            "The client did not acknowledge the request; its outcome is unknown."));
        } else resolve(result);
      };
      client.pending.set(command.id, { command, resolve: done });
      signal.addEventListener("abort", abort, { once: true });
      client.commands.push(command); client.wake?.();
    });
    return { client: this.describe(client), ...result };
  }

  observeNotification(scope: RequestScope, threadId: string, turnId: string, publication: Promise<string | undefined>) {
    const key = scopeKey(scope) + turnKey(threadId, turnId);
    this.#notifications.set(key, publication);
    // This map only bridges synchronous lifecycle notification and completion observation.
    void publication.finally(() => { if (this.#notifications.get(key) === publication) this.#notifications.delete(key); });
  }

  async complete(scope: RequestScope, threadId: string, turnId: string, outcome = "completed") {
    const replyEventId = await this.#notifications.get(scopeKey(scope) + turnKey(threadId, turnId));
    for (const client of this.#clients.values()) {
      if (!sameScope(scope, client.scope)) continue;
      const key = turnKey(threadId, turnId);
      const deferred = client.deferred.get(key);
      client.deferred.delete(key);
      if (!deferred || deferred.expiresAt <= this.now() || outcome !== "completed") continue;
      client.commands.push({ ...deferred, action: "turn_settled", replyEventId: replyEventId ?? null, expiresAt: this.now() + 3_600_000 });
      client.wake?.();
    }
  }

  close() { clearInterval(this.#timer); for (const client of this.#clients.values()) this.#remove(client); this.#sessions.clear(); }
  #remove(client: Registration) {
    this.#clients.delete(client.token); client.wake?.();
    for (const pending of client.pending.values()) pending.resolve();
    client.pending.clear(); client.deferred.clear(); client.commands = [];
  }
  #prune() {
    for (const [token, session] of this.#sessions) if (session.seen + 300_000 < this.now()) this.#sessions.delete(token);
    for (const [token, replacedAt] of this.#replaced) if (replacedAt + 300_000 < this.now()) this.#replaced.delete(token);
    while (this.#replaced.size > 1024) this.#replaced.delete(this.#replaced.keys().next().value!);
    for (const client of this.#clients.values()) {
      if (client.seen + 45_000 < this.now()) this.#remove(client);
      else for (const [key, command] of client.deferred) if (command.expiresAt <= this.now()) client.deferred.delete(key);
    }
  }
}
