// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./ApiClient.js";

const template = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Careful launch",
  workspaceId: "88888888-8888-4888-8888-888888888888",
  targetId: "target-pi",
  executionWorkspace: { kind: "direct" },
  agentId: "11111111-1111-4111-8111-111111111111",
  capturedAgentName: "Careful",
  capturedWorkspaceName: "Sedes",
  capturedTargetName: "Local SDK",
  revision: 0,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("ApiClient Thread Templates", () => {
  it("loads a bounded page with pagination", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [template], nextCursor: "next" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const page = await new ApiClient().listThreadTemplates({
      cursor: "cursor",
      pageSize: 25,
    });

    expect(page).toEqual({ items: [template], nextCursor: "next" });
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "/api/thread-templates?cursor=cursor&pageSize=25",
    );
  });

  it("loads one template by encoded id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(template), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await new ApiClient().getThreadTemplate(template.id)).toEqual(
      template,
    );
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      `/api/thread-templates/${template.id}`,
    );
  });
});
