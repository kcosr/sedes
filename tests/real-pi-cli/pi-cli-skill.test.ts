import { randomUUID } from "node:crypto";
import { unavailableTurnBookmarks } from "../support/unavailable-turn-bookmarks.js";
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";
import { afterAll, describe, expect, it } from "vitest";
import type {
  BackendItem,
  BackendConversationEvent,
  SequencedBackendEvent,
} from "../../src/shared/protocol/backend.js";
import type { BoundedValue } from "../../src/shared/protocol/payload.js";
import { ApplicationSnapshotPublicationBoundary } from "../../src/server/application/application-snapshot-service.js";
import { DatabaseAgentToolApplicationReader } from "../../src/server/agent-tools/application/database-agent-tool-application-reader.js";
import { DatabaseAgentToolSourceAuthority } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import type { BackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { AgentToolEnvironmentAuthorityResolver } from "../../src/server/agent-tools/environment/environment-authority.js";
import { PolicyCheckedAgentToolHttpService } from "../../src/server/agent-tools/http/agent-tool-http-service.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import {
  PiConversationBackendDriver,
  type PiDriverOptions,
} from "../../src/server/backends/pi/pi-conversation-driver.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  ConversationBinding,
} from "../../src/server/backends/contracts.js";
import type { ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { initializeDatabaseConfigurationFixture } from "../support/database-configuration-fixture.js";
import type { AppConfig } from "../../src/server/config/config.js";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { openOverlayDatabaseConnection } from "../../src/server/db/database.js";
import { initializeEmptyBackendNormalizedDatabase } from "../../src/server/db/migrate.js";
import { deriveConnectionProfileId } from "../../src/server/db/connection-profile-id.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";
import { ScopedApplicationEventHubs } from "../../src/server/events/application-event-hub.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import {
  createNormalizedApp,
  type NormalizedAppDependencies,
} from "../../src/server/normalized-app.js";
import {
  PI_TOOL_APPROVAL_APPROVE_ACTION_ID,
  PI_TOOL_APPROVAL_DENY_ACTION_ID,
  PI_TOOL_APPROVAL_TITLE,
} from "../../src/server/backends/pi/pi-tool-access.js";
import { evaluateModelEligibility } from "../support/model-eligibility.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";

const requiredProvider = "xai";
const requiredModelId = "grok-4.5";
const requiredThinkingLevel = "low";
const timeoutMilliseconds = 240_000;
const describeRealPiCli =
  process.env.SEDES_RUN_REAL_PI_CLI === "1"
    ? describe.sequential
    : describe.skip;
const roots: string[] = [];
const toolProvenanceKey = new Uint8Array(32).fill(0x43);
const catalogModelPolicy = compileBackendModelPolicy(
  { type: "catalog" },
  "provider_model_effort",
);
const noAgentTools = {
  eligibleCatalog: () => [],
  catalogSummaries: () => [],
  describeMany: () => [],
  readPolicy: () => ({
    enabled: false,
    presentation: { surface: "native" as const, mode: "individual" as const },
    accessBoundary: "environment" as const,
    enabledToolIds: [],
  }),
  invoke: async () => {
    throw new Error("unexpected_agent_tool_invocation");
  },
} satisfies BackendAgentToolFacade;
const scope = {
  tenantId: "019196f7-a0a8-7bc4-a89b-8cf013978403",
  principalId: "019196f7-a0a8-7bc4-a89b-8cf013978404",
};
const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const instance: AgentBackendInstance = {
  id: "pi-primary",
  tenantId: scope.tenantId,
  kind: "pi",
  label: "Real Pi CLI",
  enabled: true,
  configurationRevision: 1,
  protocolRelease: "0.86.0",
};
const connection: AgentConnectionProfile = {
  id: deriveConnectionProfileId(scope.tenantId, scope.principalId, "pi-local"),
  tenantId: scope.tenantId,
  ownerPrincipalId: scope.principalId,
  templateId: "pi-local",
  kind: "pi_sdk",
  backendInstanceId: instance.id,
  executionEnvironmentId: environmentId,
  label: "Real Pi CLI",
  enabled: true,
  configurationRevision: 1,
};
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
        id: instance.id,
        kind: "pi",
        label: instance.label,
        enabled: true,
        modelPolicy: { type: "catalog" },
      },
    ],
    targets: [
      {
        id: connection.templateId,
        kind: "pi_sdk",
        label: connection.label,
        backendInstanceId: instance.id,
        executionEnvironmentId: environmentId,
        enabled: true,
      },
    ],
    defaultTargetId: connection.templateId,
    webSearch: null,
  };
}

