import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationSnapshotPublicationBoundary } from "../../src/server/application/application-snapshot-service.js";
import { DatabaseAgentToolApplicationReader } from "../../src/server/agent-tools/application/database-agent-tool-application-reader.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import { SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER } from "../../src/server/agent-tools/http/agent-tool-http-contracts.js";
import { PolicyCheckedAgentToolHttpService } from "../../src/server/agent-tools/http/agent-tool-http-service.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import type { ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { initializeDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import type { AppConfig } from "../../src/server/config/config.js";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { openOverlayDatabaseConnection } from "../../src/server/db/database.js";
import { deriveConnectionProfileId } from "../../src/server/db/connection-profile-id.js";
import { initializeEmptyBackendNormalizedDatabase } from "../../src/server/db/migrate.js";
import { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ScopedApplicationEventHubs } from "../../src/server/events/application-event-hub.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import {
  createNormalizedApp,
  type NormalizedAppDependencies,
} from "../../src/server/normalized-app.js";

const roots: string[] = [];
const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const liveGate = "SEDES_RUN_REAL_CODEX_AGENT_TOOLS";
function configuration(workspace: string): ConfigurationDocument {
  return {
    executionEnvironments: [{
      id: environmentId,
      kind: "local",
      label: "Local",
      workspaceRoots: [workspace],
      workspaceIsolation: {
        kind: "bubblewrap",
        networkProfiles: ["isolated", "execution_host"],
      },
    }],
    backends: [
      {
        id: "codex-primary",
        kind: "codex_app_server",
        label: "Codex",
        enabled: true,
        modelPolicy: { type: "catalog" },
        moduleConfiguration: {
          connection: {
            ownership: "owned",
            channel: { type: "process_stdio", workingDirectory: workspace },
          },
          policy: {
            allowedSandboxModes: ["workspace-write"],
            allowedNetworkAccess: ["enabled"],
            allowedApprovalPolicies: ["never"],
            allowedApprovalReviewers: ["user"],
          },
        },
      },
    ],
    targets: [
      {
        id: "codex-local",
        kind: "codex_app_server",
        label: "Codex",
        backendInstanceId: "codex-primary",
        executionEnvironmentId: environmentId,
        enabled: true,
        moduleConfiguration: {
          defaults: {
            sandboxMode: "workspace-write",
            networkAccess: "enabled",
            approvalPolicy: "never",
            approvalReviewer: "user",
            model: { type: "fixed", modelId: "gpt-5.6-luna" },
          },
        },
      },
    ],
    defaultTargetId: "codex-local",
    webSearch: null,
  };
}

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
    throw new Error("real_codex_agent_tool_listener_invalid");
  }
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function parseJsonLines(output: string): unknown[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function startedShellCommands(events: readonly unknown[]): string[] {
  return events.flatMap((event) => {
    if (!event || typeof event !== "object") return [];
    const record = event as Record<string, unknown>;
    if (record.type !== "item.started") return [];
    const item = record.item;
    if (!item || typeof item !== "object") return [];
    const itemRecord = item as Record<string, unknown>;
    return itemRecord.type === "command_execution" &&
      typeof itemRecord.command === "string"
      ? [itemRecord.command]
      : [];
  });
}

function unwrappedSedesCommands(events: readonly unknown[]): string[] {
  return startedShellCommands(events).flatMap((command) => {
    const prefix = ["/bin/bash -lc ", "/bin/bash -c "].find((candidate) =>
      command.startsWith(candidate),
    );
    if (!prefix) return [command];
    const shellInput = command.slice(prefix.length);
    const quote = shellInput[0];
    if ((quote !== "'" && quote !== '"') || shellInput.at(-1) !== quote) {
      return [command];
    }
    return shellInput.slice(1, -1).split(" && ");
  });
}

async function runCodex(input: {
  readonly executable: string;
  readonly arguments_: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly stdin: string;
  readonly timeoutMilliseconds: number;
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.arguments_, {
      cwd: input.cwd,
      env: input.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, input.timeoutMilliseconds);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (timedOut) {
        reject(
          new Error(
            `real_codex_agent_tools_timed_out: ${result.stderr.trim()}`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `real_codex_agent_tools_failed (${String(code)}, ${String(signal)}): stderr=${result.stderr.trim()} stdout=${result.stdout.trim()}`,
          ),
        );
        return;
      }
      resolve(result);
    });
    child.stdin.end(input.stdin);
  });
}

