import { resolveSedesServerUrl, type SedesServerEndpoint } from "../app/server-endpoint.js";

const credentials = new Map<string, string>();
const credentialVersions = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
const key = (endpoint: SedesServerEndpoint): string => endpoint.baseUrl ?? "same-origin";

export function getEndpointCredential(endpoint: SedesServerEndpoint): string | undefined {
  return credentials.get(key(endpoint));
}
export function setEndpointCredential(endpoint: SedesServerEndpoint, credential: string | null): void {
  credentialVersions.set(key(endpoint), (credentialVersions.get(key(endpoint)) ?? 0) + 1);
  if (credential) credentials.set(key(endpoint), credential);
  else credentials.delete(key(endpoint));
}
export function onUnauthorized(endpoint: SedesServerEndpoint, listener: () => void): () => void {
  const endpointKey = key(endpoint);
  const set = listeners.get(endpointKey) ?? new Set();
  set.add(listener);
  listeners.set(endpointKey, set);
  return () => { set.delete(listener); if (!set.size) listeners.delete(endpointKey); };
}
export function notifyUnauthorized(endpoint: SedesServerEndpoint): void {
  setEndpointCredential(endpoint, null);
  for (const listener of listeners.get(key(endpoint)) ?? []) listener();
}
export async function authenticatedFetch(endpoint: SedesServerEndpoint, path: string, init: RequestInit = {}, credentialOverride?: string | null): Promise<Response> {
  const version = credentialVersions.get(key(endpoint));
  const headers = new Headers(init.headers);
  const credential = credentialOverride === undefined ? getEndpointCredential(endpoint) : credentialOverride ?? undefined;
  if (credential) headers.set("Authorization", `Bearer ${credential}`);
  const response = await fetch(resolveSedesServerUrl(endpoint, path), {
    ...init, headers: credential ? headers : init.headers, redirect: "error", credentials: endpoint.baseUrl ? "omit" : "same-origin",
  });
  // Enrollment rejection describes the one-use code, not the saved credential.
  if (path !== "/api/auth/pair" && !init.signal?.aborted && response.status === 401 && version === credentialVersions.get(key(endpoint)) && credential === getEndpointCredential(endpoint)) notifyUnauthorized(endpoint);
  return response;
}

const profiles = new Map<string, string>();
export function setEndpointProfile(endpoint: SedesServerEndpoint, profileId: string | null): void {
  if (profileId) profiles.set(key(endpoint), profileId); else profiles.delete(key(endpoint));
}
export function getEndpointProfile(endpoint: SedesServerEndpoint): string | undefined { return profiles.get(key(endpoint)); }
