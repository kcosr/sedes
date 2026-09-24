import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  BackendConversationEvent,
  BackendItem,
  SequencedBackendEvent,
} from "../../src/shared/protocol/backend.js";
import type { BoundedValue } from "../../src/shared/protocol/payload.js";
import {
  PiConversationBackendDriver,
  type PiDriverOptions,
} from "../../src/server/backends/pi/pi-conversation-driver.js";
import { PiSessionStore } from "../../src/server/backends/pi/pi-session-store.js";
import type { BackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  ConversationBinding,
  ConversationHandle,
} from "../../src/server/backends/contracts.js";
import { BackendError } from "../../src/server/backends/contracts.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import { CanonicalInlineAgentToolService } from "../../src/server/agent-tools/invocation/canonical-inline-agent-tool-service.js";
import { evaluateModelEligibility } from "../support/model-eligibility.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";

const requiredProvider = "xai";
const requiredModelId = "grok-4.5";
const requiredThinkingLevel = "low";
const timeoutMilliseconds = 240_000;
const temporaryRoots: string[] = [];
const fullToolAccessPolicy = () => "full" as const;
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
const toolProvenanceKey = new Uint8Array(32).fill(0x52);
const catalogModelPolicy = compileBackendModelPolicy(
  { type: "catalog" },
  "provider_model_effort",
);
const agentToolSourceCapabilities =
  createFakeAgentToolSourceCapabilities().issuer;

const scope = {
  tenantId: "real-pi-tenant",
  principalId: "real-pi-principal",
};

const instance: AgentBackendInstance = {
  id: "real-pi-instance",
  tenantId: scope.tenantId,
  kind: "pi",
  label: "Real Pi",
  enabled: true,
  configurationRevision: 1,
  protocolRelease: "0.86.0",
};

const connection: AgentConnectionProfile = {
  id: "real-pi-connection",
  tenantId: scope.tenantId,
  ownerPrincipalId: scope.principalId,
  templateId: "real-pi-template",
  kind: "pi_sdk",
  backendInstanceId: instance.id,
  executionEnvironmentId: "real-pi-environment",
  label: "Real Pi",
  enabled: true,
  configurationRevision: 1,
};

interface Fixture {
  readonly root: string;
  readonly sessionDirectory: string;
  readonly workspace: ValidatedWorkspace;
  readonly driverOptions: PiDriverOptions;
}

interface OpenedConversation {
  readonly binding: ConversationBinding;
  readonly opaqueBindingDetail: string;
  readonly handle: ConversationHandle;
}