describe("real Codex Sedes CLI skill", () => {
  const run = process.env[liveGate] === "1" ? it : it.skip;

  run(
    "discovers the repository skill and uses the built CLI against its associated source thread",
    async () => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "sedes-real-codex-agent-tools-"),
      );
      roots.push(root);
      const workspace = path.join(root, "workspace");
      const binDirectory = path.join(root, "bin");
      const skillDirectory = path.join(
        workspace,
        ".agents",
        "skills",
        "sedes-cli-progressive-tools",
      );
      await mkdir(binDirectory, { recursive: true });
      await mkdir(path.dirname(skillDirectory), { recursive: true });
      await cp(
        path.resolve("skills/sedes-cli-progressive-tools"),
        skillDirectory,
        {
          recursive: true,
        },
      );
      await symlink(
        path.resolve("dist/cli/provider-bin/sedes"),
        path.join(binDirectory, "sedes"),
      );

      const outputSchemaPath = path.join(root, "proof.schema.json");
      const outputPath = path.join(root, "proof.json");
      await writeFile(
        outputSchemaPath,
        JSON.stringify({
          type: "object",
          additionalProperties: false,
          required: ["usedSkill", "sequence", "source"],
          properties: {
            usedSkill: { type: "string", const: "sedes-cli-progressive-tools" },
            sequence: {
              type: "array",
              minItems: 3,
              maxItems: 3,
              items: {
                type: "string",
                enum: [
                  "list",
                  "describe:agent.context",
                  "invoke:agent.context",
                ],
              },
            },
            source: {
              type: "object",
              additionalProperties: false,
              required: ["threadId", "workspaceId", "backend"],
              properties: {
                threadId: { type: "string" },
                workspaceId: { type: "string" },
                backend: { type: "string", const: "codex_app_server" },
              },
            },
          },
        }),
      );

      const database = openOverlayDatabaseConnection(
        path.join(root, "state", "overlay.sqlite"),
      );
      let server: Server | undefined;
      try {
        initializeEmptyBackendNormalizedDatabase(database);
        initializeDatabaseConfigurationFixture(
          database,
          configuration(workspace),
          { sourceLabel: "real-codex-cli-fixture", now: 100 },
        );
        const identity = new SingleUserIdentityProvider<Request>(database);
        const scope = identity.getScope();
        const inventory = new InventoryRepository(database);
        const environment = inventory.updateEnvironmentAvailability(
          scope,
          environmentId,
          { available: true, now: 110 },
        );
        const rememberedWorkspace = inventory.upsertWorkspace(scope, {
          environmentId,
          canonicalPath: workspace,
          displayName: "Real Codex agent-tool workspace",
          available: true,
          trustState: "trusted",
          environmentConfigurationRevision: environment.configurationRevision,
          now: 120,
        });
        const source = new ConversationBindingRepository(
          database,
        ).createUnboundThread(scope, {
          workspaceId: rememberedWorkspace.id,
          connectionProfileId: deriveConnectionProfileId(
            scope.tenantId,
            scope.principalId,
            "codex-local",
          ),
          title: "Real Codex CLI source",
          now: 300,
        });
        const sources = new DatabaseAgentToolSourceAuthority(
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
          sources,
        );
        const policyDependencies = createThreadAgentToolPolicyDependencies();
        const policies = new ThreadAgentToolPolicyRepository(
          database,
          policyDependencies.eligibility,
        );
        policies.update(scope, source.id, {
          expectedRevision: 0,
          enabled: true,
          presentation: { surface: "cli", mode: "progressive" },
          accessBoundary: "environment",
          enabledToolIds: ["agent.context", "thread.status"],
          now: 300,
        });
        const canonical = new CanonicalInlineAgentToolService({
          application,
          invocationId: () => "real-codex-cli-skill-invocation",
        });
        const scopedTools = new SourceScopedAgentToolService(
          canonical,
          policies,
          new AgentToolEnvironmentAuthorityResolver(sources),
          sources,
          {
            acquireAgentToolApprovalAuthority: async () => ({
              generation: "generation-1",
              signal: new AbortController().signal,
              isCurrent: () => true,
              release: () => undefined,
            }),
          },
          { requestApplicationDecision: async () => "allow" },
        );
        const sourceReference = sources.issue(
          sources.resolveInScope(
            scope,
            source.id,
            new AbortController().signal,
          ),
          "management_http",
          "cli",
        );
        const agentTools = {
          sources: application,
          tools: new PolicyCheckedAgentToolHttpService(scopedTools),
        };
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
          csrfToken: "real-codex-agent-tool-csrf",
          identity,
          applicationSnapshots,
          agentTools,
        } as unknown as NormalizedAppDependencies);
        const observed: Array<{
          readonly method: string;
          readonly url: string;
          readonly sourceReference: string | undefined;
        }> = [];
        server = createServer((request, response) => {
          if (request.url?.startsWith("/api/agent-tool")) {
            observed.push({
              method: request.method ?? "",
              url: request.url,
              sourceReference: request.headers[
                SEDES_AGENT_TOOL_SOURCE_CAPABILITY_HEADER.toLowerCase()
              ] as string | undefined,
            });
          }
          app(request, response);
        });
        const port = await listen(server);

        const codexExecutable = path.resolve("node_modules/.bin/codex");
        const prompt = [
          "Use $sedes-cli-progressive-tools and follow that skill exactly.",
          "Use only the sedes executable; do not run any unrelated shell command.",
          "First run `sedes tool list --json`.",
          "Then run `sedes tool describe agent.context --json`.",
          "Then run `sedes tool invoke agent.context --input-json '{}' --json`.",
          "Return the required JSON proof using the actual invocation result.",
        ].join("\n");
        const execution = await runCodex({
          executable: codexExecutable,
          arguments_: [
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--skip-git-repo-check",
            "--json",
            "--output-schema",
            outputSchemaPath,
            "--output-last-message",
            outputPath,
            "--model",
            "gpt-5.6-luna",
            "--sandbox",
            "workspace-write",
            "--config",
            'model_reasoning_effort="low"',
            "--config",
            "sandbox_workspace_write.network_access=true",
            "--config",
            'approval_policy="never"',
            "--cd",
            workspace,
            "-",
          ],
          cwd: workspace,
          environment: {
            ...process.env,
            PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
            SEDES_AGENT_TOOL_ENDPOINT: `http://127.0.0.1:${port}`,
            SEDES_AGENT_TOOL_SOURCE_CAPABILITY: sourceReference,
            SEDES_AGENT_TOOL_CLI_MODE: "progressive",
          },
          stdin: prompt,
          timeoutMilliseconds: 340_000,
        });

        expect(execution.stderr).toBe("");
        const events = parseJsonLines(execution.stdout);
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
          if (!event || typeof event !== "object") continue;
          const record = event as Record<string, unknown>;
          if (record.type !== "item.completed") continue;
          const item = record.item as Record<string, unknown> | undefined;
          if (item?.type !== "command_execution") continue;
          const output = String(item.aggregated_output ?? "").replaceAll(
            sourceReference,
            "[source capability redacted]",
          );
          expect(item.exit_code, output).toBe(0);
        }
        expect(unwrappedSedesCommands(events)).toEqual([
          "sedes tool list --json",
          "sedes tool describe agent.context --json",
          "sedes tool invoke agent.context --input-json '{}' --json",
        ]);
        const proof = JSON.parse(await readFile(outputPath, "utf8"));
        expect(proof).toEqual({
          usedSkill: "sedes-cli-progressive-tools",
          sequence: ["list", "describe:agent.context", "invoke:agent.context"],
          source: {
            threadId: source.id,
            workspaceId: rememberedWorkspace.id,
            backend: "codex_app_server",
          },
        });
        expect(observed).toEqual([
          {
            method: "GET",
            url: "/api/agent-tools",
            sourceReference,
          },
          {
            method: "POST",
            url: "/api/agent-tool-descriptions",
            sourceReference,
          },
          {
            method: "POST",
            url: "/api/agent-tool-descriptions",
            sourceReference,
          },
          {
            method: "GET",
            url: "/api/agent-tool-csrf",
            sourceReference: undefined,
          },
          {
            method: "POST",
            url: "/api/agent-tool-invocations",
            sourceReference,
          },
        ]);
      } finally {
        if (server?.listening) await close(server);
        database.close();
      }
    },
    420_000,
  );
});
