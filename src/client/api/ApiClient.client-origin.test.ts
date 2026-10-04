import { afterEach, describe, expect, it, vi } from "vitest";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../shared/index.js";
import type { ClientOrigin } from "../../shared/protocol/thread-input.js";
import { SEDES_VERSION } from "../../shared/version.js";
import { ApiClient, ApiError } from "./ApiClient.js";

const threadId = "10000000-0000-4000-8000-000000000003";
const mutationId = "20000000-0000-4000-8000-000000000001";
const session = { clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION, version: SEDES_VERSION, csrfToken: "a".repeat(32), providerPulseEnabled: true, experimentalUsageEnabled: false };
afterEach(() => { vi.unstubAllGlobals(); });

describe("ApiClient advisory client origin", () => {
  it("reads the current origin at each delivery, keeps an explicit origin, and never adds one to other operations", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "/api/application/session") return Response.json(session);
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ error: { code: "thread_revision_conflict", message: "The thread changed.", retryable: false } }, { status: 409 });
    }));
    let origin: ClientOrigin | undefined;
    const readOrigin = vi.fn(() => origin);
    const client = new ApiClient(undefined, undefined, readOrigin);
    const deliver = { kind: "deliver", mode: "submit", mutationId, expectedThreadRevision: 1, expectedDraftRevision: 1 } as const;
    const cancel = { kind: "cancel_queued_input", queuedInputId: "queued-1", mutationId, expectedThreadRevision: 1 } as const;
    await expect(client.operateThread(threadId, deliver)).rejects.toBeInstanceOf(ApiError);
    origin = { clientId: "30000000-0000-4000-8000-000000000001" };
    await expect(client.operateThread(threadId, deliver)).rejects.toBeInstanceOf(ApiError);
    origin = { clientId: "30000000-0000-4000-8000-000000000002" };
    await expect(client.operateThread(threadId, { ...deliver, origin: { clientId: "30000000-0000-4000-8000-000000000003" } })).rejects.toBeInstanceOf(ApiError);
    await expect(client.operateThread(threadId, cancel)).rejects.toBeInstanceOf(ApiError);
    expect(bodies).toEqual([
      deliver,
      { ...deliver, origin: { clientId: "30000000-0000-4000-8000-000000000001" } },
      { ...deliver, origin: { clientId: "30000000-0000-4000-8000-000000000003" } },
      cancel,
    ]);
    expect(readOrigin).toHaveBeenCalledTimes(2);
  });
});
