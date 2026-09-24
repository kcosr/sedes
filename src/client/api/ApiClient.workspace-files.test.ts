// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SEDES_CLIENT_PROTOCOL_VERSION,
  workspaceFileLinkedWorktreeRootIdSchema,
} from "../../shared/index.js";
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

describe("ApiClient thread worktree context", () => {
  it("uses thread-scoped routes for relative links and worktree preference", async () => {
    const linkedRootId =
      workspaceFileLinkedWorktreeRootIdSchema.parse("linked-worktree-1");
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/application/session")) {
          return Response.json(session());
        }
        if (url.endsWith("/file-links/resolve")) {
          return Response.json({
            status: "resolved",
            rootId: linkedRootId,
            path: "src/index.ts",
            rootVisibility: "listed",
          });
        }
        return Response.json({
          preference: { rootId: linkedRootId, revision: 5 },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();

    await client.resolveThreadWorkspaceFileLink("thread/one", {
      kind: "workspace_relative",
      path: "src/index.ts",
    });
    await client.updateThreadPreferredWorktree("thread/one", {
      rootId: linkedRootId,
      expectedRevision: 4,
      mutationId: "30000000-0000-4000-8000-000000000001",
    });

    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      "/api/threads/thread%2Fone/file-links/resolve",
    );
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      reference: { kind: "workspace_relative", path: "src/index.ts" },
    });
    expect(String(fetchMock.mock.calls[2]![0])).toContain(
      "/api/threads/thread%2Fone/preferred-worktree",
    );
    expect(fetchMock.mock.calls[2]![1]).toMatchObject({ method: "PUT" });
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body))).toEqual({
      rootId: linkedRootId,
      expectedRevision: 4,
      mutationId: "30000000-0000-4000-8000-000000000001",
    });
  });

  it("uses the confirmed linked-worktree deletion route", async () => {
    const linkedRootId =
      workspaceFileLinkedWorktreeRootIdSchema.parse("linked-worktree-1");
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/api/application/session")) {
          return Response.json(session());
        }
        return Response.json({
          rootId: linkedRootId,
          outcome: "removed",
          clearedThreadIds: ["30000000-0000-4000-8000-000000000002"],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient();

    await client.deleteLinkedWorktree("workspace/one", linkedRootId, {
      expectedRevision: 4,
      mutationId: "30000000-0000-4000-8000-000000000001",
      confirmation: true,
    });

    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      "/api/workspaces/workspace%2Fone/linked-worktrees/linked-worktree-1",
    );
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "DELETE" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      expectedRevision: 4,
      mutationId: "30000000-0000-4000-8000-000000000001",
      confirmation: true,
    });
  });
});
