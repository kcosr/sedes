import type { RunningApplication } from "../../src/server/production-application.js";

/** Pair through the public enrollment endpoint, then authenticate this server's requests. */
export async function authenticatedProductionFetch(application: RunningApplication): Promise<typeof fetch> {
  const address = application.server.address();
  if (!address || typeof address === "string") throw new Error("test_server_not_listening");
  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${origin}/api/auth/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: application.createManagementPairing().token, clientName: "Integration test", kind: "device" }),
  });
  if (!response.ok) throw new Error(`test_pairing_failed:${response.status}:${await response.text()}`);
  const result = await response.json() as { credential?: unknown };
  if (typeof result.credential !== "string") throw new Error("test_pairing_credential_missing");
  const credential = result.credential;
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== origin) throw new Error("test_credential_origin_mismatch");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("Authorization", `Bearer ${credential}`);
    return fetch(input, { ...init, headers, redirect: "error" });
  };
}