afterAll(async () => {
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
    throw new Error("real_pi_cli_listener_invalid");
  }
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function waitFor(
  predicate: () => boolean,
  failure: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(failure);
}

function eventsOfType<T extends BackendConversationEvent["type"]>(
  events: readonly SequencedBackendEvent[],
  type: T,
): Array<Extract<BackendConversationEvent, { readonly type: T }>> {
  return events.flatMap(({ event }) =>
    event.type === type
      ? [event as Extract<BackendConversationEvent, { readonly type: T }>]
      : [],
  );
}

function boundedObject(
  value: BoundedValue | undefined,
): ReadonlyMap<string, BoundedValue> | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "object" ||
    value.truncation
  ) {
    return undefined;
  }
  const entries = new Map<string, BoundedValue>();
  for (const entry of value.entries) {
    if (entry.key.truncation || entries.has(entry.key.text)) return undefined;
    entries.set(entry.key.text, entry.value);
  }
  return entries;
}

function boundedObjectEntry(
  value: BoundedValue | undefined,
  key: string,
): BoundedValue | undefined {
  return boundedObject(value)?.get(key);
}

function boundedArray(
  value: BoundedValue | undefined,
): readonly BoundedValue[] | undefined {
  return value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "array" &&
    !value.truncation
    ? value.values
    : undefined;
}

function boundedText(value: BoundedValue | undefined): string | undefined {
  return value !== null &&
    typeof value === "object" &&
    "text" in value &&
    !value.truncation
    ? value.text
    : undefined;
}

function containsBoundedTruncation(value: BoundedValue | undefined): boolean {
  if (value === undefined || value === null || typeof value !== "object") {
    return false;
  }
  if ("text" in value) return value.truncation !== undefined;
  if (!("kind" in value)) return false;
  if (value.kind === "array") {
    return (
      value.truncation !== undefined ||
      value.values.some(containsBoundedTruncation)
    );
  }
  if (value.kind === "object") {
    return (
      value.truncation !== undefined ||
      value.entries.some(
        ({ key, value: entryValue }) =>
          key.truncation !== undefined || containsBoundedTruncation(entryValue),
      )
    );
  }
  return false;
}

interface CommandEvidence {
  readonly command: string;
  readonly output: string;
}

const executableSemanticKinds = new Set<BackendItem["semanticKind"]>([
  "command",
  "file_read",
  "file_change",
  "tool",
  "mcp",
  "web_search",
  "collaboration",
]);

function nativeCommandEvidence(
  items: readonly BackendItem[],
): readonly CommandEvidence[] | undefined {
  const commands = items.flatMap((item) =>
    item.semanticKind === "command" ? [item] : [],
  );
  if (commands.length === 0) return undefined;
  if (
    items.some(
      (item) =>
        executableSemanticKinds.has(item.semanticKind) &&
        item.semanticKind !== "command",
    )
  ) {
    throw new Error("real_pi_cli_mixed_or_extra_native_execution");
  }
  return commands.map((item) => {
    if (
      item.status !== "completed" ||
      item.phase !== "completed" ||
      item.command.truncation ||
      item.output === undefined ||
      item.output.truncation
    ) {
      throw new Error("real_pi_cli_incomplete_native_command_evidence");
    }
    return { command: item.command.text, output: item.output.text };
  });
}

