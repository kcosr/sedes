import { testAgentToolExecutionAuthority } from "../support/agent-tool-execution-authority.js";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseAgentToolApplicationReader } from "../../src/server/agent-tools/application/database-agent-tool-application-reader.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import { SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER } from "../../src/server/agent-tools/http/agent-tool-http-contracts.js";
import { PolicyCheckedAgentToolHttpService } from "../../src/server/agent-tools/http/agent-tool-http-service.js";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import { createAgentToolRouter } from "../../src/server/agent-tools/http/agent-tool-router.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import {
  InteractionBroker,
  type InteractionBrokerPublisher,
  type InteractionConversation,
} from "../../src/server/conversations/interaction-broker.js";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { openOverlayDatabaseConnection } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
  deployedMigrations,
} from "../../src/server/db/migrate.js";
import { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";
import { loadOrCreateToolProvenanceKey } from "../../src/server/security/installation-secret.js";
import { unavailablePrincipalAgentToolClientService } from "../support/agent-tool-http.js";

const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const crossEnvironmentSource = Object.freeze({
  scope: { tenantId: "tenant-cross-env", principalId: "principal-cross-env" },
  sourceThreadId: "source-thread",
  sourceWorkspaceId: "source-workspace",
  sourceEnvironmentId: "source-environment",
  backendKind: "pi" as const,
});
const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [{ id: environmentId, kind: "local", label: "Local" }],
  backends: [
    {
      id: "pi-primary",
      kind: "pi",
      label: "Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "pi-local",
      kind: "pi_sdk",
      label: "Pi",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: environmentId,
      enabled: true,
    },
  ],
  defaultTargetId: "pi-local",
});

function createCrossEnvironmentComposition() {
  const readThreadStatus = vi.fn(async () => ({
    threadId: "remote-thread",
    backend: "pi" as const,
    lifecycle: "active" as const,
    pinned: false,
    activity: "idle" as const,
  }));
  const canonical = new CanonicalInlineAgentToolService({
    application: { readThreadStatus },
    invocationId: () => "cross-environment-invocation",
  });
  const policy = {
    enabled: true,
    enabledToolIds: ["thread.status"],
    presentation: { surface: "cli" as const, mode: "progressive" as const },
    resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
    revision: 1,
  };
  const policies = { get: () => policy } as unknown as ThreadAgentToolPolicyRepository;
  const environmentAuthority = new AgentToolEnvironmentAuthorityResolver({
    resolveEnvironment: () => undefined,
    resolveWorkspace: () => undefined,
    resolveAutomation: () => undefined,
    resolveThread: (_scope, id) =>
      id === "remote-thread"
        ? {
            id,
            environmentId: "remote-environment",
            label: "Remote thread",
          }
        : undefined,
    resolveThreadFamily: () => undefined,
    resolveTask: () => undefined,
    resolveProject: () => undefined,
    resolveWorkspaceProject: () => "project-1",
    resolveWorkpad: () => undefined,
    resolveSavedAgent: () => undefined,
    listEnvironments: () => [
      {
        id: "source-environment",
        environmentId: "source-environment",
        label: "Local",
      },
      {
        id: "remote-environment",
        environmentId: "remote-environment",
        label: "Remote",
      },
    ],
  });
  const broker = new InteractionBroker();
  const publisher = {
    opened: vi.fn(),
    resolved: vi.fn(),
  } satisfies InteractionBrokerPublisher;
  const conversation = {
    subscribe: () => () => undefined,
    respond: vi.fn(async () => undefined),

  } satisfies InteractionConversation;
  broker.bind(
    crossEnvironmentSource.scope,
    crossEnvironmentSource.sourceThreadId,
    conversation,
    publisher,
  );
  const service = new SourceScopedAgentToolService(canonical,
policies,
environmentAuthority,
{ resolveInScope: () => crossEnvironmentSource }, testAgentToolExecutionAuthority);

  return { broker, publisher, readThreadStatus, service,
    setCrossEnvironmentAccess(allowed: boolean) {
      policy.resourceScope.allowOtherEnvironments = allowed;
      policy.revision += 1;
    },
  };
}

