// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../shared/index.js";
import { SEDES_VERSION } from "../../shared/version.js";
import {
  ApiClient,
  ApiError,
  LocationConflictApiError,
  ProjectRemovalBlockedApiError,
} from "./ApiClient.js";

const projectId = "10000000-0000-4000-8000-000000000001";
const targetId = "10000000-0000-4000-8000-000000000002";
const locationId = "20000000-0000-4000-8000-000000000001";
const environmentId = "30000000-0000-4000-8000-000000000001";
const threadId = "40000000-0000-4000-8000-000000000001";

const location = {
  id: locationId,
  environmentId,
  environmentLabel: "Local",
  label: "sedes",
  path: "/src/sedes",
  removed: false,
  removedWithProject: false,
  available: true,
  threadCount: 2,
  revision: 3,
};
const project = {
  id: projectId,
  name: "sedes",
  revision: 1,
  membershipRevision: 2,
  removed: false,
  locations: [location],
};

function session() {
  return {
    clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
    version: SEDES_VERSION,
    csrfToken: "a".repeat(32),
    providerPulseEnabled: false,
    experimentalUsageEnabled: false,
  };
}

type Call = { readonly path: string; readonly method?: string; readonly body?: unknown };

/** Answers the session, then every mutation with `respond`, recording calls. */
function serve(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://sedes.test").pathname;
    if (path === "/api/application/session") return Response.json(session());
    expect(init?.headers).toMatchObject({ "X-CSRF-Token": "a".repeat(32) });
    const call = {
      path,
      ...(init?.method ? { method: init.method } : {}),
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
    };
    calls.push(call);
    return respond(call);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("ApiClient project management", () => {
  it("sends each project and location operation with its expected revisions", async () => {
    const restored = {
      project,
      locations: [
        { id: locationId, status: "failed", error: { code: "runtime_unavailable", message: "The host is offline.", retryable: true } },
      ],
    };
    const calls = serve(({ path }) => Response.json(path.endsWith("/restore") ? restored : project));
    const api = new ApiClient();

    await expect(api.renameProject(projectId, { name: "  Sedes app ", expectedRevision: 1 })).resolves.toEqual(project);
    await expect(api.removeProject(projectId, { expectedRevision: 1, expectedMembershipRevision: 2 })).resolves.toEqual(project);
    await expect(api.restoreProject(projectId, { expectedRevision: 2, locationIds: [locationId] })).resolves.toEqual(restored);
    await expect(api.mergeProject(projectId, {
      targetProjectId: targetId, expectedSourceMembershipRevision: 2, expectedTargetMembershipRevision: 5,
    })).resolves.toEqual(project);
    await expect(api.moveLocation(locationId, { target: { kind: "new", name: " Split " }, expectedRevision: 3 })).resolves.toEqual(project);
    await expect(api.moveLocation(locationId, { target: { kind: "existing", projectId: targetId }, expectedRevision: 4 })).resolves.toEqual(project);

    expect(calls).toEqual([
      { path: `/api/projects/${projectId}`, method: "PATCH", body: { name: "Sedes app", expectedRevision: 1 } },
      { path: `/api/projects/${projectId}/remove`, method: "POST", body: { expectedRevision: 1, expectedMembershipRevision: 2 } },
      { path: `/api/projects/${projectId}/restore`, method: "POST", body: { expectedRevision: 2, locationIds: [locationId] } },
      { path: `/api/projects/${projectId}/merge`, method: "POST", body: {
        targetProjectId: targetId, expectedSourceMembershipRevision: 2, expectedTargetMembershipRevision: 5,
      } },
      { path: `/api/workspaces/${locationId}/move`, method: "POST", body: { target: { kind: "new", name: "Split" }, expectedRevision: 3 } },
      { path: `/api/workspaces/${locationId}/move`, method: "POST", body: { target: { kind: "existing", projectId: targetId }, expectedRevision: 4 } },
    ]);
  });

  it("rejects invalid requests before sending them", async () => {
    const calls = serve(() => Response.json(project));
    const api = new ApiClient();
    expect(() => api.renameProject(projectId, { name: "   ", expectedRevision: 1 })).toThrow();
    expect(() => api.renameProject(projectId, { name: "x".repeat(241), expectedRevision: 1 })).toThrow();
    expect(() => api.restoreProject(projectId, { expectedRevision: 1, locationIds: [locationId, locationId] })).toThrow();
    expect(calls).toEqual([]);
  });

  it("parses a blocked removal into every blocker", async () => {
    const blockers = [
      { locationId, environmentId, kind: "durable_work", threadIds: [threadId] },
      { locationId, environmentId, kind: "busy_runtime", threadIds: [threadId] },
    ];
    serve(() => Response.json({
      error: { code: "invalid_transition", message: "Resolve running work before removing it.", retryable: false },
      blockers,
    }, { status: 400 }));

    const failure = await new ApiClient()
      .removeProject(projectId, { expectedRevision: 1, expectedMembershipRevision: 2 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProjectRemovalBlockedApiError);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 400,
      code: "invalid_transition",
      message: "Resolve running work before removing it.",
      retryable: false,
      blockers,
    });
  });

  it("parses an Add project conflict into the existing location and its project", async () => {
    const conflict = {
      reason: "other_project",
      workspaceId: locationId,
      locationRevision: 3,
      locationRemoved: false,
      projectId,
      projectName: "sedes",
      projectRevision: 1,
    };
    const calls = serve(() => Response.json({
      error: { code: "conflict", message: "This directory already belongs to another project. Move it instead.", retryable: false },
      conflict,
    }, { status: 409 }));

    const failure = await new ApiClient()
      .openWorkspace("/src/sedes", environmentId, { kind: "existing", projectId: targetId })
      .catch((error: unknown) => error);
    expect(calls).toEqual([{
      path: "/api/workspaces/open",
      method: "POST",
      body: { path: "/src/sedes", environmentId, project: { kind: "existing", projectId: targetId } },
    }]);
    expect(failure).toBeInstanceOf(LocationConflictApiError);
    expect(failure).toMatchObject({ status: 409, code: "conflict", conflict });

    serve(() => Response.json({
      error: { code: "invalid_transition", message: "The project was removed.", retryable: false },
      conflict: { ...conflict, reason: "project_removed", locationRemoved: true },
    }, { status: 400 }));
    await expect(new ApiClient().openWorkspace("/src/sedes", environmentId, { kind: "new", name: "sedes" }))
      .rejects.toMatchObject({ code: "invalid_transition", conflict: { reason: "project_removed", locationRemoved: true } });
  });

  it("keeps plain errors plain and rejects malformed structured bodies", async () => {
    serve(() => Response.json({
      error: { code: "invalid_transition", message: "The project was removed.", retryable: false },
    }, { status: 400 }));
    const plain = await new ApiClient().reopenWorkspace(locationId).catch((error: unknown) => error);
    expect(plain).toBeInstanceOf(ApiError);
    expect(plain).not.toBeInstanceOf(LocationConflictApiError);
    expect(plain).not.toBeInstanceOf(ProjectRemovalBlockedApiError);
    expect(plain).toMatchObject({ code: "invalid_transition", message: "The project was removed." });

    serve(() => Response.json({
      error: { code: "invalid_transition", message: "Blocked.", retryable: false },
      blockers: [],
    }, { status: 400 }));
    await expect(new ApiClient().removeProject(projectId, { expectedRevision: 1, expectedMembershipRevision: 2 }))
      .rejects.toMatchObject({ code: "invalid_response" });
  });
});