function piFabricCommandEvidence(
  items: readonly BackendItem[],
): readonly CommandEvidence[] | undefined {
  const tools = items.flatMap((item) =>
    item.semanticKind === "tool" ? [item] : [],
  );
  if (tools.length === 0) return undefined;
  if (
    items.some(
      (item) =>
        executableSemanticKinds.has(item.semanticKind) &&
        item.semanticKind !== "tool",
    )
  ) {
    throw new Error("real_pi_cli_mixed_or_extra_fabric_execution");
  }

  return tools.flatMap((item) => {
    const result = item.result;
    const outerEvidence = {
      toolNameUntruncated: item.toolName.truncation === undefined,
      toolNameExact: item.toolName.text === "fabric_exec",
      titleUntruncated: item.title.truncation === undefined,
      titleExact: item.title.text === "fabric_exec",
      statusCompleted: item.status === "completed",
      phaseCompleted: item.phase === "completed",
      resultPresent: result !== undefined,
      resultNotError: result?.isError === false,
      resultEnvelopeUntruncated: result?.truncation === undefined,
      contentAllText:
        result !== undefined &&
        result.content.every((part) => part.kind === "text"),
      contentAllUntruncated:
        result !== undefined &&
        result.content.every(
          (part) => part.kind === "text" && part.value.truncation === undefined,
        ),
      detailsUntruncated:
        result !== undefined && !containsBoundedTruncation(result.details),
      detailsSuccessTrue:
        result !== undefined &&
        boundedObjectEntry(result.details, "success") === true,
    };
    if (Object.values(outerEvidence).some((satisfied) => !satisfied)) {
      throw new Error(
        `real_pi_cli_incomplete_fabric_execution:${JSON.stringify(outerEvidence)}`,
      );
    }
    const audits = boundedArray(boundedObjectEntry(result?.details, "audits"));
    if (audits === undefined || audits.length === 0) {
      throw new Error("real_pi_cli_missing_rich_fabric_audits");
    }
    return audits.map((audit) => {
      const argumentsValue = boundedObjectEntry(audit, "args");
      const result = boundedObjectEntry(audit, "result");
      const command = boundedText(
        boundedObjectEntry(argumentsValue, "command"),
      );
      const output = boundedText(boundedObjectEntry(result, "output"));
      if (
        boundedText(boundedObjectEntry(audit, "ref")) !== "pi.bash" ||
        boundedText(boundedObjectEntry(audit, "tool")) !== "bash" ||
        boundedText(boundedObjectEntry(audit, "provider")) !== "pi" ||
        boundedObjectEntry(audit, "success") !== true ||
        boundedObjectEntry(audit, "fromTrace") === true ||
        boundedObjectEntry(audit, "resultTruncated") !== false ||
        boundedObjectEntry(result, "ok") !== true ||
        command === undefined ||
        output === undefined
      ) {
        throw new Error("real_pi_cli_invalid_or_extra_fabric_audit");
      }
      return { command, output };
    });
  });
}