function invokeRemoteThreadStatus(
  service: SourceScopedAgentToolService,
  signal: AbortSignal,
) {
  return service.invoke({
    source: crossEnvironmentSource,
    adapter: "cli",
    request: {
      toolId: "thread.status",
      schemaVersion: 3,
      requestId: "cross-environment-request",
      input: { threadId: "remote-thread" },
    },
    signal,
  });
}

describe("agent-tool HTTP production composition", () => {
  it("retains one stable thread reference across restart without provider-turn authority", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "sedes-agent-tool-restart-"),
    );
    const stateDirectory = path.join(root, "state");
    const databasePath = path.join(stateDirectory, "overlay.sqlite");
    await mkdir(stateDirectory);
    const firstDatabase = openOverlayDatabaseConnection(databasePath);
    let firstDatabaseOpen = true;
    let secondDatabase:
      ReturnType<typeof openOverlayDatabaseConnection> | undefined;
    try {
      applyDatabaseMigrations(firstDatabase, deployedMigrations);
      const firstIdentity = new SingleUserIdentityProvider<express.Request>(
        firstDatabase,
      );
      const scope = firstIdentity.getScope();
      const legacy = new ThreadInventoryService(
        new OverlayRepository(firstDatabase),
      );
      const environment = legacy.getLocalEnvironment(scope);
      const workspace = legacy.rememberWorkspace(
        scope,
        {
          environmentId: environment.id,
          canonicalPath: "/tmp/agent-tool-restart",
          displayName: "Agent tool restart",
          availability: "available",
          trustState: "trusted",
        },
        100,
      );
      const thread = legacy.createThread(
        scope,
        { workspaceId: workspace.id, title: "Restart source" },
        110,
      );
      applyBackendNormalizationMigration(firstDatabase, {
        configuration,
        quiescentCutoverConfirmed: true,
        appliedAt: 200,
      });
      applyDatabaseMigrations(firstDatabase, backendNormalizedMigrations);
      const firstPolicies = new ThreadAgentToolPolicyRepository(
        firstDatabase,
        createThreadAgentToolPolicyDependencies().eligibility,
      );
      firstPolicies.update(scope, thread.thread.id, {
        expectedRevision: 0,
        enabled: true,
        presentation: { surface: "cli", mode: "progressive" },
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        enabledToolIds: ["agent.context", "thread.status"],
        now: 300,
      });
      const firstInstallationKey =
        await loadOrCreateToolProvenanceKey(stateDirectory);
      const firstAuthority = new DatabaseAgentToolSourceAuthority(
        firstDatabase,
        firstInstallationKey,
      );
      const retainedReference = firstAuthority.issue(
        {
          scope,
          sourceThreadId: thread.thread.id,
          sourceWorkspaceId: workspace.id,
          sourceEnvironmentId: environment.id,
          backendKind: "pi",
        },
        "management_http",
        "cli",
      );

      const firstRequest = new AbortController();
      let invocationStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        invocationStarted = resolve;
      });
      const firstCanonical = new CanonicalInlineAgentToolService({
        application: {
          readThreadStatus: async (_scope, _threadId, _grant, signal) =>
            await new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            }),
        },
      });
      const firstTools = new SourceScopedAgentToolService(firstCanonical,
firstPolicies,
new AgentToolEnvironmentAuthorityResolver(firstAuthority),
firstAuthority, testAgentToolExecutionAuthority);
      const oldRuntimeWork = firstTools.invoke({
        source: firstAuthority.resolveCapabilityInScope(
          scope,
          retainedReference,
          new AbortController().signal,
        ).source,
        adapter: "http",
        request: {
          toolId: "thread.status",
          schemaVersion: 3,
          requestId: "pre-restart-active-work",
          input: { threadId: thread.thread.id },
        },
        signal: firstRequest.signal,
        onInvocationStarted: invocationStarted,
      });
      await started;
      firstRequest.abort(new Error("application_restart"));
      await expect(oldRuntimeWork).rejects.toMatchObject({
        toolError: { code: "cancelled" },
      });
      await firstCanonical.close();

      firstDatabase.close();
      firstDatabaseOpen = false;

      const secondInstallationKey =
        await loadOrCreateToolProvenanceKey(stateDirectory);
      expect(secondInstallationKey).toEqual(firstInstallationKey);
      secondDatabase = openOverlayDatabaseConnection(databasePath);
      const secondIdentity = new SingleUserIdentityProvider<express.Request>(
        secondDatabase,
      );
      const secondAuthority = new DatabaseAgentToolSourceAuthority(
        secondDatabase,
        secondInstallationKey,
      );
      expect(
        secondAuthority.issue(
          {
            scope,
            sourceThreadId: thread.thread.id,
            sourceWorkspaceId: workspace.id,
            sourceEnvironmentId: environment.id,
            backendKind: "pi",
          },
          "management_http",
          "cli",
        ),
      ).toBe(retainedReference);
      const application = new DatabaseAgentToolApplicationReader(
        secondDatabase,
        secondIdentity,
        { snapshot: async () => undefined } as never,
        secondAuthority,
      );
      const policies = new ThreadAgentToolPolicyRepository(
        secondDatabase,
        createThreadAgentToolPolicyDependencies().eligibility,
      );
      const canonical = new CanonicalInlineAgentToolService({
        application,
      });
      const providerTools = new SourceScopedAgentToolService(canonical,
policies,
new AgentToolEnvironmentAuthorityResolver(secondAuthority),
secondAuthority, testAgentToolExecutionAuthority);
      const app = express();
      app.use(express.json({ strict: true, type: "application/json" }));
      app.use(
        createAgentToolRouter({
          sources: application,
          tools: new PolicyCheckedAgentToolHttpService(providerTools),
          clients: unavailablePrincipalAgentToolClientService(),
        }),
      );
      const associated = (test: request.Test) =>
        test.set(
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER,
          retainedReference,
        );

      await associated(request(app).get("/api/agent-tools"))
        .expect(200)
        .expect(({ body }) =>
          expect(body.tools.map(({ id }: { id: string }) => id)).toEqual([
            "agent.context",
            "thread.status",
          ]),
        );
      await associated(request(app).post("/api/agent-tool-descriptions"))
        .send({ toolIds: ["agent.context"] })
        .expect(200)
        .expect(({ body }) =>
          expect(body.tools.map(({ id }: { id: string }) => id)).toEqual([
            "agent.context",
          ]),
        );
      await associated(request(app).post("/api/agent-tool-invocations"))
        .send({
          toolId: "agent.context",
          schemaVersion: 3,
          requestId: "thread-scoped-after-restart",
          input: {},
        })
        .expect(200)
        .expect(({ body }) =>
          expect(body.output).toEqual({
            threadId: thread.thread.id,
            workspaceId: workspace.id,
            projectId: secondDatabase!
              .prepare("SELECT project_id FROM workspaces WHERE id = ?")
              .pluck()
              .get(workspace.id),
            backend: "pi",
          }),
        );
    } finally {
      if (firstDatabaseOpen) firstDatabase.close();
      if (secondDatabase?.open) secondDatabase.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves scoped source facts and serves policy-checked canonical tools", async () => {
    const database = openOverlayDatabaseConnection(":memory:");
    try {
      applyDatabaseMigrations(database, deployedMigrations);
      const identity = new SingleUserIdentityProvider<express.Request>(
        database,
      );
      const scope = identity.getScope();
      const legacy = new ThreadInventoryService(
        new OverlayRepository(database),
      );
      const environment = legacy.getLocalEnvironment(scope);
      const workspace = legacy.rememberWorkspace(
        scope,
        {
          environmentId: environment.id,
          canonicalPath: "/tmp/agent-tool-http-composition",
          displayName: "Agent tool HTTP",
          availability: "available",
          trustState: "trusted",
        },
        100,
      );
      const thread = legacy.createThread(
        scope,
        { workspaceId: workspace.id, title: "Source thread" },
        110,
      );
      applyBackendNormalizationMigration(database, {
        configuration,
        quiescentCutoverConfirmed: true,
        appliedAt: 200,
      });
      applyDatabaseMigrations(database, backendNormalizedMigrations);
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN (
               'agent_executions', 'agent_runs', 'agent_capability_grants',
               'agent_capability_entries', 'agent_tool_invocations'
             )
             ORDER BY name`,
          )
          .all(),
      ).toEqual([]);
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index'
               AND name = 'application_threads_agent_execution_target'`,
          )
          .get(),
      ).toEqual({ name: "application_threads_agent_execution_target" });

      const snapshot = vi.fn(async () => ({
        thread: { inventoryState: "settled", runState: "waiting_for_input" },
      }));
      const sourceAuthority = new DatabaseAgentToolSourceAuthority(
        database,
        new Uint8Array(32).fill(7),
      );
      const application = new DatabaseAgentToolApplicationReader(
        database,
        identity,
        { snapshot } as never,
        sourceAuthority,
      );
      const dependencies = createThreadAgentToolPolicyDependencies();
      const policies = new ThreadAgentToolPolicyRepository(
        database,
        dependencies.eligibility,
      );
      policies.update(scope, thread.thread.id, {
        expectedRevision: 0,
        enabled: true,
        presentation: { surface: "native", mode: "individual" },
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        enabledToolIds: ["agent.context", "thread.status"],
        now: 300,
      });
      const listMessages = vi.fn(async () => ({
        turns: [],
        nextCursor: null,
        activeTurn: null,
      }));
      const sendDirect = vi.fn(async () => ({
        status: "delivery_accepted" as const,
        operationId: "operation-1",
      }));
      const forkAgent = vi.fn(async () => ({
        status: "created" as const,
        childThreadId: "child-thread-1",
      }));
      const forkPrincipalClient = vi.fn(async () => ({
        status: "created" as const,
        childThreadId: "child-thread-1",
      }));
      const canonical = new CanonicalInlineAgentToolService({
        application,
        threadControl: {
          messages: { list: listMessages },
          send: { sendDirect },
          forks: { forkAgent, forkPrincipalClient },
          inventory: {
            archive: vi.fn(async (_scope, input) => ({
              threadId: input.threadId,
              archivedThreadCount: 1,
            })),
            restore: vi.fn(async (_scope, input) => ({
              threadId: input.threadId,
            })),
          },
        },
        invocationId: () => "invocation-1",
      });
      const environmentAuthority = new AgentToolEnvironmentAuthorityResolver(
        sourceAuthority,
      );
      const providerTools = new SourceScopedAgentToolService(canonical,
policies,
environmentAuthority,
sourceAuthority, testAgentToolExecutionAuthority);
      const source = {
        scope,
        sourceThreadId: thread.thread.id,
        sourceWorkspaceId: workspace.id,
        sourceEnvironmentId: environment.id,
        backendKind: "pi" as const,
      };
      const sourceCapability = sourceAuthority.issue(
        source,
        "management_http",
        "cli",
      );
      expect(
        providerTools.eligibleCatalog("pi_sdk").map(({ id }) => id),
      ).toEqual([
        "agent.context",
        "thread.status",
        "thread.messages",
        "thread.send",
        "thread.fork",
        "thread.archive",
        "thread.restore",
        "client.list", "client.end_interaction", "client.switch_thread", "client.settings.get", "client.settings.update", "client.replay_turn",
      ]);
      expect(providerTools.eligibleCatalog("cli").map(({ id }) => id)).toEqual(
        providerTools.eligibleCatalog("pi_sdk").map(({ id }) => id),
      );
      expect(providerTools.readPolicy(source)).toMatchObject({
        enabled: true,
        presentation: { surface: "native", mode: "individual" },
      });
      policies.update(scope, thread.thread.id, {
        expectedRevision: 1,
        enabled: false,
        presentation: { surface: "native", mode: "individual" },
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        enabledToolIds: ["agent.context", "thread.status"],
        now: 301,
      });
      await expect(
        providerTools.invoke({
          source,
          adapter: "pi_sdk",
          request: {
            toolId: "agent.context",
            schemaVersion: 3,
            requestId: "disabled-request",
            input: {},
          },
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({
        toolError: {
          code: "permission_denied",
          message: "The tool is not exposed to this thread.",
          retryable: false,
        },
      });
      policies.update(scope, thread.thread.id, {
        expectedRevision: 2,
        enabled: true,
        presentation: { surface: "native", mode: "individual" },
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        enabledToolIds: ["agent.context", "thread.status"],
        now: 302,
      });
      await expect(
        providerTools.invoke({
          source,
          adapter: "pi_sdk",
          request: {
            toolId: "agent.context",
            schemaVersion: 3,
            requestId: "trusted-source-context",
            input: {},
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        state: "completed",
        output: {
          threadId: thread.thread.id,
          workspaceId: workspace.id,
          backend: "pi",
        },
      });
      const tools = new PolicyCheckedAgentToolHttpService(providerTools);
      const app = express();
      app.use(express.json({ strict: true, type: "application/json" }));
      app.use(
        createAgentToolRouter({
          sources: application,
          tools,
          clients: unavailablePrincipalAgentToolClientService(),
        }),
      );

      const associated = (test: request.Test) =>
        test.set(SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER, sourceCapability);
      await associated(request(app).get("/api/agent-tools"))
        .expect(200)
        .expect(({ body }) => expect(body.tools).toEqual([]));
      await associated(request(app).post("/api/agent-tool-invocations"))
        .send({
          toolId: "agent.context",
          schemaVersion: 3,
          requestId: "native-http-request",
          input: {},
        })
        .expect(403);
      policies.update(scope, thread.thread.id, {
        expectedRevision: 3,
        enabled: true,
        presentation: { surface: "cli", mode: "progressive" },
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
        enabledToolIds: [
          "agent.context",
          "thread.status",
          "thread.messages",
          "thread.send",
          "thread.fork",
        ],
        now: 303,
      });
      await associated(request(app).get("/api/agent-tools"))
        .expect(200)
        .expect(({ body }) =>
          expect(body.tools.map(({ id }: { id: string }) => id)).toEqual([
            "agent.context",
            "thread.status",
            "thread.messages",
            "thread.send",
            "thread.fork",
          ]),
        );
      await associated(request(app).post("/api/agent-tool-invocations"))
        .send({
          toolId: "agent.context",
          schemaVersion: 3,
          requestId: "context-request",
          input: {},
        })
        .expect(200)
        .expect(({ body }) =>
          expect(body.output).toEqual({
            threadId: thread.thread.id,
            workspaceId: workspace.id,
            projectId: database
              .prepare("SELECT project_id FROM workspaces WHERE id = ?")
              .pluck()
              .get(workspace.id),
            backend: "pi",
          }),
        );
      await associated(request(app).post("/api/agent-tool-invocations"))
        .send({
          toolId: "thread.status",
          schemaVersion: 3,
          requestId: "status-request",
          input: { threadId: thread.thread.id },
        })
        .expect(200)
        .expect(({ body }) =>
          expect(body.output).toEqual({
            threadId: thread.thread.id,
            backend: "pi",
            lifecycle: "settled",
            activity: "waiting_for_input",
            pinned: false,
          }),
        );
      expect(snapshot).toHaveBeenCalledWith(scope, thread.thread.id);
      await associated(request(app).post("/api/agent-tool-invocations"))
        .send({
          toolId: "thread.messages",
          schemaVersion: 5,
          requestId: "messages-request",
          input: { threadId: thread.thread.id },
        })
        .expect(200)
        .expect(({ body }) =>
          expect(body.output).toEqual({
            turns: [],
            nextCursor: null,
            activeTurn: null,
          }),
        );
      expect(listMessages).toHaveBeenCalledWith(
        scope,
        thread.thread.id,
        expect.objectContaining({
          pageSize: 10,
          environmentAuthority: expect.objectContaining({
            defaults: expect.objectContaining({
              environmentId: environment.id,
            }),
          }),
        }),
      );
      await associated(request(app).post("/api/agent-tool-invocations"))
        .send({
          toolId: "thread.send",
          schemaVersion: 2,
          requestId: "send-request",
          input: { threadId: thread.thread.id, message: "Independent input" },
        })
        .expect(200)
        .expect(({ body }) =>
          expect(body.output).toEqual({
            status: "delivery_accepted",
            operationId: "operation-1",
          }),
        );
      expect(sendDirect).toHaveBeenCalledWith(
        scope,
        expect.objectContaining({
          initiator: {
            kind: "thread_agent",
            sourceThreadId: thread.thread.id,
            sourceWorkspaceId: workspace.id,
          },
          targetThreadId: thread.thread.id,
          message: "Independent input",
          mutationId: expect.any(String),
          environmentAuthority: expect.objectContaining({
            defaults: expect.objectContaining({
              environmentId: environment.id,
            }),
          }),
        }),
      );
      const sourceTurnId = "11111111-1111-4111-8111-111111111111";
      await associated(request(app).post("/api/agent-tool-invocations"))
        .send({
          toolId: "thread.fork",
          schemaVersion: 1,
          requestId: "fork-request",
          input: {
            threadId: thread.thread.id,
            sourceTurnId,
            expectedTurnRevision: 4,
          },
        })
        .expect(200)
        .expect(({ body }) =>
          expect(body.output).toEqual({
            status: "created",
            childThreadId: "child-thread-1",
          }),
        );
      expect(forkAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          scope,
          controllerThreadId: thread.thread.id,
          sourceThreadId: thread.thread.id,
          sourceTurnId,
          expectedTurnRevision: 4,
          mutationId: expect.any(String),
          environmentAuthority: expect.objectContaining({
            defaults: expect.objectContaining({
              environmentId: environment.id,
            }),
          }),
        }),
      );
      expect(canonical.registry.get("thread.messages", 5)).toBeDefined();
      expect(canonical.registry.get("thread.send", 2)).toBeDefined();
      expect(canonical.registry.get("thread.fork", 1)).toBeDefined();

      await expect(
        application.readThreadStatus(
          { tenantId: scope.tenantId, principalId: "foreign-principal" },
          thread.thread.id,
          {} as never,
          new AbortController().signal,
        ),
      ).resolves.toBeUndefined();
    } finally {
      database.close();
    }
  });
});

