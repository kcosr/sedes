import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import express, { type Request, type RequestHandler, type Response } from "express";
import { pairingRequestSchema, type AuthenticationClient } from "../../shared/authentication.js";
import { ApiError } from "../http/errors.js";
import type { AuthenticationRepository } from "./authentication-repository.js";

const TOOL_ROUTES = new Set(["/api/agent-tools", "/api/agent-tool-descriptions", "/api/agent-tool-invocations", "/api/agent-tool-csrf"]);
const safe = new Set(["GET", "HEAD", "OPTIONS"]);
const unauthorized = () => new ApiError(401, "authentication_required", "Pair this client with the Sedes server.");

/** Stable browser storage boundary; never use a client ID or a browser-selected identity. */
export function deriveClientNavigationNamespace(installationKey: Uint8Array, scope: { readonly tenantId: string; readonly principalId: string }): string {
  return createHmac("sha256", installationKey)
    .update(JSON.stringify(["client-navigation-v1", scope.tenantId, scope.principalId]))
    .digest("hex");
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === name) count++;
  }
  if (count > 1) throw unauthorized();
  const value = request.headers[name];
  if (Array.isArray(value)) throw unauthorized();
  return value;
}

/** Installation authentication maps only management clients to the local principal.
 * Sidecar credentials are admitted exclusively on explicit outbound surfaces. */
export class AuthenticationAdmission {
  readonly cookieName: string;
  readonly #connections = new Map<string, Set<() => void>>();
  readonly #tickets = new Map<string, { clientId: string; expiresAt: number }>();
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #csrfSecret = randomBytes(32);
  constructor(readonly repository: AuthenticationRepository, namespace: string,
    readonly options: { required?: boolean; navigationNamespace?: string; canEnrollSidecar?: (connectorId: string) => boolean } = {}) {
    this.cookieName = `sedes_session_${createHash("sha256").update(namespace).digest("hex").slice(0, 16)}`;
    this.#timer = setInterval(() => this.refresh(), 1_000);
    this.#timer.unref();
  }

  get required(): boolean { return this.options.required !== false; }

  clientForRequest(request: IncomingMessage): AuthenticationClient | undefined {
    const authorization = singleHeader(request, "authorization");
    if (authorization !== undefined) {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
      if (!match) throw unauthorized();
      return this.repository.authenticate(match[1]!);
    }
    const cookies = (singleHeader(request, "cookie") ?? "").split(";").map(value => value.trim());
    const values = cookies.filter(value => value.startsWith(`${this.cookieName}=`));
    if (values.length > 1) throw unauthorized();
    return values[0] ? this.repository.authenticate(values[0].slice(this.cookieName.length + 1)) : undefined;
  }

  authenticateSidecar(request: IncomingMessage): AuthenticationClient {
    // Cookie management sessions cannot become native connector authority.
    if (!request.headers.authorization) throw unauthorized();
    const client = this.clientForRequest(request);
    if (client?.kind !== "sidecar" || !client.connectorId) throw unauthorized();
    return client;
  }

