import { AuthenticationContext, type AuthenticationControls } from "./AuthenticationSettings.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { consumePairingToken } from "./pairing-link.js";
import { authenticationStatusSchema, authenticationClientsResponseSchema, pairingCodeSchema, pairingResponseSchema, type AuthenticationClient } from "../../shared/authentication.js";
import { ApiClient } from "../api/ApiClient.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isPackagedClient } from "../app/client-platform.js";
import { getCredential, setCredential, removeCredential } from "../app/client-credentials.js";
import type { SedesServerEndpoint } from "../app/server-endpoint.js";
import { Button } from "../components/ui/button.js";
import { FullPageLoading } from "../components/LoadingStates.js";
import { authenticatedFetch, onUnauthorized, setEndpointProfile, setEndpointCredential } from "./auth-transport.js";

type Client = AuthenticationClient;
interface GateScope { alive: boolean; epoch: number; controller: AbortController }
interface GateRequest { scope: GateScope; epoch: number }
const credentialWrites = new Map<string, Promise<void>>();
async function writeCredential(profileId: string, origin: string, current: () => boolean, write: () => Promise<void>): Promise<void> {
  const key = JSON.stringify([profileId, origin]);
  const previous = credentialWrites.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => { if (current()) await write(); });
  credentialWrites.set(key, pending);
  try { await pending; } finally { if (credentialWrites.get(key) === pending) credentialWrites.delete(key); }
}
type Status = { required: boolean; authenticated: boolean; client?: Client };