describe("cross-environment agent-tool policy composition", () => {
  it("uses an explicit user policy change and immediately revokes later cross-environment calls", async () => {
    const composition = createCrossEnvironmentComposition();
    try {
      composition.setCrossEnvironmentAccess(true);
      await expect(invokeRemoteThreadStatus(composition.service, new AbortController().signal))
        .resolves.toMatchObject({ state: "completed", output: { threadId: "remote-thread" } });
      expect(composition.readThreadStatus).toHaveBeenCalledOnce();
      composition.setCrossEnvironmentAccess(false);
      await expect(invokeRemoteThreadStatus(composition.service, new AbortController().signal))
        .rejects.toMatchObject({ toolError: { code: "permission_denied" } });
      expect(composition.readThreadStatus).toHaveBeenCalledOnce();
      expect(composition.publisher.opened).not.toHaveBeenCalled();
      expect(composition.publisher.resolved).not.toHaveBeenCalled();
    } finally { await composition.broker.close(); }
  });

  it("denies an outside ID without executing the tool or requesting an approval", async () => {
    const composition = createCrossEnvironmentComposition();
    try {
      await expect(invokeRemoteThreadStatus(composition.service, new AbortController().signal))
        .rejects.toMatchObject({ toolError: { code: "permission_denied", message: expect.stringContaining("Cross-environment access is disabled") } });
      expect(composition.readThreadStatus).not.toHaveBeenCalled();
      expect(composition.publisher.opened).not.toHaveBeenCalled();
      expect(composition.broker.listPending(crossEnvironmentSource.scope, crossEnvironmentSource.sourceThreadId)).toEqual([]);
    } finally { await composition.broker.close(); }
  });

  it("executes nothing when the caller has already aborted", async () => {
    const composition = createCrossEnvironmentComposition();
    const controller = new AbortController();
    try {
      composition.setCrossEnvironmentAccess(true);
      controller.abort();
      await expect(invokeRemoteThreadStatus(composition.service, controller.signal))
        .rejects.toMatchObject({ toolError: { code: "cancelled" } });
      expect(composition.readThreadStatus).not.toHaveBeenCalled();
      expect(composition.publisher.opened).not.toHaveBeenCalled();
      expect(composition.broker.listPending(crossEnvironmentSource.scope, crossEnvironmentSource.sourceThreadId)).toEqual([]);
    } finally { await composition.broker.close(); }
  });
});