  csrfForRequest(request: IncomingMessage): string {
    // Anonymous access still needs an unpredictable CSRF token. Do not parse
    // retained credentials here: expired or malformed ones must work while off.
    if (!this.required) return createHmac("sha256", this.#csrfSecret).update("anonymous").digest("base64url");
    const client = this.clientForRequest(request);
    return client ? createHmac("sha256", this.#csrfSecret).update(client.id).digest("base64url") : "";
  }

  bindTicket(token: string, clientId: string, expiresAt: number): void {
    this.#pruneTickets();
    if (this.#tickets.size >= 4096) throw new ApiError(503, "authentication_busy", "Too many pending connection admissions.", true);
    if (!this.#active(clientId)) throw unauthorized();
    this.#tickets.set(token, { clientId, expiresAt: Math.min(expiresAt, Date.now() + 60_000) });
  }

  consumeTicket(token: string): AuthenticationClient {
    const entry = this.#tickets.get(token);
    this.#tickets.delete(token);
    if (!entry || entry.expiresAt <= Date.now()) throw unauthorized();
    const client = this.#active(entry.clientId);
    if (!client || client.kind !== "management") throw unauthorized();
    return client;
  }

  trackClient(clientId: string, close: () => void): () => void {
    if (!this.#active(clientId)) { close(); return () => undefined; }
    const entries = this.#connections.get(clientId) ?? new Set<() => void>();
    entries.add(close);
    this.#connections.set(clientId, entries);
    return () => { entries.delete(close); if (entries.size === 0) this.#connections.delete(clientId); };
  }

  revokeClient(id: string): void { this.repository.revokeClient(id); this.refresh(); }
  revokeConnector(connectorId: string): void {
    for (const client of this.repository.listClients()) if (client.connectorId === connectorId) this.repository.revokeClient(client.id);
    this.refresh();
  }
  refresh(): void {
    let active: Set<string>;
    try { active = new Set(this.repository.listClients().map(client => client.id)); }
    catch {
      // A failed revocation check cannot leave authenticated streams admitted.
      this.#closeConnections(); this.#tickets.clear(); return;
    }
    for (const [id, callbacks] of this.#connections) if (!active.has(id)) {
      this.#connections.delete(id);
      for (const close of callbacks) { try { close(); } catch { /* Continue closing other transports. */ } }
    }
    this.#pruneTickets();
  }
  close(): void {
    clearInterval(this.#timer);
    this.#closeConnections(); this.#tickets.clear();
  }
  #closeConnections(): void {
    const connections = [...this.#connections.values()];
    this.#connections.clear();
    for (const callbacks of connections) for (const close of callbacks) {
      try { close(); } catch { /* A broken transport must not retain other clients. */ }
    }
  }
  #active(id: string): AuthenticationClient | undefined { return this.repository.listClients().find(client => client.id === id); }
  #pruneTickets(): void { for (const [token, entry] of this.#tickets) if (entry.expiresAt <= Date.now()) this.#tickets.delete(token); }

  #requireManagement(request: Request): AuthenticationClient {
    const client = this.clientForRequest(request);
    if (!client) throw unauthorized();
    if (client.kind !== "management") throw new ApiError(403, "authentication_scope_denied", "This credential cannot access the management API.");
    return client;
  }
  #requireCsrf(request: Request): void {
    if (request.headers.authorization) return;
    const actual = Buffer.from(request.get("X-CSRF-Token") ?? "");
    const expected = Buffer.from(this.csrfForRequest(request));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new ApiError(403, "csrf_token_invalid", "Refresh the application and try again.", true);
    }
  }
  #cookie(request: Request, response: Response, credential: string, expiresAt: string): void {
    response.cookie(this.cookieName, credential, {
      httpOnly: true, secure: request.secure || request.get("X-Forwarded-Proto") === "https",
      sameSite: "strict", path: "/api", expires: new Date(expiresAt),
    });
  }

  router(): express.Router {
    const router = express.Router();
    router.use((_request, response, next) => { response.setHeader("Cache-Control", "no-store"); next(); });
    router.get("/status", (request, response) => {
      let client: AuthenticationClient | undefined;
      try { client = this.clientForRequest(request); } catch { /* Show the pairing screen for invalid credentials. */ }
      response.json({ required: this.required, authenticated: client?.kind === "management", ...(client?.kind === "management" ? { client } : {}), ...((client?.kind === "management" || !this.required) && this.options.navigationNamespace ? { navigationNamespace: this.options.navigationNamespace } : {}) });
    });
    router.post("/pair", express.json({ limit: "4kb", strict: true }), (request, response) => {
      if (!request.is("application/json")) throw new ApiError(415, "invalid_content_type", "Pairing requires JSON.");
      if (!this.repository.admitPairingRequest()) throw new ApiError(429, "pairing_rate_limited", "Too many pairing attempts. Try again shortly.", true);
      const input = pairingRequestSchema.parse(request.body);
      if (input.kind === "sidecar" && this.options.canEnrollSidecar?.(input.connectorId!) === false) {
        throw new ApiError(403, "authentication_scope_denied", "This connector identity predates authentication. Create a new authenticated host registration.");
      }
      const result = this.repository.exchangePairing(input);
      if (!result) throw new ApiError(401, "pairing_invalid", "The pairing code is invalid, expired, or already used.");
      this.refresh();
      if (input.kind === "browser") {
        this.#cookie(request, response, result.credential, result.client.expiresAt);
        response.json({ client: result.client, ...(this.options.navigationNamespace ? { navigationNamespace: this.options.navigationNamespace } : {}) });
      } else response.json({ ...result, ...(input.kind !== "sidecar" && this.options.navigationNamespace ? { navigationNamespace: this.options.navigationNamespace } : {}) });
    });
    router.get("/clients", (request, response) => { this.#requireManagement(request); response.json({ clients: this.repository.listClients() }); });
    router.delete("/clients/:id", (request, response) => {
      this.#requireManagement(request); this.#requireCsrf(request);
      this.revokeClient(String(request.params.id)); response.status(204).end();
    });
    router.post("/logout", (request, response) => {
      const client = this.#requireManagement(request); this.#requireCsrf(request);
      this.revokeClient(client.id);
      this.#cookie(request, response, "", new Date(0).toISOString());
      response.status(204).end();
    });
    return router;
  }

  middleware(): RequestHandler {
    return (request, response, next) => {
      const pathname = request.path.toLowerCase().replace(/\/$/u, "");
      if (pathname !== "/api" && !pathname.startsWith("/api/")) { next(); return; }
      // These exact routes have independent, narrower agent-tool credential checks.
      if (TOOL_ROUTES.has(pathname)) { next(); return; }
      if (!this.required) { next(); return; }
      // The connector executable is public application code, like the frontend bundle.
      if (safe.has(request.method) && pathname === "/api/outbound/connector/sedes-sidecar.mjs") { next(); return; }
      const client = this.clientForRequest(request);
      if (!client) throw unauthorized();
      const outboundArtifact = /^\/api\/outbound\/artifacts\/[a-f0-9]+\/(manifest|payload)$/u.test(pathname);
      if (client.kind !== "management" && !(client.kind === "sidecar" && safe.has(request.method) && outboundArtifact)) {
        throw new ApiError(403, "authentication_scope_denied", "This credential cannot access the management API.");
      }
      const untrack = this.trackClient(client.id, () => response.destroy());
      response.once("close", untrack); response.once("finish", untrack);
      next();
    };
  }
}