afterAll(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-real-pi-driver-"));
  temporaryRoots.push(root);
  const workspacePath = path.join(root, "workspace");
  const sessionDirectory = path.join(root, "sessions");
  await Promise.all([
    mkdir(workspacePath, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const canonicalPath = await realpath(workspacePath);
  const workspace: ValidatedWorkspace = {
    canonicalPath,
    authorityRevision: 0,
    summary: {
      id: "real-pi-workspace",
      environmentId: connection.executionEnvironmentId,
      displayName: "real-pi-workspace",
      displayPath: canonicalPath,
      availability: "available",
      trustState: "trusted",
      revision: 0,
    },
  };
  return {
    root,
    sessionDirectory,
    workspace,
    driverOptions: {
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      agentToolSourceCapabilities,
      toolAccessPolicy: fullToolAccessPolicy,
      modelPolicy: catalogModelPolicy,
      sessionDirectory,
    },
  };
}

async function createConversation(
  driver: PiConversationBackendDriver,
  workspace: ValidatedWorkspace,
  label: string,
): Promise<OpenedConversation> {
  const applicationOperationId = `${label}-create-${randomUUID()}`;
  const applicationThreadId = `${label}-thread-${randomUUID()}`;
  const created = await driver.create({
    scope,
    workspace,
    applicationThreadId,
    applicationOperationId,
    source: { kind: "user" },
    title: `Real Pi ${label}`,
  });
  const binding: ConversationBinding = {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    applicationThreadId,
    backendInstanceId: instance.id,
    connectionProfileId: connection.id,
    executionEnvironmentId: connection.executionEnvironmentId,
    backendConversationId: created.backendConversationId,
    createdAt: new Date().toISOString(),
  };
  return {
    binding,
    opaqueBindingDetail: created.opaqueBindingDetail,
    handle: await driver.attach({
      scope,
      workspace,
      binding,
      opaqueBindingDetail: created.opaqueBindingDetail,
    }),
  };
}

async function resolveEligibleModel(
  fixture: Fixture,
): Promise<{ readonly provider: string; readonly id: string }> {
  const catalogDriver = new PiConversationBackendDriver(fixture.driverOptions);
  const catalog = await catalogDriver.catalog({
    scope,
    workspace: fixture.workspace,
  });
  const eligibility = await evaluateModelEligibility({
    catalog: catalog.models,
    requiredProvider,
    requiredModelId,
    requiredThinkingLevel,
    inspect: async (candidate) => {
      const probe = await createConversation(
        catalogDriver,
        fixture.workspace,
        `eligibility-${candidate.provider}`,
      );
      try {
        // These public driver operations verify the exact effective model,
        // thinking level, and active read-only tool set before returning.
        await probe.handle.perform({
          applicationOperationId: `eligibility-model-${candidate.provider}`,
          action: "set_model",
          provider: candidate.provider,
          modelId: candidate.id,
        });
        await probe.handle.perform({
          applicationOperationId: `eligibility-thinking-${candidate.provider}`,
          action: "set_thinking_level",
          level: requiredThinkingLevel,
        });
        await probe.handle.perform({
          applicationOperationId: `eligibility-tools-${candidate.provider}`,
          action: "set_tool_access",
          mode: "read_only",
        });
        const projection = await probe.handle.establishProjection({
          signal: new AbortController().signal,
        });
        if (
          projection.snapshot.orderedBackendTurnIds.length !== 0 ||
          Object.keys(projection.snapshot.itemsById).length !== 0
        ) {
          throw new Error(
            "REAL_PI_BLOCKER: no-prompt eligibility probe created conversation content.",
          );
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
        await probe.handle.close();
      }
    },
  });
  if (eligibility.eligible.length !== 1) {
    throw new Error(
      `REAL_PI_BLOCKER: expected exactly one authenticated ${requiredProvider}/${requiredModelId}/${requiredThinkingLevel} provider/model pair; found ${eligibility.eligible.length}.`,
    );
  }
  return eligibility.eligible[0]!;
}

async function waitFor(
  predicate: () => boolean,
  failure: string,
  terminalFailure?: () => Promise<string | undefined>,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    const terminalFailureMessage = await terminalFailure?.();
    if (terminalFailureMessage) {
      throw new Error(terminalFailureMessage);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(failure);
}

async function waitForPromise(
  promise: Promise<void>,
  failure: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(failure)),
          timeoutMilliseconds,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function eventOfType<T extends BackendConversationEvent["type"]>(
  events: readonly SequencedBackendEvent[],
  type: T,
): Array<Extract<BackendConversationEvent, { readonly type: T }>> {
  return events.flatMap(({ event }) =>
    event.type === type
      ? [event as Extract<BackendConversationEvent, { readonly type: T }>]
      : [],
  );
}

function boundedObjectEntry(
  value: BoundedValue | undefined,
  key: string,
): BoundedValue | undefined {
  return boundedObject(value)?.get(key);
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
    if (entry.key.truncation || entries.has(entry.key.text)) {
      return undefined;
    }
    entries.set(entry.key.text, entry.value);
  }
  return entries;
}

function boundedTextValue(value: BoundedValue | undefined): string | undefined {
  return value !== null &&
    typeof value === "object" &&
    "text" in value &&
    typeof value.text === "string" &&
    !("truncation" in value && value.truncation)
    ? value.text
    : undefined;
}

function boundedArrayValues(
  value: BoundedValue | undefined,
): readonly BoundedValue[] {
  return value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "array" &&
    !value.truncation
    ? value.values
    : [];
}

type PiFabricToolItem = Extract<BackendItem, { semanticKind: "tool" }>;

function isNativeReadExecution(
  item: BackendItem,
  sentinelPath: string,
  token: string,
): boolean {
  return (
    item.semanticKind === "file_read" &&
    item.phase === "completed" &&
    item.status === "completed" &&
    !item.path.truncation &&
    item.path.text === sentinelPath &&
    !item.contentPreview?.truncation &&
    item.contentPreview?.text === `${token}\n`
  );
}

function isPiFabricReadExecution(
  item: BackendItem,
  sentinelPath: string,
  token: string,
): item is PiFabricToolItem {
  if (
    item.semanticKind !== "tool" ||
    item.toolName.truncation ||
    item.toolName.text !== "fabric_exec" ||
    item.title.truncation ||
    item.title.text !== "fabric_exec" ||
    item.phase !== "completed" ||
    item.status !== "completed" ||
    item.result?.isError !== false ||
    item.result.truncation
  ) {
    return false;
  }
  if (boundedObjectEntry(item.result.details, "success") !== true) {
    return false;
  }
  const audits = boundedArrayValues(
    boundedObjectEntry(item.result.details, "audits"),
  );
  return (
    audits.length === 1 &&
    audits.some((audit) => {
      const argumentsValue = boundedObjectEntry(audit, "args");
      return (
        boundedTextValue(boundedObjectEntry(audit, "ref")) === "pi.read" &&
        boundedTextValue(boundedObjectEntry(audit, "tool")) === "read" &&
        boundedTextValue(boundedObjectEntry(audit, "provider")) === "pi" &&
        boundedObjectEntry(audit, "success") === true &&
        boundedTextValue(boundedObjectEntry(argumentsValue, "path")) ===
          sentinelPath &&
        boundedTextValue(boundedObjectEntry(audit, "result")) ===
          `${token}\n` &&
        boundedObjectEntry(audit, "resultTruncated") === false
      );
    })
  );
}

function isStreamingPiFabricExecution(item: BackendItem): boolean {
  return (
    item.semanticKind === "tool" &&
    item.status === "streaming" &&
    item.toolName.truncation === undefined &&
    item.toolName.text === "fabric_exec"
  );
}

interface ReadEvidence {
  readonly kind: "native" | "pi_fabric";
  readonly backendItemId: string;
  readonly backendTurnId: string;
}

function matchesReadEvidence(
  item: BackendItem | undefined,
  evidence: ReadEvidence,
  sentinelPath: string,
  token: string,
): boolean {
  return item !== undefined && evidence.kind === "native"
    ? isNativeReadExecution(item, sentinelPath, token)
    : item !== undefined && isPiFabricReadExecution(item, sentinelPath, token);
}

async function unexpectedTerminalTurnFailure(input: {
  readonly events: readonly SequencedBackendEvent[];
  readonly fixture: Fixture;
  readonly binding: ConversationBinding;
  readonly expectedOutcome: string;
}): Promise<string | undefined> {
  const terminal = eventOfType(input.events, "turn_completed").find(
    ({ turn }) => turn.status !== "completed",
  );
  if (!terminal) return undefined;

  let providerError: string | undefined;
  try {
    const persisted = await new PiSessionStore({
      sessionDirectory: input.fixture.sessionDirectory,
    }).openPersisted(
      input.fixture.workspace,
      input.binding.backendConversationId,
    );
    const branch = persisted?.getBranch() ?? [];
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index]!;
      if (
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.stopReason === "error" &&
        entry.message.errorMessage
      ) {
        providerError = entry.message.errorMessage;
        break;
      }
    }
  } catch (error) {
    providerError = `provider error unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  const outcome = terminal.turn.endedBy
    ? `${terminal.turn.status}/${terminal.turn.endedBy}`
    : terminal.turn.status;
  return (
    `Real Pi turn ended ${outcome} before ${input.expectedOutcome}.` +
    (providerError ? ` Provider error: ${providerError}` : "")
  );
}

describe.sequential("Pi 0.86.0 normalized driver live verification", () => {
  it("installs and invokes the source-scoped native agent context tool", async () => {
    const fixture = await createFixture();
    const selectedModel = await resolveEligibleModel(fixture);
    process.stdout.write(
      `Real Pi native agent tool model: ${selectedModel.provider}/${selectedModel.id}; low reasoning and read-only tools verified before prompting.\n`,
    );
    const canonical = new CanonicalInlineAgentToolService({
      application: {
        readThreadStatus: async () => undefined,
      },
    });
    const facade: BackendAgentToolFacade = {
      eligibleCatalog: (adapter) => canonical.catalog(adapter, "thread_agent"),
      catalogSummaries: () => [],
      describeMany: () => [],
      readPolicy: () => ({
        enabled: true,
        presentation: { surface: "native", mode: "individual" },
        accessBoundary: "environment",
        enabledToolIds: ["agent.context"],
      }),
      invoke: (input) =>
        canonical.invoke(input.request, {
          scope: input.source.scope,
          subject: {
            kind: "thread_agent",
            sourceThreadId: input.source.sourceThreadId,
            backendKind: input.source.backendKind,
          },
          defaults: {
            kind: "thread_agent",
            environmentId: input.source.sourceEnvironmentId,
            workspaceId: input.source.sourceWorkspaceId,
            threadId: input.source.sourceThreadId,
          },
          policyIdentity: {
            ownerKind: "thread",
            ownerId: input.source.sourceThreadId,
            revision: 1,
          },
          environmentAuthority: {
            id: "real-pi-source-environment-grant",
            callerKind: "thread_agent",
            defaults: {
              kind: "thread_agent",
              environmentId: input.source.sourceEnvironmentId,
              workspaceId: input.source.sourceWorkspaceId,
              threadId: input.source.sourceThreadId,
            },
            policyIdentity: {
              ownerKind: "thread",
              ownerId: input.source.sourceThreadId,
              revision: 1,
            },
            admittedEnvironmentIds: [input.source.sourceEnvironmentId],
            targetEnvironmentIds: [input.source.sourceEnvironmentId],
            resolvedResourceRefs: [],
            canonicalInputDigest: "real-pi-agent-context-input",
            authorityDigest: "real-pi-agent-context-authority",
            display: {
              defaultEnvironmentLabel: "Real Pi",
              targetEnvironmentLabels: ["Real Pi"],
              resourceLabels: [],
            },
          },
          adapter: input.adapter,
          signal: input.signal,
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        }),
    };
    const driver = new PiConversationBackendDriver({
      ...fixture.driverOptions,
      agentTools: facade,
    });
    const current = await createConversation(
      driver,
      fixture.workspace,
      "native-agent-context",
    );
    const events: SequencedBackendEvent[] = [];
    let unsubscribe: () => void = () => undefined;
    try {
      await current.handle.perform({
        applicationOperationId: "real-pi-native-tool-model",
        action: "set_model",
        provider: selectedModel.provider,
        modelId: selectedModel.id,
      });
      await current.handle.perform({
        applicationOperationId: "real-pi-native-tool-thinking",
        action: "set_thinking_level",
        level: requiredThinkingLevel,
      });
      await current.handle.perform({
        applicationOperationId: "real-pi-native-tool-access",
        action: "set_tool_access",
        mode: "read_only",
      });
      const projection = await current.handle.establishProjection({
        signal: new AbortController().signal,
      });
      unsubscribe = projection.subscribeFromNext((event) => events.push(event));
      const applicationOperationId = `native-tool-${randomUUID()}`;
      const turnEventStart = events.length;
      await current.handle.submit({
        applicationOperationId,
        mutationId: randomUUID(),
        source: { kind: "user" },
        reconciliationToken: `native-tool-token-${randomUUID()}`,
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text:
          "Call the sedes_agent_context tool exactly once with an empty object. " +
          "Then reply with exactly TOOL_CONTEXT_OK and nothing else. Do not call any other tool.",
      });
      await waitFor(
        () =>
          eventOfType(events.slice(turnEventStart), "turn_completed").some(
            ({ turn }) =>
              turn.completionCorrelations?.includes(applicationOperationId) &&
              turn.status === "completed",
          ),
        "Timed out waiting for the real Pi native agent-tool turn to settle.",
        () =>
          unexpectedTerminalTurnFailure({
            events: events.slice(turnEventStart),
            fixture,
            binding: current.binding,
            expectedOutcome: "the native agent-tool assertion completed",
          }),
      );
      unsubscribe();
      unsubscribe = () => undefined;
      const persisted = await current.handle.establishProjection({
        signal: new AbortController().signal,
      });
      const toolItems = Object.values(persisted.snapshot.itemsById).filter(
        (item) =>
          item.semanticKind === "tool" &&
          item.agentToolInvocation?.toolId === "agent.context",
      );
      expect(toolItems).toHaveLength(1);
      const tool = toolItems[0]!;
      expect(tool).toMatchObject({
        semanticKind: "tool",
        phase: "completed",
        agentToolInvocation: {
          toolId: "agent.context",
          schemaVersion: 2,
        },
      });
      if (tool.semanticKind !== "tool") {
        throw new Error(
          "REAL_PI_BLOCKER: native agent context projection missing.",
        );
      }
      const resultText = (tool.result?.content ?? [])
        .flatMap((part) => (part.kind === "text" ? [part.value.text] : []))
        .join("");
      expect(resultText).toContain(current.binding.applicationThreadId);
      expect(resultText).toContain(fixture.workspace.summary.id);
    } finally {
      unsubscribe();
      await current.handle.close();
    }
  });

  it("streams and persists normalized output, then interrupts an active turn", async () => {
    const fixture = await createFixture();
    const selectedModel = await resolveEligibleModel(fixture);
    process.stdout.write(
      `Real Pi model: ${selectedModel.provider}/${selectedModel.id}; low reasoning and read-only tools verified before prompting.\n`,
    );

    const driver = new PiConversationBackendDriver(fixture.driverOptions);
    const conversation = await createConversation(
      driver,
      fixture.workspace,
      "live",
    );
    const events: SequencedBackendEvent[] = [];
    let unsubscribe: () => void = () => undefined;
    const token = `REAL_PI_${randomUUID().replaceAll("-", "")}`;
    const sentinelPath = path.join(
      fixture.workspace.canonicalPath,
      "real-pi-sentinel.txt",
    );
    let readEvidence: ReadEvidence | undefined;
    try {
      await conversation.handle.perform({
        applicationOperationId: "real-pi-live-model",
        action: "set_model",
        provider: selectedModel.provider,
        modelId: selectedModel.id,
      });
      await conversation.handle.perform({
        applicationOperationId: "real-pi-live-thinking",
        action: "set_thinking_level",
        level: requiredThinkingLevel,
      });
      await conversation.handle.perform({
        applicationOperationId: "real-pi-live-tools",
        action: "set_tool_access",
        mode: "read_only",
      });

      const projection = await conversation.handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(projection.snapshot).toMatchObject({
        runState: "idle",
        orderedBackendTurnIds: [],
      });
      unsubscribe = projection.subscribeFromNext((event) => {
        events.push(event);
      });

      await writeFile(sentinelPath, `${token}\n`, "utf8");
      const prompt =
        `Read ${sentinelPath} using either the built-in read tool or ` +
        "Pi-Fabric's pi.read operation. " +
        "Then reply with exactly the file contents and nothing else.";
      const turnEventStart = events.length;
      const submitted = await conversation.handle.submit({
        applicationOperationId: `submit-${randomUUID()}`,
        source: { kind: "user" },
        mutationId: randomUUID(),
        reconciliationToken: `submit-token-${randomUUID()}`,
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: prompt,
      });
      expect(submitted).toMatchObject({ accepted: true });

      await waitFor(
        () =>
          eventOfType(events.slice(turnEventStart), "turn_completed").some(
            ({ turn }) => turn.status === "completed",
          ) &&
          eventOfType(events.slice(turnEventStart), "run_state_changed").some(
            ({ state }) => state === "idle",
          ),
        "Timed out waiting for the real Pi turn to settle.",
        () =>
          unexpectedTerminalTurnFailure({
            events: events.slice(turnEventStart),
            fixture,
            binding: conversation.binding,
            expectedOutcome:
              "the streaming and persistence assertions completed",
          }),
      );
      for (const [index, event] of events.entries()) {
        expect(event.handleSequence).toBe(
          projection.handleSequence + index + 1,
        );
      }
      expect(
        eventOfType(events, "run_state_changed").some(
          ({ state }) => state === "running",
        ),
      ).toBe(true);
      const liveTurnIndex = events.findIndex(
        ({ event }) => event.type === "turn_started",
      );
      const liveUserIndex = events.findIndex(
        ({ event }) =>
          event.type === "item_completed" &&
          event.item.semanticKind === "user_message",
      );
      const firstAssistantIndex = events.findIndex(
        ({ event }) =>
          (event.type === "item_started" ||
            event.type === "item_updated" ||
            event.type === "item_completed") &&
          event.item.semanticKind === "assistant_message",
      );
      expect(liveTurnIndex).toBeGreaterThanOrEqual(0);
      expect(liveUserIndex).toBeGreaterThan(liveTurnIndex);
      expect(firstAssistantIndex).toBeGreaterThan(liveUserIndex);
      expect(events[liveTurnIndex]?.event).toMatchObject({
        type: "turn_started",
        turn: { orderedBackendItemIds: [] },
      });
      const assistantEvents = events.filter(
        ({ event }) =>
          (event.type === "item_started" ||
            event.type === "item_updated" ||
            event.type === "item_completed") &&
          event.item.semanticKind === "assistant_message",
      );
      expect(
        assistantEvents.some(
          ({ event }) =>
            event.type === "item_started" && event.item.status === "streaming",
        ),
      ).toBe(true);
      const finalAssistantIndex = events.findIndex(
        ({ event }) =>
          event.type === "item_updated" &&
          event.item.semanticKind === "assistant_message" &&
          event.item.responsePhase === "final" &&
          event.item.markdown.text.includes(token),
      );
      const completedTurnIndex = events.findIndex(
        ({ event }) => event.type === "turn_completed" && event.turn.status === "completed",
      );
      expect(finalAssistantIndex).toBeGreaterThanOrEqual(0);
      expect(finalAssistantIndex).toBeLessThan(completedTurnIndex);
      expect(
        assistantEvents.some(
          ({ event }) =>
            event.type === "item_completed" &&
            event.item.semanticKind === "assistant_message" &&
            event.item.markdown.text.includes(token),
        ),
      ).toBe(true);
      const operationEvents = events
        .slice(turnEventStart)
        .flatMap(({ event }) =>
          event.type === "item_started" ||
          event.type === "item_updated" ||
          event.type === "item_completed"
            ? [event]
            : [],
        );
      const nativeCandidates = operationEvents.filter(
        (event) =>
          event.type === "item_completed" &&
          isNativeReadExecution(event.item, sentinelPath, token) &&
          operationEvents.some(
            (streamed) =>
              (streamed.type === "item_started" ||
                streamed.type === "item_updated") &&
              streamed.item.backendItemId === event.item.backendItemId &&
              streamed.item.semanticKind === "file_read" &&
              streamed.item.status === "streaming" &&
              !streamed.item.path.truncation &&
              streamed.item.path.text === sentinelPath,
          ),
      );
      const piFabricCandidates = operationEvents.filter(
        (event) =>
          event.type === "item_completed" &&
          isPiFabricReadExecution(event.item, sentinelPath, token) &&
          operationEvents.some(
            (streamed) =>
              (streamed.type === "item_started" ||
                streamed.type === "item_updated") &&
              streamed.item.backendItemId === event.item.backendItemId &&
              isStreamingPiFabricExecution(streamed.item),
          ),
      );
      expect(nativeCandidates.length + piFabricCandidates.length).toBe(1);
      const selectedRead = nativeCandidates[0] ?? piFabricCandidates[0]!;
      readEvidence = {
        kind: nativeCandidates.length === 1 ? "native" : "pi_fabric",
        backendItemId: selectedRead.item.backendItemId,
        backendTurnId: selectedRead.item.backendTurnId,
      };

      const selectedSourceTurnId = eventOfType(events, "turn_completed").find(
        ({ turn }) =>
          turn.status === "completed" && turn.endedBy === "agent_settled",
      )!.turn.backendTurnId;
      const selectedCheckpoint = await driver.resolveBranchCheckpoint({
        scope,
        binding: conversation.binding,
        workspace: fixture.workspace,
        opaqueBindingDetail: conversation.opaqueBindingDetail,
        selection: {
          kind: "selected_completed_turn",
          backendTurnId: selectedSourceTurnId,
          boundary: "completed_turn_inclusive",
        },
      });
      const branchInput = {
        scope,
        applicationOperationId: `live-branch-${randomUUID()}`,
        childApplicationThreadId: `live-child-thread-${randomUUID()}`,
        source: { kind: "user" as const },
        sourceBinding: conversation.binding,
        sourceOpaqueBindingDetail: conversation.opaqueBindingDetail,
        workspace: fixture.workspace,
        sourceCheckpoint: selectedCheckpoint,
        requestedBackendConversationId: `live-child-${randomUUID()}`,
        inheritedSettings: {
          model: selectedModel,
          thinkingLevel: requiredThinkingLevel,
          toolAccess: "read_only" as const,
        },
        title: "Real Pi selected-turn child",
      };
      const branched = await driver.branchConversation(branchInput);
      await expect(driver.branchConversation(branchInput)).resolves.toEqual(
        branched,
      );
      const childBinding: ConversationBinding = {
        ...conversation.binding,
        applicationThreadId: `live-child-thread-${randomUUID()}`,
        backendConversationId: branched.backendConversationId,
        createdAt: new Date().toISOString(),
      };
      const childBeforeSourceActivity = await driver.read({
        scope,
        workspace: fixture.workspace,
        binding: childBinding,
        opaqueBindingDetail: branched.opaqueBindingDetail,
      });
      expect(childBeforeSourceActivity.snapshot).toMatchObject({
        runState: "idle",
        orderedBackendTurnIds: [selectedSourceTurnId],
        turnsById: {
          [selectedSourceTurnId]: {
            status: "completed",
            endedBy: "agent_settled",
          },
        },
      });
      expect(
        Object.values(childBeforeSourceActivity.snapshot.itemsById).some(
          (item) =>
            item.semanticKind === "assistant_message" &&
            item.markdown.text.includes(token),
        ),
      ).toBe(true);

      unsubscribe();
      const replacement = await conversation.handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(replacement.snapshot.runState).toBe("idle");
      expect(
        Object.values(replacement.snapshot.turnsById).some(
          (turn) => turn.status === "completed",
        ),
      ).toBe(true);
      expect(
        Object.values(replacement.snapshot.itemsById).some(
          (item) =>
            item.semanticKind === "assistant_message" &&
            item.responsePhase === "final" &&
            item.markdown.text.includes(token),
        ),
      ).toBe(true);
      expect(
        matchesReadEvidence(
          replacement.snapshot.itemsById[readEvidence.backendItemId],
          readEvidence,
          sentinelPath,
          token,
        ),
      ).toBe(true);
      expect((await conversation.handle.usage()).counters?.userMessages).toBe(
        1,
      );
      unsubscribe = replacement.subscribeFromNext((event) => {
        events.push(event);
      });

      const stopEventStart = events.length;
      await conversation.handle.submit({
        applicationOperationId: `stop-submit-${randomUUID()}`,
        source: { kind: "user" },
        mutationId: randomUUID(),
        reconciliationToken: `stop-token-${randomUUID()}`,
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text:
          "Write 200 numbered one-sentence observations about software testing. " +
          "Do not use tools.",
      });
      await waitFor(
        () =>
          eventOfType(events.slice(stopEventStart), "turn_started").length > 0,
        "Timed out waiting for the interrupt target turn to start.",
      );
      await conversation.handle.interrupt({
        applicationOperationId: `interrupt-${randomUUID()}`,
        expectedBackendTurnId: eventOfType(
          events.slice(stopEventStart),
          "turn_started",
        ).at(-1)!.turn.backendTurnId,
      });
      await waitFor(
        () =>
          eventOfType(events.slice(stopEventStart), "turn_completed").some(
            ({ turn }) => turn.status === "interrupted",
          ) &&
          eventOfType(events.slice(stopEventStart), "run_state_changed").some(
            ({ state }) => state === "idle",
          ),
        "Timed out waiting for the interrupted real Pi turn to settle.",
      );
      const childAfterSourceActivity = await driver.read({
        scope,
        workspace: fixture.workspace,
        binding: childBinding,
        opaqueBindingDetail: branched.opaqueBindingDetail,
      });
      expect(childAfterSourceActivity.snapshot).toEqual(
        childBeforeSourceActivity.snapshot,
      );
    } finally {
      unsubscribe();
      await conversation.handle.close();
    }

    const restarted = new PiConversationBackendDriver(fixture.driverOptions);
    const reopened = await restarted.read({
      scope,
      workspace: fixture.workspace,
      binding: conversation.binding,
      opaqueBindingDetail: conversation.opaqueBindingDetail,
    });
    if (!readEvidence) {
      throw new Error("REAL_PI_BLOCKER: no validated read path was observed.");
    }
    expect(reopened.snapshot.runState).toBe("idle");
    expect(
      Object.values(reopened.snapshot.itemsById).some(
        (item) =>
          item.semanticKind === "assistant_message" &&
          item.backendTurnId === readEvidence.backendTurnId &&
          item.responsePhase === "final" &&
          item.markdown.text.includes(token),
      ),
    ).toBe(true);
    const reopenedReadItems = Object.values(reopened.snapshot.itemsById).filter(
      (item) =>
        item.backendTurnId === readEvidence.backendTurnId &&
        matchesReadEvidence(item, readEvidence, sentinelPath, token),
    );
    expect(reopenedReadItems).toHaveLength(1);
    expect(
      Object.values(reopened.snapshot.turnsById).some(
        (turn) =>
          turn.status === "interrupted" && turn.endedBy === "interrupted",
      ),
    ).toBe(true);
    expect(reopened.usage.counters?.userMessages).toBeGreaterThanOrEqual(2);
  });
});