async function eligibleModel(
  options: PiDriverOptions,
  workspace: ValidatedWorkspace,
): Promise<{ readonly provider: string; readonly id: string }> {
  const driver = new PiConversationBackendDriver({
    ...options,
    agentTools: noAgentTools,
    agentToolCli: {
      availability: "unavailable",
      reason: "cli_unavailable",
    },
  });
  const catalog = await driver.catalog({ scope, workspace });
  const eligibility = await evaluateModelEligibility({
    catalog: catalog.models,
    requiredProvider,
    requiredModelId,
    requiredThinkingLevel,
    inspect: async (candidate) => {
      const applicationThreadId = `eligibility-${randomUUID()}`;
      const created = await driver.create({
        scope,
        workspace,
        applicationThreadId,
        applicationOperationId: `create-${applicationThreadId}`,
        source: { kind: "user" },
      });
      const handle = await driver.attach({
        scope,
        workspace,
        binding: {
          tenantId: scope.tenantId,
          ownerPrincipalId: scope.principalId,
          applicationThreadId,
          backendInstanceId: instance.id,
          connectionProfileId: connection.id,
          executionEnvironmentId: environmentId,
          backendConversationId: created.backendConversationId,
          createdAt: new Date().toISOString(),
        },
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      try {
        await handle.perform({
          applicationOperationId: `model-${applicationThreadId}`,
          action: "set_model",
          provider: candidate.provider,
          modelId: candidate.id,
        });
        await handle.perform({
          applicationOperationId: `thinking-${applicationThreadId}`,
          action: "set_thinking_level",
          level: requiredThinkingLevel,
        });
        await handle.perform({
          applicationOperationId: `tools-${applicationThreadId}`,
          action: "set_tool_access",
          mode: "read_only",
        });
        const projection = await handle.establishProjection({
          signal: new AbortController().signal,
        });
        if (projection.snapshot.orderedBackendTurnIds.length !== 0) {
          return { kind: "indeterminate" as const };
        }
        return {
          kind: "effective_state" as const,
          provider: candidate.provider,
          id: candidate.id,
          thinkingLevel: requiredThinkingLevel,
          additionalSafetyChecksPassed: true,
        };
      } catch {
        return { kind: "indeterminate" as const };
      } finally {
        await handle.close();
      }
    },
  });
  if (eligibility.eligible.length !== 1) {
    throw new Error(
      `REAL_PI_CLI_BLOCKER: expected exactly one authenticated ${requiredProvider}/${requiredModelId}/${requiredThinkingLevel} provider/model pair; found ${eligibility.eligible.length}.`,
    );
  }
  return eligibility.eligible[0]!;
}

describeRealPiCli("real Pi repository-skill CLI verification", () => {
  it("selects the checked-in skill and discovers, describes, and invokes through the built CLI", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-real-pi-cli-"));
    roots.push(root);
    const workspacePath = path.join(root, "workspace");
    const sessionDirectory = path.join(root, "sessions");
    const binDirectory = path.join(root, "bin");
    const stateDirectory = path.join(root, "state");
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(path.join(workspacePath, ".agents/skills"), { recursive: true }),
      mkdir(sessionDirectory, { recursive: true, mode: 0o700 }),
      mkdir(binDirectory, { recursive: true }),
      mkdir(stateDirectory, { recursive: true }),
    ]);
    await cp(
      path.resolve("skills/sedes-cli-progressive-tools"),
      path.join(workspacePath, ".agents/skills/sedes-cli-progressive-tools"),
      { recursive: true },
    );
    await symlink(
      path.resolve("dist/cli/provider-bin/sedes"),
      path.join(binDirectory, "sedes"),
    );

    const canonicalWorkspacePath = await realpath(workspacePath);
    const database = openOverlayDatabaseConnection(
      path.join(stateDirectory, "overlay.sqlite"),
    );
    let server: Server | undefined;
    try {
      initializeEmptyBackendNormalizedDatabase(database);
      initializeDatabaseConfigurationFixture(
        database,
        configuration(canonicalWorkspacePath),
        { sourceLabel: "real-pi-cli-fixture", now: 100 },
      );
      const identity = new SingleUserIdentityProvider<Request>(database);
      const resolvedScope = identity.getScope();
      expect(resolvedScope).toEqual(scope);
      const inventory = new InventoryRepository(database);
      const environment = inventory.updateEnvironmentAvailability(
        resolvedScope,
        environmentId,
        { available: true, now: 110 },
      );
      const rememberedWorkspace = inventory.upsertWorkspace(resolvedScope, {
        environmentId,
        canonicalPath: canonicalWorkspacePath,
        displayName: "Real Pi CLI workspace",
        available: true,
        trustState: "trusted",
        environmentConfigurationRevision: environment.configurationRevision,
        now: 120,
      });
      const source = new ConversationBindingRepository(
        database,
      ).createUnboundThread(resolvedScope, {
        workspaceId: rememberedWorkspace.id,
        connectionProfileId: connection.id,
        title: "Real Pi CLI source",
        now: 130,
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
      policies.update(resolvedScope, source.id, {
        expectedRevision: 0,
        enabled: true,
        presentation: { surface: "cli", mode: "progressive" },
        accessBoundary: "environment",
        enabledToolIds: ["agent.context"],
        now: 300,
      });
      const canonical = new CanonicalInlineAgentToolService({ application });
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
      const appConfig: AppConfig = {
        authenticationRequired: true,
        host: "127.0.0.1",
        port: 4784,
        stateDirectory,
        allowedTailscaleHosts: [],
        packagedClientOrigins: [],
        conversationRetentionMilliseconds: 600_000,
        conversationRuntimeBudget: 8,
      };
      const app = createNormalizedApp({
    workpads: {} as never,
        turnBookmarks: unavailableTurnBookmarks(),
        config: appConfig,
        csrfToken: "real-pi-cli-csrf",
        identity,
        applicationSnapshots,
        agentTools: {
          sources: application,
          tools: new PolicyCheckedAgentToolHttpService(scopedTools),
        },
      } as unknown as NormalizedAppDependencies);
      server = createServer(app);
      const port = await listen(server);

      const workspace: ValidatedWorkspace = {
        canonicalPath: canonicalWorkspacePath,
        authorityRevision: 0,
        summary: {
          id: rememberedWorkspace.id,
          environmentId,
          displayName: "Real Pi CLI workspace",
          displayPath: canonicalWorkspacePath,
          availability: "available",
          trustState: "trusted",
          revision: 0,
        },
      };
      const options: PiDriverOptions = {
        instance,
        connection,
        nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
        toolProvenanceKey,
        agentTools: scopedTools,
        agentToolSourceCapabilities: sources,
        toolAccessPolicy: () => "ask",
        modelPolicy: catalogModelPolicy,
        sessionDirectory,
        agentToolCli: {
          availability: "available",
          endpoint: `http://127.0.0.1:${port}`,
          executableDirectory: binDirectory,
          inheritedPath: process.env.PATH ?? "",
        },
      };
      const selectedModel = await eligibleModel(options, workspace);
      const driver = new PiConversationBackendDriver(options);
      const catalog = await driver.catalog({ scope, workspace });
      const skill = catalog.skills.find(
        ({ name }) => name === "sedes-cli-progressive-tools",
      );
      if (!skill) {
        throw new Error(
          "REAL_PI_CLI_BLOCKER: repository skill was not discovered.",
        );
      }
      const created = await driver.create({
        scope,
        workspace,
        applicationThreadId: source.id,
        applicationOperationId: `create-${randomUUID()}`,
        source: { kind: "user" },
      });
      const binding: ConversationBinding = {
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        applicationThreadId: source.id,
        backendInstanceId: instance.id,
        connectionProfileId: connection.id,
        executionEnvironmentId: environmentId,
        backendConversationId: created.backendConversationId,
        createdAt: new Date().toISOString(),
      };
      const handle = await driver.attach({
        scope,
        workspace,
        binding,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      const events: SequencedBackendEvent[] = [];
      const approvedCommands: string[] = [];
      const deniedMutations: string[] = [];
      const brokerOutcomes: Array<"pending" | "fulfilled" | "rejected"> = [];
      const allowedCommands = new Set([
        "sedes tool list --json",
        "sedes tool describe agent.context --json",
        "sedes tool invoke agent.context --input-json '{}' --json",
      ]);
      const brokerResponses: Promise<void>[] = [];
      const projection = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      let unsubscribe = projection.subscribeFromNext((sequenced) => {
        events.push(sequenced);
        const event = sequenced.event;
        if (
          event.type !== "interaction_opened" ||
          event.interaction.kind !== "decision" ||
          event.interaction.title.text !== PI_TOOL_APPROVAL_TITLE
        ) {
          return;
        }
        const detail = event.interaction.message?.text ?? "";
        const commandMatch = /^bash: ([^\n]+)\ncwd: /u.exec(detail);
        const command = commandMatch?.[1];
        const approved = command !== undefined && allowedCommands.has(command);
        if (approved) approvedCommands.push(command);
        else deniedMutations.push(detail);
        const brokerIndex = brokerOutcomes.push("pending") - 1;
        const response = handle.respond({
          applicationOperationId: `broker-${randomUUID()}`,
          interactionId: event.interaction.backendInteractionId,
          kind: "decision",
          selectedActionId: approved
            ? PI_TOOL_APPROVAL_APPROVE_ACTION_ID
            : PI_TOOL_APPROVAL_DENY_ACTION_ID,
        });
        void response.then(
          () => {
            brokerOutcomes[brokerIndex] = "fulfilled";
          },
          () => {
            brokerOutcomes[brokerIndex] = "rejected";
          },
        );
        brokerResponses.push(response);
      });
      try {
        await handle.perform({
          applicationOperationId: `model-${randomUUID()}`,
          action: "set_model",
          provider: selectedModel.provider,
          modelId: selectedModel.id,
        });
        await handle.perform({
          applicationOperationId: `thinking-${randomUUID()}`,
          action: "set_thinking_level",
          level: requiredThinkingLevel,
        });
        await handle.perform({
          applicationOperationId: `tools-${randomUUID()}`,
          action: "set_tool_access",
          mode: "ask",
        });
        const applicationOperationId = `submit-${randomUUID()}`;
        await handle.submit({
          applicationOperationId,
          mutationId: randomUUID(),
          reconciliationToken: `real-pi-cli-${randomUUID()}`,
          selectedSkillId: skill.id,
          source: { kind: "user" },
          contextExcerpts: [],
          attachments: [],
          taskContexts: [],
          text: "Use the selected skill. Run these three bash commands separately, exactly as written and in this order: `sedes tool list --json`, `sedes tool describe agent.context --json`, and `sedes tool invoke agent.context --input-json '{}' --json`. Do not run any other command or tool. Then reply with exactly CLI_CONTEXT_OK.",
        });
        try {
          await waitFor(
            () =>
              eventsOfType(events, "turn_completed").some(({ turn }) =>
                turn.completionCorrelations?.includes(applicationOperationId),
              ),
            "Timed out waiting for the real Pi CLI skill turn to settle.",
          );
        } catch (error) {
          unsubscribe();
          unsubscribe = () => undefined;
          const eventTypeCounts = Object.fromEntries(
            [...new Set(events.map(({ event }) => event.type))]
              .sort()
              .map((type) => [
                type,
                events.filter(({ event }) => event.type === type).length,
              ]),
          );
          const correlatedTurnEvents = events.flatMap(({ event }) =>
            (event.type === "turn_started" ||
              event.type === "turn_updated" ||
              event.type === "turn_completed") &&
            event.turn.completionCorrelations?.includes(applicationOperationId)
              ? [{ type: event.type, status: event.turn.status }]
              : [],
          );
          const interactionEvidence = eventsOfType(
            events,
            "interaction_opened",
          ).map(({ interaction }) => {
            const toolApproval =
              interaction.kind === "decision" &&
              interaction.title.text === PI_TOOL_APPROVAL_TITLE;
            const command = toolApproval
              ? /^bash: ([^\n]+)\ncwd: /u.exec(
                  interaction.message?.text ?? "",
                )?.[1]
              : undefined;
            return {
              kind: interaction.kind,
              classification: toolApproval ? "pi_tool_approval" : "other",
              command:
                command !== undefined && allowedCommands.has(command)
                  ? command
                  : command === undefined
                    ? "none"
                    : "unexpected",
            };
          });
          let projectionEvidence: unknown = { availability: "unavailable" };
          try {
            const diagnosticProjection = await handle.establishProjection({
              signal: AbortSignal.timeout(2_000),
            });
            const correlatedTurns = Object.values(
              diagnosticProjection.snapshot.turnsById,
            ).filter((turn) =>
              turn.completionCorrelations?.includes(applicationOperationId),
            );
            const relevantTurnIds = new Set([
              ...correlatedTurns.map(({ backendTurnId }) => backendTurnId),
              ...(diagnosticProjection.snapshot.activeBackendTurnId
                ? [diagnosticProjection.snapshot.activeBackendTurnId]
                : []),
            ]);
            projectionEvidence = {
              availability: "available",
              runState: diagnosticProjection.snapshot.runState,
              hasActiveTurn:
                diagnosticProjection.snapshot.activeBackendTurnId !== undefined,
              correlatedTurnStatuses: correlatedTurns.map(
                ({ status }) => status,
              ),
              relevantItems: Object.values(
                diagnosticProjection.snapshot.itemsById,
              )
                .filter(({ backendTurnId }) =>
                  relevantTurnIds.has(backendTurnId),
                )
                .sort((left, right) => left.sourceOrder - right.sourceOrder)
                .map((item) => ({
                  semanticKind: item.semanticKind,
                  status: item.status,
                  ...(item.semanticKind === "tool"
                    ? {
                        tool:
                          !item.toolName.truncation &&
                          item.toolName.text === "fabric_exec"
                            ? "fabric_exec"
                            : "other",
                      }
                    : {}),
                })),
            };
          } catch {
            projectionEvidence = { availability: "failed" };
          }
          const cause = error instanceof Error ? error.message : String(error);
          throw new Error(
            `${cause} Evidence: ${JSON.stringify({
              eventTypeCounts,
              correlatedTurnEvents,
              interactionEvidence,
              approvedCommands,
              deniedMutationCount: deniedMutations.length,
              brokerOutcomes,
              projectionEvidence,
            })}`,
          );
        }
        const terminalTurn = eventsOfType(events, "turn_completed").find(
          ({ turn }) =>
            turn.completionCorrelations?.includes(applicationOperationId),
        );
        expect(terminalTurn?.turn.status).toBe("completed");
        await Promise.all(brokerResponses);
        unsubscribe();
        unsubscribe = () => undefined;
        const persisted = await handle.establishProjection({
          signal: new AbortController().signal,
        });
        const completedTurn = Object.values(persisted.snapshot.turnsById).find(
          (turn) =>
            turn.status === "completed" &&
            turn.completionCorrelations?.includes(applicationOperationId),
        );
        if (!completedTurn) {
          throw new Error("real_pi_cli_correlated_turn_missing");
        }
        const turnItems = completedTurn.orderedBackendItemIds.map(
          (backendItemId) => persisted.snapshot.itemsById[backendItemId],
        );
        if (turnItems.some((item) => item === undefined)) {
          throw new Error("real_pi_cli_correlated_turn_item_missing");
        }
        const orderedItems = (turnItems as BackendItem[]).sort(
          (left, right) => left.sourceOrder - right.sourceOrder,
        );
        if (
          new Set(orderedItems.map(({ sourceOrder }) => sourceOrder)).size !==
          orderedItems.length
        ) {
          throw new Error("real_pi_cli_ambiguous_source_order");
        }
        const nativeEvidence = nativeCommandEvidence(orderedItems);
        const fabricEvidence = piFabricCommandEvidence(orderedItems);
        if ((nativeEvidence === undefined) === (fabricEvidence === undefined)) {
          throw new Error("real_pi_cli_ambiguous_execution_evidence");
        }
        const commandEvidence = nativeEvidence ?? fabricEvidence!;
        expect(commandEvidence.map(({ command }) => command)).toEqual([
          ...allowedCommands,
        ]);
        expect(commandEvidence[0]?.output).toContain("agent.context");
        expect(commandEvidence[1]?.output).toContain('"id":"agent.context"');
        expect(commandEvidence[2]?.output).toContain(source.id);
        expect(commandEvidence[2]?.output).toContain(rememberedWorkspace.id);
        expect(approvedCommands).toEqual([...allowedCommands]);
        expect(deniedMutations).toEqual([]);
        const assistantText = Object.values(persisted.snapshot.itemsById)
          .flatMap((item) =>
            item.semanticKind === "assistant_message"
              ? [item.markdown.text]
              : [],
          )
          .join("\n");
        expect(assistantText).toContain("CLI_CONTEXT_OK");
        process.stdout.write(
          `Real Pi CLI skill: ${selectedModel.provider}/${selectedModel.id}; selected ${skill.reference}; approved exactly ${approvedCommands.join(" -> ")}; source ${source.id}.\n`,
        );
      } finally {
        unsubscribe();
        await handle.close();
      }
    } finally {
      if (server) await close(server);
      database.close();
    }
  });
});
