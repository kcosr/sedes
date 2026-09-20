export interface SedesServerEndpoint {
  /** Null is the browser-only implicit same-origin server. */
  readonly baseUrl: string | null;
}

export const sameOriginSedesServer: SedesServerEndpoint = Object.freeze({
  baseUrl: null,
});

export function configuredSedesServer(input: string): SedesServerEndpoint {
  return Object.freeze({ baseUrl: normalizeSedesServerUrl(input) });
}

export function normalizeSedesServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a Sedes server URL.");
  if (!/^https?:\/\//iu.test(trimmed)) {
    throw new Error("Sedes server URL must begin with http:// or https://.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Sedes server URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Sedes server URL must begin with http:// or https://.");
  }
  if (url.username || url.password) {
    throw new Error("Sedes server URL must not include credentials.");
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error(
      "Sedes server URL must not include a path, query, or fragment.",
    );
  }
  if (!url.hostname) throw new Error("Sedes server URL must include a host.");
  return url.origin;
}

export function resolveSedesServerUrl(
  endpoint: SedesServerEndpoint,
  path: string,
): string {
  if (!path.startsWith("/api/")) {
    throw new Error("Sedes API paths must begin with /api/.");
  }
  return endpoint.baseUrl ? new URL(path, endpoint.baseUrl).toString() : path;
}

export function resolveSedesServerWebSocketUrl(
  endpoint: SedesServerEndpoint,
  path: string,
): string {
  const httpUrl = new URL(
    resolveSedesServerUrl(endpoint, path),
    endpoint.baseUrl ?? window.location.origin,
  );
  httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return httpUrl.toString();
}

export function endpointUsesCrossOriginTransport(
  endpoint: SedesServerEndpoint,
): boolean {
  return endpoint.baseUrl !== null;
}
