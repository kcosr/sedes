import { describe, expect, it, vi } from "vitest";
import { AgentThreadControlService } from "../../src/server/agent-tools/application/agent-thread-control-service.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };

describe("AgentThreadControlService", () => {
  it("rechecks target environment authority before dispatching model work", async () => {
    const sendDirect = vi.fn(async () => ({
      status: "delivery_accepted" as const,
      operationId: "mutation-1",
    }));
    const service = new AgentThreadControlService(
      { sendDirect },
      {
        getThread: vi.fn(
          () =>
            ({
              thread: { id: "thread-2", environmentId: "environment-2" },
            }) as never,
        ),
      },
    );

    expect(() =>
      service.sendDirect(scope, {
        initiator: {
          kind: "thread_agent",
          sourceThreadId: "thread-1",
          sourceWorkspaceId: "workspace-1",
        },
        targetThreadId: "thread-2",
        message: "Run it",
        mutationId: "mutation-1",
        environmentAuthority: {
          id: "grant-1",
          callerKind: "thread_agent",
          defaults: {
            kind: "thread_agent",
            environmentId: "environment-1",
            workspaceId: "workspace-1",
            threadId: "thread-1",
          },
          policyIdentity: {
            ownerKind: "thread",
            ownerId: "thread-1",
            revision: 1,
          },
          admittedEnvironmentIds: ["environment-1"],
          targetEnvironmentIds: [],
          resolvedResourceRefs: [],
          canonicalInputDigest: "input-digest",
          authorityDigest: "authority-digest",
          display: { targetEnvironmentLabels: [], resourceLabels: [] },
        },
      }),
    ).toThrow(expect.objectContaining({ code: "permission_denied" }));
    expect(sendDirect).not.toHaveBeenCalled();
  });

  it("allows callback delivery only for trusted thread-agent initiators", async () => {
    const sendDirect = vi.fn(async () => ({
      status: "delivery_accepted" as const,
      operationId: "mutation-1",
      callbackId: "callback-1",
    }));
    const service = new AgentThreadControlService(
      { sendDirect },
      {
        getThread: vi.fn(
          () =>
            ({
              thread: {
                id: "thread-2",
                environmentId: "environment-1",
                workspaceId: "workspace-1",
              },
            }) as never,
        ),
      },
    );
    const environmentAuthority = {
      id: "grant-1",
      callerKind: "thread_agent" as const,
      defaults: {
        kind: "thread_agent" as const,
        environmentId: "environment-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
      },
      policyIdentity: {
        ownerKind: "thread" as const,
        ownerId: "thread-1",
        revision: 1,
      },
      admittedEnvironmentIds: ["environment-1"],
      targetEnvironmentIds: [],
      resolvedResourceRefs: [
        {
          kind: "thread" as const,
          id: "thread-2",
          environmentId: "environment-1",
          workspaceId: "workspace-1",
        },
      ],
      canonicalInputDigest: "input-digest",
      authorityDigest: "authority-digest",
      display: { targetEnvironmentLabels: [], resourceLabels: [] },
    };

    await expect(
      service.sendDirect(scope, {
        initiator: {
          kind: "thread_agent",
          sourceThreadId: "thread-1",
          sourceWorkspaceId: "workspace-1",
        },
        targetThreadId: "thread-2",
        message: "Run it",
        callback: true,
        mutationId: "mutation-1",
        environmentAuthority,
      }),
    ).resolves.toMatchObject({ callbackId: "callback-1" });
    expect(sendDirect).toHaveBeenCalledWith(scope, {
      initiator: {
        kind: "thread_agent",
        sourceThreadId: "thread-1",
        sourceWorkspaceId: "workspace-1",
      },
      targetThreadId: "thread-2",
      message: "Run it",
      callback: true,
      mutationId: "mutation-1",
    });

    expect(() =>
      service.sendDirect(scope, {
        initiator: { kind: "principal_client", clientId: "client-1" },
        targetThreadId: "thread-2",
        message: "Run it",
        callback: true,
        mutationId: "mutation-2",
        environmentAuthority: {
          ...environmentAuthority,
          callerKind: "principal_client",
          defaults: {
            kind: "principal_client",
            environmentId: "environment-1",
          },
          policyIdentity: {
            ownerKind: "principal_client",
            ownerId: "client-1",
            revision: 1,
            credentialGeneration: 1,
          },
        },
      }),
    ).toThrow(expect.objectContaining({ code: "permission_denied" }));
    expect(sendDirect).toHaveBeenCalledTimes(1);
  });
});
