// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../shared/index.js";
import { SEDES_VERSION } from "../../shared/version.js";
import { ApiClient } from "./ApiClient.js";

afterEach(() => vi.unstubAllGlobals());

function session() {
  return {
    clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
    version: SEDES_VERSION,
    csrfToken: "a".repeat(32),
    providerPulseEnabled: false, experimentalUsageEnabled: false,
  };
}

describe("ApiClient bulk inventory", () => {
  const impact = {
    action: "settle",
    targets: [
      {
        threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expectedRevision: 2,
      },
      {
        threadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        expectedRevision: 4,
      },
    ],
    targetCount: 2,
    pendingQuestionCount: 0,
    affectedCount: 1,
    unchangedCount: 1,
    blockers: { items: [], total: 0, omitted: 0 },
    openTasks: { items: [], total: 0, omitted: 0 },
    stashedPromptCount: 0,
    available: true,
  };

  it("posts ordered thread ids to the authoritative impact endpoint", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) =>
        Response.json(
          String(input).endsWith("/api/application/session")
            ? session()
            : impact,
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ApiClient().getBulkInventoryImpact({
        action: "settle",
        threadIds: impact.targets.map(({ threadId }) => threadId),
      }),
    ).resolves.toEqual(impact);
    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      "/api/thread-inventory/bulk-impact",
    );
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        action: "settle",
        threadIds: impact.targets.map(({ threadId }) => threadId),
      }),
    });
  });

  it("posts the caller-owned immutable mutation request unchanged", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) =>
        Response.json(
          String(input).endsWith("/api/application/session")
            ? session()
            : { changedThreadIds: [impact.targets[0]!.threadId] },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      action: "settle" as const,
      targets: impact.targets,
      expectedStashedPromptCount: 0,
      expectedOpenTaskCount: 0,
      mutationId: "11111111-1111-4111-8111-111111111111",
    };

    await expect(new ApiClient().mutateBulkInventory(request)).resolves.toEqual(
      { changedThreadIds: [impact.targets[0]!.threadId] },
    );
    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      "/api/thread-inventory/bulk",
    );
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "POST" });
    expect(
      JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)),
    ).toEqual(request);
  });
});
