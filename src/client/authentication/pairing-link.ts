import { normalizeSedesServerUrl } from "../app/server-endpoint.js";

// Enrollment secrets live only until the selected connection opens its gate.
const pendingTokens = new Map<string, string>();
export function serverFromPairingInput(input: string): string {
  const value = input.trim();
  let url: URL;
  try { url = new URL(value); } catch { return normalizeSedesServerUrl(value); }
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("pair");
  if (!token) return normalizeSedesServerUrl(value);
  if (url.username || url.password || url.search || url.pathname !== "/" || [...fragment.keys()].some((entry) => entry !== "pair")) {
    throw new Error("Enter the server's pairing URL without additional credentials or parameters.");
  }
  const origin = normalizeSedesServerUrl(url.origin);
  pendingTokens.set(origin, token);
  return origin;
}
export function consumePairingToken(origin: string): string {
  const token = pendingTokens.get(origin) ?? "";
  pendingTokens.delete(origin);
  return token;
}
