import { WorkpadRepository } from "../../src/server/db/repositories/workpad-repository.js";
import { WorkpadService } from "../../src/server/domain/workpad-service.js";
import { WorkpadAgentToolService } from "../../src/server/agent-tools/tools/workpad-agent-tool-service.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { PrincipalAgentToolClientService } from "../../src/server/agent-tools/application/principal-agent-tool-client-service.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import {
  createPrincipalAgentToolClientEligibility,
  createThreadAgentToolPolicyDependencies,
} from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { PrincipalAgentToolClientRepository } from "../../src/server/db/repositories/principal-agent-tool-client-repository.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import type { AgentManagementService } from "../../src/server/agent-tools/application/agent-management-service.js";
import type { AutomationAgentToolService } from "../../src/server/agent-tools/tools/automation-agent-tool-service.js";
import type { AgentThreadCreationService } from "../../src/server/agent-tools/tools/thread-management-tools.js";
import type { SavedAgentCanonicalToolService } from "../../src/server/agent-tools/tools/saved-agent-management-tools.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { ConfigurationProjection } from "../../src/server/configuration-admin/configuration-projection.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { createAgentToolRouter } from "../../src/server/agent-tools/http/agent-tool-router.js";
import { SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER } from "../../src/server/agent-tools/http/agent-tool-http-contracts.js";
import { unavailableAgentToolRouterDependencies } from "../support/agent-tool-http.js";

const keyA = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const keyB = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const remoteEnvironmentId = "019196f7-a0a8-7bc4-a89b-8cf013978406";

function unavailableDomainService<T extends object>(): T {
  return new Proxy(Object.create(null) as T, {
    get() {
      return () => {
        throw new Error("unavailable_test_domain_service");
      };
    },
  });
}

function fixture() {
  const { database, scope } = savedAgentDatabase();
  const inventory = new InventoryRepository(database);
  const environment = inventory.listEnvironments(scope)[0]!;
  const workspace = inventory.upsertWorkspace(scope, {
    environmentId: environment.id,
    canonicalPath: "/tmp/principal-agent-tool-client",
    displayName: "Principal client",
    available: true,
    trustState: "trusted",
    environmentConfigurationRevision: environment.configurationRevision,
    now: 100,
  });
  const profile = database
    .prepare(
      `SELECT id FROM agent_connection_profiles
       WHERE tenant_id = ? AND owner_principal_id = ?
       ORDER BY id LIMIT 1`,
    )
    .get(scope.tenantId, scope.principalId) as { readonly id: string };
  const thread = new ConversationBindingRepository(database).createUnboundThread(
    scope,
    {
      workspaceId: workspace.id,
      connectionProfileId: profile.id,
      title: "Default client thread",
      now: 110,
    },
  );
  database
    .prepare(
      `INSERT INTO execution_environments(
         tenant_id, owner_principal_id, id, kind, label, availability,
         diagnostic_code, revision, configuration_revision,
         configuration_fingerprint, created_at, updated_at,
         operations_configuration_revision,
         operations_configuration_fingerprint
       ) VALUES (?, ?, ?, 'ssh', 'Remote', 'available', NULL, 0, 0,
         ?, 120, 120, 0, ?)` ,
    )
    .run(
      scope.tenantId,
      scope.principalId,
      remoteEnvironmentId,
      "1".repeat(64),
      "2".repeat(64),
    );

  const authority = new DatabaseAgentToolSourceAuthority(database, keyA);
  const management = unavailableDomainService<AgentManagementService>();
  const canonical = new CanonicalInlineAgentToolService({
    application: {
      readThreadStatus: async (_scope, threadId) =>
        threadId === thread.id
          ? {
              threadId,
              backend: "pi" as const,
              lifecycle: "active" as const,
              activity: "idle" as const,
            }
          : undefined,
    },
    management,
    workpads: new WorkpadAgentToolService({ workpads: new WorkpadService(new WorkpadRepository(database), { publishWorkpadChange: async () => undefined }), authorityReader: authority }),
    automations: unavailableDomainService<AutomationAgentToolService>(),
    threadCreation: unavailableDomainService<AgentThreadCreationService>(),
    savedAgents: unavailableDomainService<SavedAgentCanonicalToolService>(),
  });
  const repository = new PrincipalAgentToolClientRepository(
    database,
    createPrincipalAgentToolClientEligibility(),
  );
  let clock = 1_000;
  const service = (
    key: Uint8Array = keyA,
    hooks: ConstructorParameters<typeof PrincipalAgentToolClientService>[6] = {},
  ) =>
    new PrincipalAgentToolClientService(
      key,
      database,
      repository,
      canonical,
      new AgentToolEnvironmentAuthorityResolver(authority),
      () => clock,
      hooks,
      createThreadAgentToolPolicyDependencies().catalog,
    );
  return {
    database,
    scope,
    environment,
    workspace,
    thread,
    connectionProfileId: profile.id,
    repository,
    canonical,
    service,
    setClock(value: number) {
      clock = value;
    },
  };
}