export function readPairingToken(input: string, serverOrigin: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter a pairing code or URL.");
  if (!/^https?:\/\//iu.test(value)) return parsePairingCode(value);
  const url = new URL(value);
  if (url.origin !== serverOrigin || url.username || url.password) throw new Error("This pairing URL belongs to a different server.");
  const token = new URLSearchParams(url.hash.slice(1)).get("pair");
  if (!token) throw new Error("The URL does not contain a pairing code.");
  return parsePairingCode(token);
}
function parsePairingCode(value: string): string {
  const parsed = pairingCodeSchema.safeParse(value);
  if (!parsed.success) throw new Error("Enter an eight-letter pairing code, such as BCDF-GHJK, or a pairing URL.");
  return parsed.data;
}
function capturePairingToken(): string {
  if (typeof window === "undefined") return "";
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get("pair") ?? "";
  if (fragment.has("pair")) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  return token;
}

export function AuthenticationGate({ endpoint, profileId, children, settings }: {
  endpoint: SedesServerEndpoint; profileId?: string; children: ReactNode; settings?: ReactNode;
}): React.JSX.Element {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [token, setToken] = useState("");
  const scopeRef = useRef<GateScope | null>(null);
  const capturedOrigin = useRef<string | null>(null);
  const [optionalPairing, setOptionalPairing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const native = isPackagedClient();
  const [clientName, setClientName] = useState(() => native ? "Sedes device" : "Sedes browser");
  const serverOrigin = endpoint.baseUrl ?? window.location.origin;
  useEffect(() => {
    const scope: GateScope = { alive: true, epoch: 0, controller: new AbortController() };
    scopeRef.current = scope;
    const controller = scope.controller;
    const initialRequest: GateRequest = { scope, epoch: 0 };
    if (capturedOrigin.current !== serverOrigin) {
      capturedOrigin.current = serverOrigin;
      const captured = capturePairingToken() || consumePairingToken(serverOrigin);
      setToken(captured);
      setOptionalPairing(Boolean(captured));
    }
    setBusy(false);
    const unsubscribe = onUnauthorized(endpoint, () => {
      if (!scope.alive) return;
      setStatus((current) => ({ required: current?.required ?? true, authenticated: false }));
      setError("This connection needs to be paired again.");
      scope.epoch += 1;
      const refresh: GateRequest = { scope, epoch: scope.epoch };
      void readStatus().then((result) => { if (isCurrent(refresh)) setStatus(result); }).catch(() => undefined);
      setBusy(false);
      // Invalid credentials cannot authorize access. Leave the saved value until
      // successful pairing overwrites it; an asynchronous delete here could
      // erase a replacement credential issued by a newer connection.
    });
    setStatus(null);
    setEndpointProfile(endpoint, profileId ?? null);
    async function readStatus(credentialOverride?: string | null): Promise<Status> {
      const response = await authenticatedFetch(endpoint, "/api/auth/status", { signal: controller.signal }, credentialOverride);
      if (!response.ok) throw new Error("Could not check server authentication.");
      return authenticationStatusSchema.parse(await response.json());
    }
    void (async () => {
      const publicStatus = await readStatus();
      if (!isCurrent(initialRequest)) return;
      // An open server remains usable even if the OS credential vault is locked
      // or unavailable. Retain its saved secret for later re-enablement.
      if (!publicStatus.required) { setStatus(publicStatus); setError(""); }
      if (native) {
        try {
          if (!profileId) throw new Error("A saved connection is required for device authentication.");
          const credential = await getCredential(profileId, serverOrigin);
          if (!isCurrent(initialRequest)) return;
          const result = credential ? await readStatus(credential) : publicStatus;
          if (isCurrent(initialRequest)) {
            setEndpointCredential(endpoint, credential ?? null);
            setStatus(result); setError("");
          }
        } catch (cause) {
          if (publicStatus.required) throw cause;
        }
      } else { setStatus(publicStatus); setError(""); }
    })().catch((cause: unknown) => { if (isCurrent(initialRequest)) { setError(message(cause)); setStatus({ required: true, authenticated: false }); } });
    return () => {
      scope.alive = false; controller.abort(); unsubscribe();
      if (scopeRef.current === scope) { scopeRef.current = null; setEndpointCredential(endpoint, null); setEndpointProfile(endpoint, null); }
    };
  }, [endpoint.baseUrl, native, profileId, serverOrigin, retry]);

  function ticket(): GateRequest {
    const scope = scopeRef.current;
    if (!scope?.alive) throw new Error("This connection is no longer active.");
    return { scope, epoch: scope.epoch };
  }
  function isCurrent(operation: GateRequest): boolean {
    return scopeRef.current === operation.scope && operation.scope.alive && operation.epoch === operation.scope.epoch;
  }
  function check(operation: GateRequest): void {
    if (!isCurrent(operation)) throw new Error("This connection is no longer active.");
  }
  async function request(path: string, init?: RequestInit, operation = ticket()): Promise<Response> {
    check(operation);
    let requestInit = init;
    if (!native && init?.method && init.method !== "GET" && path !== "/api/auth/pair") {
      const session = await new ApiClient(endpoint).session({ signal: operation.scope.controller.signal });
      check(operation);
      requestInit = { ...init, headers: { ...init.headers, "X-CSRF-Token": session.csrfToken } };
    }
    const response = await authenticatedFetch(endpoint, path, { ...requestInit, signal: operation.scope.controller.signal });
    check(operation);
    if (!response.ok) throw new Error("The authentication request failed. Check the pairing code and try again.");
    return response;
  }
  async function pair(): Promise<void> {
    let operation = ticket();
    setBusy(true); setError("");
    try {
      const pairingToken = readPairingToken(token, serverOrigin);
      setToken("");
      const response = await request("/api/auth/pair", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: pairingToken, clientName: clientName.trim(), kind: native ? "device" : "browser" }),
      }, operation);
      const result = pairingResponseSchema.parse(await response.json());
      check(operation);
      if (native) {
        if (!profileId || !result.credential) throw new Error("The server did not return a device credential.");
        const credential = result.credential;
        await writeCredential(profileId, serverOrigin, () => isCurrent(operation), () => setCredential(profileId, serverOrigin, credential));
        check(operation);
      }
      // Supersede the retained credential read only once enrollment and secure
      // persistence succeed. Failed enrollment leaves that read usable.
      operation.scope.epoch += 1;
      operation = ticket();
      if (native) setEndpointCredential(endpoint, result.credential!);
      setStatus({ required: status?.required ?? true, authenticated: true, client: result.client });
      setOptionalPairing(false);
    } catch (cause) { if (isCurrent(operation)) setError(message(cause)); }
    finally { if (isCurrent(operation)) setBusy(false); }
  }
  async function logout(): Promise<void> {
    const operation = ticket();
    await request("/api/auth/logout", { method: "POST" }, operation);
    if (native && profileId) {
      await writeCredential(profileId, serverOrigin, () => isCurrent(operation), () => removeCredential(profileId, serverOrigin));
      check(operation);
    }
    setEndpointCredential(endpoint, null); setStatus({ required: status?.required ?? true, authenticated: false });
  }
  const controls = useMemo<AuthenticationControls | null>(() => status?.client ? {
    client: status.client,
    list: async () => authenticationClientsResponseSchema.parse(await (await request("/api/auth/clients")).json()).clients,
    revoke: async (id) => { await request(`/api/auth/clients/${encodeURIComponent(id)}`, { method: "DELETE" }); },
    logout,
  } : null, [status, endpoint.baseUrl, profileId]);
  if (status === null) return <FullPageLoading />;
  if (!status.authenticated && (status.required || optionalPairing)) return (
    <main className="authentication-gate">
      <div className="authentication-gate-content">
        <section className="authentication-pairing-card" aria-labelledby="pairing-title">
          <header className="authentication-pairing-heading">
            <p className="eyebrow">Sedes connection</p>
            <h1 id="pairing-title">Pair with this server</h1>
            <p className="authentication-pairing-origin">{serverOrigin}</p>
          </header>
          <p className="authentication-pairing-instructions">
            Run <code>sedes auth pair --server {serverOrigin}</code>
            on the server, then paste its pairing URL or code.
          </p>
          <form className="authentication-pairing-form" onSubmit={(event) => { event.preventDefault(); void pair(); }}>
            <div className="authentication-pairing-field">
              <Label htmlFor="pairing-client-name">Client name</Label>
              <Input id="pairing-client-name" value={clientName} maxLength={128} disabled={busy} onChange={(event) => setClientName(event.target.value)} />
            </div>
            <div className="authentication-pairing-field">
              <Label htmlFor="pairing-token">Pairing URL or code</Label>
              <Input id="pairing-token" type="password" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="BCDF-GHJK or pairing URL" value={token} onChange={(event) => setToken(event.target.value)} disabled={busy} />
            </div>
            {error && <p className="authentication-pairing-error" role="alert">{error}</p>}
            <div className="authentication-pairing-actions">
              <Button type="submit" disabled={busy || !token.trim() || !clientName.trim()}>{busy ? "Pairing…" : "Pair connection"}</Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setRetry((value) => value + 1)}>Retry connection</Button>
              {!status.required && <Button type="button" variant="outline" disabled={busy} onClick={() => { setOptionalPairing(false); setToken(""); }}>Continue without pairing</Button>}
            </div>
          </form>
        </section>
        {settings}
      </div>
    </main>
  );
  return <AuthenticationContext.Provider key={status.client?.id ?? "anonymous"} value={controls}>{children}</AuthenticationContext.Provider>;
}
function message(error: unknown): string { return error instanceof Error ? error.message : "The connection could not be authenticated."; }
