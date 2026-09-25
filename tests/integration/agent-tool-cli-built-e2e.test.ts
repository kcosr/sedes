import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationSnapshotPublicationBoundary } from "../../src/server/application/application-snapshot-service.js";
import { WorkspaceApplicationService } from "../../src/server/application/workspace-application-service.js";
import { DatabaseApplicationThreadSummaryReader } from "../../src/server/application/database-application-summary-reader.js";
import { AgentManagementService } from "../../src/server/agent-tools/application/agent-management-service.js";
import { DatabaseAgentToolApplicationReader } from "../../src/server/agent-tools/application/database-agent-tool-application-reader.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { PrincipalAgentToolClientService } from "../../src/server/agent-tools/application/principal-agent-tool-client-service.js";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import { SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER } from "../../src/server/agent-tools/http/agent-tool-http-contracts.js";
import { PolicyCheckedAgentToolHttpService } from "../../src/server/agent-tools/http/agent-tool-http-service.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { AutomationAgentToolService } from "../../src/server/agent-tools/tools/automation-agent-tool-service.js";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import type { AppConfig } from "../../src/server/config/config.js";
import {
  createPrincipalAgentToolClientEligibility,
  createThreadAgentToolPolicyDependencies,
} from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { openOverlayDatabaseConnection } from "../../src/server/db/database.js";
import {
  applyBackendNormalizationMigration,
  applyDatabaseMigrations,
  backendNormalizedMigrations,
  deployedMigrations,
} from "../../src/server/db/migrate.js";
import { AutomationRepository } from "../../src/server/db/repositories/automation-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { PrincipalAgentToolClientRepository } from "../../src/server/db/repositories/principal-agent-tool-client-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { TaskRepository } from "../../src/server/db/repositories/task-repository.js";
import { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { AutomationService } from "../../src/server/domain/automation-service.js";
import { TaskService } from "../../src/server/domain/task-service.js";
import { ScopedApplicationEventHubs } from "../../src/server/events/application-event-hub.js";
import { LocalExecutionEnvironment } from "../../src/server/execution/local-execution-environment.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import {
  createNormalizedApp,
  type NormalizedAppDependencies,
} from "../../src/server/normalized-app.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const fullToolCatalog = [
  "agent.context",
  "environment.list",
  "workspace.list",
  "workspace.open",
  "thread.status",
  "thread.list",
  "thread.create",
  "saved_agent.list",
  "saved_agent.get",
  "saved_agent.options",
  "saved_agent.create",
  "saved_agent.update",
  "saved_agent.delete",
  "task.list",
  "task.get",
  "task.create",
  "task.update",
  "automation.get",
  "automation.runs",
  "automation.create",
  "automation.update",
  "automation.set_state",
  "automation.run_now",
] as const;
const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("agent_tool_cli_test_listener_invalid");
  }
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function requestJson(input: {
  readonly port: number;
  readonly host: string;
  readonly origin?: string;
  readonly sourceCapability: string;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: input.port,
        path: "/api/agent-tools",
        method: "GET",
        headers: {
          Host: input.host,
          ...(input.origin ? { Origin: input.origin } : {}),
          [SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER]: input.sourceCapability,
          Accept: "application/json",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function buildSedesToolExecutable(): Promise<string> {
  // Compile into an isolated directory so this test exercises the generated
  // executable without requiring (or mutating) the repository's dist tree.
  // Keeping the directory below the repository also preserves normal Node
  // package resolution for the emitted CLI's runtime dependencies.
  const buildRoot = await mkdtemp(path.resolve(".agent-tool-cli-test-build-"));
  roots.push(buildRoot);
  const outputRoot = path.join(buildRoot, "output");
  const compilerConfiguration = path.join(buildRoot, "tsconfig.json");
  await writeFile(
    compilerConfiguration,
    JSON.stringify({
      extends: path.resolve("tsconfig.server.json"),
      compilerOptions: { outDir: outputRoot },
      include: [],
      files: [path.resolve("src/cli/provider-bin/sedes.ts")],
    }),
    "utf8",
  );
  await execFileAsync(
    process.execPath,
    [
      path.resolve("node_modules/typescript/bin/tsc"),
      "--project",
      compilerConfiguration,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  const compiledExecutable = path.join(
    outputRoot,
    "cli",
    "provider-bin",
    "sedes.js",
  );
  const generatedExecutable = path.join(
    outputRoot,
    "cli",
    "provider-bin",
    "sedes",
  );
  await copyFile(compiledExecutable, generatedExecutable);
  await chmod(generatedExecutable, 0o755);
  return generatedExecutable;
}

describe("built Sedes agent-tool CLI", () => {
  it("uses the real normalized listener, scoped SQLite policy, and generated executable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-tool-cli-e2e-"));
    roots.push(root);
    const binDirectory = path.join(root, "bin");
    await mkdir(binDirectory);
    const builtExecutable = await buildSedesToolExecutable();
    await symlink(builtExecutable, path.join(binDirectory, "sedes"));

    const database = openOverlayDatabaseConnection(
      path.join(root, "state", "overlay.sqlite"),
    );
    let server: Server | undefined;
    let workspaceExecution: LocalExecutionEnvironment | undefined;
    try {
      applyDatabaseMigrations(database, deployedMigrations);
      const identity = new SingleUserIdentityProvider<Request>(database);
      const scope = identity.getScope();
      const legacy = new ThreadInventoryService(
        new OverlayRepository(database),
      );
      const environment = legacy.getLocalEnvironment(scope);
      const workspace = legacy.rememberWorkspace(
        scope,
        {
          environmentId: environment.id,
          canonicalPath: path.join(root, "workspace"),
          displayName: "CLI test workspace",
          availability: "available",
          trustState: "trusted",
        },
        100,
      );
      const source = legacy.createThread(
        scope,
        { workspaceId: workspace.id, title: "CLI source" },
        110,
      );
      const otherSource = legacy.createThread(
        scope,
        { workspaceId: workspace.id, title: "Other CLI source" },
        120,
      );
      applyBackendNormalizationMigration(database, {
        configuration,
        quiescentCutoverConfirmed: true,
        appliedAt: 200,
      });
      applyDatabaseMigrations(database, backendNormalizedMigrations);

      const sourceAuthority = new DatabaseAgentToolSourceAuthority(
        database,
        new Uint8Array(32).fill(7),
      );
      const application = new DatabaseAgentToolApplicationReader(
        database,
        identity,
        {
          snapshot: async () => ({
            thread: { inventoryState: "active", runState: "idle" },
          }),
        } as never,
        sourceAuthority,
      );
      const policyDependencies = createThreadAgentToolPolicyDependencies();
      const policies = new ThreadAgentToolPolicyRepository(
        database,
        policyDependencies.eligibility,
      );
      policies.update(scope, source.thread.id, {
        expectedRevision: 0,
        enabled: true,
        presentation: { surface: "cli", mode: "progressive" },
        accessBoundary: "environment",
        enabledToolIds: [...fullToolCatalog],
        now: 300,
      });
      const inventory = new InventoryRepository(database);
      const openedProjectPath = path.join(root, "opened-project");
      await mkdir(openedProjectPath);
      const environmentConfigurationRevision = inventory.getEnvironment(
        scope,
        environment.id,
      ).configurationRevision;
      workspaceExecution = new LocalExecutionEnvironment({
        environmentId: environment.id,
        scope,
        allowedRoots: [root],
        label: "Local",
        workspaceTrusted: () => true,
        configurationRevision: environmentConfigurationRevision,
        activeConfigurationRevision: () => environmentConfigurationRevision,
      });
      const workspaceManagement = new WorkspaceApplicationService({
        inventory,
        execution: workspaceExecution,
        publications: { handoffAuthoritativeReplacement: () => undefined },
        now: () => 350,
      });
      const threadSummaries = new DatabaseApplicationThreadSummaryReader({
        inventory,
        queue: new QueuedInputRepository(database),
        completion: new SubmissionCompletionRepository(database),
      });
      const taskRepository = new TaskRepository(database);
      const tasks = new TaskService(taskRepository, {
        publishTaskChange: async () => undefined,
      });
      const management = new AgentManagementService({
        database,
        inventory,
        threadSummaries,
        runtimes: { captureLoadedState: async () => undefined },
        workspaces: workspaceManagement,
        taskRepository,
        tasks,
      });
      const automationDomain = new AutomationService({
        repository: new AutomationRepository(database),
        inventory,
        publisher: { publish: async () => undefined },
        executionPolicy: { assertCanAutomate: () => undefined },
      });
      const automations = new AutomationAgentToolService({
        automations: automationDomain,
        threads: {} as never,
        inventory,
      });
      const canonical = new CanonicalInlineAgentToolService({
        application,
        management,
        automations,
        threadCreation: {} as never,
        savedAgents: {} as never,
        invocationId: () => "cli-e2e-invocation",
      });
      const principalClients = new PrincipalAgentToolClientService(
        new Uint8Array(32).fill(11),
        database,
        new PrincipalAgentToolClientRepository(
          database,
          createPrincipalAgentToolClientEligibility(),
        ),
        canonical,
        new AgentToolEnvironmentAuthorityResolver(sourceAuthority),
        () => 375,
        {},
        policyDependencies.catalog,
      );
      const principalClient = principalClients.create(scope, {
        requestId: "10000000-0000-4000-8000-000000000099",
        name: "Built external CLI",
        toolIds: ["workspace.list", "thread.status"],
        defaultEnvironmentId: environment.id,
        allowedEnvironmentIds: [environment.id],
        defaultWorkspaceId: workspace.id,
        defaultThreadId: source.thread.id,
      });
      const agentTools = {
        sources: application,
        clients: principalClients,
        tools: new PolicyCheckedAgentToolHttpService(
          new SourceScopedAgentToolService(
            canonical,
            policies,
            new AgentToolEnvironmentAuthorityResolver(sourceAuthority),
            sourceAuthority,
            {
              acquireAgentToolApprovalAuthority: async () => ({
                generation: "generation-1",
                signal: new AbortController().signal,
                isCurrent: () => true,
                release: () => undefined,
              }),
            },
            { requestApplicationDecision: async () => "allow" },
          ),
        ),
      };
      const trustedSource = sourceAuthority.resolveInScope(
        scope,
        source.thread.id,
        new AbortController().signal,
      );
      const trustedOtherSource = sourceAuthority.resolveInScope(
        scope,
        otherSource.thread.id,
        new AbortController().signal,
      );
      const sourceCapability = sourceAuthority.issue(
        trustedSource,
        "management_http",
        "cli",
      );
      const otherSourceCapability = sourceAuthority.issue(
        trustedOtherSource,
        "management_http",
        "cli",
      );
      const applicationSnapshots = new ApplicationSnapshotPublicationBoundary(
        {
          capture: async () => ({
            environments: [],
            workspaces: [],
            threads: [],
            forkOrigins: [],
            lineagePlacements: [],
            lineageFamilies: [],
            executionTargets: [],
            defaultNewThreadTargetId: null,
            counts: { active: 0, snoozed: 0, settled: 0, archived: 0 },
            tasks: [],
          }),
        } as never,
        new ScopedApplicationEventHubs(),
      );
      const config: AppConfig = {
        authenticationRequired: true,
        experimentalUsageEnabled: false,
        host: "127.0.0.1",
        port: 4784,
        stateDirectory: path.join(root, "state"),
        allowedTailscaleHosts: [],
        packagedClientOrigins: [],
        conversationRetentionMilliseconds: 600_000,
        conversationRuntimeBudget: 8,
      };
      const app = createNormalizedApp({
    workpads: {} as never,
        config,
        csrfToken: "cli-e2e-csrf",
        identity,
        applicationSnapshots,
        agentTools,
      } as unknown as NormalizedAppDependencies);
      server = createServer(app);
      const port = await listen(server);
      const baseEnvironment = {
        ...process.env,
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        SEDES_AGENT_TOOL_ENDPOINT: `http://127.0.0.1:${port}`,
        SEDES_AGENT_TOOL_SOURCE_CAPABILITY: sourceCapability,
      };
      const run = (
        arguments_: readonly string[],
        environment: NodeJS.ProcessEnv = baseEnvironment,
      ) =>
        execFileAsync("sedes", arguments_, {
          cwd: root,
          env: {
            ...environment,
            SEDES_AGENT_TOOL_CLI_MODE:
              arguments_[0] === "tool" ? "progressive" : "individual",
          },
          encoding: "utf8",
          timeout: 10_000,
        });
      const {
        SEDES_AGENT_TOOL_SOURCE_CAPABILITY: _sourceCapability,
        ...principalBaseEnvironment
      } = baseEnvironment;
      const principalEnvironment: NodeJS.ProcessEnv = {
        ...principalBaseEnvironment,
        SEDES_AGENT_TOOL_CLIENT_TOKEN: principalClient.credential,
      };

      const [
        checkedInCliProgressiveSkill,
        checkedInCliIndividualSkill,
        checkedInNativeProgressiveSkill,
        checkedInNativeIndividualSkill,
      ] = await Promise.all([
        readFile(
          path.resolve("skills/sedes-cli-progressive-tools/SKILL.md"),
          "utf8",
        ),
        readFile(
          path.resolve("skills/sedes-cli-individual-tools/SKILL.md"),
          "utf8",
        ),
        readFile(
          path.resolve("skills/sedes-native-progressive-tools/SKILL.md"),
          "utf8",
        ),
        readFile(
          path.resolve("skills/sedes-native-individual-tools/SKILL.md"),
          "utf8",
        ),
      ]);
      expect(checkedInCliProgressiveSkill).toContain("sedes tool list --json");
      expect(checkedInCliProgressiveSkill).toContain(
        "sedes tool describe TOOL_ID [TOOL_ID ...] --json",
      );
      expect(checkedInCliProgressiveSkill).toContain(
        "sedes tool invoke TOOL_ID --input-file INPUT.json --json",
      );
      expect(checkedInCliIndividualSkill).toContain("sedes --help");
      expect(checkedInCliIndividualSkill).toContain("sedes task create --help");
      expect(checkedInCliIndividualSkill).not.toContain("sedes tool list");
      expect(checkedInNativeProgressiveSkill).toContain(
        'Call `sedes_catalog` with `{ "action": "list" }`.',
      );
      expect(checkedInNativeProgressiveSkill).toContain("Never invoke Bash");
      expect(checkedInNativeProgressiveSkill).not.toContain(
        "sedes tool list --json",
      );
      expect(checkedInNativeIndividualSkill).toContain(
        "`sedes_catalog` is absent",
      );
      expect(checkedInNativeIndividualSkill).toContain("Bash");
      expect(checkedInNativeIndividualSkill).not.toContain(
        "sedes tool list --json",
      );

      const listed = JSON.parse((await run(["tool", "list", "--json"])).stdout);
      expect(listed.tools.map(({ id }: { id: string }) => id)).toEqual(
        fullToolCatalog,
      );
      expect(listed.tools[0]).not.toHaveProperty("inputSchema");
      expect(listed.tools[0]).not.toHaveProperty("adapters");

      const principalListed = await run(
        ["tool", "list", "--json"],
        principalEnvironment,
      );
      expect(
        JSON.parse(principalListed.stdout).tools.map(
          ({ id }: { id: string }) => id,
        ),
      ).toEqual(["workspace.list", "thread.status"]);
      expect(principalListed.stdout).not.toContain(principalClient.credential);
      expect(principalListed.stderr).not.toContain(principalClient.credential);
      const principalStatus = JSON.parse(
        (
          await run(
            ["thread", "status", "--thread-id", source.thread.id, "--json"],
            principalEnvironment,
          )
        ).stdout,
      );
      expect(principalStatus.threadId).toBe(source.thread.id);

      const described = JSON.parse(
        (
          await run([
            "tool",
            "describe",
            "thread.status",
            "workspace.list",
            "--json",
          ])
        ).stdout,
      );
      expect(described.tools.map(({ id }: { id: string }) => id)).toEqual([
        "thread.status",
        "workspace.list",
      ]);
      expect(described.tools[1]).toMatchObject({
        id: "workspace.list",
        schemaVersion: 4,
        execution: { waitCeilingMilliseconds: 30_000 },
      });

      const workspaces = JSON.parse(
        (
          await run([
            "tool",
            "invoke",
            "workspace.list",
            "--input-json",
            "{}",
            "--json",
          ])
        ).stdout,
      );
      expect(workspaces).toMatchObject({
        items: [
          {
            id: workspace.id,
            label: "CLI test workspace",
            availability: "available",
            lastOpenedAt: expect.any(String),
            environment: {
              id: environment.id,
              label: "Local",
            },
          },
        ],
      });

      const environments = JSON.parse(
        (
          await run([
            "tool",
            "invoke",
            "environment.list",
            "--input-json",
            "{}",
            "--json",
          ])
        ).stdout,
      );
      expect(environments).toMatchObject({
        items: [
          {
            id: environment.id,
            label: "Local",
            availability: "available",
          },
        ],
      });

      const openedWorkspace = JSON.parse(
        (
          await run([
            "tool",
            "invoke",
            "workspace.open",
            "--input-json",
            JSON.stringify({
              environmentId: environment.id,
              path: openedProjectPath,
            }),
            "--json",
          ])
        ).stdout,
      );
      expect(openedWorkspace).toMatchObject({
        environmentId: environment.id,
        label: "opened-project",
        availability: "available",
      });
      expect(openedWorkspace).not.toHaveProperty("path");
      expect(
        inventory.getWorkspace(scope, openedWorkspace.workspaceId),
      ).toMatchObject({
        environmentId: environment.id,
        canonicalPath: openedProjectPath,
      });
      const reopenedWorkspace = JSON.parse(
        (
          await run([
            "tool",
            "invoke",
            "workspace.open",
            "--input-json",
            JSON.stringify({
              environmentId: environment.id,
              path: openedProjectPath,
            }),
            "--json",
          ])
        ).stdout,
      );
      expect(reopenedWorkspace.workspaceId).toBe(openedWorkspace.workspaceId);

      const taskDetails =
        "Created through the named CLI with `agent-access`, $HOME, and $(literal).\nSecond line.";
      const taskDetailsPath = path.join(root, "task-details.md");
      await writeFile(taskDetailsPath, taskDetails, "utf8");
      const createdTask = JSON.parse(
        (
          await run([
            "task",
            "create",
            "--title",
            "Generated CLI task",
            "--details-file",
            taskDetailsPath,
            "--pinned",
            "true",
            "--files",
            path.join(root, "workspace", "README.md"),
            "--scope-kind",
            "workspace",
            "--json",
          ])
        ).stdout,
      );
      expect(createdTask).toMatchObject({
        title: "Generated CLI task",
        details: taskDetails,
        pinned: true,
        scope: { kind: "workspace", workspaceId: workspace.id },
        revision: 0,
      });
      const taskId = createdTask.id as string;

      const fetchedTask = JSON.parse(
        (await run(["task", "get", "--task-id", taskId, "--json"])).stdout,
      );
      expect(fetchedTask).toEqual(createdTask);

      const listedTasks = JSON.parse(
        (
          await run([
            "task",
            "list",
            "--scope-kind",
            "workspace",
            "--scope-mode",
            "exact",
            "--json",
          ])
        ).stdout,
      );
      expect(listedTasks).toMatchObject({
        page: {
          projection: "summary",
          items: [
            {
              id: taskId,
              title: "Generated CLI task",
              pinned: true,
              fileCount: 1,
              scope: { kind: "workspace", workspaceId: workspace.id },
            },
          ],
        },
      });

      const updatedTask = JSON.parse(
        (
          await run([
            "task",
            "update",
            "--task-id",
            taskId,
            "--expected-revision",
            String(createdTask.revision),
            "--completed",
            "true",
            "--json",
          ])
        ).stdout,
      );
      expect(updatedTask).toMatchObject({
        id: taskId,
        completedAt: expect.any(String),
        revision: 1,
      });

      const globalTask = JSON.parse(
        (
          await run([
            "tool",
            "invoke",
            "task.create",
            "--input-json",
            JSON.stringify({
              title: "Principal-wide CLI task",
              scope: { kind: "global" },
            }),
            "--json",
          ])
        ).stdout,
      );
      const globalTasks = JSON.parse(
        (
          await run([
            "tool",
            "invoke",
            "task.list",
            "--input-json",
            JSON.stringify({
              scope: { kind: "global" },
              scopeMode: "exact",
            }),
            "--json",
          ])
        ).stdout,
      );
      expect(globalTasks).toMatchObject({
        page: {
          projection: "summary",
          items: [
            {
              id: globalTask.id,
              title: "Principal-wide CLI task",
              associatedWorkspaceId: null,
              scope: { kind: "global" },
            },
          ],
        },
      });

      const status = JSON.parse(
        (
          await run([
            "thread",
            "status",
            "--thread-id",
            source.thread.id,
            "--json",
          ])
        ).stdout,
      );
      expect(status).toMatchObject({
        threadId: source.thread.id,
        backend: "pi",
        lifecycle: "active",
        activity: "idle",
      });

      const csrf = await fetchJson(
        `http://127.0.0.1:${port}/api/agent-tool-csrf`,
      );
      expect(csrf).toEqual({
        status: 200,
        body: { csrfToken: "cli-e2e-csrf" },
      });
      const automationRequest = {
        toolId: "automation.create",
        schemaVersion: 1,
        requestId: "direct-http-automation-create",
        input: {
          prompt: "Review the workspace",
          runMode: "same_thread",
          schedule: {
            kind: "date_time",
            runAt: "2099-08-09T00:00:00.000Z",
          },
        },
      };
      const missingCsrf = await fetchJson(
        `http://127.0.0.1:${port}/api/agent-tool-invocations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER]: sourceCapability,
          },
          body: JSON.stringify(automationRequest),
        },
      );
      expect(missingCsrf).toMatchObject({
        status: 403,
        body: { error: { code: "csrf_token_invalid" } },
      });
      const createdAutomation = await fetchJson(
        `http://127.0.0.1:${port}/api/agent-tool-invocations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": "cli-e2e-csrf",
            [SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER]: sourceCapability,
          },
          body: JSON.stringify(automationRequest),
        },
      );
      expect(createdAutomation).toMatchObject({
        status: 200,
        body: {
          state: "completed",
          output: {
            status: "paused",
            runMode: "same_thread",
            prompt: "Review the workspace",
            schedule: automationRequest.input.schedule,
            revision: 0,
          },
        },
      });
      const fetchedAutomation = await fetchJson(
        `http://127.0.0.1:${port}/api/agent-tool-invocations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": "cli-e2e-csrf",
            [SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER]: sourceCapability,
          },
          body: JSON.stringify({
            toolId: "automation.get",
            schemaVersion: 1,
            requestId: "direct-http-automation-get",
            input: {},
          }),
        },
      );
      expect(fetchedAutomation).toEqual({
        status: 200,
        body: createdAutomation.body,
      });

      const threadsWithAutomation = JSON.parse(
        (
          await run([
            "tool",
            "invoke",
            "thread.list",
            "--input-json",
            JSON.stringify({ hasAutomation: true }),
            "--json",
          ])
        ).stdout,
      );
      expect(threadsWithAutomation.items).toEqual([
        expect.objectContaining({ id: source.thread.id }),
      ]);

      const threadsWithoutAutomation = JSON.parse(
        (
          await run([
            "tool",
            "invoke",
            "thread.list",
            "--input-json",
            JSON.stringify({ hasAutomation: false }),
            "--json",
          ])
        ).stdout,
      );
      expect(threadsWithoutAutomation.items).toEqual([
        expect.objectContaining({ id: otherSource.thread.id }),
      ]);

      policies.update(scope, source.thread.id, {
        expectedRevision: 1,
        enabled: true,
        presentation: { surface: "cli", mode: "progressive" },
        accessBoundary: "environment",
        enabledToolIds: ["agent.context"],
        now: 400,
      });
      await expect(
        run([
          "tool",
          "invoke",
          "thread.status",
          "--input-json",
          JSON.stringify({ threadId: source.thread.id }),
          "--json",
        ]),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("not_found"),
      });

      policies.update(scope, source.thread.id, {
        expectedRevision: 2,
        enabled: false,
        presentation: { surface: "cli", mode: "progressive" },
        accessBoundary: "environment",
        enabledToolIds: ["agent.context"],
        now: 500,
      });
      const disabled = JSON.parse(
        (await run(["tool", "list", "--json"])).stdout,
      );
      expect(disabled.tools).toEqual([]);
      await expect(
        run([
          "tool",
          "invoke",
          "agent.context",
          "--input-json",
          "{}",
          "--json",
        ]),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("not_found"),
      });

      const wrongSource = JSON.parse(
        (
          await run(["tool", "list", "--json"], {
            ...baseEnvironment,
            SEDES_AGENT_TOOL_SOURCE_CAPABILITY: otherSourceCapability,
          })
        ).stdout,
      );
      expect(wrongSource.tools).toEqual([]);

      const rejectedHost = await requestJson({
        port,
        host: "attacker.example",
        sourceCapability,
      });
      expect(rejectedHost).toEqual({
        status: 403,
        body: {
          error: {
            code: "host_not_allowed",
            message: "This host is not allowed.",
            retryable: false,
          },
        },
      });
      const rejectedOrigin = await requestJson({
        port,
        host: `127.0.0.1:${port}`,
        origin: "https://attacker.example",
        sourceCapability,
      });
      expect(rejectedOrigin).toMatchObject({
        status: 403,
        body: { error: { code: "origin_not_allowed" } },
      });
    } finally {
      if (server?.listening) await close(server);
      workspaceExecution?.close();
      database.close();
    }
  }, 30_000);
});