function createClient(
  value: ReturnType<typeof fixture>,
  overrides: Partial<{
    readonly requestId: string;
    readonly name: string;
    readonly toolIds: readonly string[];
    readonly defaultEnvironmentId: string;
    readonly allowedEnvironmentIds: readonly string[];
    readonly defaultWorkspaceId: string;
    readonly defaultThreadId: string;
  }> = {},
) {
  return value.service().create(value.scope, {
    requestId: overrides.requestId ?? randomUUID(),
    name: overrides.name ?? "External CLI",
    toolIds: overrides.toolIds ?? ["thread.status", "workspace.list"],
    defaultEnvironmentId:
      overrides.defaultEnvironmentId ?? value.environment.id,
    allowedEnvironmentIds:
      overrides.allowedEnvironmentIds ?? [value.environment.id],
    defaultWorkspaceId: overrides.defaultWorkspaceId ?? value.workspace.id,
    defaultThreadId: overrides.defaultThreadId ?? value.thread.id,
  });
}

function replacement(
  client: ReturnType<typeof createClient>["client"],
  overrides: Partial<{
    readonly enabled: boolean;
    readonly toolIds: readonly string[];
  }> = {},
) {
  return {
    expectedRevision: client.policyRevision,
    name: client.name,
    enabled: overrides.enabled ?? client.enabled,
    toolIds: overrides.toolIds ?? client.toolIds,
    defaultEnvironmentId: client.defaultEnvironmentId!,
    allowedEnvironmentIds: client.allowedEnvironmentIds,
    ...(client.defaultWorkspaceId
      ? { defaultWorkspaceId: client.defaultWorkspaceId }
      : {}),
    ...(client.defaultThreadId ? { defaultThreadId: client.defaultThreadId } : {}),
  };
}

const statusRequest = {
  toolId: "thread.status",
  schemaVersion: 2,
  requestId: "principal-client-status",
  input: { threadId: "target-thread" },
} as const;

function corrupted(credential: string): string {
  return `${credential.slice(0, -1)}${credential.endsWith("A") ? "B" : "A"}`;
}

describe("principal agent-tool client persistence and admission", () => {
  it("stores only a keyed verifier, recovers by creation request, and scopes reads", () => {
    const value = fixture();
    try {
      const requestId = randomUUID();
      const created = createClient(value, { requestId, name: "  Build CLI  " });
      expect(created.client).toMatchObject({
        creationRequestId: requestId,
        name: "Build CLI",
        enabled: true,
        policyRevision: 1,
        credentialGeneration: 1,
      });
      const stored = value.database
        .prepare(
          `SELECT credential_verifier AS verifier
           FROM principal_agent_tool_clients WHERE id = ?`,
        )
        .get(created.client.id) as { readonly verifier: Buffer };
      expect(stored.verifier).toHaveLength(32);
      expect(stored.verifier.toString("utf8")).not.toContain(created.credential);
      expect(
        value.database
          .prepare(
            `SELECT count(*) AS count FROM principal_agent_tool_clients
             WHERE CAST(credential_verifier AS TEXT) LIKE ?`,
          )
          .get(`%${created.credential}%`),
      ).toEqual({ count: 0 });
      expect(
        value.repository.findByCreationRequestId(value.scope, requestId)?.id,
      ).toBe(created.client.id);
      expect(() => createClient(value, { requestId })).toThrowError(
        expect.objectContaining({ code: "conflict" }),
      );
      expect(() =>
        value.repository.get(
          { ...value.scope, principalId: "another-principal" },
          created.client.id,
        ),
      ).toThrowError(expect.objectContaining({ code: "not_found" }));
    } finally {
      value.database.close();
    }
  });

  it("filters the principal catalog, freezes coherent authority, and denies other environments", () => {
    const value = fixture();
    try {
      const created = createClient(value);
      expect(
        value.service().catalogSummaries(created.credential).map(({ id }) => id),
      ).toEqual(["workspace.list", "thread.status"]);
      expect(
        value.service().describeMany(created.credential, ["thread.status"])[0],
      ).toMatchObject({ id: "thread.status", schemaVersion: 2 });
      expect(() =>
        value.service().describeMany(created.credential, ["agent.context"]),
      ).toThrowError(expect.objectContaining({ code: "not_found" }));
      const admitted = value.service().admitInvocation(created.credential, {
        ...statusRequest,
        input: { threadId: value.thread.id },
      });
      expect(admitted.scope).toEqual(value.scope);
      expect(admitted.authority).toMatchObject({
        subject: {
          kind: "principal_client",
          clientId: created.client.id,
          credentialGeneration: 1,
        },
        defaults: {
          kind: "principal_client",
          environmentId: value.environment.id,
          workspaceId: value.workspace.id,
          threadId: value.thread.id,
        },
        policyIdentity: {
          ownerKind: "principal_client",
          ownerId: created.client.id,
          revision: 1,
          credentialGeneration: 1,
        },
        environmentAuthority: {
          callerKind: "principal_client",
          admittedEnvironmentIds: [value.environment.id],
        },
      });
      expect(() =>
        value.service().admitInvocation(created.credential, {
          toolId: "workspace.list",
          schemaVersion: 4,
          requestId: "other-environment",
          input: {
            scope: { kind: "environment", environmentId: remoteEnvironmentId },
          },
        }),
      ).toThrowError(expect.objectContaining({ code: "permission_denied" }));
    } finally {
      value.database.close();
    }
  });

  it("attributes Workpad HTTP edits to the Tool client without impersonating its default thread", async () => {
    const value = fixture();
    try {
      const created = createClient(value, { toolIds: ["workpad.create", "workpad.get", "workpad.update"], name: "Build CLI" });
      const app = express();
      app.use(express.json({ strict: true, type: "application/json" }));
      const dependencies = unavailableAgentToolRouterDependencies();
      Object.assign(dependencies, { clients: value.service() });
      app.use(createAgentToolRouter(dependencies));
      const invoke = (toolId: string, input: unknown) => request(app).post("/api/agent-tool-invocations")
        .set(SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER, created.credential)
        .send({ toolId, schemaVersion: 1, requestId: randomUUID(), input });
      const response = await invoke("workpad.create", { title: "Client notes", scope: { kind: "thread" }, content: "Original" }).expect(200);
      const pad = response.body.output.workpad;
      expect(pad.author).toMatchObject({ kind: "tool_client", clientId: created.client.id, threadId: null, name: "Build CLI" });
      expect(pad.scope).toEqual({ kind: "thread", threadId: value.thread.id });
      await invoke("workpad.update", { workpadId: pad.id, expectedRevision: 0, edit: { kind: "replace", content: "Updated" } }).expect(200);
      const stale = await invoke("workpad.update", { workpadId: pad.id, expectedRevision: 0, edit: { kind: "replace", content: "Stale" } });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ error: { code: "conflict" } });
      const read = await invoke("workpad.get", { workpadId: pad.id }).expect(200);
      expect(read.body.output.workpad).toMatchObject({ revision: 1, content: "Updated" });
    } finally { value.database.close(); }
  });

  it("executes through the canonical HTTP routes and rechecks rotated credentials", async () => {
    const value = fixture();
    try {
      const created = createClient(value, { toolIds: ["thread.status"] });
      const app = express();
      app.use(express.json({ strict: true, type: "application/json" }));
      const dependencies = unavailableAgentToolRouterDependencies();
      Object.assign(dependencies, { clients: value.service() });
      app.use(createAgentToolRouter(dependencies));
      const associated = (token: string, test: request.Test) =>
        test.set(SEDES_AGENT_TOOL_CLIENT_CREDENTIAL_HEADER, token);

      await associated(created.credential, request(app).get("/api/agent-tools"))
        .expect(200)
        .expect(({ body }) =>
          expect(body.tools.map(({ id }: { id: string }) => id)).toEqual([
            "thread.status",
          ]),
        );
      await associated(
        created.credential,
        request(app).post("/api/agent-tool-invocations"),
      )
        .send({
          ...statusRequest,
          input: { threadId: value.thread.id },
        })
        .expect(200)
        .expect(({ body }) =>
          expect(body.output).toMatchObject({
            threadId: value.thread.id,
            activity: "idle",
          }),
        );

      const rotated = value
        .service()
        .rotate(value.scope, created.client.id, created.client.policyRevision);
      await associated(created.credential, request(app).get("/api/agent-tools"))
        .expect(401)
        .expect(({ body }) => expect(body.error.code).toBe("unauthenticated"));
      await associated(rotated.credential, request(app).get("/api/agent-tools"))
        .expect(200);
      value
        .service()
        .revoke(value.scope, rotated.client.id, rotated.client.policyRevision);
      await associated(rotated.credential, request(app).get("/api/agent-tools"))
        .expect(401)
        .expect(({ body }) => expect(body.error.code).toBe("unauthenticated"));
    } finally {
      value.database.close();
    }
  });

  it("makes disable, rotation, revocation, and installation-key replacement immediate", () => {
    const value = fixture();
    try {
      const created = createClient(value);
      const disabled = value.service().replace(
        value.scope,
        created.client.id,
        replacement(created.client, { enabled: false }),
      );
      expect(disabled.enabled).toBe(false);
      const unauthenticated = {
        code: "unauthenticated",
        message: "The tool client credential is invalid.",
      };
      expect(() => value.service().catalogSummaries(created.credential)).toThrowError(
        expect.objectContaining(unauthenticated),
      );
      const enabled = value.service().replace(value.scope, created.client.id, {
        ...replacement(disabled, { enabled: true }),
      });
      const rotated = value
        .service()
        .rotate(value.scope, created.client.id, enabled.policyRevision);
      expect(() => value.service().catalogSummaries(created.credential)).toThrowError(
        expect.objectContaining(unauthenticated),
      );
      expect(value.service().catalogSummaries(rotated.credential)).not.toHaveLength(0);
      expect(() => value.service(keyB).catalogSummaries(rotated.credential)).toThrowError(
        expect.objectContaining(unauthenticated),
      );
      const replacementCredential = value
        .service(keyB)
        .rotate(value.scope, created.client.id, rotated.client.policyRevision);
      expect(value.service(keyB).catalogSummaries(replacementCredential.credential)).not.toHaveLength(0);
      const revoked = value
        .service(keyB)
        .revoke(
          value.scope,
          created.client.id,
          replacementCredential.client.policyRevision,
        );
      expect(revoked).toMatchObject({ enabled: false, toolIds: [], allowedEnvironmentIds: [] });
      expect(revoked.revokedAt).toBeDefined();
      expect(() =>
        value.service(keyB).catalogSummaries(replacementCredential.credential),
      ).toThrowError(expect.objectContaining(unauthenticated));
      expect(() =>
        value.service(keyB).replace(
          value.scope,
          created.client.id,
          replacement(revoked, { enabled: true }),
        ),
      ).toThrowError(expect.objectContaining({ code: "conflict" }));
    } finally {
      value.database.close();
    }
  });

  it("projects bounded management options, recovery metadata, and availability", () => {
    const value = fixture();
    try {
      const service = value.service();
      const options = service.options(value.scope);
      const optionIds = options.groups.flatMap(({ tools }) =>
        tools.map(({ id }) => id),
      );
      expect(new Set(optionIds)).toEqual(
        value.repository.eligibility.eligibleToolIds,
      );
      expect(optionIds).toHaveLength(33);
      expect(optionIds).not.toContain("agent.context");
      expect(options.environments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: value.environment.id, available: true }),
        ]),
      );

      const requestId = randomUUID();
      const first = service.createForManagement(value.scope, {
        requestId,
        name: "First client",
        toolIds: ["thread.status"],
        defaultEnvironmentId: value.environment.id,
        allowedEnvironmentIds: [value.environment.id],
        defaultWorkspaceId: value.workspace.id,
        defaultThreadId: value.thread.id,
      });
      value.setClock(1_001);
      const second = service.createForManagement(value.scope, {
        requestId: randomUUID(),
        name: "Second client",
        toolIds: ["workspace.list"],
        defaultEnvironmentId: value.environment.id,
        allowedEnvironmentIds: [value.environment.id],
      });
      expect(first.credential).toMatch(/^hatc1_/u);
      expect(first.client).not.toHaveProperty("tenantId");
      expect(first.client).not.toHaveProperty("credentialVerifier");
      expect(
        service.list(value.scope, { pageSize: 50, creationRequestId: requestId }),
      ).toEqual({ items: [first.client] });
      const page = service.list(value.scope, { pageSize: 1 });
      expect(page.items).toEqual([second.client]);
      expect(page.nextCursor).toBeDefined();
      expect(
        service.list(value.scope, { pageSize: 1, cursor: page.nextCursor }),
      ).toMatchObject({ items: [first.client] });

      expect(() =>
        service.createForManagement(value.scope, {
          requestId,
          name: "Replay",
          toolIds: ["thread.status"],
          defaultEnvironmentId: value.environment.id,
          allowedEnvironmentIds: [value.environment.id],
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "conflict",
          client: first.client,
        }),
      );

      value.database
        .prepare(
          `UPDATE execution_environments
           SET availability = 'unavailable',
             diagnostic_code = 'ssh_environment_not_validated'
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(value.scope.tenantId, value.scope.principalId, value.environment.id);
      expect(service.options(value.scope).environments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: value.environment.id, available: true }),
        ]),
      );
      expect(service.get(value.scope, first.client.id)).toMatchObject({
        availability: "available",
        environments: [{ id: value.environment.id, available: true }],
      });
      expect(() =>
        service.admitInvocation(first.credential, {
          ...statusRequest,
          input: { threadId: value.thread.id },
        }),
      ).not.toThrow();

      value.database
        .prepare(
          `UPDATE execution_environments
           SET diagnostic_code = 'sidecar_session_failed'
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(value.scope.tenantId, value.scope.principalId, value.environment.id);
      expect(service.get(value.scope, first.client.id)).toMatchObject({
        availability: "needs_attention",
        environments: [{ id: value.environment.id, available: false }],
        defaultWorkspaceAvailable: true,
        defaultThreadAvailable: true,
      });
    } finally {
      value.database.close();
    }
  });

  it("coalesces last-used writes without advancing policy revision", () => {
    const value = fixture();
    try {
      const created = createClient(value);
      value.service().catalogSummaries(created.credential);
      expect(value.repository.get(value.scope, created.client.id)).toMatchObject({
        policyRevision: 1,
        lastUsedAt: 1_000,
      });
      value.setClock(1_050);
      value.service().catalogSummaries(created.credential);
      expect(value.repository.get(value.scope, created.client.id)).toMatchObject({
        policyRevision: 1,
        lastUsedAt: 1_000,
      });
      value.setClock(61_001);
      value.service().catalogSummaries(created.credential);
      expect(value.repository.get(value.scope, created.client.id)).toMatchObject({
        policyRevision: 1,
        lastUsedAt: 61_001,
      });
    } finally {
      value.database.close();
    }
  });

  it("returns indistinguishable authentication failures", () => {
    const value = fixture();
    try {
      const created = createClient(value);
      const rotated = value
        .service()
        .rotate(value.scope, created.client.id, created.client.policyRevision);
      const candidates = [
        "not-a-credential",
        corrupted(rotated.credential),
        created.credential,
      ];
      for (const credential of candidates) {
        expect(() => value.service().catalogSummaries(credential)).toThrowError(
          expect.objectContaining({
            code: "unauthenticated",
            message: "The tool client credential is invalid.",
          }),
        );
      }
    } finally {
      value.database.close();
    }
  });

  it.each(["edit", "disable", "rotate", "revoke"] as const)(
    "denies an admission when %s commits before its transaction",
    (mutation) => {
      const value = fixture();
      try {
        const created = createClient(value);
        const beforeService = value.service(keyA, {
          beforeTransaction: () => {
            if (mutation === "edit") {
              value.service().replace(
                value.scope,
                created.client.id,
                replacement(created.client, { toolIds: ["environment.list"] }),
              );
            } else if (mutation === "disable") {
              value.service().replace(
                value.scope,
                created.client.id,
                replacement(created.client, { enabled: false }),
              );
            } else if (mutation === "rotate") {
              value
                .service()
                .rotate(
                  value.scope,
                  created.client.id,
                  created.client.policyRevision,
                );
            } else {
              value
                .service()
                .revoke(
                  value.scope,
                  created.client.id,
                  created.client.policyRevision,
                );
            }
          },
        });
        expect(() =>
          beforeService.admitInvocation(created.credential, {
            ...statusRequest,
            input: { threadId: value.thread.id },
          }),
        ).toThrowError(
          expect.objectContaining({
            code: mutation === "edit" ? "not_found" : "unauthenticated",
          }),
        );
      } finally {
        value.database.close();
      }
    },
  );

  it.each(["edit", "disable", "rotate", "revoke"] as const)(
    "preserves an immutable admission when %s serializes after its commit",
    (mutation) => {
      const value = fixture();
      try {
        const created = createClient(value);
        let committedRevision: number | undefined;
        const afterService = value.service(keyA, {
          afterCommit: (authority) => {
            committedRevision = authority.policyIdentity.revision;
            if (mutation === "edit") {
              value.service().replace(
                value.scope,
                created.client.id,
                replacement(created.client, { toolIds: ["environment.list"] }),
              );
            } else if (mutation === "disable") {
              value.service().replace(
                value.scope,
                created.client.id,
                replacement(created.client, { enabled: false }),
              );
            } else if (mutation === "rotate") {
              value
                .service()
                .rotate(
                  value.scope,
                  created.client.id,
                  created.client.policyRevision,
                );
            } else {
              value
                .service()
                .revoke(
                  value.scope,
                  created.client.id,
                  created.client.policyRevision,
                );
            }
          },
        });
        const admitted = afterService.admitInvocation(created.credential, {
          ...statusRequest,
          input: { threadId: value.thread.id },
        });
        expect(admitted.authority).toMatchObject({
          subject: {
            kind: "principal_client",
            clientId: created.client.id,
            credentialGeneration: 1,
          },
          policyIdentity: {
            revision: committedRevision,
            credentialGeneration: 1,
          },
        });
        expect(
          value.repository.get(value.scope, created.client.id).policyRevision,
        ).toBe(2);
      } finally {
        value.database.close();
      }
    },
  );

  it("uses compare-and-swap across edit, rotation, and revocation", () => {
    const value = fixture();
    try {
      const created = createClient(value);
      const edited = value.service().replace(
        value.scope,
        created.client.id,
        replacement(created.client, { toolIds: ["environment.list"] }),
      );
      expect(edited.policyRevision).toBe(2);
      expect(() =>
        value
          .service()
          .rotate(
            value.scope,
            created.client.id,
            created.client.policyRevision,
          ),
      ).toThrowError(expect.objectContaining({ code: "conflict" }));
      expect(() =>
        value
          .service()
          .revoke(
            value.scope,
            created.client.id,
            created.client.policyRevision,
          ),
      ).toThrowError(expect.objectContaining({ code: "conflict" }));
      const rotated = value
        .service()
        .rotate(value.scope, created.client.id, edited.policyRevision);
      expect(rotated.client.policyRevision).toBe(3);
      expect(() =>
        value.service().replace(
          value.scope,
          created.client.id,
          replacement(edited, { toolIds: ["workspace.list"] }),
        ),
      ).toThrowError(expect.objectContaining({ code: "conflict" }));
    } finally {
      value.database.close();
    }
  });

  it("rejects unavailable defaults and exposes bounded deletion blockers", () => {
    const value = fixture();
    try {
      const created = createClient(value);
      expect(
        value.repository.blockerNamesForEnvironments(value.scope, [
          value.environment.id,
        ]),
      ).toEqual([created.client.name]);
      expect(
        value.repository.blockerNamesForWorkspace(
          value.scope,
          value.workspace.id,
        ),
      ).toEqual([created.client.name]);
      expect(
        value.repository.blockerNamesForThread(value.scope, value.thread.id),
      ).toEqual([created.client.name]);
      value.database
        .prepare(
          `UPDATE execution_environments SET availability = 'unavailable'
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(value.scope.tenantId, value.scope.principalId, value.environment.id);
      expect(() =>
        value.service().admitInvocation(created.credential, {
          ...statusRequest,
          input: { threadId: value.thread.id },
        }),
      ).toThrowError(expect.objectContaining({ code: "not_found" }));
    } finally {
      value.database.close();
    }
  });

  it("checks stale workspace and thread defaults only when an invocation consumes them", () => {
    const value = fixture();
    try {
      const alternateWorkspace = new InventoryRepository(
        value.database,
      ).upsertWorkspace(value.scope, {
        environmentId: value.environment.id,
        canonicalPath: "/tmp/principal-agent-tool-client-alternate",
        displayName: "Alternate principal client",
        available: true,
        trustState: "trusted",
        environmentConfigurationRevision:
          value.environment.configurationRevision,
        now: 130,
      });
      const alternateThread = new ConversationBindingRepository(
        value.database,
      ).createUnboundThread(value.scope, {
        workspaceId: alternateWorkspace.id,
        connectionProfileId: value.connectionProfileId,
        title: "Alternate client thread",
        now: 140,
      });
      const created = createClient(value, {
        toolIds: ["thread.status", "thread.list", "automation.get"],
      });
      value.database
        .prepare(
          `UPDATE thread_principal_state SET inventory_state = 'archived'
           WHERE tenant_id = ? AND principal_id = ? AND thread_id = ?`,
        )
        .run(value.scope.tenantId, value.scope.principalId, value.thread.id);
      value.database
        .prepare(
          `UPDATE workspaces SET availability = 'unavailable'
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(value.scope.tenantId, value.scope.principalId, value.workspace.id);

      expect(() =>
        value.service().admitInvocation(created.credential, {
          ...statusRequest,
          input: { threadId: alternateThread.id },
        }),
      ).not.toThrow();
      expect(() =>
        value.service().admitInvocation(created.credential, {
          toolId: "thread.list",
          schemaVersion: 5,
          requestId: "principal-client-default-workspace",
          input: { scope: { kind: "default_workspace" } },
        }),
      ).toThrowError(expect.objectContaining({ code: "not_found" }));
      expect(() =>
        value.service().admitInvocation(created.credential, {
          toolId: "automation.get",
          schemaVersion: 1,
          requestId: "principal-client-default-thread",
          input: {},
        }),
      ).toThrowError(expect.objectContaining({ code: "not_found" }));
    } finally {
      value.database.close();
    }
  });

  it("retains a removed environment while invalidating its admission authority", () => {
    const value = fixture();
    try {
      const created = createClient(value, { name: "Remote build CLI", allowedEnvironmentIds: [value.environment.id, remoteEnvironmentId] });
      const repository = new ConfigurationRepository(value.database);
      const projection = new ConfigurationProjection(value.database, {
        pi: compiledBackendModuleCatalog.protocolReleaseForBackendKind("pi"), codex_app_server: "unused", claude_agent_sdk: "unused", grok_build: "unused",
      });
      const snapshot = repository.get(value.scope);
      repository.save(value.scope, { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration: snapshot.configuration }, document => projection.project(value.scope, document));
      expect(value.database.prepare(`SELECT id, availability, diagnostic_code AS diagnosticCode FROM execution_environments
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`).get(value.scope.tenantId, value.scope.principalId, remoteEnvironmentId))
        .toEqual({ id: remoteEnvironmentId, availability: "unavailable", diagnosticCode: "configuration_removed" });
      expect(() => value.service().revoke(value.scope, created.client.id, created.client.policyRevision)).not.toThrow();
    } finally { value.database.close(); }
  });
});
