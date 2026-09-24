import { savedAgentDatabase } from "../support/saved-agent-fixture.js";
import { UsageService } from "../../src/server/usage/usage-service.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { BackendConfigurationRepository } from "../../src/server/db/repositories/backend-configuration-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { applicationTurnIdForBackendTurn } from "../../src/server/conversations/conversation-projector.js";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { type UsageObservation } from "../../src/server/usage/contracts.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import { PiUsageAccounting } from "../../src/server/backends/pi/pi-usage-accounting.js";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PiConversationBackendDriver as ProductionPiConversationBackendDriver,
  type PiDriverOptions as ProductionPiDriverOptions,
} from "../../src/server/backends/pi/pi-conversation-driver.js";
import type {
  BackendConversationEvent,
  BackendTurn,
  SequencedBackendEvent,
} from "../../src/shared/protocol/backend.js";
import type {
  PiSdkSession,
  PiSdkSessionFactory,
} from "../../src/server/backends/pi/pi-sdk-session.js";
import {
  PiInteractionBridge,
  DefaultPiSdkSessionFactory,
  piModels,
} from "../../src/server/backends/pi/pi-sdk-session.js";
import { PI_EXECUTOR_BUILTIN_TOOL_NAMES } from "../../src/server/backends/pi/pi-remote-workspace.js";
import {
  PiSessionStore,
  type PiStoredConversationWithAncestry,
} from "../../src/server/backends/pi/pi-session-store.js";
import { WorkspaceSkillReaderError } from "../../src/server/workspace-skills/contracts.js";
import { PiDiscoverySnapshotStore } from "../../src/server/backends/pi/pi-discovery-snapshot-store.js";
import { PiHistoryProjector } from "../../src/server/backends/pi/pi-history-projector.js";
import {
  createPiAgentToolInvocationMarker,
  piAgentToolInvocationMarkerType,
  readPiAgentToolInvocationMarker,
} from "../../src/server/backends/pi/pi-agent-tool-invocation-marker.js";
import {
  createPiToolIdentityMarker,
  piToolIdentityMarker,
  piToolIdentityMarkerType,
  readPiToolIdentityMarker,
} from "../../src/server/backends/pi/pi-tool-identity-marker.js";
import {
  createPiInteractionResponseMarker,
  piInteractionResponseMarkerType,
} from "../../src/server/backends/pi/pi-interaction-response-marker.js";
import {
  createPiSubmissionMarker,
  piSubmissionMarker,
  piSubmissionMarkerType,
} from "../../src/server/backends/pi/pi-submission-marker.js";
import { piSubmissionAttestationType } from "../../src/server/backends/pi/pi-submission-attestation.js";
import { formatPiContextExcerptPrompt } from "../../src/server/backends/pi/pi-context-excerpt-message.js";
import { formatPiTaskContextPrompt } from "../../src/server/backends/pi/pi-task-context-message.js";
import {
  createPiContextExcerptMarker,
  piContextExcerptMarkerType,
  readPiContextExcerptMarker,
} from "../../src/server/backends/pi/pi-context-excerpt-marker.js";
import {
  createPiTaskContextMarker,
  piTaskContextMarkerType,
  readPiTaskContextMarker,
} from "../../src/server/backends/pi/pi-task-context-marker.js";
import {
  createPiBranchMarker,
  piBranchMarkerType,
  readPiBranchMarker,
} from "../../src/server/backends/pi/pi-branch-marker.js";
import {
  createPiActionMarker,
  piActionMarkerType,
} from "../../src/server/backends/pi/pi-action-marker.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  ConversationBinding,
} from "../../src/server/backends/contracts.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import type {
  BackendAgentToolFacade,
  BackendAgentToolInvocationInput,
} from "../../src/server/agent-tools/adapters/backend-facade.js";
import { AgentToolRegistry } from "../../src/server/agent-tools/registry/agent-tool-registry.js";
import { agentContextToolDefinition } from "../../src/server/agent-tools/tools/agent-context-tool.js";
import { ConversationProjector } from "../../src/server/conversations/conversation-projector.js";
import { renderTaskContextsForModel } from "../../src/server/conversations/delivery-input-projection.js";
import {
  compileBackendModelPolicy,
  type CompiledBackendModelPolicy,
} from "../../src/server/backends/model-policy.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";

const roots: string[] = [];
const toolProvenanceKey = new Uint8Array(32).fill(0x42);
const fullToolAccessPolicy = () => "full" as const;
const catalogModelPolicy = compileBackendModelPolicy(
  { type: "catalog" },
  "provider_model_effort",
);
const agentToolSourceCapabilities =
  createFakeAgentToolSourceCapabilities().issuer;

class PiConversationBackendDriver extends ProductionPiConversationBackendDriver {
  constructor(options: PiDriverOptions) {
    super({
      modelPolicy: catalogModelPolicy,
      agentToolSourceCapabilities,
      ...options,
    });
  }
}

type PiDriverOptions = Omit<
  ProductionPiDriverOptions,
  "agentToolSourceCapabilities" | "modelPolicy"
> & {
  readonly modelPolicy?: CompiledBackendModelPolicy;
  readonly agentToolSourceCapabilities?: ProductionPiDriverOptions["agentToolSourceCapabilities"];
};

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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<{
  readonly root: string;
  readonly sessions: string;
  readonly workspace: ValidatedWorkspace;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-pi-driver-"));
  roots.push(root);
  const project = path.join(root, "project");
  const sessions = path.join(root, "sessions");
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(sessions, { recursive: true }),
  ]);
  const canonicalPath = await realpath(project);
  return {
    root,
    sessions,
    workspace: {
      canonicalPath,
      authorityRevision: 0,
      summary: {
        id: "workspace",
        environmentId: "environment",
        displayName: "project",
        displayPath: canonicalPath,
        availability: "available",
        trustState: "trusted",
        revision: 0,
      },
    },
  };
}

const instance: AgentBackendInstance = {
  id: "pi-instance",
  tenantId: "tenant",
  kind: "pi",
  label: "Pi",
  enabled: true,
  configurationRevision: 1,
  protocolRelease: "0.86.0",
};

const connection: AgentConnectionProfile = {
  id: "pi-connection",
  tenantId: "tenant",
  ownerPrincipalId: "principal",
  templateId: "pi-template",
  kind: "pi_sdk",
  backendInstanceId: instance.id,
  executionEnvironmentId: "environment",
  label: "Pi",
  enabled: true,
  configurationRevision: 1,
};

const scope = { tenantId: "tenant", principalId: "principal" };

function fakeSessionFactory(
  assistantResponseCount = 1,
  includeToolLoop = false,
  onCompact: (manager: PiSdkSession["sessionManager"]) => void = () =>
    undefined,
  userPersistenceDelayMilliseconds = 0,
  steerMessages?: (text: string) => readonly string[],
  steerPersistenceDelayMilliseconds = 0,
  assistantStopReasons?: readonly ("error" | "stop")[],
  promptMessages?: (text: string) => readonly string[],
  beforeAssistant?: (text: string) => Promise<void>,
  capturePendingSteer?: (materialize: () => void) => void,
  steerFailure?: Error,
  settleBeforeSteerReturns = false,
  settleOnAbort = false,
  afterToolResult?: (
    manager: PiSdkSession["sessionManager"],
    emit: (event: never) => void,
  ) => void | Promise<void>,
  beforePromptPreflight?: (
    manager: PiSdkSession["sessionManager"],
    emit: (event: never) => void,
  ) => Error | undefined | Promise<Error | undefined>,
  assistantTextChunks?: readonly string[],
  assistantTextBlocks?: readonly string[],
): PiSdkSessionFactory {
  return {
    async create({ manager, customTools = [] }) {
      const listeners = new Set<Parameters<PiSdkSession["subscribe"]>[0]>();
      const emit = (event: never): void => {
        for (const listener of listeners) listener(event);
      };
      const session: PiSdkSession = {
        sessionId: manager.getSessionId(),
        get sessionName() {
          return manager.getSessionName();
        },
        get isIdle() {
          return steerMessages === undefined;
        },
        model: { provider: "test", id: "model", input: ["text"] },
        thinkingLevel: "low",
        sessionManager: manager,
        ready: async () => undefined,
        async skillPrompt(selectedSkillId, text) {
          return {
            text: `resolved:${selectedSkillId}${text ? ` ${text}` : ""}`,
            expandPromptTemplates: true,
          };
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt(text, options) {
          const persistedPromptTexts = promptMessages?.(text) ?? [text];
          const preflightFailure = await beforePromptPreflight?.(manager, emit);
          if (preflightFailure) {
            options.preflightResult(false);
            throw preflightFailure;
          }
          options.preflightResult(true);
          if (persistedPromptTexts.length === 0) return;
          emit({ type: "agent_start" } as never);
          if (userPersistenceDelayMilliseconds > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, userPersistenceDelayMilliseconds),
            );
          }
          for (const persistedText of persistedPromptTexts) {
            const user = {
              role: "user" as const,
              content: [{ type: "text" as const, text: persistedText }],
              timestamp: Date.now(),
            };
            manager.appendMessage(user);
            emit({ type: "message_end", message: user } as never);
          }
          await Promise.resolve();
          await beforeAssistant?.(text);

          if (includeToolLoop) {
            const toolAssistant = {
              role: "assistant" as const,
              content: [
                {
                  type: "toolCall" as const,
                  id: "call-read",
                  name: "read",
                  arguments: { path: "README.md" },
                },
              ],
              api: "test",
              provider: "test",
              model: "model",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: "toolUse" as const,
              timestamp: Date.now(),
            };
            emit({
              type: "message_start",
              message: toolAssistant,
            } as never);
            emit({
              type: "message_update",
              message: toolAssistant,
              assistantMessageEvent: {
                type: "toolcall_end",
                contentIndex: 0,
                toolCall: toolAssistant.content[0],
                partial: toolAssistant,
              },
            } as never);
            manager.appendMessage(toolAssistant);
            emit({
              type: "message_end",
              message: toolAssistant,
            } as never);
            await Promise.resolve();
            emit({
              type: "tool_execution_start",
              toolCallId: "call-read",
              toolName: "read",
              args: { path: "README.md" },
            } as never);
            const result = {
              role: "toolResult" as const,
              toolCallId: "call-read",
              toolName: "read",
              content: [{ type: "text" as const, text: "project readme" }],
              details: {},
              isError: false,
              timestamp: Date.now(),
            };
            emit({
              type: "tool_execution_end",
              toolCallId: "call-read",
              toolName: "read",
              result,
              isError: false,
            } as never);
            manager.appendMessage(result);
            emit({ type: "message_end", message: result } as never);
            await Promise.resolve();
            await afterToolResult?.(manager, emit);
          }

          const responseStopReasons =
            assistantStopReasons ??
            Array.from(
              { length: assistantResponseCount },
              () => "stop" as const,
            );
          for (const [
            responseIndex,
            stopReason,
          ] of responseStopReasons.entries()) {
            const responseText =
              assistantTextChunks?.join("") ??
              (responseStopReasons.length === 1
                ? "done"
                : `done-${responseIndex + 1}`);
            const assistant = {
              role: "assistant" as const,
              content: (assistantTextBlocks ?? [responseText]).map((text) => ({
                type: "text" as const,
                text,
              })),
              api: "test",
              provider: "test",
              model: "model",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason,
              ...(stopReason === "error" ? { errorMessage: "Unknown model: broken-model" } : {}),
              timestamp: Date.now(),
            };
            emit({ type: "message_start", message: assistant } as never);
            for (const [contentIndex, blockText] of (
              assistantTextBlocks ?? [responseText]
            ).entries()) {
              const chunks = assistantTextBlocks
                ? [blockText]
                : assistantTextChunks ?? [responseText];
              for (const delta of chunks) {
                emit({
                  type: "message_update",
                  message: assistant,
                  assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex,
                    delta,
                    partial: assistant,
                  },
                } as never);
              }
            }
            manager.appendMessage(assistant);
            emit({ type: "message_end", message: assistant } as never);
            await Promise.resolve();
          }
          emit({ type: "agent_settled" } as never);
        },
        async steer(text) {
          if (steerFailure) throw steerFailure;
          const persist = (persistedText: string): void => {
            const user = {
              role: "user" as const,
              content: [{ type: "text" as const, text: persistedText }],
              timestamp: Date.now(),
            };
            manager.appendMessage(user);
            emit({ type: "message_end", message: user } as never);
          };
          const messages = steerMessages?.(text) ?? [];
          if (capturePendingSteer && messages.length > 0) {
            capturePendingSteer(() => {
              for (const persistedText of messages) persist(persistedText);
            });
            return;
          }
          if (steerPersistenceDelayMilliseconds > 0 && messages.length > 1) {
            persist(messages[0]!);
            setTimeout(() => {
              for (const persistedText of messages.slice(1)) {
                persist(persistedText);
              }
            }, steerPersistenceDelayMilliseconds);
            return;
          }
          for (const persistedText of messages) {
            persist(persistedText);
          }
          if (settleBeforeSteerReturns) {
            emit({ type: "agent_settled" } as never);
          }
        },
        clearQueue: () => ({ steering: [], followUp: [] }),
        async abort() {
          if (settleOnAbort) emit({ type: "agent_settled" } as never);
        },
        async compact() {
          onCompact(manager);
        },
        setSessionName(title) {
          manager.appendSessionInfo(title);
        },
        async setModel() {},
        setThinkingLevel() {},
        getActiveToolNames: () => (includeToolLoop ? ["read"] : []),
        getAllTools: () =>
          [
            ...(includeToolLoop
              ? [
                  {
                    name: "read",
                    description: "Read a file",
                    parameters: {},
                    promptGuidelines: [],
                    sourceInfo: {
                      source: "builtin",
                      path: "<builtin:read>",
                    },
                  },
                ]
              : []),
            ...customTools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              promptGuidelines: tool.promptGuidelines ?? [],
              sourceInfo: { source: "sdk", path: `<sdk:${tool.name}>` },
            })),
          ] as unknown as ReturnType<PiSdkSession["getAllTools"]>,
        setActiveToolsByName() {},
        getSessionStats: () => ({
          sessionFile: manager.getSessionFile(),
          sessionId: manager.getSessionId(),
          userMessages: manager
            .getBranch()
            .filter(
              (entry) =>
                entry.type === "message" && entry.message.role === "user",
            ).length,
          assistantMessages: manager
            .getBranch()
            .filter(
              (entry) =>
                entry.type === "message" && entry.message.role === "assistant",
            ).length,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: manager
            .getBranch()
            .filter((entry) => entry.type === "message").length,
          tokens: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            total: 2,
          },
          cost: 0,
          contextUsage: {
            tokens: 2,
            contextWindow: 128_000,
            percent: 0.0015625,
          },
        }),
        availableModels: async () => [
          { provider: "test", id: "model", name: "Test model" },
        ],
        providerDisplayName: (providerId) =>
          providerId === "test" ? "Test Provider" : undefined,
        catalog: () => ({ models: [], commands: [], skills: [], notices: [] }),
        dispose() {
          listeners.clear();
        },
      };
      return session;
    },
  };
}

const canonicalThinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function clampThinkingLevel(
  requested: string,
  supported: readonly string[],
): string {
  if (supported.includes(requested)) return requested;
  const index = canonicalThinkingLevels.indexOf(requested as never);
  for (let i = index; i < canonicalThinkingLevels.length; i += 1) {
    if (supported.includes(canonicalThinkingLevels[i]!)) {
      return canonicalThinkingLevels[i]!;
    }
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    if (supported.includes(canonicalThinkingLevels[i]!)) {
      return canonicalThinkingLevels[i]!;
    }
  }
  return supported[0] ?? "off";
}

/**
 * Mirrors the Pi SDK's thinking-level semantics: unsupported requests clamp
 * to the nearest model-supported level instead of rejecting, and a level
 * change persists a native thinking_level_change entry.
 */
function thinkingLevelSessionFactory(
  supported: readonly string[],
  initialLevel = "low",
): PiSdkSessionFactory {
  const base = fakeSessionFactory();
  return {
    async create(input) {
      const session = await base.create(input);
      let level = initialLevel;
      return {
        ...session,
        get thinkingLevel() {
          return level;
        },
        setThinkingLevel(requested: string) {
          const effective = clampThinkingLevel(requested, supported);
          if (effective !== level) {
            level = effective;
            input.manager.appendThinkingLevelChange(effective);
          }
        },
      };
    },
  };
}

function toolAccessSessionFactory(
  appliedSelections: string[][],
): PiSdkSessionFactory {
  const base = fakeSessionFactory();
  return {
    async create(input) {
      const session = await base.create(input);
      let active = ["read", "grep", "bash"];
      const tools = [
        ...active.map((name) => ({
          name,
          description: name,
          parameters: {},
          promptGuidelines: [],
          sourceInfo: {
            source: "builtin" as const,
            path: `<builtin:${name}>`,
          },
        })),
        {
          name: "project_extension",
          description: "Project extension",
          parameters: {},
          promptGuidelines: [],
          sourceInfo: {
            source: "extension" as const,
            path: "/workspace/.pi/extensions/project-extension.ts",
          },
        },
        ...session.getAllTools(),
      ] as unknown as ReturnType<PiSdkSession["getAllTools"]>;
      return {
        ...session,
        getActiveToolNames: () => [...active],
        getAllTools: () => tools,
        setActiveToolsByName(names) {
          active = [...names];
          appliedSelections.push([...names]);
        },
      };
    },
  };
}

function binding(
  backendConversationId: string,
  applicationThreadId = "thread",
): ConversationBinding {
  return {
    tenantId: "tenant",
    ownerPrincipalId: "principal",
    applicationThreadId,
    backendConversationId,
    backendInstanceId: instance.id,
    connectionProfileId: connection.id,
    executionEnvironmentId: connection.executionEnvironmentId,
    createdAt: "2026-07-30T12:00:00.000Z",
  };
}

function appendBranchableSessionTurn(
  manager: Awaited<ReturnType<PiSessionStore["reserve"]>>["manager"],
  text: string,
): string {
  manager.appendMessage({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });
  return manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `${text} complete` }],
    api: "test",
    provider: "test",
    model: "model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

describe("Pi model catalog presentation", () => {
  it("uses runtime provider names without changing raw model identity", async () => {
    const providerNames = new Map<string, string | undefined>([
      ["openai", "OpenAI"],
      ["xai", "xAI"],
      ["github-copilot", "GitHub Copilot"],
      // Pi uses the raw ID as the composed provider name when a custom
      // provider has no display name.
      ["local-gateway", "local-gateway"],
      ["blank-provider", "   "],
    ]);
    const providerDisplayName = vi.fn((providerId: string) =>
      providerNames.get(providerId),
    );
    const models = await piModels({
      availableModels: async () => [
        {
          provider: "openai",
          id: "gpt-5.6",
          name: "GPT-5.6",
          reasoning: true,
        },
        { provider: "xai", id: "grok-4", name: "Grok" },
        {
          provider: "github-copilot",
          id: "copilot-model",
          name: "Copilot Model",
        },
        {
          provider: "local-gateway",
          id: "custom-model",
          name: "Custom Model",
        },
        { provider: "blank-provider", id: "model-without-name" },
      ],
      providerDisplayName,
    } as unknown as PiSdkSession);

    expect(models).toMatchObject([
      {
        provider: "openai",
        id: "gpt-5.6",
        label: "OpenAI / GPT-5.6",
      },
      { provider: "xai", id: "grok-4", label: "xAI / Grok" },
      {
        provider: "github-copilot",
        id: "copilot-model",
        label: "GitHub Copilot / Copilot Model",
      },
      {
        provider: "local-gateway",
        id: "custom-model",
        label: "Local-gateway / Custom Model",
      },
      {
        provider: "blank-provider",
        id: "model-without-name",
        label: "Blank-provider / model-without-name",
      },
    ]);
    expect(providerDisplayName.mock.calls).toEqual([
      ["openai"],
      ["xai"],
      ["github-copilot"],
      ["local-gateway"],
      ["blank-provider"],
    ]);
  });
});

describe("Pi session persistence adapter", () => {
  it("persists a deterministic reservation path and reopens it exactly", async () => {
    const fixture = await workspace();
    const store = new PiSessionStore({
      sessionDirectory: fixture.sessions,
    });
    const first = await store.reserve(
      fixture.workspace,
      "reserved-session",
      "Reserved",
    );
    expect(first.manager.getSessionId()).toBe("reserved-session");
    const listed = await store.list(fixture.workspace);
    expect(listed).toMatchObject([
      { backendConversationId: "reserved-session", title: "Reserved" },
    ]);

    const reopened = await store.open(
      fixture.workspace,
      "reserved-session",
      first.opaqueBindingDetail,
    );
    expect(reopened.getSessionId()).toBe("reserved-session");
    expect(reopened.getSessionName()).toBe("Reserved");
    expect(reopened.getSessionFile()).toBe(listed[0]?.sessionFile);
  });

  it("recovers an exact historical Harness creation marker", async () => {
    const fixture = await workspace();
    const store = new PiSessionStore({ sessionDirectory: fixture.sessions });
    const created = await store.reserve(
      fixture.workspace,
      "legacy-created-session",
      undefined,
      "creation-operation",
    );
    const sessionFile = created.manager.getSessionFile()!;
    const persisted = await readFile(sessionFile, "utf8");
    await writeFile(
      sessionFile,
      persisted.replace(
        '"customType":"sedes.creation_operation.v1"',
        '"customType":"harness.creation_operation.v1"',
      ),
      "utf8",
    );

    await expect(
      new PiSessionStore({ sessionDirectory: fixture.sessions }).reserve(
        fixture.workspace,
        "legacy-created-session",
        undefined,
        "creation-operation",
      ),
    ).resolves.toMatchObject({
      manager: expect.objectContaining({}),
    });
    await expect(
      store.reserve(
        fixture.workspace,
        "legacy-created-session",
        undefined,
        "different-operation",
      ),
    ).rejects.toMatchObject({ backendCode: "pi_session_id_collision" });
  });

  it("normalizes provider session titles before exposing discovery metadata", async () => {
    const fixture = await workspace();
    const store = new PiSessionStore({ sessionDirectory: fixture.sessions });
    await store.reserve(
      fixture.workspace,
      "normalized-title",
      `A\r\n${"x".repeat(237)}😀tail`,
    );
    await store.reserve(
      fixture.workspace,
      "maximum-provider-title",
      "y".repeat(4_096),
    );

    const listed = await store.list(fixture.workspace);
    expect(
      listed.find(
        ({ backendConversationId }) =>
          backendConversationId === "normalized-title",
      )?.title,
    ).toBe(`A ${"x".repeat(237)}`);
    expect(
      listed.find(
        ({ backendConversationId }) =>
          backendConversationId === "maximum-provider-title",
      )?.title,
    ).toBe("y".repeat(240));
  });

  it("creates an idempotent checkpoint branch with Pi parent metadata", async () => {
    const fixture = await workspace();
    const store = new PiSessionStore({
      sessionDirectory: fixture.sessions,
    });
    const source = await store.reserve(fixture.workspace, "source-session");
    const user = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "source" }],
      timestamp: Date.now(),
    };
    const assistant = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "complete" }],
      api: "test",
      provider: "test",
      model: "model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    source.manager.appendMessage(user);
    const leafId = source.manager.appendMessage(assistant);

    const [first, concurrentReplay] = await Promise.all([
      store.branch(
        fixture.workspace,
        "source-session",
        source.opaqueBindingDetail,
        leafId,
        toolProvenanceKey,
        "target-session",
        "branch-operation",
        "Branched",
      ),
      store.branch(
        fixture.workspace,
        "source-session",
        source.opaqueBindingDetail,
        leafId,
        toolProvenanceKey,
        "target-session",
        "branch-operation",
        "Branched",
      ),
    ]);
    expect(concurrentReplay.manager.getSessionFile()).toBe(
      first.manager.getSessionFile(),
    );
    const reservedIdentity = createHash("sha256")
      .update("harness-pi-reserved-branch-v1\0")
      .update(fixture.workspace.canonicalPath)
      .update("\0")
      .update("target-session")
      .digest("hex");
    expect(path.basename(first.manager.getSessionFile()!)).toBe(
      `harness-branch-${reservedIdentity}.jsonl`,
    );
    expect(
      (await store.list(fixture.workspace)).filter(
        ({ backendConversationId }) =>
          backendConversationId === "target-session",
      ),
    ).toHaveLength(1);
    const replay = await store.branch(
      fixture.workspace,
      "source-session",
      source.opaqueBindingDetail,
      leafId,
      toolProvenanceKey,
      "target-session",
      "branch-operation",
      "Ignored replay title",
    );
    expect(replay.manager.getSessionFile()).toBe(
      first.manager.getSessionFile(),
    );
    expect(replay.manager.getSessionName()).toBe("Branched");
    expect(replay.manager.getHeader()?.parentSession).toBe(
      await realpath(source.manager.getSessionFile()!),
    );
    const marker = replay.manager
      .getBranch()
      .find(
        (entry) =>
          entry.type === "custom" && entry.customType === piBranchMarkerType,
      );
    if (!marker || marker.type !== "custom") {
      throw new Error("missing branch marker");
    }
    replay.manager.appendCustomEntry(piBranchMarkerType, marker.data);
    await expect(
      store.branch(
        fixture.workspace,
        "source-session",
        source.opaqueBindingDetail,
        leafId,
        toolProvenanceKey,
        "target-session",
        "branch-operation",
        "Ignored replay title",
      ),
    ).rejects.toMatchObject({
      backendCode: "pi_branch_id_collision",
    });
  });

  it("treats an unparsable EEXIST child as an uncertain crossed-boundary outcome", async () => {
    const fixture = await workspace();
    const store = new PiSessionStore({
      sessionDirectory: fixture.sessions,
    });
    const source = await store.reserve(
      fixture.workspace,
      "uncertain-eexist-source",
    );
    const leafId = appendBranchableSessionTurn(
      source.manager,
      "uncertain EEXIST",
    );
    const branchInput = [
      fixture.workspace,
      "uncertain-eexist-source",
      source.opaqueBindingDetail,
      leafId,
      toolProvenanceKey,
      "uncertain-eexist-child",
      "uncertain-eexist-operation",
      "Uncertain EEXIST child",
    ] as const;
    const created = await store.branch(...branchInput);
    const childPath = created.manager.getSessionFile()!;
    const durableChild = await readFile(childPath, "utf8");
    const partialChild = '{"type":"session"';
    await writeFile(childPath, partialChild, "utf8");

    await expect(store.branch(...branchInput)).rejects.toMatchObject({
      backendCode: "pi_branch_id_collision",
      crossedSubmissionBoundary: true,
    });
    expect(await readFile(childPath, "utf8")).toBe(partialChild);
    expect(
      (await store.list(fixture.workspace)).filter(
        ({ backendConversationId }) =>
          backendConversationId === "uncertain-eexist-child",
      ),
    ).toHaveLength(0);

    await writeFile(childPath, durableChild, "utf8");
    const recovered = await store.branch(...branchInput);
    expect(recovered.manager.getSessionFile()).toBe(childPath);
    expect(
      (await store.list(fixture.workspace)).filter(
        ({ backendConversationId }) =>
          backendConversationId === "uncertain-eexist-child",
      ),
    ).toHaveLength(1);
  });

  it("treats a branch write failure as uncertain and retries one reserved identity", async () => {
    const fixture = await workspace();
    const store = new PiSessionStore({
      sessionDirectory: fixture.sessions,
    });
    const source = await store.reserve(
      fixture.workspace,
      "uncertain-write-source",
    );
    const leafId = appendBranchableSessionTurn(
      source.manager,
      "uncertain write",
    );
    const branchInput = [
      fixture.workspace,
      "uncertain-write-source",
      source.opaqueBindingDetail,
      leafId,
      toolProvenanceKey,
      "uncertain-write-child",
      "uncertain-write-operation",
      "Uncertain write child",
    ] as const;

    await chmod(fixture.sessions, 0o500);
    try {
      await expect(store.branch(...branchInput)).rejects.toMatchObject({
        backendCode: "pi_branch_write_failed",
        crossedSubmissionBoundary: true,
      });
    } finally {
      await chmod(fixture.sessions, 0o700);
    }
    expect(
      (await store.list(fixture.workspace)).filter(
        ({ backendConversationId }) =>
          backendConversationId === "uncertain-write-child",
      ),
    ).toHaveLength(0);

    const recovered = await store.branch(...branchInput);
    const replay = await store.branch(...branchInput);
    expect(replay.manager.getSessionFile()).toBe(
      recovered.manager.getSessionFile(),
    );
    expect(
      (await store.list(fixture.workspace)).filter(
        ({ backendConversationId }) =>
          backendConversationId === "uncertain-write-child",
      ),
    ).toHaveLength(1);
  });

  it("re-signs authenticated provider metadata for the branch conversation", async () => {
    const fixture = await workspace();
    const store = new PiSessionStore({
      sessionDirectory: fixture.sessions,
    });
    const source = await store.reserve(fixture.workspace, "provenance-source");
    const sourceAuthentication = {
      conversationId: "provenance-source",
      installationKey: toolProvenanceKey,
    };
    const identity = {
      registrationId: "pi:builtin:read",
      origin: "pi_builtin" as const,
      canonicalKind: "read" as const,
      displayName: "read",
    };
    const authenticated = createPiToolIdentityMarker(
      {
        assistantEntryId: "assistant-tool-entry",
        toolCallId: "authenticated-call",
        toolName: "read",
        identity,
      },
      sourceAuthentication,
    );
    source.manager.appendCustomEntry(piToolIdentityMarkerType, authenticated);
    source.manager.appendCustomEntry(piToolIdentityMarkerType, {
      ...authenticated,
      toolCallId: "tampered-call",
    });
    source.manager.appendCustomEntry(piToolIdentityMarkerType, {
      version: 2,
      assistantEntryId: "malformed",
    });
    source.manager.appendCustomEntry(
      piAgentToolInvocationMarkerType,
      createPiAgentToolInvocationMarker(
        {
          assistantEntryId: "assistant-tool-entry",
          toolCallId: "agent-tool-call",
          toolName: "sedes_reference_check",
          toolId: "reference.check",
          schemaVersion: 3,
          invocationId: "source-invocation",
        },
        sourceAuthentication,
      ),
    );
    const taskContext = {
      id: "10000000-0000-4000-8000-000000000001",
      scope: { kind: "global" as const },
      title: "Preserve this task",
      details: "The native branch keeps this immutable snapshot.",
      pinned: false,
      files: [],
      completedAt: null,
      revision: 2,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T13:00:00.000Z",
    };
    source.manager.appendCustomEntry(
      piTaskContextMarkerType,
      createPiTaskContextMarker(
        {
          applicationOperationId: "task-operation",
          requestFingerprint: "a".repeat(64),
          taskContexts: [taskContext],
        },
        sourceAuthentication,
      ),
    );
    const leafId = source.manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "complete" }],
      api: "test",
      provider: "test",
      model: "model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const target = await store.branch(
      fixture.workspace,
      "provenance-source",
      source.opaqueBindingDetail,
      leafId,
      toolProvenanceKey,
      "provenance-target",
      "provenance-branch",
      undefined,
    );
    const targetAuthentication = {
      conversationId: "provenance-target",
      installationKey: toolProvenanceKey,
    };
    const markers = target.manager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === piToolIdentityMarkerType,
      );

    expect(markers).toHaveLength(3);
    expect(
      readPiToolIdentityMarker(markers[0]!, targetAuthentication),
    ).toMatchObject({ status: "authenticated" });
    expect(readPiToolIdentityMarker(markers[0]!, sourceAuthentication)).toEqual(
      { status: "unauthenticated" },
    );
    expect(readPiToolIdentityMarker(markers[1]!, targetAuthentication)).toEqual(
      { status: "unauthenticated" },
    );
    expect(readPiToolIdentityMarker(markers[2]!, targetAuthentication)).toEqual(
      { status: "malformed" },
    );
    const invocationMarkers = target.manager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === piAgentToolInvocationMarkerType,
      );
    expect(invocationMarkers).toHaveLength(1);
    expect(
      readPiAgentToolInvocationMarker(
        invocationMarkers[0]!,
        targetAuthentication,
      ),
    ).toMatchObject({ status: "authenticated" });
    expect(
      readPiAgentToolInvocationMarker(
        invocationMarkers[0]!,
        sourceAuthentication,
      ),
    ).toEqual({ status: "unauthenticated" });
    const taskMarkers = target.manager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === piTaskContextMarkerType,
      );
    expect(taskMarkers).toHaveLength(1);
    expect(
      readPiTaskContextMarker(taskMarkers[0]!, targetAuthentication),
    ).toMatchObject({
      status: "authenticated",
      marker: { taskContexts: [taskContext] },
    });
    expect(
      readPiTaskContextMarker(taskMarkers[0]!, sourceAuthentication),
    ).toEqual({ status: "unauthenticated" });
  });

  it("rewrites copied historical Harness provenance to current Sedes types", async () => {
    const fixture = await workspace();
    const store = new PiSessionStore({ sessionDirectory: fixture.sessions });
    const source = await store.reserve(
      fixture.workspace,
      "legacy-provenance-source",
    );
    const legacyType = "harness.tool_identity.v2";
    source.manager.appendMessage({
      role: "user",
      content: "Use the historical tool",
      timestamp: Date.now(),
    });
    const assistantEntryId = source.manager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "legacy-call",
          name: "harness_reference_check",
          arguments: {},
        },
      ],
      api: "test",
      provider: "test",
      model: "model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    const fields = {
      assistantEntryId,
      toolCallId: "legacy-call",
      toolName: "harness_reference_check",
      identity: {
        registrationId:
          "harness:agent-tool:reference.check:3:harness_reference_check",
        origin: "harness_agent_tool",
        canonicalKind: "agent_tool",
        displayName: "Reference check",
        agentToolId: "reference.check",
        agentToolSchemaVersion: 3,
      },
    } as const;
    const tag = createHmac("sha256", toolProvenanceKey)
      .update(
        JSON.stringify([
          legacyType,
          "legacy-provenance-source",
          fields.assistantEntryId,
          fields.toolCallId,
          fields.toolName,
          [
            fields.identity.registrationId,
            fields.identity.origin,
            fields.identity.canonicalKind,
            fields.identity.displayName,
            null,
            fields.identity.agentToolId,
            fields.identity.agentToolSchemaVersion,
          ],
        ]),
        "utf8",
      )
      .digest("base64url");
    source.manager.appendCustomEntry(legacyType, {
      version: 2,
      ...fields,
      authentication: { algorithm: "hmac-sha256", tag },
    });
    const invocationType = "harness.agent_tool_invocation.v1";
    const invocationFields = {
      assistantEntryId,
      toolCallId: "legacy-call",
      toolName: "harness_reference_check",
      toolId: "reference.check",
      schemaVersion: 3,
      invocationId: "legacy-invocation",
    };
    source.manager.appendCustomEntry(invocationType, {
      version: 1,
      ...invocationFields,
      authentication: {
        algorithm: "hmac-sha256",
        tag: createHmac("sha256", toolProvenanceKey)
          .update(
            JSON.stringify([
              invocationType,
              "legacy-provenance-source",
              ...Object.values(invocationFields),
            ]),
            "utf8",
          )
          .digest("base64url"),
      },
    });
    source.manager.appendMessage({
      role: "toolResult",
      toolCallId: "legacy-call",
      toolName: "harness_reference_check",
      content: [{ type: "text", text: "done" }],
      isError: false,
      timestamp: Date.now(),
    });
    const leafId = appendBranchableSessionTurn(
      source.manager,
      "legacy provenance",
    );

    const target = await store.branch(
      fixture.workspace,
      "legacy-provenance-source",
      source.opaqueBindingDetail,
      leafId,
      toolProvenanceKey,
      "legacy-provenance-target",
      "legacy-provenance-operation",
    );
    const copied = target.manager
      .getBranch()
      .find(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === piToolIdentityMarkerType &&
          (entry.data as { toolCallId?: unknown }).toolCallId === "legacy-call",
      );
    expect(copied).toBeDefined();
    expect(
      readPiToolIdentityMarker(copied!, {
        conversationId: "legacy-provenance-target",
        installationKey: toolProvenanceKey,
      }),
    ).toMatchObject({ status: "authenticated" });
    expect(
      target.manager
        .getBranch()
        .some(
          (entry) => entry.type === "custom" && entry.customType === legacyType,
        ),
    ).toBe(false);
    const copiedMessages = target.manager
      .getBranch()
      .filter((entry) => entry.type === "message");
    expect(JSON.stringify(copiedMessages)).not.toContain(
      "harness_reference_check",
    );
    expect(JSON.stringify(copiedMessages)).toContain("sedes_reference_check");
    const projection = new PiHistoryProjector({
      toolIdentityAuthentication: {
        conversationId: "legacy-provenance-target",
        installationKey: toolProvenanceKey,
      },
    }).project(target.manager.getBranch());
    expect(
      projection.snapshot.itemsById[`${assistantEntryId}:0`],
    ).toMatchObject({
      agentToolInvocation: { invocationId: "legacy-invocation" },
    });
  });
});

describe("Pi interaction bridge", () => {
  it("buffers extension dialogs until the handle publisher exists and resolves by backend IDs", async () => {
    const bridge = new PiInteractionBridge();
    const pending = bridge.uiContext().select("Choose", ["one", "two"]);
    const events: BackendConversationEvent[] = [];
    bridge.setPublisher((event) => events.push(event));
    expect(events).toMatchObject([
      {
        type: "interaction_opened",
        interaction: {
          kind: "choice",
          destructive: true,
          options: [
            { backendOptionId: "0", label: { text: "one" } },
            { backendOptionId: "1", label: { text: "two" } },
          ],
        },
      },
    ]);
    const opened = events[0];
    if (opened?.type !== "interaction_opened") {
      throw new Error("expected interaction");
    }
    bridge.respond({
      applicationOperationId: "interaction-response-operation",
      interactionId: opened.interaction.backendInteractionId,
      kind: "choice",
      selectedOptionIds: ["1"],
    });
    bridge.respond({
      applicationOperationId: "interaction-response-operation",
      interactionId: opened.interaction.backendInteractionId,
      kind: "choice",
      selectedOptionIds: ["1"],
    });
    expect(() =>
      bridge.respond({
        applicationOperationId: "interaction-response-operation",
        interactionId: opened.interaction.backendInteractionId,
        kind: "choice",
        selectedOptionIds: ["0"],
      }),
    ).toThrow("replay_mismatch");
    await expect(pending).resolves.toBe("two");
    expect(events.at(-1)).toMatchObject({
      type: "interaction_resolved",
      backendInteractionId: opened.interaction.backendInteractionId,
    });
    bridge.close();
  });

  it("projects managed Pi tool approval as a semantic decision", async () => {
    const bridge = new PiInteractionBridge();
    const events: BackendConversationEvent[] = [];
    bridge.setPublisher((event) => events.push(event));
    const pending = bridge.requestToolApproval({
      title: "Pi tool approval",
      detail: "bash: ls\ncwd: /workspace",
    });
    const opened = events[0];
    if (opened?.type !== "interaction_opened") {
      throw new Error("expected interaction");
    }
    expect(opened.interaction).toMatchObject({
      kind: "decision",
      destructive: true,
      sourceLabel: { text: "Pi extension" },
      title: { text: "Pi tool approval" },
      message: { text: expect.stringContaining("bash: ls") },
      actions: [
        {
          backendActionId: "approve_once",
          label: { text: "Approve once" },
          role: "primary",
        },
        {
          backendActionId: "deny",
          label: { text: "Deny" },
          role: "reject",
        },
      ],
    });
    bridge.respond({
      applicationOperationId: "tool-approval-response",
      interactionId: opened.interaction.backendInteractionId,
      kind: "decision",
      selectedActionId: "approve_once",
    });
    await expect(pending).resolves.toBe("approve_once");
    bridge.close();
  });

  it("keeps ordinary extension choices generic even when labels resemble approval", async () => {
    const bridge = new PiInteractionBridge();
    const events: BackendConversationEvent[] = [];
    bridge.setPublisher((event) => events.push(event));
    const pending = bridge
      .uiContext()
      .select("Ordinary choice", ["Approve once", "Deny"]);
    const opened = events[0];
    if (opened?.type !== "interaction_opened") {
      throw new Error("expected interaction");
    }
    expect(opened.interaction).toMatchObject({
      kind: "choice",
      options: [
        { backendOptionId: "0", label: { text: "Approve once" } },
        { backendOptionId: "1", label: { text: "Deny" } },
      ],
    });
    bridge.respond({
      applicationOperationId: "ordinary-choice-response",
      interactionId: opened.interaction.backendInteractionId,
      kind: "choice",
      selectedOptionIds: ["0"],
    });
    await expect(pending).resolves.toBe("Approve once");
    bridge.close();
  });

  it("rejects an action outside the managed Pi approval decision", async () => {
    const bridge = new PiInteractionBridge();
    const events: BackendConversationEvent[] = [];
    bridge.setPublisher((event) => events.push(event));
    const pending = bridge.requestToolApproval({
      title: "Pi tool approval",
      detail: "bash: ls",
    });
    const opened = events[0];
    if (opened?.type !== "interaction_opened") {
      throw new Error("expected interaction");
    }
    expect(() =>
      bridge.respond({
        applicationOperationId: "invalid-tool-approval-response",
        interactionId: opened.interaction.backendInteractionId,
        kind: "decision",
        selectedActionId: "approve_always",
      }),
    ).toThrow("pi_interaction_decision_invalid");
    expect(bridge.hasPending(opened.interaction.backendInteractionId)).toBe(
      true,
    );
    bridge.close();
    await expect(pending).resolves.toBeUndefined();
  });

  it("cancels bootstrap dialogs in headless catalog/read sessions", async () => {
    const bridge = new PiInteractionBridge({
      cancelUnpublishedRequests: true,
    });
    await expect(
      bridge.uiContext().confirm("Startup", "Continue?"),
    ).resolves.toBe(false);
    bridge.close();
  });

  it("keeps an unanswered tool approval pending after arbitrary elapsed time", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new PiInteractionBridge();
      const events: BackendConversationEvent[] = [];
      bridge.setPublisher((event) => events.push(event));
      const pending = bridge.requestToolApproval({
        title: "Pi tool approval",
        detail: "bash: sleep 1",
      });
      const opened = events[0];
      if (opened?.type !== "interaction_opened") {
        throw new Error("expected interaction");
      }
      await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1_000);
      expect(bridge.hasPending(opened.interaction.backendInteractionId)).toBe(
        true,
      );
      expect(events).toHaveLength(1);
      bridge.respond({
        applicationOperationId: "late-tool-approval-response",
        interactionId: opened.interaction.backendInteractionId,
        kind: "decision",
        selectedActionId: "approve_once",
      });
      await expect(pending).resolves.toBe("approve_once");
      expect(events.at(-1)).toMatchObject({
        type: "interaction_resolved",
      });
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a pending approval exactly once when the bridge closes", async () => {
    const bridge = new PiInteractionBridge();
    const events: BackendConversationEvent[] = [];
    bridge.setPublisher((event) => events.push(event));
    const pending = bridge.requestToolApproval({
      title: "Pi tool approval",
      detail: "bash: ls",
    });
    const opened = events[0];
    if (opened?.type !== "interaction_opened") {
      throw new Error("expected interaction");
    }
    bridge.close();
    await expect(pending).resolves.toBeUndefined();
    expect(
      events.filter((event) => event.type === "interaction_resolved"),
    ).toHaveLength(1);
    expect(() =>
      bridge.respond({
        applicationOperationId: "after-close",
        interactionId: opened.interaction.backendInteractionId,
        kind: "decision",
        selectedActionId: "approve_once",
      }),
    ).toThrow();
  });
});

describe("Pi conversation backend driver", () => {
  it("records live assistant and tool usage after the pinned SDK persists message_end without entry_appended", async () => {
    const fixture = await workspace();
    const agentDir=path.join(fixture.root,"agent");await mkdir(agentDir);
    await writeFile(path.join(agentDir,"settings.json"),JSON.stringify({cacheWarming:"off"}));
    const bindExtensions=vi.spyOn(AgentSession.prototype,"bindExtensions");
    const current=savedAgentDatabase(), database=current.database, owner=current.scope;
    const profile=new BackendConfigurationRepository(database).listProfiles(owner)[0]!;
    const dbWorkspace=new InventoryRepository(database).upsertWorkspace(owner,{environmentId:profile.executionEnvironmentId,canonicalPath:fixture.workspace.canonicalPath,displayName:"Usage fixture",available:true,trustState:"trusted",environmentConfigurationRevision:0,now:1});
    const thread=new ConversationBindingRepository(database).createUnboundThread(owner,{workspaceId:dbWorkspace.id,connectionProfileId:profile.id,title:"Usage fixture",now:1});
    const sdkWorkspace={...fixture.workspace,summary:{...fixture.workspace.summary,id:dbWorkspace.id,environmentId:profile.executionEnvironmentId}};
    const usage=new UsageService(database, {enabled: true}), observations:UsageObservation[]=[];
    const fixtureInstance={...instance,tenantId:owner.tenantId,id:profile.backendInstanceId};
    const fixtureConnection={...profile,enabled:profile.enabled===1};
    const driver=new PiConversationBackendDriver({instance:fixtureInstance,connection:fixtureConnection,usage:{enabled: true, findSubagent: () => null, listSubagentRoots: () => ({bindings:[],nextCursor:null}), listSubagents: input => usage.listSubagents(input), open:source=>{const capture=usage.open(source);return {...capture,capture:batch=>{observations.push(...batch);return capture.capture(batch);}};}},nativeDiscoveryNamespaceKey:"pi-test-native-namespace",toolProvenanceKey,agentTools:noAgentTools,toolAccessPolicy:fullToolAccessPolicy,sessionDirectory:fixture.sessions,sessionFactory:new DefaultPiSdkSessionFactory({agentDir})});
    const created=await driver.create({scope:owner,workspace:sdkWorkspace,applicationThreadId:thread.id,applicationOperationId:"sdk-usage-create",source:{kind:"user"}});
    database.prepare("UPDATE application_threads SET backing_state='bound' WHERE id=?").run(thread.id);
    database.prepare("INSERT INTO conversation_bindings(tenant_id,owner_principal_id,application_thread_id,backend_instance_id,connection_profile_id,execution_environment_id,backend_conversation_id,created_at) VALUES(?,?,?,?,?,?,?,?)").run(owner.tenantId,owner.principalId,thread.id,profile.backendInstanceId,profile.id,profile.executionEnvironmentId,created.backendConversationId,1);
    const nativeBinding={tenantId:owner.tenantId,ownerPrincipalId:owner.principalId,applicationThreadId:thread.id,backendInstanceId:profile.backendInstanceId,connectionProfileId:profile.id,executionEnvironmentId:profile.executionEnvironmentId,backendConversationId:created.backendConversationId,createdAt:new Date(1).toISOString()};
    const handle=await driver.attach({scope:owner,workspace:sdkWorkspace,binding:nativeBinding,opaqueBindingDetail:created.opaqueBindingDetail});
    try {
      const projection=await handle.establishProjection({signal:new AbortController().signal});
      const events:BackendConversationEvent[]=[];projection.subscribeFromNext(({event})=>events.push(event));
      const native=bindExtensions.mock.instances.at(-1)! as AgentSession;
      const rawEvents:string[]=[];native.subscribe(event=>rawEvents.push(event.type));
      // Exercise the pinned SDK's actual event/persistence ordering without a provider request.
      const sdk=native as unknown as {_handleAgentEvent(event:unknown):Promise<void>;_emitAgentSettled():Promise<void>;_emit(event:unknown):void};
      await sdk._handleAgentEvent({type:"agent_start"});
      await sdk._handleAgentEvent({type:"message_end",message:{role:"user",content:"Question",timestamp:1}});
      const nativeUsage={input:11,output:7,cacheRead:3,cacheWrite:2,totalTokens:23,cost:{input:0.0001,output:0.0001,cacheRead:0,cacheWrite:0,total:0.0002}};
      const assistant={role:"assistant",content:[{type:"toolCall",id:"fixture-tool",name:"fixture",arguments:{}}],api:"openai-completions",provider:"fixture",model:"fixture-model",usage:nativeUsage,stopReason:"toolUse",timestamp:2};
      await sdk._handleAgentEvent({type:"message_start",message:assistant});
      await sdk._handleAgentEvent({type:"message_end",message:assistant});
      await sdk._handleAgentEvent({type:"message_end",message:{role:"toolResult",toolCallId:"fixture-tool",toolName:"fixture",content:[{type:"text",text:"Result"}],isError:false,timestamp:3,usage:nativeUsage}});
      const finalAssistant={...assistant,content:[{type:"text",text:"Answer"}],stopReason:"stop",timestamp:4};
      await sdk._handleAgentEvent({type:"message_start",message:finalAssistant});
      await sdk._handleAgentEvent({type:"message_end",message:finalAssistant});
      await sdk._emitAgentSettled();
      expect(rawEvents).not.toContain("entry_appended");
      const started=events.find(event=>event.type==="turn_started");
      expect(started?.type).toBe("turn_started");
      const turnId=started?.type==="turn_started"?started.turn.backendTurnId:"missing";
      expect(observations).toHaveLength(3);
      expect(observations.map(observation=>observation.facts[0]!.turn?.backendTurnId)).toEqual([turnId,turnId,turnId]);
      expect(observations.map(observation=>observation.facts[0]!.activity)).toEqual(["model","tool","model"]);
      expect(observations[0]!.facts[0]).toMatchObject({tokens:{input:"16",output:"7",requests:"1"},costs:[{amount:"0.0002"}]});
      const applicationTurnId=applicationTurnIdForBackendTurn({backendInstanceId:profile.backendInstanceId,sourceApplicationThreadId:thread.id,backendTurnId:turnId});
      expect(database.prepare("SELECT count(*) AS count FROM usage_records WHERE turn_id=?").get(applicationTurnId)).toEqual({count:3});
      expect(usage.read(owner,thread.id,applicationTurnId)).toMatchObject({state:"complete",turnState:"completed",captureState:"active",measurementScope:"whole_turn",summary:{reasons:[],metrics:{input:{value:"48"},output:{value:"21"},requests:{value:"2"}},costs:[{amount:"0.0006"}]}});
      expect(usage.read(owner,thread.id).summary.metrics.input.value).toBe("48");
      native.sessionManager.appendCompaction("Summary",turnId,23,undefined,false,nativeUsage);
      sdk._emit({type:"compaction_end",reason:"manual",result:{summary:"Summary",firstKeptEntryId:turnId,tokensBefore:23,usage:nativeUsage},aborted:false,willRetry:false});
      expect(observations).toHaveLength(4);
      expect(observations[3]!.facts[0]).toMatchObject({activity:"compaction",turn:null,tokens:{input:"16",output:"7"}});
      expect(usage.read(owner,thread.id).summary.metrics.input.value).toBe("64");
      expect(usage.read(owner,thread.id,applicationTurnId).summary.metrics.input.value).toBe("48");
    } finally {await handle.close();database.close();bindExtensions.mockRestore();}
  });

  it.each([
    { kind: "cache_warm", running: false },
    { kind: "cache_warm", running: true },
    { kind: "extension_aggregate", running: false },
  ])("publishes $kind context while running=$running with accounting disabled", async ({ kind, running }) => {
    const fixture = await workspace();
    const reconcile = vi.spyOn(PiUsageAccounting.prototype, "reconcile");
    const append = vi.spyOn(PiUsageAccounting.prototype, "append");
    const baseFactory = fakeSessionFactory();
    let nativeListener!: Parameters<PiSdkSession["subscribe"]>[0];
    let manager!: PiSdkSession["sessionManager"];
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: {
        async create(input) {
          manager = input.manager;
          const session = await baseFactory.create(input);
          return {
            ...session,
            subscribe(listener) {
              nativeListener = listener;
              return session.subscribe(listener);
            },
            getSessionStats() {
              const stats = session.getSessionStats();
              const entries = manager
                .getEntries()
                .filter((entry) => entry.type === "usage");
              return {
                ...stats,
                cost: entries.reduce(
                  (sum, entry) => sum + entry.usage.cost.total,
                  stats.cost,
                ),
                tokens: {
                  ...stats.tokens,
                  total: entries.reduce(
                    (sum, entry) => sum + entry.usage.totalTokens,
                    stats.tokens.total,
                  ),
                },
              };
            },
          };
        },
      },
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "cache-usage",
      applicationOperationId: "cache-usage-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    try {
      const projection = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      const events: BackendConversationEvent[] = [];
      projection.subscribeFromNext(({ event }) => events.push(event));
      if (running) nativeListener({ type: "agent_start" });
      events.length = 0;
      const entry = manager.appendUsage(kind, "test", "model", {
        input: 0,
        output: 1,
        cacheRead: 100,
        cacheWrite: 0,
        totalTokens: 101,
        cost: { input: 0, output: 0.1, cacheRead: 0.4, cacheWrite: 0, total: 0.5 },
      });
      nativeListener({ type: "entry_appended", entry });
      expect(events).toEqual([
        {
          type: "usage_changed",
          usage: expect.objectContaining({
            counters: expect.objectContaining({
              assistantMessages: 0,
              totalMessages: 0,
            }),
          }),
        },
      ]);
      const usage = await handle.usage();
      expect(usage.counters).not.toHaveProperty("requests");
      expect(events[0]).toEqual({ type: "usage_changed", usage });

      // Repeated notification rereads the aggregate instead of double-counting.
      nativeListener({ type: "entry_appended", entry });
      expect(events[1]).toEqual(events[0]);
      await handle.close();
      const afterClose = events.length;
      nativeListener({ type: "entry_appended", entry });
      expect(events).toHaveLength(afterClose);
      expect(reconcile).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    } finally {
      await handle.close();
      reconcile.mockRestore(); append.mockRestore();
    }
  });

  it("rejects oversized accumulated live text without publishing a clipped or oversized item", async () => {
    const fixture = await workspace();
    const chunks = ["safe prefix", "x".repeat(16 * 1024 * 1024)];
    const driver = new PiConversationBackendDriver({
      instance, connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey, agentTools: noAgentTools, toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1, false, undefined, 0, undefined, 0, undefined, undefined,
        undefined, undefined, undefined, false, false, undefined, undefined, chunks,
      ),
    });
    const created = await driver.create({
      scope, workspace: fixture.workspace, applicationThreadId: "oversized-live",
      applicationOperationId: "oversized-live-create", source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope, workspace: fixture.workspace, binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    try {
      const baseline = await handle.establishProjection({ signal: new AbortController().signal });
      const events: BackendConversationEvent[] = [];
      const unsubscribe = baseline.subscribeFromNext(({ event }) => events.push(event));
      await handle.submit({
        applicationOperationId: "oversized-live-submit", mutationId: "oversized-live-submit",
        reconciliationToken: "oversized-live-submit", source: { kind: "user" },
        contextExcerpts: [], attachments: [], taskContexts: [], text: "prompt",
      });
      await vi.waitFor(() => expect(events).toContainEqual({
        type: "resnapshot_required", reason: "contradictory_state",
      }));
      const assistantTexts = events.flatMap((event) =>
        (event.type === "item_started" || event.type === "item_updated" || event.type === "item_completed") &&
        event.item.semanticKind === "assistant_message" ? [event.item.markdown.text] : [],
      );
      expect(assistantTexts).toContain("safe prefix");
      expect(assistantTexts.every((text) => text === "" || text === "safe prefix")).toBe(true);
      unsubscribe();
      await expect(handle.establishProjection({ signal: new AbortController().signal })).rejects.toMatchObject({
        category: "incompatible_protocol", retryable: false, backendCode: "pi_message_payload_too_large",
      });
    } finally {
      await handle.close();
    }
  });

  it("preserves long Unicode assistant updates and their completed history", async () => {
    const fixture = await workspace();
    const chunks = ["assistant 雪🙂\n".repeat(10_000), "after the former cutoff"];
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1, false, undefined, 0, undefined, 0, undefined, undefined,
        undefined, undefined, undefined, false, false, undefined, undefined, chunks,
      ),
    });
    const created = await driver.create({
      scope, workspace: fixture.workspace, applicationThreadId: "long-text",
      applicationOperationId: "long-text-create", source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope, workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    try {
      const baseline = await handle.establishProjection({ signal: new AbortController().signal });
      const items: string[] = [];
      const unsubscribe = baseline.subscribeFromNext(({ event }) => {
        if ((event.type === "item_started" || event.type === "item_updated" || event.type === "item_completed") &&
          event.item.semanticKind === "assistant_message") items.push(event.item.markdown.text);
      });
      await handle.submit({
        applicationOperationId: "long-text-submit", mutationId: "long-text-submit",
        reconciliationToken: "long-text-submit", source: { kind: "user" },
        contextExcerpts: [], attachments: [], taskContexts: [], text: "Preserve the whole response.",
      });
      await vi.waitFor(() => expect(items).toContain(chunks.join("")));
      expect(items).toContain(chunks[0]);
      unsubscribe();
      const completed = await handle.establishProjection({ signal: new AbortController().signal });
      expect(Object.values(completed.snapshot.itemsById)).toContainEqual(expect.objectContaining({
        semanticKind: "assistant_message", markdown: { text: chunks.join("") },
      }));
    } finally {
      await handle.close();
    }
  });

  it("uses a thread-scoped isolated workspace and owns its active lease", async () => {
    const fixture = await workspace();
    const isolatedPath = path.join(fixture.root, "isolated", "workspace");
    await mkdir(isolatedPath, { recursive: true });
    const effectiveWorkspace: ValidatedWorkspace = {
      ...fixture.workspace,
      canonicalPath: await realpath(isolatedPath),
    };
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const isSelected = vi.fn(() => true);
    const resolve = vi.fn(
      async (input: { access: "passive" | "prepare" | "active" }) => {
        const release = vi.fn(async () => undefined);
        releases.push(release);
        if (input.access === "active") {
          return {
            access: "active" as const,
            workspaceAccess: "read_write" as const,
            effectiveWorkspace,
            semanticCwd: "/home/agent",
            serviceCwd: path.join(fixture.root, "isolated", "home"),
            executor: {} as never,
            contextReader: {} as never,
            environmentLabel: "Isolated",
            release,
          };
        }
        if (input.access === "passive") {
          return {
            access: "passive" as const,
            workspaceAccess: "read_write" as const,
            effectiveWorkspace,
            release,
          };
        }
        return {
          access: "prepare" as const,
          workspaceAccess: "read_write" as const,
          effectiveWorkspace,
          release,
        };
      },
    );
    const base = fakeSessionFactory();
    const createInputs: Parameters<PiSdkSessionFactory["create"]>[0][] = [];
    let failSessionCreate = false;
    const sessionFactory: PiSdkSessionFactory = {
      async create(input) {
        createInputs.push(input);
        if (failSessionCreate) throw new Error("isolated_session_failed");
        const session = await base.create(input);
        let active: string[] = [];
        const names = ["bash", "read", "write", "edit", "grep", "find", "ls"];
        const allTools = [
          ...names.map((name) => ({
            name,
            description: name,
            parameters: {},
            promptGuidelines: [],
            sourceInfo: { source: "sdk", path: `<sdk:${name}>` },
          })),
          ...(input.customTools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            promptGuidelines: tool.promptGuidelines ?? [],
            sourceInfo: { source: "sdk", path: `<sdk:${tool.name}>` },
          })),
        ] as unknown as ReturnType<PiSdkSession["getAllTools"]>;
        return {
          ...session,
          isolatedWorkspace: input.isolatedWorkspace !== undefined,
          trustedBuiltinOverrides: new Set(names) as never,
          getAllTools: () => allTools,
          getActiveToolNames: () => [...active],
          setActiveToolsByName(names) {
            active = [...names];
          },
        };
      },
    };
    const cliCapabilities = createFakeAgentToolSourceCapabilities();
    const store = new PiSessionStore({ sessionDirectory: fixture.sessions });
    const openPersisted = vi.spyOn(store, "openPersisted");
    const list = vi.spyOn(store, "list");
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      agentToolSourceCapabilities: cliCapabilities.issuer,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      store,
      sessionFactory,
      isolatedWorkspaces: { isSelected, resolve },
      agentToolCli: {
        availability: "available",
        endpoint: "http://127.0.0.1:4784",
        executableDirectory: "/opt/sedes/bin",
        inheritedPath: "/usr/bin",
      },
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "thread",
      applicationOperationId: "isolated-create",
      source: { kind: "user" },
    });
    expect(resolve).toHaveBeenNthCalledWith(1, {
      scope,
      applicationThreadId: "thread",
      sourceWorkspace: fixture.workspace,
      access: "prepare",
    });
    expect(releases[0]).toHaveBeenCalledOnce();

    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId, "thread"),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    expect(resolve).toHaveBeenNthCalledWith(2, {
      scope,
      applicationThreadId: "thread",
      sourceWorkspace: fixture.workspace,
      access: "active",
    });
    expect(createInputs).toHaveLength(1);
    expect(createInputs[0]).toMatchObject({
      workspace: effectiveWorkspace,
      isolatedWorkspace: {
        semanticCwd: "/home/agent",
        environmentLabel: "Isolated",
      },
    });
    expect(createInputs[0]!.customTools?.map(({ name }) => name)).toEqual([
      "sedes_catalog",
      "sedes_read",
      "sedes_act",
    ]);
    expect(createInputs[0]!.cliEnvironment).toBeUndefined();
    expect(cliCapabilities.issue).not.toHaveBeenCalled();
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      branching: { availability: "unavailable" },
    });
    openPersisted.mockClear();
    await expect(
      driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: binding(created.backendConversationId, "thread"),
        applicationOperationId: "isolated-missing-submission",
      }),
    ).resolves.toMatchObject({ status: "unresolved" });
    expect(resolve).toHaveBeenNthCalledWith(3, {
      scope,
      applicationThreadId: "thread",
      sourceWorkspace: fixture.workspace,
      access: "passive",
    });
    expect(openPersisted).toHaveBeenCalledWith(
      effectiveWorkspace,
      created.backendConversationId,
    );
    expect(releases[2]).toHaveBeenCalledOnce();

    openPersisted.mockRejectedValueOnce(
      new Error("isolated_reconciliation_failed"),
    );
    await expect(
      driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: binding(created.backendConversationId, "thread"),
        applicationOperationId: "isolated-failed-reconciliation",
      }),
    ).rejects.toMatchObject({ backendCode: "pi_operation_failed" });
    expect(releases[3]).toHaveBeenCalledOnce();

    list.mockClear();
    await expect(
      driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        applicationOperationId: "unbound-source-scan",
      }),
    ).resolves.toMatchObject({ status: "unresolved" });
    expect(list).toHaveBeenCalledWith(fixture.workspace);
    expect(resolve).toHaveBeenCalledTimes(4);

    expect(releases[1]).not.toHaveBeenCalled();
    await handle.close();
    expect(releases[1]).toHaveBeenCalledOnce();

    await expect(
      driver.read({
        scope,
        workspace: fixture.workspace,
        binding: binding(created.backendConversationId, "thread"),
        opaqueBindingDetail: created.opaqueBindingDetail,
      }),
    ).resolves.toMatchObject({ snapshot: { runState: "idle" } });
    expect(resolve).toHaveBeenNthCalledWith(5, {
      scope,
      applicationThreadId: "thread",
      sourceWorkspace: fixture.workspace,
      access: "passive",
    });
    expect(createInputs[1]).toMatchObject({
      workspace: effectiveWorkspace,
      isolatedWorkspace: {
        semanticCwd: "/home/agent",
        environmentLabel: "Isolated workspace",
      },
    });
    await expect(
      createInputs[1]!.isolatedWorkspace!.executor.read({ path: "README.md" }),
    ).rejects.toMatchObject({ code: "workspace_tools_unavailable" });
    expect(releases[4]).toHaveBeenCalledOnce();

    const failedCreated = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "failed-thread",
      applicationOperationId: "failed-isolated-create",
      source: { kind: "user" },
    });
    failSessionCreate = true;
    await expect(
      driver.attach({
        scope,
        workspace: fixture.workspace,
        binding: binding(failedCreated.backendConversationId, "failed-thread"),
        opaqueBindingDetail: failedCreated.opaqueBindingDetail,
      }),
    ).rejects.toMatchObject({ backendCode: "pi_operation_failed" });
    expect(releases[5]).toHaveBeenCalledOnce();
    expect(releases[6]).toHaveBeenCalledOnce();
  });

  it("uses the thread Sedes policy for isolated native tools without admitting CLI authority", async () => {
    const fixture = await workspace();
    const isolatedPath = path.join(fixture.root, "isolated-agent-tools");
    await mkdir(isolatedPath, { recursive: true });
    const effectiveWorkspace: ValidatedWorkspace = {
      ...fixture.workspace,
      canonicalPath: await realpath(isolatedPath),
    };
    const executor = {} as never;
    const contextReader = {} as never;
    const resolve = vi.fn(
      async (input: { access: "passive" | "prepare" | "active" }) => {
        const resolution = {
          effectiveWorkspace,
          workspaceAccess: "read_write" as const,
          release: async () => undefined,
        };
        if (input.access === "active") {
          return {
            access: "active" as const,
            ...resolution,
            semanticCwd: "/home/agent",
            serviceCwd: path.join(fixture.root, "isolated-service"),
            executor,
            contextReader,
            environmentLabel: "Isolated",
          };
        }
        if (input.access === "passive") {
          return { access: "passive" as const, ...resolution };
        }
        return { access: "prepare" as const, ...resolution };
      },
    );
    const registry = new AgentToolRegistry();
    registry.register(agentContextToolDefinition);
    const readContract = registry.artifact(
      agentContextToolDefinition.id,
      agentContextToolDefinition.schemaVersion,
    );
    const actionContract = {
      ...readContract,
      id: "workspace.mutate",
      effects: {
        application: "write" as const,
        modelUsage: "none" as const,
        external: "none" as const,
      },
      adapters: {
        ...readContract.adapters,
        pi: {
          name: "sedes_workspace_mutate",
          label: "Sedes workspace mutation",
        },
      },
    };
    let enabled = true;
    let enabledToolIds = [readContract.id, actionContract.id];
    let presentation:
      | { surface: "cli"; mode: "progressive" }
      | { surface: "native"; mode: "individual" | "progressive" } = {
      surface: "native",
      mode: "individual",
    };
    const readPolicy = vi.fn(() => ({
      enabled,
      presentation,
      accessBoundary: "environment" as const,
      enabledToolIds,
    }));
    const facade = {
      eligibleCatalog: () => [readContract, actionContract],
      catalogSummaries: () => [],
      describeMany: () => [],
      readPolicy,
      invoke: async () => {
        throw new Error("unexpected_agent_tool_invocation");
      },
    } satisfies BackendAgentToolFacade;
    const base = fakeSessionFactory();
    const createInputs: Parameters<PiSdkSessionFactory["create"]>[0][] = [];
    const protectedNameInputs: Array<readonly string[] | undefined> = [];
    const appliedSelections: string[][] = [];
    const sessionFactory: PiSdkSessionFactory = {
      async create(input) {
        createInputs.push(input);
        protectedNameInputs.push(
          input.protectedAgentToolNames
            ? [...input.protectedAgentToolNames]
            : undefined,
        );
        const session = await base.create(input);
        let active: string[] = [];
        const allTools = [
          ...PI_EXECUTOR_BUILTIN_TOOL_NAMES.map((name) => ({
            name,
            description: name,
            parameters: {},
            promptGuidelines: [],
            sourceInfo: { source: "sdk", path: `<sdk:${name}>` },
          })),
          ...(input.customTools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            promptGuidelines: tool.promptGuidelines ?? [],
            sourceInfo: { source: "sdk", path: `<sdk:${tool.name}>` },
          })),
        ] as unknown as ReturnType<PiSdkSession["getAllTools"]>;
        return {
          ...session,
          isolatedWorkspace: input.isolatedWorkspace !== undefined,
          trustedBuiltinOverrides: new Set(
            PI_EXECUTOR_BUILTIN_TOOL_NAMES,
          ) as never,
          getAllTools: () => allTools,
          getActiveToolNames: () => [...active],
          setActiveToolsByName(names) {
            active = [...names];
            appliedSelections.push([...names]);
          },
        };
      },
    };
    const cliCapabilities = createFakeAgentToolSourceCapabilities();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: facade,
      agentToolSourceCapabilities: cliCapabilities.issuer,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory,
      isolatedWorkspaces: { isSelected: () => true, resolve },
      agentToolCli: {
        availability: "available",
        endpoint: "http://127.0.0.1:4784",
        executableDirectory: "/opt/sedes/bin",
        inheritedPath: "/usr/bin",
      },
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "isolated-agent-tools",
      applicationOperationId: "isolated-agent-tools-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId, "isolated-agent-tools"),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });

    expect(createInputs).toHaveLength(1);
    expect(createInputs[0]!.isolatedWorkspace).toMatchObject({
      executor,
      contextReader,
    });
    expect(createInputs[0]!.customTools?.map(({ name }) => name)).toEqual([
      "sedes_agent_context",
      "sedes_workspace_mutate",
      "sedes_catalog",
      "sedes_read",
      "sedes_act",
    ]);
    expect(protectedNameInputs).toEqual([
      ["sedes_workspace_mutate", "sedes_act"],
    ]);
    expect(createInputs[0]!.cliEnvironment).toBeUndefined();
    expect(cliCapabilities.issue).not.toHaveBeenCalled();
    expect(appliedSelections.at(-1)).toEqual([
      ...PI_EXECUTOR_BUILTIN_TOOL_NAMES,
      "sedes_agent_context",
      "sedes_workspace_mutate",
    ]);

    enabledToolIds = [readContract.id];
    await handle.perform({
      applicationOperationId: "isolated-agent-tools-ask",
      action: "set_tool_access",
      mode: "ask",
    });
    expect(appliedSelections.at(-1)).toEqual([
      ...PI_EXECUTOR_BUILTIN_TOOL_NAMES,
      "sedes_agent_context",
    ]);

    enabledToolIds = [readContract.id, actionContract.id];
    presentation = { surface: "native", mode: "progressive" };
    await handle.perform({
      applicationOperationId: "isolated-agent-tools-progressive",
      action: "set_tool_access",
      mode: "full",
    });
    expect(appliedSelections.at(-1)).toEqual([
      ...PI_EXECUTOR_BUILTIN_TOOL_NAMES,
      "sedes_catalog",
      "sedes_read",
      "sedes_act",
    ]);

    enabled = false;
    await handle.perform({
      applicationOperationId: "isolated-agent-tools-disabled",
      action: "set_tool_access",
      mode: "ask",
    });
    expect(appliedSelections.at(-1)).toEqual([
      ...PI_EXECUTOR_BUILTIN_TOOL_NAMES,
    ]);

    enabled = true;
    presentation = { surface: "cli", mode: "progressive" };
    await handle.perform({
      applicationOperationId: "isolated-agent-tools-cli",
      action: "set_tool_access",
      mode: "full",
    });
    expect(appliedSelections.at(-1)).toEqual([
      ...PI_EXECUTOR_BUILTIN_TOOL_NAMES,
    ]);
    expect(cliCapabilities.issue).not.toHaveBeenCalled();
    expect(readPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceThreadId: "isolated-agent-tools",
        sourceWorkspaceId: fixture.workspace.summary.id,
        sourceEnvironmentId: fixture.workspace.summary.environmentId,
      }),
    );
    await handle.close();
  });

  it("rejects isolated branch resolution before materializing a workspace", async () => {
    const fixture = await workspace();
    const isSelected = vi.fn(() => true);
    const resolve = vi.fn(async () => {
      throw new Error("isolated_workspace_must_not_resolve");
    });
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
      isolatedWorkspaces: { isSelected, resolve },
    });
    const sourceBinding = binding("isolated-source", "isolated-thread");

    await expect(
      driver.resolveBranchCheckpoint({
        scope,
        workspace: fixture.workspace,
        binding: sourceBinding,
        opaqueBindingDetail: "isolated-source-binding",
        selection: { kind: "latest_completed" },
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      backendCode: "pi_isolated_fork_unsupported",
    });
    await expect(
      driver.branchConversation({
        scope,
        workspace: fixture.workspace,
        applicationOperationId: "isolated-branch",
        childApplicationThreadId: "isolated-child-thread",
        source: { kind: "user" },
        sourceBinding,
        sourceOpaqueBindingDetail: "isolated-source-binding",
        sourceCheckpoint: {
          backendInstanceId: instance.id,
          kind: "conversation_leaf",
          opaqueReference: JSON.stringify({ version: 1, entryId: "leaf" }),
        },
        requestedBackendConversationId: "isolated-child",
        inheritedSettings: { toolAccess: "full" },
      }),
    ).rejects.toMatchObject({
      category: "unavailable",
      backendCode: "pi_isolated_fork_unsupported",
    });
    expect(isSelected).toHaveBeenCalledTimes(2);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("reserves attachment ownership before asynchronous session establishment", async () => {
    const fixture = await workspace();
    const base = fakeSessionFactory();
    let unblockFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });
    let createAttempts = 0;
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: {
        async create(input) {
          createAttempts += 1;
          if (createAttempts === 1) await firstGate;
          return base.create(input);
        },
      },
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "thread",
      applicationOperationId: "concurrent-attach-create",
      source: { kind: "user" },
    });
    const attachInput = {
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    };

    const first = driver.attach(attachInput);
    await vi.waitFor(() => expect(createAttempts).toBe(1));
    await expect(driver.attach(attachInput)).rejects.toMatchObject({
      category: "invalid_state",
      backendCode: "pi_conversation_already_attached",
    });
    expect(createAttempts).toBe(1);
    unblockFirst();
    const handle = await first;
    await handle.close();
  });

  it("clears a failed attachment reservation for a later retry", async () => {
    const fixture = await workspace();
    const base = fakeSessionFactory();
    let createAttempts = 0;
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: {
        async create(input) {
          createAttempts += 1;
          if (createAttempts === 1) {
            throw new Error("first_attach_failed");
          }
          return base.create(input);
        },
      },
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "thread",
      applicationOperationId: "retry-attach-create",
      source: { kind: "user" },
    });
    const attachInput = {
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    };

    await expect(driver.attach(attachInput)).rejects.toMatchObject({
      backendCode: "pi_operation_failed",
    });
    const handle = await driver.attach(attachInput);
    expect(createAttempts).toBe(2);
    await handle.close();
  });

  it("uses canonical scoped bytes for native images without reading agentPath", async () => {
    const fixture = await workspace();
    const bytes = Buffer.from("img");
    let promptImages: unknown;
    const base = fakeSessionFactory();
    const sessionFactory: PiSdkSessionFactory = {
      async create(input) {
        const session = await base.create(input);
        return {
          ...session,
          model: {
            provider: "test",
            id: "model",
            input: ["text", "image"] as const,
          },
          async prompt(text, options) {
            promptImages = options.images;
            return session.prompt(text, options);
          },
        };
      },
    };
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory,
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "canonical-image-create",
      applicationOperationId: "canonical-image-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    await handle.establishProjection({ signal: new AbortController().signal });
    const attachment = {
      id: crypto.randomUUID(),
      kind: "image" as const,
      fileName: "image.png",
      mediaType: "image/png" as const,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      agentPath: "/remote/ssh/.sedes-attachments/image.png",
    };
    const read = vi.fn(async () => bytes);

    await handle.submit({
      applicationOperationId: "canonical-image-submit",
      source: { kind: "user" },
      mutationId: "canonical-image-submit",
      reconciliationToken: "canonical-image-submit",
      contextExcerpts: [],
      attachments: [attachment],
      attachmentBytes: { read },
      taskContexts: [],
      text: "inspect",
    });

    expect(read).toHaveBeenCalledWith(attachment);
    expect(promptImages).toEqual([
      {
        type: "image",
        data: bytes.toString("base64"),
        mimeType: "image/png",
      },
    ]);
    await handle.close();
  });

  it.each([
    ["with text", "inspect this", "resolved:opaque-review-skill inspect this"],
    ["without text", "", "resolved:opaque-review-skill"],
  ])(
    "resolves a selected skill %s into Pi's native prompt before submission",
    async (_label, text, expectedPrompt) => {
      const fixture = await workspace();
      const prompts: string[] = [];
      const driver = new PiConversationBackendDriver({
        instance,
        connection,
        usage: NO_USAGE_SINK,
        nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
        toolProvenanceKey,
        agentTools: noAgentTools,
        toolAccessPolicy: fullToolAccessPolicy,
        sessionDirectory: fixture.sessions,
        sessionFactory: fakeSessionFactory(
          1,
          false,
          () => undefined,
          0,
          undefined,
          0,
          undefined,
          (text) => {
            prompts.push(text);
            return [text];
          },
        ),
      });
      const created = await driver.create({
        scope,
        workspace: fixture.workspace,
        applicationThreadId: "skill-submit-create",
        applicationOperationId: "skill-submit-create",
        source: { kind: "user" },
      });
      const handle = await driver.attach({
        scope,
        workspace: fixture.workspace,
        binding: binding(created.backendConversationId),
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      await handle.establishProjection({
        signal: new AbortController().signal,
      });

      await handle.submit({
        applicationOperationId: "skill-submit",
        source: { kind: "user" },
        mutationId: "skill-submit",
        reconciliationToken: "skill-submit",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        selectedSkillId: "opaque-review-skill",
        text,
      });

      expect(prompts).toEqual([expectedPrompt]);
      await handle.close();
    },
  );

  it("maps remote skill catalog drift to an explicit reselect rejection", async () => {
    const fixture = await workspace();
    const baseFactory = fakeSessionFactory();
    const sessionFactory: PiSdkSessionFactory = {
      async create(input) {
        const session = await baseFactory.create(input);
        return {
          ...session,
          async skillPrompt() {
            throw new WorkspaceSkillReaderError(
              "workspace_skills_catalog_changed",
              false,
            );
          },
        };
      },
    };
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory,
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "skill-drift-create",
      applicationOperationId: "skill-drift-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    await handle.establishProjection({ signal: new AbortController().signal });

    await expect(
      handle.submit({
        applicationOperationId: "skill-drift-submit",
        source: { kind: "user" },
        mutationId: "skill-drift-submit",
        reconciliationToken: "skill-drift-submit",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        selectedSkillId: "stale-review-skill",
        text: "Review this.",
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "pi_skill_catalog_changed",
      safeMessage:
        "The selected Pi skill changed. Reselect it before submitting.",
      crossedSubmissionBoundary: false,
    });
    await handle.close();
  });

  it("rejects a fully empty submit before crossing the Pi boundary", async () => {
    const fixture = await workspace();
    const prompts: string[] = [];
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        false,
        () => undefined,
        0,
        undefined,
        0,
        undefined,
        (text) => {
          prompts.push(text);
          return [text];
        },
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "empty-submit-create",
      applicationOperationId: "empty-submit-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });

    await expect(
      handle.submit({
        applicationOperationId: "empty-submit",
        source: { kind: "user" },
        mutationId: "empty-submit",
        reconciliationToken: "empty-submit",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: " \n ",
      }),
    ).rejects.toMatchObject({ backendCode: "pi_submission_empty" });
    expect(prompts).toEqual([]);
    await handle.close();
  });

  it("carries context excerpts through Pi input and live projection", async () => {
    const fixture = await workspace();
    const prompts: string[] = [];
    const contextExcerpt = {
      id: "0d1bfa8b-dc37-4f52-8b0e-f8181ac0a7e9",
      excerpt: "const answer = 42;",
      note: "Rename this value.",
      source: {
        kind: "conversation_message" as const,
        itemId: "normalized-assistant-item-1",
        itemRevision: 4,
      },
      locator: {
        kind: "text_quote" as const,
        prefix: "The result is ",
        suffix: ".",
      },
    };
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      toolProvenanceKey,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        false,
        () => undefined,
        0,
        undefined,
        0,
        undefined,
        (text) => {
          prompts.push(text);
          return [text];
        },
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "context-submit-create",
      applicationOperationId: "context-submit-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const projection = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: BackendConversationEvent[] = [];
    const unsubscribe = projection.subscribeFromNext((event) =>
      events.push(event.event),
    );

    await handle.submit({
      applicationOperationId: "context-submit",
      source: { kind: "user" },
      mutationId: "context-submit",
      reconciliationToken: "context-submit",
      contextExcerpts: [contextExcerpt],
      attachments: [],
      taskContexts: [],
      text: "Please update it.",
    });

    expect(prompts).toEqual([
      formatPiContextExcerptPrompt([contextExcerpt], "Please update it."),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item_completed",
        item: expect.objectContaining({
          semanticKind: "user_message",
          deliveryOperationId: "context-submit",
          content: [
            { kind: "context_excerpt", excerpt: contextExcerpt },
            { kind: "text", text: { text: "Please update it." } },
          ],
        }),
      }),
    );
    unsubscribe();
    await handle.close();
  });

  it("carries exact task context through Pi input and live projection", async () => {
    const fixture = await workspace();
    const prompts: string[] = [];
    const taskContext = {
      id: "10000000-0000-4000-8000-000000000001",
      scope: { kind: "global" as const },
      title: "Work the selected task",
      details: "Use the exact id, not title matching.",
      pinned: true,
      files: ["/workspace/src/task.ts"],
      completedAt: null,
      revision: 7,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T13:00:00.000Z",
    };
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      toolProvenanceKey,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        false,
        () => undefined,
        0,
        undefined,
        0,
        undefined,
        (text) => {
          prompts.push(text);
          return [text];
        },
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "task-context-submit-create",
      applicationOperationId: "task-context-submit-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const projection = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: BackendConversationEvent[] = [];
    const unsubscribe = projection.subscribeFromNext((event) =>
      events.push(event.event),
    );

    await handle.submit({
      applicationOperationId: "task-context-submit",
      source: { kind: "user" },
      mutationId: "task-context-submit",
      reconciliationToken: "task-context-submit",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: renderTaskContextsForModel([taskContext], ""),
    });

    expect(prompts).toEqual([renderTaskContextsForModel([taskContext], "")]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item_completed",
        item: expect.objectContaining({
          semanticKind: "user_message",
          deliveryOperationId: "task-context-submit",
          content: [
            {
              kind: "text",
              text: { text: renderTaskContextsForModel([taskContext], "") },
            },
          ],
        }),
      }),
    );
    unsubscribe();
    await handle.close();
  });

  it("repairs task history when reattached after user persistence but before live attestation", async () => {
    const fixture = await workspace();
    const nativeId = "task-attestation-recovery-native";
    const store = new PiSessionStore({ sessionDirectory: fixture.sessions });
    const reserved = await store.reserve(fixture.workspace, nativeId);
    const authentication = {
      conversationId: nativeId,
      installationKey: toolProvenanceKey,
    };
    const taskContext = {
      id: "10000000-0000-4000-8000-000000000001",
      scope: { kind: "global" as const },
      title: "Recover after restart",
      details: "The native user entry is already durable.",
      pinned: false,
      files: [],
      completedAt: null,
      revision: 5,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T13:00:00.000Z",
    };
    const submission = createPiSubmissionMarker({
      applicationOperationId: "task-attestation-recovery",
      mutationId: "task-attestation-recovery",
      reconciliationToken: "task-attestation-recovery",
      mode: "submit",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [taskContext],
      text: "",
    });
    reserved.manager.appendCustomEntry(
      piTaskContextMarkerType,
      createPiTaskContextMarker(
        {
          applicationOperationId: submission.applicationOperationId,
          requestFingerprint: submission.requestFingerprint,
          taskContexts: [taskContext],
        },
        authentication,
      ),
    );
    reserved.manager.appendCustomEntry(piSubmissionMarkerType, submission);
    const userEntryId = reserved.manager.appendMessage({
      role: "user",
      content: formatPiTaskContextPrompt([taskContext], ""),
      timestamp: Date.now(),
    });

    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(nativeId, "task-attestation-recovery-thread"),
      opaqueBindingDetail: reserved.opaqueBindingDetail,
    });
    const projection = await handle.establishProjection({
      signal: new AbortController().signal,
    });

    expect(projection.snapshot.itemsById[`${userEntryId}:user`]).toMatchObject({
      deliveryOperationId: "task-attestation-recovery",
      content: [{ kind: "task_context", task: taskContext }],
    });
    const recoveredManager = await store.openPersisted(
      fixture.workspace,
      nativeId,
    );
    expect(
      recoveredManager!
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === piSubmissionAttestationType,
        ),
    ).toHaveLength(1);
    await handle.close();
  });

  it("forwards the exact skill, context, and text through Pi steering", async () => {
    const fixture = await workspace();
    const steeredPrompts: string[] = [];
    const contextExcerpt = {
      id: "f168bca4-03d0-4fd3-bf22-24235436c8d2",
      excerpt: "Keep the settled behavior.",
      note: "Apply this clarification while steering.",
      source: {
        kind: "conversation_message" as const,
        itemId: "normalized-assistant-item-steer",
        itemRevision: 7,
      },
      locator: {
        kind: "text_quote" as const,
        prefix: "Earlier: ",
        suffix: " Continue.",
      },
    };
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        false,
        () => undefined,
        0,
        (text) => {
          steeredPrompts.push(text);
          return [text];
        },
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "combined-steer-create",
      applicationOperationId: "combined-steer-create",
      source: { kind: "user" },
    });
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const activeTurnId = manager!.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Active work" }],
      timestamp: Date.now(),
    });
    const target = binding(created.backendConversationId);
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });

    const result = await handle.steer({
      applicationOperationId: "combined-steer-operation",
      mutationId: "combined-steer-mutation",
      reconciliationToken: "combined-steer-token",
      target: { kind: "turn", turnId: activeTurnId },
      selectedSkillId: "opaque-review-skill",
      contextExcerpts: [contextExcerpt],
      attachments: [],
      taskContexts: [],
      text: "Change direction exactly.",
    });

    expect(steeredPrompts).toEqual([
      `resolved:opaque-review-skill ${formatPiContextExcerptPrompt(
        [contextExcerpt],
        "Change direction exactly.",
      )}`,
    ]);
    expect(result).toMatchObject({
      status: "accepted",
      reconciliationToken: "combined-steer-token",
      completionCorrelation: "combined-steer-operation",
      backendTurnId: activeTurnId,
    });
    await expect(
      driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: target,
        applicationOperationId: "combined-steer-operation",
        reconciliationToken: "combined-steer-token",
      }),
    ).resolves.toMatchObject({ status: "accepted" });
    await handle.close();
  });

  it("acknowledges Pi enqueue before materialization and closes the exact lifecycle", async () => {
    const fixture = await workspace();
    let materialize: (() => void) | undefined;
    let steerCalls = 0;
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        false,
        () => undefined,
        0,
        (text) => {
          steerCalls += 1;
          return [`Transformed: ${text}`];
        },
        0,
        undefined,
        undefined,
        undefined,
        (release) => {
          materialize = release;
        },
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "pending-steer-create",
      applicationOperationId: "pending-steer-create",
      source: { kind: "user" },
    });
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const activeTurnId = manager!.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Active work" }],
      timestamp: Date.now(),
    });
    const target = binding(created.backendConversationId);
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const input = {
      applicationOperationId: "pending-steer-operation",
      mutationId: "pending-steer-mutation",
      reconciliationToken: "pending-steer-token",
      target: { kind: "turn" as const, turnId: activeTurnId },
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Change direction",
    };

    const pending = await handle.steer(input);

    expect(pending).toEqual({
      status: "pending_materialization",
      reconciliationToken: input.reconciliationToken,
      completionCorrelation: input.applicationOperationId,
      backendTurnId: activeTurnId,
    });
    await expect(handle.steer(input)).resolves.toEqual(pending);
    expect(steerCalls).toBe(1);
    expect(
      (await new PiSessionStore({
        sessionDirectory: fixture.sessions,
      }).openPersisted(fixture.workspace, created.backendConversationId))!
        .getBranch()
        .flatMap((entry) => {
          const marker = piSubmissionMarker(entry);
          return marker?.applicationOperationId === input.applicationOperationId
            ? [marker.phase]
            : [];
        }),
    ).toEqual(["intent", "enqueued"]);
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      deliveryModes: expect.arrayContaining(["steer"]),
    });
    await expect(
      driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: target,
        applicationOperationId: input.applicationOperationId,
        reconciliationToken: input.reconciliationToken,
      }),
    ).resolves.toMatchObject({ status: "unresolved" });
    await expect(
      handle.steer({
        ...input,
        applicationOperationId: "second-pending-steer",
        mutationId: "second-pending-steer",
        reconciliationToken: "second-pending-steer",
      }),
    ).rejects.toMatchObject({
      backendCode: "pi_steer_materialization_pending",
    });

    materialize?.();
    await vi.waitFor(async () => {
      await expect(
        driver.reconcileSubmission({
          scope,
          workspace: fixture.workspace,
          binding: target,
          applicationOperationId: input.applicationOperationId,
          reconciliationToken: input.reconciliationToken,
        }),
      ).resolves.toMatchObject({ status: "accepted" });
    });
    await expect(handle.steer(input)).resolves.toMatchObject({
      status: "accepted",
    });
    const materialized = await driver.read({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    expect(
      Object.values(materialized.snapshot.itemsById).find(
        (item) =>
          item.semanticKind === "user_message" &&
          item.deliveryOperationId === input.applicationOperationId,
      ),
    ).toMatchObject({
      semanticKind: "user_message",
      deliveryOperationId: input.applicationOperationId,
    });
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      deliveryModes: expect.arrayContaining(["steer"]),
    });
    await handle.close();
  });

  it("withdraws an unmaterialized Steer before Stop and preserves not-accepted reconciliation", async () => {
    const fixture = await workspace();
    const order: string[] = [];
    const base = fakeSessionFactory(
      1,
      false,
      () => undefined,
      0,
      () => [],
      0,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      true,
    );
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: {
        async create(input) {
          const session = await base.create(input);
          return {
            ...session,
            clearQueue() {
              order.push("clear_queue");
              return { steering: ["Withdraw me"], followUp: [] };
            },
            async abort() {
              order.push("abort");
              await session.abort();
            },
          };
        },
      },
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "interrupt-unmaterialized-steer-create",
      applicationOperationId: "interrupt-unmaterialized-steer-create",
      source: { kind: "user" },
    });
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const activeTurnId = manager!.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Active work" }],
      timestamp: Date.now(),
    });
    const target = binding(created.backendConversationId);
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const steerInput = {
      applicationOperationId: "interrupt-unmaterialized-steer-operation",
      mutationId: "interrupt-unmaterialized-steer-mutation",
      reconciliationToken: "interrupt-unmaterialized-steer-token",
      target: { kind: "turn" as const, turnId: activeTurnId },
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Withdraw me",
    };
    await expect(handle.steer(steerInput)).resolves.toMatchObject({
      status: "pending_materialization",
    });

    await expect(
      handle.interrupt({
        applicationOperationId: "interrupt-unmaterialized-steer-stop",
        expectedBackendTurnId: activeTurnId,
      }),
    ).resolves.toBeUndefined();

    expect(order).toEqual(["clear_queue", "abort"]);
    await expect(
      driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: target,
        applicationOperationId: steerInput.applicationOperationId,
        reconciliationToken: steerInput.reconciliationToken,
      }),
    ).resolves.toEqual({ status: "not_accepted", retryable: true });
    expect(
      (await new PiSessionStore({
        sessionDirectory: fixture.sessions,
      }).openPersisted(fixture.workspace, created.backendConversationId))!
        .getBranch()
        .flatMap((entry) => {
          const marker = piSubmissionMarker(entry);
          return marker?.applicationOperationId ===
            steerInput.applicationOperationId
            ? [marker.phase]
            : [];
        }),
    ).toEqual(["intent", "enqueued", "lost"]);
    await handle.close();
  });

  it("keeps an already-drained Steer accepted when it materializes during interrupt queue clearing", async () => {
    const fixture = await workspace();
    let materialize: (() => void) | undefined;
    const order: string[] = [];
    const base = fakeSessionFactory(
      1,
      false,
      () => undefined,
      0,
      (text) => [text],
      0,
      undefined,
      undefined,
      undefined,
      (release) => {
        materialize = release;
      },
    );
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: {
        async create(input) {
          const session = await base.create(input);
          return {
            ...session,
            clearQueue() {
              order.push("clear_queue");
              const release = materialize;
              materialize = undefined;
              release?.();
              return { steering: [], followUp: [] };
            },
            async abort() {
              order.push("abort");
            },
          };
        },
      },
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "interrupt-drained-steer-create",
      applicationOperationId: "interrupt-drained-steer-create",
      source: { kind: "user" },
    });
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const activeTurnId = manager!.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Active work" }],
      timestamp: Date.now(),
    });
    const target = binding(created.backendConversationId);
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const steerInput = {
      applicationOperationId: "interrupt-drained-steer-operation",
      mutationId: "interrupt-drained-steer-mutation",
      reconciliationToken: "interrupt-drained-steer-token",
      target: { kind: "turn" as const, turnId: activeTurnId },
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Already drained by Pi",
    };
    await expect(handle.steer(steerInput)).resolves.toMatchObject({
      status: "pending_materialization",
    });

    await expect(
      handle.interrupt({
        applicationOperationId: "interrupt-drained-steer-stop",
        expectedBackendTurnId: activeTurnId,
      }),
    ).resolves.toBeUndefined();

    expect(order).toEqual(["clear_queue", "abort"]);
    await expect(
      driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: target,
        applicationOperationId: steerInput.applicationOperationId,
        reconciliationToken: steerInput.reconciliationToken,
      }),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(
      (await new PiSessionStore({
        sessionDirectory: fixture.sessions,
      }).openPersisted(fixture.workspace, created.backendConversationId))!
        .getBranch()
        .flatMap((entry) => {
          const marker = piSubmissionMarker(entry);
          return marker?.applicationOperationId ===
            steerInput.applicationOperationId
            ? [marker.phase]
            : [];
        }),
    ).toEqual(["intent", "enqueued"]);
    await handle.close();
  });

  it("rejects an unmaterialized steer when the Pi generation settles during enqueue", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        false,
        () => undefined,
        0,
        () => [],
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "settled-during-steer-create",
      applicationOperationId: "settled-during-steer-create",
      source: { kind: "user" },
    });
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const activeTurnId = manager!.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Active work" }],
      timestamp: Date.now(),
    });
    const target = binding(created.backendConversationId);
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const input = {
      applicationOperationId: "settled-during-steer-operation",
      mutationId: "settled-during-steer-mutation",
      reconciliationToken: "settled-during-steer-token",
      target: { kind: "turn" as const, turnId: activeTurnId },
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Too late for this generation",
    };

    await expect(handle.steer(input)).rejects.toMatchObject({
      backendCode: "pi_steer_generation_ended",
      retryable: true,
      crossedSubmissionBoundary: false,
    });
    await expect(
      driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: target,
        applicationOperationId: input.applicationOperationId,
        reconciliationToken: input.reconciliationToken,
      }),
    ).resolves.toEqual({ status: "not_accepted", retryable: true });
    expect(
      (await new PiSessionStore({
        sessionDirectory: fixture.sessions,
      }).openPersisted(fixture.workspace, created.backendConversationId))!
        .getBranch()
        .flatMap((entry) => {
          const marker = piSubmissionMarker(entry);
          return marker?.applicationOperationId === input.applicationOperationId
            ? [marker.phase]
            : [];
        }),
    ).toEqual(["intent", "enqueued", "lost"]);
    await handle.close();
  });

  it("marks an unmaterialized Pi enqueue lost and disposes when close abort fails", async () => {
    const fixture = await workspace();
    const order: string[] = [];
    const closeFailure = new Error("abort cleanup failed");
    const dispose = vi.fn();
    const base = fakeSessionFactory(
      1,
      false,
      () => undefined,
      0,
      () => [],
    );
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: {
        async create(input) {
          const session = await base.create(input);
          return {
            ...session,
            clearQueue() {
              order.push("clear_queue");
              return { steering: ["Never materialized"], followUp: [] };
            },
            async abort() {
              order.push("abort");
              throw closeFailure;
            },
            dispose() {
              dispose();
              session.dispose();
            },
          };
        },
      },
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "lost-steer-create",
      applicationOperationId: "lost-steer-create",
      source: { kind: "user" },
    });
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const activeTurnId = manager!.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Active work" }],
      timestamp: Date.now(),
    });
    const target = binding(created.backendConversationId);
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const input = {
      applicationOperationId: "lost-steer-operation",
      mutationId: "lost-steer-mutation",
      reconciliationToken: "lost-steer-token",
      target: { kind: "turn" as const, turnId: activeTurnId },
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Never materialized",
    };
    await expect(handle.steer(input)).resolves.toMatchObject({
      status: "pending_materialization",
    });

    await expect(handle.close()).rejects.toBe(closeFailure);

    expect(order).toEqual(["clear_queue", "abort"]);
    expect(dispose).toHaveBeenCalledOnce();
    await expect(
      driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: target,
        applicationOperationId: input.applicationOperationId,
        reconciliationToken: input.reconciliationToken,
      }),
    ).resolves.toEqual({ status: "not_accepted", retryable: true });
    expect(
      (await new PiSessionStore({
        sessionDirectory: fixture.sessions,
      }).openPersisted(fixture.workspace, created.backendConversationId))!
        .getBranch()
        .flatMap((entry) => {
          const marker = piSubmissionMarker(entry);
          return marker?.applicationOperationId === input.applicationOperationId
            ? [marker.phase]
            : [];
        }),
    ).toEqual(["intent", "enqueued", "lost"]);
  });

  it("recovers an enqueued steer as lost after its owning process generation disappears", async () => {
    const fixture = await workspace();
    const sessionFactory = fakeSessionFactory(
      1,
      false,
      () => undefined,
      0,
      () => [],
    );
    const original = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory,
    });
    const created = await original.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "restart-lost-steer-create",
      applicationOperationId: "restart-lost-steer-create",
      source: { kind: "user" },
    });
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const activeTurnId = manager!.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Active work" }],
      timestamp: Date.now(),
    });
    const target = binding(created.backendConversationId);
    const originalHandle = await original.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const input = {
      applicationOperationId: "restart-lost-steer-operation",
      mutationId: "restart-lost-steer-mutation",
      reconciliationToken: "restart-lost-steer-token",
      target: { kind: "turn" as const, turnId: activeTurnId },
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Never materialized before restart",
    };
    await expect(originalHandle.steer(input)).resolves.toMatchObject({
      status: "pending_materialization",
    });

    const restarted = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory,
    });
    await expect(
      restarted.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: target,
        applicationOperationId: input.applicationOperationId,
        reconciliationToken: input.reconciliationToken,
      }),
    ).resolves.toEqual({ status: "not_accepted", retryable: true });
    expect(
      (await new PiSessionStore({
        sessionDirectory: fixture.sessions,
      }).openPersisted(fixture.workspace, created.backendConversationId))!
        .getBranch()
        .flatMap((entry) => {
          const marker = piSubmissionMarker(entry);
          return marker?.applicationOperationId === input.applicationOperationId
            ? [marker.phase]
            : [];
        }),
    ).toEqual(["intent", "enqueued", "lost"]);
    await originalHandle.close();
  });

  it("records proven rejection when Pi refuses a steer before enqueue", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        false,
        () => undefined,
        0,
        () => [],
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        new Error("native steer rejected"),
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "rejected-native-steer-create",
      applicationOperationId: "rejected-native-steer-create",
      source: { kind: "user" },
    });
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const activeTurnId = manager!.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Active work" }],
      timestamp: Date.now(),
    });
    const target = binding(created.backendConversationId);
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const input = {
      applicationOperationId: "rejected-native-steer-operation",
      mutationId: "rejected-native-steer-mutation",
      reconciliationToken: "rejected-native-steer-token",
      target: { kind: "turn" as const, turnId: activeTurnId },
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Reject before enqueue",
    };

    await expect(handle.steer(input)).rejects.toMatchObject({
      crossedSubmissionBoundary: false,
    });
    expect(
      (await new PiSessionStore({
        sessionDirectory: fixture.sessions,
      }).openPersisted(fixture.workspace, created.backendConversationId))!
        .getBranch()
        .flatMap((entry) => {
          const marker = piSubmissionMarker(entry);
          return marker?.applicationOperationId === input.applicationOperationId
            ? [marker.phase]
            : [];
        }),
    ).toEqual(["intent", "rejected"]);
    await expect(
      driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: target,
        applicationOperationId: input.applicationOperationId,
        reconciliationToken: input.reconciliationToken,
      }),
    ).resolves.toEqual({ status: "not_accepted", retryable: true });
    await handle.close();
  });

  it("returns the establishment history boundary without a second provider read", async () => {
    const fixture = await workspace();
    const project = vi.spyOn(PiHistoryProjector.prototype, "project");
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "projection-history-create",
      applicationOperationId: "projection-history-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });

    await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(project).toHaveBeenCalledTimes(1);
    await handle.history({ limit: 1 });

    expect(project).toHaveBeenCalledTimes(2);
    await handle.close();
    project.mockRestore();
  });

  it("locates exactly one normalized turn from retained history within a bounded newest-first scan", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "locate-turn-create",
      applicationOperationId: "locate-turn-create",
      source: { kind: "user" },
    });
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const turnIds = ["oldest", "middle", "newest"].map((text) => {
      const turnId = manager!.appendMessage({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      });
      manager!.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `Reply ${text}` }],
        api: "test",
        provider: "test",
        model: "model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      return turnId;
    });
    const oldestTurnId = turnIds[0]!;
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const inspected: string[] = [];

    await expect(
      handle.locateTurn({
        matchesBackendTurnId: (backendTurnId) => {
          inspected.push(backendTurnId);
          return backendTurnId === oldestTurnId;
        },
        maximumTurnCandidates: 3,
      }),
    ).resolves.toMatchObject({
      status: "found",
      page: {
        orderedBackendTurnIds: [oldestTurnId],
        turnsById: { [oldestTurnId]: { backendTurnId: oldestTurnId } },
      },
    });
    expect(inspected).toEqual([turnIds[2], turnIds[1], turnIds[0]]);
    const found = await handle.locateTurn({
      matchesBackendTurnId: (backendTurnId) => backendTurnId === oldestTurnId,
      maximumTurnCandidates: 3,
    });
    expect(found).toMatchObject({ status: "found" });
    if (found.status !== "found") throw new Error("expected located Pi turn");
    expect(found.page.previousCursor).toBeUndefined();
    expect(Object.keys(found.page.turnsById)).toEqual([oldestTurnId]);
    expect(Object.values(found.page.itemsById)).toHaveLength(2);
    expect(
      Object.values(found.page.itemsById).every(
        (item) => item.backendTurnId === oldestTurnId,
      ),
    ).toBe(true);
    await expect(
      handle.locateTurn({
        matchesBackendTurnId: (backendTurnId) => backendTurnId === oldestTurnId,
        maximumTurnCandidates: 2,
      }),
    ).resolves.toEqual({ status: "search_limit_reached" });
    await expect(
      handle.locateTurn({
        matchesBackendTurnId: () => false,
        maximumTurnCandidates: 3,
      }),
    ).resolves.toEqual({ status: "not_found" });
    await handle.close();
  });

  it("rejects invalid and aborted Pi turn locator requests before scanning history", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "locate-turn-abort-create",
      applicationOperationId: "locate-turn-abort-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const matchesBackendTurnId = vi.fn(() => false);
    await expect(
      handle.locateTurn({
        matchesBackendTurnId,
        maximumTurnCandidates: 0,
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "pi_turn_candidate_limit_invalid",
    });
    const controller = new AbortController();
    const reason = new Error("stop locating Pi turn");
    controller.abort(reason);
    await expect(
      handle.locateTurn({
        matchesBackendTurnId,
        maximumTurnCandidates: 1,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(matchesBackendTurnId).not.toHaveBeenCalled();
    await handle.close();
  });

  it("keeps an oversized older-page failure request-local and supports a later submit and stop", async () => {
    const fixture = await workspace();
    let idle = true;
    let releaseAssistant!: () => void;
    const assistantGate = new Promise<void>((resolve) => {
      releaseAssistant = resolve;
    });
    const abort = vi.fn(async () => {
      idle = true;
      releaseAssistant();
    });
    const base = fakeSessionFactory(
      1,
      false,
      () => undefined,
      0,
      undefined,
      0,
      undefined,
      undefined,
      async () => assistantGate,
    );
    const sessionFactory: PiSdkSessionFactory = {
      async create(input) {
        const session = await base.create(input);
        return {
          ...session,
          get isIdle() {
            return idle;
          },
          async prompt(text, options) {
            idle = false;
            try {
              await session.prompt(text, options);
            } finally {
              idle = true;
            }
          },
          abort,
        };
      },
    };
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory,
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "oversized-older-history-create",
      applicationOperationId: "oversized-older-history-create",
      source: { kind: "user" },
    });
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    manager!.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Oversized old turn" }],
      timestamp: Date.now(),
    });
    // Pi history bounds each projected text item to 16 KiB. Enough individually
    // valid items still make this one whole turn exceed the 4 MiB transfer cap.
    for (let index = 0; index < 260; index += 1) {
      manager!.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(16_384) }],
        api: "test",
        provider: "test",
        model: "model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    }
    for (let index = 0; index < 10; index += 1) {
      manager!.appendMessage({
        role: "user",
        content: [{ type: "text", text: `Recent turn ${index}` }],
        timestamp: Date.now(),
      });
      manager!.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `Recent reply ${index}` }],
        api: "test",
        provider: "test",
        model: "model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    }
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(established.snapshot.orderedBackendTurnIds).toHaveLength(10);

    await expect(
      handle.history({
        cursor: `pi-history:${encodeURIComponent(created.backendConversationId)}:1`,
        limit: 1,
      }),
    ).rejects.toMatchObject({
      category: "internal",
      retryable: false,
      crossedSubmissionBoundary: false,
      backendCode: "pi_turn_payload_too_large",
    });

    const submitted = await handle.submit({
      applicationOperationId: "oversized-history-later-submit",
      source: { kind: "user" },
      mutationId: "oversized-history-later-submit",
      reconciliationToken: "oversized-history-later-submit",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Continue after the failed history page.",
    });
    expect(submitted).toMatchObject({
      accepted: true,
      backendTurnId: expect.any(String),
    });
    await expect(
      handle.interrupt({
        applicationOperationId: "oversized-history-later-stop",
        expectedBackendTurnId: submitted.backendTurnId!,
      }),
    ).resolves.toBeUndefined();
    expect(abort).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(idle).toBe(true));
    await handle.close();
  });

  it("rotates a full turn window once and derives the exact older boundary from persisted history", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "stable-history-create",
      applicationOperationId: "stable-history-create",
      source: { kind: "user" },
    });
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const appendTurn = (text: string) => {
      manager!.appendMessage({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      });
      manager!.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `Reply ${text}` }],
        api: "test",
        provider: "test",
        model: "model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    };
    for (let index = 0; index < 101; index += 1) {
      appendTurn(`history-${index}`);
    }
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(established.snapshot.orderedBackendTurnIds).toHaveLength(10);
    expect(established.history).toEqual({
      operational: true,
      previousCursor: expect.stringMatching(/^pi-history:/u),
    });
    const immediatelyOlder = await handle.history({
      cursor: established.history.previousCursor,
      limit: 1,
    });
    expect(immediatelyOlder.orderedBackendTurnIds).toHaveLength(1);
    const recent = await handle.history({ limit: 1 });
    expect(recent.previousCursor).toBeTypeOf("string");
    const events: SequencedBackendEvent[] = [];
    const unsubscribe = established.subscribeFromNext((event) =>
      events.push(event),
    );

    await handle.submit({
      applicationOperationId: "stable-history-submit",
      source: { kind: "user" },
      mutationId: "stable-history-submit",
      reconciliationToken: "stable-history-submit",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "third",
    });
    await vi.waitFor(() =>
      expect(
        events.filter(({ event }) => event.type === "resnapshot_required"),
      ).toHaveLength(1),
    );
    await expect(
      handle.history({ cursor: recent.previousCursor, limit: 1 }),
    ).resolves.toMatchObject({
      orderedBackendTurnIds: [expect.any(String)],
    });
    unsubscribe();
    const rotated = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(rotated.snapshot.orderedBackendTurnIds).toHaveLength(10);
    expect(rotated.snapshot.orderedBackendTurnIds[0]).not.toBe(
      established.snapshot.orderedBackendTurnIds[0],
    );
    expect(rotated.history.previousCursor).toMatch(
      new RegExp(
        `^pi-history:${encodeURIComponent(created.backendConversationId)}:92$`,
        "u",
      ),
    );
    await expect(
      handle.history({ cursor: rotated.history.previousCursor, limit: 1 }),
    ).resolves.toMatchObject({
      orderedBackendTurnIds: [established.snapshot.orderedBackendTurnIds[0]],
    });
    await handle.close();
  });

  it("constructs one transient Pi catalog per workspace freshness generation", async () => {
    const fixture = await workspace();
    const base = fakeSessionFactory();
    let createCalls = 0;
    let invalidateCatalog: (() => void) | undefined;
    const sessionFactory: PiSdkSessionFactory = {
      async create(input) {
        createCalls += 1;
        if (input.onResourcesChanged) {
          invalidateCatalog = input.onResourcesChanged;
        }
        return base.create(input);
      },
    };
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory,
    });

    const [first, concurrent] = await Promise.all([
      driver.catalog({ scope, workspace: fixture.workspace }),
      driver.catalog({ scope, workspace: fixture.workspace }),
    ]);
    expect(first).toEqual(concurrent);
    expect(createCalls).toBe(1);

    await driver.catalog({ scope, workspace: fixture.workspace });
    expect(createCalls).toBe(1);

    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "catalog-invalidation-create",
      applicationOperationId: "catalog-invalidation-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    expect(createCalls).toBe(2);
    expect(invalidateCatalog).toBeTypeOf("function");

    invalidateCatalog!();
    await driver.catalog({ scope, workspace: fixture.workspace });
    expect(createCalls).toBe(3);
    await handle.close();
  });

  it("projects provider/model/effort policy and rejects a disallowed submit before prompting Pi", async () => {
    const fixture = await workspace();
    const base = fakeSessionFactory();
    let promptCalls = 0;
    let compactCalls = 0;
    const sessionFactory: PiSdkSessionFactory = {
      async create(input) {
        const session = await base.create(input);
        return {
          ...session,
          async prompt(text, options) {
            promptCalls += 1;
            return session.prompt(text, options);
          },
          async compact(instructions) {
            compactCalls += 1;
            return session.compact(instructions);
          },
          availableModels: async () => [
            {
              provider: "test",
              id: "model",
              name: "Allowed with bounded efforts",
              reasoning: true,
            },
            {
              provider: "other",
              id: "model",
              name: "Same ID, other provider",
              reasoning: true,
            },
          ],
        };
      },
    };
    const modelPolicy = compileBackendModelPolicy(
      {
        type: "allowlist",
        allowed: [
          {
            providerIds: ["test"],
            modelIds: ["model"],
            reasoningEfforts: ["medium", "high"],
          },
        ],
      },
      "provider_model_effort",
    );
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory,
      modelPolicy,
    });

    await expect(
      driver.catalog({ scope, workspace: fixture.workspace }),
    ).resolves.toMatchObject({
      models: [
        {
          provider: "test",
          id: "model",
          supportedReasoningEfforts: ["medium", "high"],
        },
      ],
    });

    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "policy-submit-create",
      applicationOperationId: "policy-submit-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    await expect(
      handle.submit({
        applicationOperationId: "policy-submit",
        source: { kind: "user" },
        mutationId: "policy-submit",
        reconciliationToken: "policy-submit",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: "must not cross the provider boundary",
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "model_policy_rejected",
      crossedSubmissionBoundary: false,
    });
    expect(promptCalls).toBe(0);
    await expect(
      handle.perform({
        applicationOperationId: "policy-compact",
        action: "compact",
        instructions: "must not compact",
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "model_policy_rejected",
    });
    expect(compactCalls).toBe(0);
    await handle.close();
  });

  it("permits a model-only staging transition when the target has an admitted effort", async () => {
    const fixture = await workspace();
    const base = fakeSessionFactory();
    let selected: PiSdkSession["model"] = {
      provider: "test",
      id: "model",
      input: ["text"],
    };
    let thinkingLevel = "low";
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      modelPolicy: compileBackendModelPolicy(
        {
          type: "allowlist",
          allowed: [
            {
              providerIds: ["test"],
              modelIds: ["next-model"],
              reasoningEfforts: ["high"],
            },
          ],
        },
        "provider_model_effort",
      ),
      sessionFactory: {
        async create(input) {
          const session = await base.create(input);
          return {
            ...session,
            get model() {
              return selected;
            },
            get thinkingLevel() {
              return thinkingLevel;
            },
            availableModels: async () => [
              {
                provider: "test",
                id: "next-model",
                reasoning: true,
                input: ["text"],
              },
            ],
            async setModel(model: unknown) {
              selected = model as typeof selected;
            },
            setThinkingLevel(level: string) {
              thinkingLevel = level;
              input.manager.appendThinkingLevelChange(level);
            },
          };
        },
      },
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "policy-model-transition-create",
      applicationOperationId: "policy-model-transition-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });

    await expect(
      handle.perform({
        applicationOperationId: "policy-model-transition",
        action: "set_model",
        provider: "test",
        modelId: "next-model",
      }),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      handle.perform({
        applicationOperationId: "policy-model-transition-effort",
        action: "set_thinking_level",
        level: "high",
      }),
    ).resolves.toMatchObject({ accepted: true });
    await handle.close();
  });

  it("rejects interrupting an idle Pi handle", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "idle-interrupt-create",
      applicationOperationId: "idle-interrupt-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });

    await expect(
      handle.interrupt({
        applicationOperationId: "idle-interrupt",
        expectedBackendTurnId: "no-active-turn",
      }),
    ).rejects.toMatchObject({
      category: "invalid_state",
      backendCode: "pi_interrupt_requires_active_turn",
    });
    await handle.close();
  });

  it("classifies an idle Pi Steer as a proven stale target", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "idle-steer-create",
      applicationOperationId: "idle-steer-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });

    await expect(
      handle.steer({
        applicationOperationId: "idle-steer-operation",
        mutationId: "idle-steer-mutation",
        reconciliationToken: "idle-steer-token",
        target: { kind: "turn", turnId: "no-active-turn" },
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: "Deliver this next.",
      }),
    ).rejects.toMatchObject({
      category: "invalid_state",
      crossedSubmissionBoundary: false,
      backendCode: "pi_steer_requires_active_run",
      steerRejectionReason: "target_no_longer_active",
    });
    await handle.close();
  });

  it("classifies a changed active Pi Steer target as proven stale", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        false,
        () => undefined,
        0,
        (text) => [text],
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "changed-steer-create",
      applicationOperationId: "changed-steer-create",
      source: { kind: "user" },
    });
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    manager!.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Current active work" }],
      timestamp: Date.now(),
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });

    await expect(
      handle.steer({
        applicationOperationId: "changed-steer-operation",
        mutationId: "changed-steer-mutation",
        reconciliationToken: "changed-steer-token",
        target: { kind: "turn", turnId: "previous-active-turn" },
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: "Deliver this next.",
      }),
    ).rejects.toMatchObject({
      category: "invalid_state",
      retryable: false,
      crossedSubmissionBoundary: false,
      backendCode: "pi_steer_target_changed",
      steerRejectionReason: "target_no_longer_active",
    });
    await handle.close();
  });

  it("cancels a pending approval before interrupt abort and keeps the bridge reusable", async () => {
    const fixture = await workspace();
    const base = fakeSessionFactory(
      1,
      false,
      () => undefined,
      0,
      () => [],
    );
    let bridge!: PiInteractionBridge;
    let idle = false;
    let pendingApproval!: Promise<"approve_once" | "deny" | undefined>;
    const order: string[] = [];
    const clearQueue = vi.fn(() => {
      order.push("clear_queue");
      return { steering: [], followUp: [] };
    });
    const abort = vi.fn(async () => {
      order.push("abort");
      await pendingApproval;
      idle = true;
    });
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: {
        async create(input) {
          bridge = input.interactions;
          const session = await base.create(input);
          pendingApproval = bridge.requestToolApproval({
            title: "Pi tool approval",
            detail: "bash: long-running-command",
          });
          return {
            ...session,
            get isIdle() {
              return idle;
            },
            clearQueue,
            abort,
          };
        },
      },
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "interrupt-pending-approval-create",
      applicationOperationId: "interrupt-pending-approval-create",
      source: { kind: "user" },
    });
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const activeTurnId = manager!.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Active work" }],
      timestamp: Date.now(),
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const events: BackendConversationEvent[] = [];
    handle.subscribe((event) => events.push(event));

    await expect(
      handle.interrupt({
        applicationOperationId: "interrupt-pending-approval",
        expectedBackendTurnId: activeTurnId,
      }),
    ).resolves.toBeUndefined();

    await expect(pendingApproval).resolves.toBeUndefined();
    expect(clearQueue).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
    expect(order).toEqual(["clear_queue", "abort"]);
    const laterApproval = bridge.requestToolApproval({
      title: "Pi tool approval",
      detail: "bash: later-command",
    });
    const laterOpened = events.findLast(
      (event) => event.type === "interaction_opened",
    );
    if (!laterOpened || laterOpened.type !== "interaction_opened") {
      throw new Error("expected later interaction");
    }
    bridge.respond({
      applicationOperationId: "later-approval-response",
      interactionId: laterOpened.interaction.backendInteractionId,
      kind: "decision",
      selectedActionId: "approve_once",
    });
    await expect(laterApproval).resolves.toBe("approve_once");
    await handle.close();
  });

  it("repeats a durable not-accepted reconciliation after recording rejection", async () => {
    const fixture = await workspace();
    const options: PiDriverOptions = {
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    };
    const driver = new PiConversationBackendDriver(options);
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "repeat-reconcile-create",
      applicationOperationId: "repeat-reconcile-create",
      source: { kind: "user" },
    });
    const target = binding(created.backendConversationId);
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    expect(manager).toBeDefined();
    const retryAnchor = JSON.stringify({
      version: 1,
      entryId: manager!.getLeafId(),
      entryCount: manager!.getBranch().length,
    });
    const submission = {
      applicationOperationId: "repeat-reconcile-submit",
      mutationId: "repeat-reconcile-mutation",
      reconciliationToken: "repeat-reconcile-token",
      mode: "submit" as const,
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Never persisted",
    };
    manager!.appendCustomEntry(
      piSubmissionMarkerType,
      createPiSubmissionMarker(submission),
    );
    const reconcile = () =>
      driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: target,
        applicationOperationId: submission.applicationOperationId,
        reconciliationToken: submission.reconciliationToken,
        retryAnchor,
      });

    await expect(reconcile()).resolves.toEqual({
      status: "not_accepted",
      retryable: true,
    });
    await expect(reconcile()).resolves.toEqual({
      status: "not_accepted",
      retryable: true,
    });
  });

  it.each([
    { label: "stable-token", rotateIdentity: false },
    { label: "rotated-token", rotateIdentity: true },
  ])(
    "executes a $label submit retry once after a durable rejection",
    async ({ rotateIdentity }) => {
      const fixture = await workspace();
      let promptCalls = 0;
      const options: PiDriverOptions = {
        instance,
        connection,
        usage: NO_USAGE_SINK,
        nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
        toolProvenanceKey,
        agentTools: noAgentTools,
        toolAccessPolicy: fullToolAccessPolicy,
        sessionDirectory: fixture.sessions,
        sessionFactory: fakeSessionFactory(
          1,
          false,
          () => undefined,
          0,
          undefined,
          0,
          undefined,
          (text) => {
            promptCalls += 1;
            return [text];
          },
        ),
      };
      const driver = new PiConversationBackendDriver(options);
      const created = await driver.create({
        scope,
        workspace: fixture.workspace,
        applicationThreadId: `rejected-submit-create-${String(rotateIdentity)}`,
        applicationOperationId: `rejected-submit-create-${String(rotateIdentity)}`,
        source: { kind: "user" },
      });
      const operationId = `rejected-submit-${String(rotateIdentity)}`;
      const retry = {
        applicationOperationId: operationId,
        mutationId: rotateIdentity ? "retry-mutation" : "stable-mutation",
        source: { kind: "user" as const },
        reconciliationToken: rotateIdentity ? "retry-token" : "stable-token",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: "Retry this input",
      };
      const rejected = {
        ...retry,
        mutationId: rotateIdentity ? "original-mutation" : retry.mutationId,
        reconciliationToken: rotateIdentity
          ? "original-token"
          : retry.reconciliationToken,
        mode: "submit" as const,
      };
      const manager = await new PiSessionStore({
        sessionDirectory: fixture.sessions,
      }).openPersisted(fixture.workspace, created.backendConversationId);
      manager!.appendCustomEntry(
        piSubmissionMarkerType,
        createPiSubmissionMarker(rejected),
      );
      manager!.appendCustomEntry(
        piSubmissionMarkerType,
        createPiSubmissionMarker({ ...rejected, phase: "rejected" }),
      );

      const handle = await driver.attach({
        scope,
        workspace: fixture.workspace,
        binding: binding(created.backendConversationId),
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      const accepted = await handle.submit(retry);

      await expect(handle.submit(retry)).resolves.toEqual(accepted);
      expect(promptCalls).toBe(1);
      await handle.close();
    },
  );

  it("executes a fresh steer once after a durable rejected attempt", async () => {
    const fixture = await workspace();
    let steerCalls = 0;
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        false,
        () => undefined,
        0,
        (text) => {
          steerCalls += 1;
          return [`Transformed steer: ${text}`];
        },
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "rejected-steer-create",
      applicationOperationId: "rejected-steer-create",
      source: { kind: "user" },
    });
    const rejected = {
      applicationOperationId: "rejected-steer-operation",
      mutationId: "rejected-steer-old-mutation",
      reconciliationToken: "rejected-steer-old-token",
      mode: "steer" as const,
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Steer again",
    };
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const activeTurnId = manager!.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Active turn" }],
      timestamp: Date.now(),
    });
    manager!.appendCustomEntry(
      piSubmissionMarkerType,
      createPiSubmissionMarker(rejected),
    );
    manager!.appendCustomEntry(
      piSubmissionMarkerType,
      createPiSubmissionMarker({
        ...rejected,
        phase: "rejected",
      }),
    );
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const retry = {
      applicationOperationId: rejected.applicationOperationId,
      mutationId: "rejected-steer-retry-mutation",
      reconciliationToken: "rejected-steer-retry-token",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      target: { kind: "turn" as const, turnId: activeTurnId },
      text: rejected.text,
    };
    const accepted = await handle.steer(retry);

    await expect(handle.steer(retry)).resolves.toEqual(accepted);
    expect(steerCalls).toBe(1);
    await handle.close();
  });

  it("keeps a handled prompt without a persisted user message non-accepted", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await workspace();
      const driver = new PiConversationBackendDriver({
        instance,
        connection,
        usage: NO_USAGE_SINK,
        nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
        toolProvenanceKey,
        agentTools: noAgentTools,
        toolAccessPolicy: fullToolAccessPolicy,
        sessionDirectory: fixture.sessions,
        sessionFactory: fakeSessionFactory(
          1,
          false,
          () => undefined,
          0,
          undefined,
          0,
          undefined,
          () => [],
        ),
      });
      const created = await driver.create({
        scope,
        workspace: fixture.workspace,
        applicationThreadId: "handled-create",
        applicationOperationId: "handled-create",
        source: { kind: "user" },
      });
      const target = binding(created.backendConversationId);
      const handle = await driver.attach({
        scope,
        workspace: fixture.workspace,
        binding: target,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      const submission = {
        applicationOperationId: "handled-submit",
        mutationId: "handled-mutation",
        source: { kind: "user" as const },
        reconciliationToken: "handled-token",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: "Handled without a message",
      };
      const pending = expect(handle.submit(submission)).rejects.toMatchObject({
        category: "submission_unknown",
        backendCode: "pi_submission_persistence_pending",
      });

      await vi.advanceTimersByTimeAsync(5_000);
      await pending;
      await expect(
        driver.reconcileSubmission({
          scope,
          workspace: fixture.workspace,
          binding: target,
          applicationOperationId: submission.applicationOperationId,
          reconciliationToken: submission.reconciliationToken,
        }),
      ).resolves.toEqual({ status: "not_accepted", retryable: true });
      const persisted = await new PiSessionStore({
        sessionDirectory: fixture.sessions,
      }).openPersisted(fixture.workspace, created.backendConversationId);
      expect(
        persisted!
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "message" && entry.message.role === "user",
          ),
      ).toEqual([]);
      await handle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies ask mode with the full tool catalog and reports ask as effective", async () => {
    const fixture = await workspace();
    const appliedSelections: string[][] = [];
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: () => "ask",
      sessionDirectory: fixture.sessions,
      sessionFactory: toolAccessSessionFactory(appliedSelections),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "ask-mode-thread",
      applicationOperationId: "ask-mode-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId, "ask-mode-thread"),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    expect(appliedSelections).toEqual([
      ["read", "grep", "bash", "project_extension"],
    ]);
    const askCapabilities = await handle.backendCapabilities();
    expect(askCapabilities).toMatchObject({
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      effectiveSettings: { toolAccess: "ask" },
    });
    expect(askCapabilities.interactionKinds).toContain("decision");
    expect(askCapabilities.interactionKinds).not.toContain("questionnaire");
    await expect(
      handle.perform({
        applicationOperationId: "ask-to-full",
        action: "set_tool_access",
        mode: "full",
      }),
    ).resolves.toMatchObject({ accepted: true });
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      effectiveSettings: { toolAccess: "full" },
    });
    await expect(
      handle.perform({
        applicationOperationId: "full-to-ask",
        action: "set_tool_access",
        mode: "ask",
      }),
    ).resolves.toMatchObject({ accepted: true });
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      effectiveSettings: { toolAccess: "ask" },
    });
    expect(appliedSelections.at(-1)).toEqual([
      "read",
      "grep",
      "bash",
      "project_extension",
    ]);
    await handle.close();
  });

  it("reapplies persisted read-only tool access before every reopened session is used", async () => {
    const fixture = await workspace();
    const appliedSelections: string[][] = [];
    const policyCalls: string[] = [];
    const options: PiDriverOptions = {
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: (_policyScope, applicationThreadId) => {
        policyCalls.push(applicationThreadId);
        return "read_only";
      },
      sessionDirectory: fixture.sessions,
      sessionFactory: toolAccessSessionFactory(appliedSelections),
    };
    const first = new PiConversationBackendDriver(options);
    const created = await first.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "tool-policy-create",
      applicationOperationId: "tool-policy-create",
      source: { kind: "user" },
    });
    const target = binding(created.backendConversationId);
    const firstHandle = await first.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });

    expect(appliedSelections).toEqual([["read", "grep"]]);
    await expect(firstHandle.backendCapabilities()).resolves.toMatchObject({
      effectiveSettings: { toolAccess: "read_only" },
    });
    await firstHandle.close();

    const restarted = new PiConversationBackendDriver(options);
    await restarted.read({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const reopenedHandle = await restarted.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });

    expect(appliedSelections).toEqual([
      ["read", "grep"],
      ["read", "grep"],
      ["read", "grep"],
    ]);
    expect(policyCalls).toEqual(["thread", "thread", "thread"]);
    await expect(reopenedHandle.backendCapabilities()).resolves.toMatchObject({
      effectiveSettings: { toolAccess: "read_only" },
    });
    await reopenedHandle.close();
  });

  it("registers the fixed Sedes ceiling and applies the exact live native policy", async () => {
    const fixture = await workspace();
    const registry = new AgentToolRegistry();
    registry.register(agentContextToolDefinition);
    const contract = registry.artifact(
      agentContextToolDefinition.id,
      agentContextToolDefinition.schemaVersion,
    );
    const nonReadContract = {
      ...contract,
      id: "workspace.mutate",
      effects: {
        application: "write" as const,
        modelUsage: "none" as const,
        external: "none" as const,
      },
      adapters: {
        ...contract.adapters,
        pi: {
          name: "sedes_workspace_mutate",
          label: "Sedes workspace mutation",
        },
      },
    };
    const eligibleCatalog = vi.fn(() => [contract, nonReadContract]);
    let enabledToolIds = [contract.id, nonReadContract.id];
    let presentation:
      | { surface: "cli"; mode: "progressive" }
      | { surface: "native"; mode: "individual" } = {
      surface: "native",
      mode: "individual",
    };
    const facade = {
      eligibleCatalog,
      catalogSummaries: () => [],
      describeMany: () => [],
      readPolicy: () => ({
        enabled: true,
        presentation,
        accessBoundary: "environment" as const,
        enabledToolIds,
      }),
      invoke: async () => {
        throw new Error("unexpected_agent_tool_invocation");
      },
    } satisfies BackendAgentToolFacade;
    const base = fakeSessionFactory();
    const customToolInputs: Array<
      readonly { readonly name: string }[] | undefined
    > = [];
    const protectedAgentToolNameInputs: Array<readonly string[] | undefined> =
      [];
    const appliedSelections: string[][] = [];
    const cliCapabilities = createFakeAgentToolSourceCapabilities();
    const sessionFactory: PiSdkSessionFactory = {
      async create(input) {
        customToolInputs.push(input.customTools);
        protectedAgentToolNameInputs.push(
          input.protectedAgentToolNames
            ? [...input.protectedAgentToolNames]
            : undefined,
        );
        const session = await base.create(input);
        let active: string[] = [];
        const allTools = [
          {
            name: "read",
            description: "Read",
            parameters: {},
            promptGuidelines: [],
            sourceInfo: { source: "builtin", path: "<builtin:read>" },
          },
          {
            name: "bash",
            description: "Bash",
            parameters: {},
            promptGuidelines: [],
            sourceInfo: { source: "builtin", path: "<builtin:bash>" },
          },
          {
            name: "grep",
            description: "Grep",
            parameters: {},
            promptGuidelines: [],
            sourceInfo: { source: "builtin", path: "<builtin:grep>" },
          },
          ...(input.customTools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            promptGuidelines: tool.promptGuidelines ?? [],
            sourceInfo: { source: "sdk", path: `<sdk:${tool.name}>` },
          })),
        ] as unknown as ReturnType<PiSdkSession["getAllTools"]>;
        return {
          ...session,
          getActiveToolNames: () => [...active],
          getAllTools: () => allTools,
          setActiveToolsByName(names) {
            active = [...names];
            appliedSelections.push([...names]);
          },
        };
      },
    };
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: facade,
      agentToolSourceCapabilities: cliCapabilities.issuer,
      toolAccessPolicy: () => "read_only",
      sessionDirectory: fixture.sessions,
      sessionFactory,
      agentToolCli: {
        availability: "available",
        endpoint: "http://127.0.0.1:4784",
        executableDirectory: "/opt/sedes/bin",
        inheritedPath: "/usr/bin",
      },
    });

    await driver.catalog({ scope, workspace: fixture.workspace });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "agent-tool-create",
      applicationOperationId: "agent-tool-create",
      source: { kind: "user" },
    });
    const target = binding(created.backendConversationId);
    await driver.read({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    expect(cliCapabilities.issue).not.toHaveBeenCalled();

    expect(
      customToolInputs.map((tools) => tools?.map(({ name }) => name)),
    ).toEqual([
      undefined,
      undefined,
      [
        "sedes_agent_context",
        "sedes_workspace_mutate",
        "sedes_catalog",
        "sedes_read",
        "sedes_act",
      ],
    ]);
    expect(protectedAgentToolNameInputs).toEqual([
      undefined,
      undefined,
      ["sedes_workspace_mutate", "sedes_act"],
    ]);
    expect(eligibleCatalog).toHaveBeenCalledOnce();
    expect(eligibleCatalog).toHaveBeenCalledWith("pi_sdk");
    expect(appliedSelections).toEqual([
      ["read", "grep"],
      ["read", "grep", "sedes_agent_context"],
    ]);
    enabledToolIds = [contract.id];
    await expect(
      handle.perform({
        applicationOperationId: "agent-tool-access-full",
        action: "set_tool_access",
        mode: "full",
      }),
    ).resolves.toMatchObject({ accepted: true });
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      effectiveSettings: { toolAccess: "full" },
    });
    expect(appliedSelections.at(-1)).toEqual([
      "read",
      "bash",
      "grep",
      "sedes_agent_context",
    ]);
    enabledToolIds = [contract.id, nonReadContract.id];
    await expect(
      handle.perform({
        applicationOperationId: "agent-tool-access-ask",
        action: "set_tool_access",
        mode: "ask",
      }),
    ).resolves.toMatchObject({ accepted: true });
    await expect(handle.backendCapabilities()).resolves.toMatchObject({
      effectiveSettings: { toolAccess: "ask" },
    });
    expect(appliedSelections.at(-1)).toEqual([
      "read",
      "bash",
      "grep",
      "sedes_agent_context",
      "sedes_workspace_mutate",
    ]);
    presentation = { surface: "cli", mode: "progressive" };
    await expect(
      handle.submit({
        applicationOperationId: "agent-tool-cli-submit",
        mutationId: "agent-tool-cli-mutation",
        reconciliationToken: "agent-tool-cli-token",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: "Use CLI presentation",
        source: { kind: "user" },
      }),
    ).resolves.toMatchObject({ accepted: true });
    expect(appliedSelections.at(-1)).toEqual(["read", "bash", "grep"]);
    await expect(
      handle.perform({
        applicationOperationId: "agent-tool-cli-read-only",
        action: "set_tool_access",
        mode: "read_only",
      }),
    ).resolves.toMatchObject({ accepted: true });
    expect(appliedSelections.at(-1)).toEqual(["read", "grep"]);
    await handle.close();
    await handle.close();
    expect(cliCapabilities.issue).not.toHaveBeenCalled();
  });

  it.each(["progressive", "individual"] as const)(
    "provisions local %s CLI authority while access is disabled and no tools are selected",
    async (mode) => {
      const fixture = await workspace();
      const base = fakeSessionFactory();
      const cliEnvironments: unknown[] = [];
      const capabilities = createFakeAgentToolSourceCapabilities();
      const driver = new PiConversationBackendDriver({
        instance,
        connection,
        usage: NO_USAGE_SINK,
        nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
        toolProvenanceKey,
        agentTools: {
          ...noAgentTools,
          readPolicy: () => ({
            enabled: false,
            presentation: { surface: "cli", mode },
            accessBoundary: "environment",
            enabledToolIds: [],
          }),
        },
        agentToolSourceCapabilities: capabilities.issuer,
        toolAccessPolicy: fullToolAccessPolicy,
        sessionDirectory: fixture.sessions,
        sessionFactory: {
          async create(input) {
            cliEnvironments.push(input.cliEnvironment);
            return base.create(input);
          },
        },
        agentToolCli: {
          availability: "available",
          endpoint: "http://127.0.0.1:4784",
          executableDirectory: "/opt/sedes/bin",
          inheritedPath: "/usr/bin",
        },
      });
      const created = await driver.create({
        scope,
        workspace: fixture.workspace,
        applicationThreadId: "cli-disabled",
        applicationOperationId: "cli-disabled",
        source: { kind: "user" },
      });
      const handle = await driver.attach({
        scope,
        workspace: fixture.workspace,
        binding: binding(created.backendConversationId),
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      expect(cliEnvironments).toEqual([
        expect.objectContaining({
          SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY: expect.any(String),
          SEDES_AGENT_TOOL_CLI_MODE: mode,
        }),
      ]);
      expect(capabilities.issue).toHaveBeenCalledOnce();
      await handle.close();
    },
  );

  it("keeps CLI-mode conversations attachable when the CLI environment is unavailable", async () => {
    const fixture = await workspace();
    const registry = new AgentToolRegistry();
    registry.register(agentContextToolDefinition);
    const contract = registry.artifact(
      agentContextToolDefinition.id,
      agentContextToolDefinition.schemaVersion,
    );
    const facade = {
      eligibleCatalog: () => [contract],
      catalogSummaries: () => [],
      describeMany: () => [],
      readPolicy: () => ({
        enabled: true,
        presentation: { surface: "cli" as const, mode: "progressive" as const },
        accessBoundary: "environment" as const,
        enabledToolIds: [contract.id],
      }),
      invoke: async () => {
        throw new Error("unexpected_agent_tool_invocation");
      },
    } satisfies BackendAgentToolFacade;
    const base = fakeSessionFactory();
    const cliEnvironments: Array<unknown> = [];
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: facade,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: {
        async create(input) {
          cliEnvironments.push(input.cliEnvironment);
          const session = await base.create(input);
          let active: string[] = [];
          const customTools = (input.customTools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            promptGuidelines: tool.promptGuidelines ?? [],
            sourceInfo: { source: "sdk", path: `<sdk:${tool.name}>` },
          })) as unknown as ReturnType<PiSdkSession["getAllTools"]>;
          return {
            ...session,
            getAllTools: () => customTools,
            getActiveToolNames: () => [...active],
            setActiveToolsByName(names) {
              active = [...names];
            },
          };
        },
      },
      agentToolCli: {
        availability: "unavailable",
        reason: "cli_unavailable",
      },
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "cli-unavailable",
      applicationOperationId: "cli-unavailable",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });

    expect(cliEnvironments).toEqual([undefined]);
    await expect(
      handle.submit({
        applicationOperationId: "cli-unavailable-submit",
        mutationId: "cli-unavailable-submit",
        reconciliationToken: "cli-unavailable-submit",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: "continue without agent tools",
        source: { kind: "user" },
      }),
    ).resolves.toMatchObject({ accepted: true });
    await handle.close();
  });

  it("maps attach-time agent tool presentation failures to backend errors", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: {
        ...noAgentTools,
        readPolicy: () => ({
          enabled: true,
          presentation: { surface: "invalid" as never, mode: "individual" },
          accessBoundary: "environment" as const,
          enabledToolIds: [],
        }),
      },
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "invalid-agent-tool-presentation",
      applicationOperationId: "invalid-agent-tool-presentation",
      source: { kind: "user" },
    });

    await expect(
      driver.attach({
        scope,
        workspace: fixture.workspace,
        binding: binding(created.backendConversationId),
        opaqueBindingDetail: created.opaqueBindingDetail,
      }),
    ).rejects.toMatchObject({ backendCode: "pi_operation_failed" });
  });

  it.each(["recovery", "handle construction"] as const)(
    "releases every attach resource when final %s fails",
    async (failurePoint) => {
      const fixture = await workspace();
      const cliCapabilities = createFakeAgentToolSourceCapabilities();
      const base = fakeSessionFactory();
      const dispose = vi.fn();
      let interactions: PiInteractionBridge | undefined;
      const driver = new PiConversationBackendDriver({
        instance,
        connection,
        usage: NO_USAGE_SINK,
        nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
        toolProvenanceKey,
        agentTools: noAgentTools,
        agentToolSourceCapabilities: cliCapabilities.issuer,
        toolAccessPolicy: fullToolAccessPolicy,
        sessionDirectory: fixture.sessions,
        sessionFactory: {
          async create(input) {
            interactions = input.interactions;
            vi.spyOn(input.interactions, "close");
            const session = await base.create(input);
            const originalDispose = session.dispose.bind(session);
            const failedSession: PiSdkSession = {
              ...session,
              dispose() {
                dispose();
                originalDispose();
              },
              ...(failurePoint === "handle construction"
                ? {
                    subscribe: () => {
                      throw new Error("pi_handle_construction_failed");
                    },
                  }
                : {}),
            };
            if (failurePoint === "recovery") {
              vi.spyOn(
                failedSession.sessionManager,
                "getBranch",
              ).mockImplementationOnce(() => {
                throw new Error("pi_attestation_recovery_failed");
              });
            }
            return failedSession;
          },
        },
        agentToolCli: {
          availability: "available",
          endpoint: "http://127.0.0.1:4784",
          executableDirectory: "/opt/sedes/bin",
          inheritedPath: "/usr/bin",
        },
      });
      const created = await driver.create({
        scope,
        workspace: fixture.workspace,
        applicationThreadId: `final-${failurePoint}`,
        applicationOperationId: `final-${failurePoint}`,
        source: { kind: "user" },
      });

      await expect(
        driver.attach({
          scope,
          workspace: fixture.workspace,
          binding: binding(created.backendConversationId),
          opaqueBindingDetail: created.opaqueBindingDetail,
        }),
      ).rejects.toMatchObject({ backendCode: "pi_operation_failed" });
      expect(cliCapabilities.issue).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
      expect(interactions?.close).toHaveBeenCalledOnce();
    },
  );

  it("keeps Sedes tool invocation correlated to the run start after steering", async () => {
    const fixture = await workspace();
    const registry = new AgentToolRegistry();
    registry.register(agentContextToolDefinition);
    const contract = registry.artifact(
      agentContextToolDefinition.id,
      agentContextToolDefinition.schemaVersion,
    );
    let invocation: Parameters<BackendAgentToolFacade["invoke"]>[0] | undefined;
    const facade: BackendAgentToolFacade = {
      eligibleCatalog: () => [contract],
      catalogSummaries: () => [],
      describeMany: () => [],
      readPolicy: () => ({
        enabled: true,
        presentation: { surface: "native", mode: "individual" },
        accessBoundary: "environment",
        enabledToolIds: [contract.id],
      }),
      async invoke<Output>(input: BackendAgentToolInvocationInput) {
        invocation = input;
        return {
          invocationId: "invocation-after-steer",
          state: "completed",
          output: { status: "ok" } as Output,
        };
      },
    };
    const base = fakeSessionFactory(
      0,
      false,
      () => undefined,
      0,
      (text) => [text],
    );
    let sedesTool:
      | NonNullable<
          Parameters<PiSdkSessionFactory["create"]>[0]["customTools"]
        >[number]
      | undefined;
    let manager:
      Parameters<PiSdkSessionFactory["create"]>[0]["manager"] | undefined;
    const sessionFactory: PiSdkSessionFactory = {
      async create(input) {
        manager = input.manager;
        input.manager.appendCustomEntry(
          piSubmissionMarkerType,
          createPiSubmissionMarker({
            applicationOperationId: "agent-tool-submit-operation",
            mutationId: "agent-tool-submit-mutation",
            reconciliationToken: "agent-tool-submit-token",
            mode: "submit",
            contextExcerpts: [],
            attachments: [],
            taskContexts: [],
            text: "Original run prompt",
          }),
        );
        input.manager.appendMessage({
          role: "user",
          content: [{ type: "text", text: "Original run prompt" }],
          timestamp: Date.now(),
        });
        sedesTool = input.customTools?.[0];
        const session = await base.create(input);
        let activeTools: string[] = [];
        const allTools = (input.customTools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          promptGuidelines: tool.promptGuidelines ?? [],
          sourceInfo: { source: "sdk" as const, path: `<sdk:${tool.name}>` },
        })) as unknown as ReturnType<PiSdkSession["getAllTools"]>;
        return {
          ...session,
          getActiveToolNames: () => [...activeTools],
          getAllTools: () => allTools,
          setActiveToolsByName(names) {
            activeTools = [...names];
          },
        };
      },
    };
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: facade,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory,
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "agent-tool-steer-create",
      applicationOperationId: "agent-tool-steer-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const originalTurnId = manager!
      .getBranch()
      .find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )!.id;
    const projection = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const normalized = new ConversationProjector({
      backendInstanceId: instance.id,
      bindingIdentity: created.backendConversationId,
    });
    normalized.replace(projection.snapshot, projection.handleSequence);
    const events: SequencedBackendEvent[] = [];
    const projectionResults: ReturnType<ConversationProjector["apply"]>[] = [];
    const unsubscribe = projection.subscribeFromNext((event) => {
      events.push(event);
      projectionResults.push(normalized.apply(event));
    });
    const steerContextExcerpt = {
      id: "c43be720-4f91-4bdd-ae1c-f0119462943e",
      excerpt: "Earlier settled clarification",
      note: "Keep this context through steering.",
      source: {
        kind: "conversation_message" as const,
        itemId: "normalized-user-item-2",
        itemRevision: 6,
      },
      locator: {
        kind: "text_quote" as const,
        prefix: "Before ",
        suffix: " after.",
      },
    };

    await expect(
      handle.steer({
        applicationOperationId: "agent-tool-steer-operation",
        mutationId: "agent-tool-steer-mutation",
        reconciliationToken: "agent-tool-steer-token",
        contextExcerpts: [steerContextExcerpt],
        attachments: [],
        taskContexts: [],
        target: { kind: "turn", turnId: originalTurnId },
        text: "Steer during the same provider run",
      }),
    ).resolves.toMatchObject({ status: "accepted" });
    const steerTurnId = manager!
      .getBranch()
      .findLast(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )!.id;
    expect(steerTurnId).not.toBe(originalTurnId);
    await expect(
      handle.steer({
        applicationOperationId: "agent-tool-steer-operation",
        mutationId: "agent-tool-steer-mutation",
        reconciliationToken: "agent-tool-steer-token",
        contextExcerpts: [steerContextExcerpt],
        attachments: [],
        taskContexts: [],
        target: { kind: "turn", turnId: steerTurnId },
        text: "Steer during the same provider run",
      }),
    ).rejects.toMatchObject({ backendCode: "pi_steer_replay_mismatch" });
    await vi.waitFor(() => {
      expect(events.some(({ event }) => event.type === "turn_updated")).toBe(
        true,
      );
    });
    expect(
      events.filter(({ event }) => event.type === "turn_completed"),
    ).toEqual([]);
    expect(
      projectionResults.filter(({ kind }) => kind === "resnapshot_required"),
    ).toEqual([]);
    expect(
      events.findLast(({ event }) => event.type === "turn_updated")?.event,
    ).toMatchObject({
      type: "turn_updated",
      turn: {
        backendTurnId: originalTurnId,
        completionCorrelations: [
          "agent-tool-submit-operation",
          "agent-tool-steer-operation",
        ],
        status: "in_progress",
      },
    });
    expect(
      events.findLast(
        ({ event }) =>
          event.type === "item_completed" &&
          event.item.backendItemId === `${steerTurnId}:user`,
      )?.event,
    ).toMatchObject({
      type: "item_completed",
      item: {
        backendTurnId: originalTurnId,
        sourceOrder: expect.any(Number),
        content: [
          { kind: "context_excerpt", excerpt: steerContextExcerpt },
          {
            kind: "text",
            text: { text: "Steer during the same provider run" },
          },
        ],
      },
    });
    manager!.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "sedes-call-after-steer",
          name: "sedes_agent_context",
          arguments: {},
        },
      ],
      api: "test",
      provider: "test",
      model: "model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });

    await expect(
      sedesTool!.execute(
        "sedes-call-after-steer",
        {},
        new AbortController().signal,
        undefined,
        {} as never,
      ),
    ).resolves.toMatchObject({
      details: { invocation: { invocationId: "invocation-after-steer" } },
    });
    expect(invocation?.source).toMatchObject({
      sourceThreadId: "thread",
      sourceWorkspaceId: fixture.workspace.summary.id,
      backendKind: "pi",
    });
    expect(steerTurnId).not.toBe(originalTurnId);
    await expect(
      driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: binding(created.backendConversationId),
        applicationOperationId: "agent-tool-steer-operation",
        reconciliationToken: "agent-tool-steer-token",
      }),
    ).resolves.toMatchObject({
      status: "accepted",
      backendTurn: {
        backendTurnId: originalTurnId,
        completionCorrelations: [
          "agent-tool-submit-operation",
          "agent-tool-steer-operation",
        ],
      },
    });
    unsubscribe();
    await handle.close();
  });

  it("derives the agent-tool source from the scoped binding", async () => {
    const fixture = await workspace();
    const readPolicy = vi.fn(() => ({
      enabled: false,
      presentation: { surface: "native" as const, mode: "individual" as const },
      accessBoundary: "environment" as const,
      enabledToolIds: [],
    }));
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: {
        eligibleCatalog: () => [],
        catalogSummaries: () => [],
        describeMany: () => [],
        readPolicy,
        invoke: vi.fn(),
      },
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "authority-mismatch-create",
      applicationOperationId: "authority-mismatch-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    expect(readPolicy).toHaveBeenCalledWith({
      scope,
      sourceThreadId: "thread",
      sourceWorkspaceId: fixture.workspace.summary.id,
      sourceEnvironmentId: fixture.workspace.summary.environmentId,
      backendKind: "pi",
    });
    await handle.close();
  });

  it("captures a retry anchor and starts a fresh turn after a failed turn", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        false,
        () => undefined,
        0,
        undefined,
        0,
        ["error"],
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "failed-turn-create",
      applicationOperationId: "failed-turn-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const projection = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: SequencedBackendEvent[] = [];
    const unsubscribe = projection.subscribeFromNext((event) =>
      events.push(event),
    );

    await handle.submit({
      applicationOperationId: "failed-turn-first",
      source: { kind: "user" },
      mutationId: "failed-turn-first",
      reconciliationToken: "failed-turn-first",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "first",
    });
    await vi.waitFor(() =>
      expect(
        events.some(
          ({ event }) =>
            event.type === "run_state_changed" && event.state === "failed",
        ),
      ).toBe(true),
    );

    await expect(handle.captureSubmissionRetryAnchor()).resolves.toEqual(
      expect.any(String),
    );
    await expect(
      handle.submit({
        applicationOperationId: "failed-turn-second",
        source: { kind: "user" },
        mutationId: "failed-turn-second",
        reconciliationToken: "failed-turn-second",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: "second",
      }),
    ).resolves.toMatchObject({
      accepted: true,
      completionCorrelation: "failed-turn-second",
    });

    const persisted = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    expect(
      persisted
        ?.getBranch()
        .filter(
          (entry) => entry.type === "message" && entry.message.role === "user",
        ),
    ).toHaveLength(2);
    unsubscribe();
    await handle.close();
  });

  it("preserves cancellation during retry backoff on reopen without a provider message", async () => {
    const fixture = await workspace();
    let waitingForRetry = false;
    const base = fakeSessionFactory(1, false, undefined, 0, undefined, 0, ["error"]);
    const driver = new PiConversationBackendDriver({
      usage: NO_USAGE_SINK,
      instance, connection, nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey, agentTools: noAgentTools, toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: { async create(input) {
        const session = await base.create(input);
        let idle = true;
        let listener: Parameters<PiSdkSession["subscribe"]>[0] | undefined;
        return {
          ...session,
          get isIdle() { return idle; },
          subscribe(callback) {
            listener = callback;
            return session.subscribe(event => {
              // The native errored attempt is persisted, but retries have not settled.
              if (event.type === "agent_settled") waitingForRetry = true;
              else callback(event);
            });
          },
          async prompt(text, options) { idle = false; await session.prompt(text, options); },
          async abort() {
            idle = true;
            // Pi cancels backoff without an additional assistant message.
            listener?.({ type: "agent_settled" });
          },
        };
      } },
    });
    const created = await driver.create({ scope, workspace: fixture.workspace,
      applicationThreadId: "cancel-retry", applicationOperationId: "cancel-retry", source: { kind: "user" } });
    const attach = { scope, workspace: fixture.workspace, binding: binding(created.backendConversationId), opaqueBindingDetail: created.opaqueBindingDetail };
    const handle = await driver.attach(attach);
    const submitted = await handle.submit({ applicationOperationId: "send", source: { kind: "user" },
      mutationId: "send", reconciliationToken: "send", contextExcerpts: [], attachments: [], taskContexts: [], text: "hi" });
    await vi.waitFor(() => expect(waitingForRetry).toBe(true));
    await handle.interrupt({ applicationOperationId: "cancel", expectedBackendTurnId: submitted.backendTurnId! });
    const live = await handle.establishProjection({ signal: new AbortController().signal });
    expect(live.snapshot.runState).toBe("idle");
    expect(Object.values(live.snapshot.turnsById).at(-1)).toMatchObject({ status: "interrupted", endedBy: "interrupted" });
    expect(Object.values(live.snapshot.turnsById).at(-1)?.failure).toBeUndefined();
    await handle.close();
    const reopened = await driver.attach(attach);
    const cold = await reopened.establishProjection({ signal: new AbortController().signal });
    expect(cold.snapshot.runState).toBe("idle");
    expect(Object.values(cold.snapshot.turnsById).at(-1)).toMatchObject({ status: "interrupted", endedBy: "interrupted" });
    expect(Object.values(cold.snapshot.turnsById).at(-1)?.failure).toBeUndefined();
    const persisted = await new PiSessionStore({ sessionDirectory: fixture.sessions }).openPersisted(fixture.workspace, created.backendConversationId);
    expect(persisted?.getBranch().filter(entry => entry.type === "message")).toHaveLength(2);
    await reopened.close();
    const assistant = persisted?.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant");
    if (!persisted || assistant?.type !== "message" || assistant.message.role !== "assistant") throw new Error("Missing assistant fixture");
    persisted.appendMessage({ role: "user", content: [{ type: "text", text: "Later successful work" }], timestamp: Date.now() });
    persisted.appendMessage({ ...assistant.message, stopReason: "stop", errorMessage: undefined, timestamp: Date.now() });
    const sourceCheckpoint = await driver.resolveBranchCheckpoint({ ...attach, selection: { kind: "latest_completed" } });
    const child = await driver.branchConversation({
      scope, workspace: fixture.workspace, applicationOperationId: "cancelled-retry-fork",
      childApplicationThreadId: "cancelled-retry-child", source: { kind: "user" },
      sourceBinding: attach.binding, sourceOpaqueBindingDetail: created.opaqueBindingDetail,
      sourceCheckpoint, requestedBackendConversationId: "cancelled-retry-child", inheritedSettings: { toolAccess: "full" },
    });
    const fork = await driver.attach({ ...attach, binding: binding(child.backendConversationId), opaqueBindingDetail: child.opaqueBindingDetail });
    const forked = await fork.establishProjection({ signal: new AbortController().signal });
    expect(forked.snapshot.runState).toBe("idle");
    const inheritedCancelledTurn = forked.snapshot.turnsById[submitted.backendTurnId!];
    expect(inheritedCancelledTurn).toMatchObject({ status: "interrupted" });
    expect(inheritedCancelledTurn?.failure).toBeUndefined();
    await fork.close();
  });

  it.each(["stop", "error"] as const)("retains only the final %s outcome after retries, live and on reopen", async (finalReason) => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        3,
        false,
        () => undefined,
        0,
        undefined,
        0,
        ["error", "error", finalReason],
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "retry-create",
      applicationOperationId: "retry-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const initial = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: SequencedBackendEvent[] = [];
    const unsubscribe = initial.subscribeFromNext((event) =>
      events.push(event),
    );

    await handle.submit({
      applicationOperationId: "retry-submit",
      source: { kind: "user" },
      mutationId: "retry-submit",
      reconciliationToken: "retry-submit",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "hi",
    });
    await vi.waitFor(() =>
      expect(events.some(({ event }) => event.type === "turn_completed")).toBe(
        true,
      ),
    );
    unsubscribe();
    const replacement = await handle.establishProjection({
      signal: new AbortController().signal,
    });

    expect(
      events.filter(({ event }) => event.type === "turn_completed").at(-1),
    ).toMatchObject({
      event: {
        type: "turn_completed",
        turn: { status: finalReason === "stop" ? "completed" : "failed", endedBy: finalReason === "stop" ? "agent_settled" : "failed" },
      },
    });
    const expectedFailure = finalReason === "error" ? { message: { text: "Unknown model: broken-model" } } : undefined;
    const completionIndex = events.findIndex(({ event }) => event.type === "turn_completed");
    expect(events.slice(0, completionIndex).some(({ event }) => event.type === "run_state_changed" && event.state === "failed")).toBe(false);
    const completed = events[completionIndex]!.event;
    if (completed.type !== "turn_completed") throw new Error("Expected completion");
    expect(completed.turn.failure).toEqual(expectedFailure);
    expect(Object.values(replacement.snapshot.turnsById).at(-1)?.failure).toEqual(expectedFailure);
    expect(replacement.snapshot.runState).toBe(finalReason === "stop" ? "idle" : "failed");
    expect(Object.values(replacement.snapshot.turnsById).at(-1)).toMatchObject({
      status: finalReason === "stop" ? "completed" : "failed",
    });
    const persisted = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    expect(
      persisted
        ?.getBranch()
        .filter(
          (entry) => entry.type === "message" && entry.message.role === "user",
        ),
    ).toHaveLength(1);
    await handle.close();
    const reopened = await driver.attach({ scope, workspace: fixture.workspace, binding: binding(created.backendConversationId), opaqueBindingDetail: created.opaqueBindingDetail });
    const cold = await reopened.establishProjection({ signal: new AbortController().signal });
    expect(cold.snapshot.runState).toBe(finalReason === "stop" ? "idle" : "failed");
    expect(Object.values(cold.snapshot.turnsById).at(-1)?.failure).toEqual(expectedFailure);
    await reopened.close();
  });

  it("reconciles only exact durable interaction-response markers across restart", async () => {
    const fixture = await workspace();
    const baseFactory = fakeSessionFactory();
    let bridge: PiInteractionBridge | undefined;
    let manager:
      Parameters<PiSdkSessionFactory["create"]>[0]["manager"] | undefined;
    const sessionFactory: PiSdkSessionFactory = {
      create: async (input) => {
        bridge = input.interactions;
        manager = input.manager;
        return baseFactory.create(input);
      },
    };
    const options: PiDriverOptions = {
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory,
    };
    const driver = new PiConversationBackendDriver(options);
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "interaction-create",
      applicationOperationId: "interaction-create",
      source: { kind: "user" },
    });
    const target = binding(created.backendConversationId);
    let handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const events: BackendConversationEvent[] = [];
    handle.subscribe((event) => events.push(event));
    const pending = bridge!.uiContext().confirm("Confirm", "Continue?");
    const opened = events.find((event) => event.type === "interaction_opened");
    if (!opened || opened.type !== "interaction_opened") {
      throw new Error("expected interaction");
    }
    const response = {
      applicationOperationId: "interaction-response-operation",
      interactionId: opened.interaction.backendInteractionId,
      kind: "confirmation" as const,
      confirmed: true,
    };

    await handle.respond(response);
    await expect(pending).resolves.toBe(true);
    await expect(
      handle.reconcileInteractionResponse(response),
    ).resolves.toEqual({ outcome: "accepted" });
    await handle.close();

    const restarted = new PiConversationBackendDriver(options);
    handle = await restarted.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    await expect(
      handle.reconcileInteractionResponse(response),
    ).resolves.toEqual({ outcome: "accepted" });
    await expect(
      handle.reconcileInteractionResponse({
        ...response,
        confirmed: false,
      }),
    ).rejects.toMatchObject({
      backendCode: "pi_interaction_response_replay_mismatch",
    });

    const uncertainEvents: BackendConversationEvent[] = [];
    handle.subscribe((event) => uncertainEvents.push(event));
    const uncertainPending = bridge!
      .uiContext()
      .confirm("Confirm", "Continue?");
    const uncertainOpened = uncertainEvents.find(
      (event) => event.type === "interaction_opened",
    );
    if (!uncertainOpened || uncertainOpened.type !== "interaction_opened") {
      throw new Error("expected uncertain interaction");
    }
    const uncertainResponse = {
      applicationOperationId: "uncertain-interaction-response",
      interactionId: uncertainOpened.interaction.backendInteractionId,
      kind: "confirmation" as const,
      confirmed: true,
    };
    manager!.appendCustomEntry(
      piInteractionResponseMarkerType,
      createPiInteractionResponseMarker(uncertainResponse, "started"),
    );
    await handle.close();
    await expect(uncertainPending).resolves.toBe(false);

    const afterCrash = new PiConversationBackendDriver(options);
    const afterCrashHandle = await afterCrash.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    await expect(
      afterCrashHandle.reconcileInteractionResponse(uncertainResponse),
    ).resolves.toEqual({ outcome: "unknown" });
    await afterCrashHandle.close();
  });

  it("deduplicates a completed compact action across handle restart", async () => {
    const fixture = await workspace();
    let compactions = 0;
    const options: PiDriverOptions = {
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(1, false, () => {
        compactions += 1;
      }),
    };
    const first = new PiConversationBackendDriver(options);
    const created = await first.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "action-create",
      applicationOperationId: "action-create",
      source: { kind: "user" },
    });
    const target = binding(created.backendConversationId);
    const handle = await first.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const action = {
      applicationOperationId: "compact-action",
      action: "compact" as const,
      instructions: "Keep the decisions.",
    };

    await expect(handle.reconcileAction(action)).resolves.toEqual({
      outcome: "not_applied",
    });
    await handle.perform(action);
    await handle.perform(action);
    await expect(handle.reconcileAction(action)).resolves.toEqual({
      outcome: "accepted",
    });
    expect(compactions).toBe(1);
    await handle.close();

    const restarted = new PiConversationBackendDriver(options);
    const reopened = await restarted.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    await expect(reopened.reconcileAction(action)).resolves.toEqual({
      outcome: "accepted",
    });
    await reopened.perform(action);
    expect(compactions).toBe(1);
    await expect(
      reopened.perform({
        ...action,
        instructions: "Different request.",
      }),
    ).rejects.toMatchObject({
      backendCode: "pi_action_replay_mismatch",
    });
    await reopened.close();
  });

  it("settles a started compact with no durable native evidence as not applied after restart", async () => {
    const fixture = await workspace();
    let compactions = 0;
    const options: PiDriverOptions = {
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(1, false, () => {
        compactions += 1;
      }),
    };
    const driver = new PiConversationBackendDriver(options);
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "started-compact-create",
      applicationOperationId: "started-compact-create",
      source: { kind: "user" },
    });
    const target = binding(created.backendConversationId);
    const action = {
      applicationOperationId: "started-compact-action",
      action: "compact" as const,
      instructions: "Keep the decisions.",
    };
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    manager?.appendCustomEntry(
      piActionMarkerType,
      createPiActionMarker(action, "started"),
    );

    const restarted = new PiConversationBackendDriver(options);
    const reopened = await restarted.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    await expect(reopened.reconcileAction(action)).resolves.toEqual({
      outcome: "not_applied",
    });

    await expect(reopened.perform(action)).resolves.toMatchObject({
      accepted: true,
    });
    expect(compactions).toBe(1);
    await expect(reopened.reconcileAction(action)).resolves.toEqual({
      outcome: "accepted",
    });
    await reopened.close();
  });

  it("accepts a started compact with durable native compaction evidence after restart", async () => {
    const fixture = await workspace();
    const options: PiDriverOptions = {
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    };
    const driver = new PiConversationBackendDriver(options);
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "observed-compact-create",
      applicationOperationId: "observed-compact-create",
      source: { kind: "user" },
    });
    const action = {
      applicationOperationId: "observed-compact-action",
      action: "compact" as const,
      instructions: "Keep the decisions.",
    };
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const startedMarkerEntryId = manager?.appendCustomEntry(
      piActionMarkerType,
      createPiActionMarker(action, "started"),
    );
    if (!startedMarkerEntryId)
      throw new Error("expected_started_compact_marker");
    manager?.appendCompaction(
      "Persisted compact summary",
      startedMarkerEntryId,
      42,
    );

    const restarted = new PiConversationBackendDriver(options);
    const reopened = await restarted.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    await expect(reopened.reconcileAction(action)).resolves.toEqual({
      outcome: "accepted",
    });
    await reopened.close();
  });

  it("rejects an unsupported thinking level before the submission boundary", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: thinkingLevelSessionFactory(["low", "medium", "high"]),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "thinking-create",
      applicationOperationId: "thinking-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const action = {
      applicationOperationId: "thinking-off",
      action: "set_thinking_level" as const,
      level: "off",
    };

    // The provider clamps the unsupported level back to the current one, so
    // the action provably never applied and fails before the boundary.
    await expect(handle.perform(action)).rejects.toMatchObject({
      category: "rejected",
      backendCode: "pi_thinking_level_unsupported",
      crossedSubmissionBoundary: false,
    });
    // A started marker with no native evidence of the requested level
    // reconciles as provably not applied instead of wedging the thread.
    await expect(handle.reconcileAction(action)).resolves.toEqual({
      outcome: "not_applied",
    });
    await expect(handle.perform(action)).rejects.toMatchObject({
      backendCode: "pi_thinking_level_unsupported",
      crossedSubmissionBoundary: false,
    });
    const persisted = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    // Both attempts share one started marker; no completed marker exists.
    expect(
      persisted
        ?.getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" && entry.customType === piActionMarkerType,
        )
        .map((entry) =>
          entry.type === "custom"
            ? (entry.data as { phase?: string }).phase
            : undefined,
        ),
    ).toEqual(["started"]);
    await handle.close();
  });

  it("keeps a thinking-level change to an unexpected value uncertain, then settles not applied", async () => {
    const fixture = await workspace();
    const options: PiDriverOptions = {
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: thinkingLevelSessionFactory(["low", "high"]),
    };
    const driver = new PiConversationBackendDriver(options);
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "thinking-clamp-create",
      applicationOperationId: "thinking-clamp-create",
      source: { kind: "user" },
    });
    const target = binding(created.backendConversationId);
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const action = {
      applicationOperationId: "thinking-max",
      action: "set_thinking_level" as const,
      level: "max",
    };

    // The provider clamped to a different level than both the request and
    // the prior state, so the outcome is genuinely unknown and fails closed.
    await expect(handle.perform(action)).rejects.toMatchObject({
      category: "submission_unknown",
      backendCode: "pi_thinking_level_outcome_unknown",
      crossedSubmissionBoundary: true,
    });
    // The requested level never appears in native history: reconciliation
    // proves the action not applied, and re-performance now observes the
    // unchanged post-state and rejects before the boundary.
    await expect(handle.reconcileAction(action)).resolves.toEqual({
      outcome: "not_applied",
    });
    await expect(handle.perform(action)).rejects.toMatchObject({
      backendCode: "pi_thinking_level_unsupported",
      crossedSubmissionBoundary: false,
    });
    await handle.close();

    const restarted = new PiConversationBackendDriver(options);
    const reopened = await restarted.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    await expect(reopened.reconcileAction(action)).resolves.toEqual({
      outcome: "not_applied",
    });
    await reopened.close();
  });

  it("applies a supported thinking level and reconciles as accepted", async () => {
    const fixture = await workspace();
    const options: PiDriverOptions = {
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: thinkingLevelSessionFactory(["low", "high"]),
    };
    const driver = new PiConversationBackendDriver(options);
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "thinking-ok-create",
      applicationOperationId: "thinking-ok-create",
      source: { kind: "user" },
    });
    const target = binding(created.backendConversationId);
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const action = {
      applicationOperationId: "thinking-high",
      action: "set_thinking_level" as const,
      level: "high",
    };
    await expect(handle.perform(action)).resolves.toMatchObject({
      accepted: true,
    });
    await expect(handle.reconcileAction(action)).resolves.toEqual({
      outcome: "accepted",
    });
    await handle.close();

    const restarted = new PiConversationBackendDriver(options);
    const reopened = await restarted.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    await expect(reopened.reconcileAction(action)).resolves.toEqual({
      outcome: "accepted",
    });
    await reopened.close();
  });

  it("keeps a started action with native evidence of the requested level unknown", async () => {
    const fixture = await workspace();
    const options: PiDriverOptions = {
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: thinkingLevelSessionFactory(["low", "max"]),
    };
    const driver = new PiConversationBackendDriver(options);
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "thinking-evidence-create",
      applicationOperationId: "thinking-evidence-create",
      source: { kind: "user" },
    });
    const target = binding(created.backendConversationId);
    const action = {
      applicationOperationId: "thinking-evidence",
      action: "set_thinking_level" as const,
      level: "max",
    };
    // Simulate an action that applied and was later reverted outside the
    // recorded marker: started marker plus a durable change to the requested
    // level, while the current session level differs.
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    manager?.appendCustomEntry(
      piActionMarkerType,
      createPiActionMarker(action, "started"),
    );
    manager?.appendThinkingLevelChange("max");
    manager?.appendThinkingLevelChange("low");

    const restarted = new PiConversationBackendDriver(options);
    const reopened = await restarted.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    await expect(reopened.reconcileAction(action)).resolves.toEqual({
      outcome: "unknown",
    });
    await reopened.close();
  });

  it("does not enumerate Pi sessions when discovery is already cancelled", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    });
    const cancellation = new Error("shutdown");
    const controller = new AbortController();
    controller.abort(cancellation);

    await expect(
      driver.discover({
        scope,
        workspace: fixture.workspace,
        signal: controller.signal,
        limit: 10,
      }),
    ).rejects.toBe(cancellation);
  });

  it.each([0, 1, 100, 101, 250])(
    "enumerates and projects %i Pi conversations exactly once across every page",
    async (count) => {
      const fixture = await workspace();
      const store = new PiSessionStore({ sessionDirectory: fixture.sessions });
      const listed: readonly PiStoredConversationWithAncestry[] = Array.from(
        { length: count },
        (_, index) => ({
          backendConversationId: `discovery-${index}`,
          canonicalWorkspacePath: fixture.workspace.canonicalPath,
          title: `Discovery ${index}`,
          updatedAt: new Date(10_000 - index).toISOString(),
          sessionFile: path.join(fixture.sessions, `${index}.jsonl`),
        }),
      );
      const enumerate = vi
        .spyOn(store, "listWithAncestry")
        .mockResolvedValue(listed);
      const driver = new PiConversationBackendDriver({
        instance,
        connection,
        usage: NO_USAGE_SINK,
        nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
        toolProvenanceKey,
        agentTools: noAgentTools,
        toolAccessPolicy: fullToolAccessPolicy,
        store,
        sessionFactory: fakeSessionFactory(),
      });

      const found: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await driver.discover({
          scope,
          workspace: fixture.workspace,
          signal: new AbortController().signal,
          ...(cursor ? { cursor } : {}),
          limit: 100,
        });
        found.push(
          ...page.conversations.map(
            ({ backendConversationId }) => backendConversationId,
          ),
        );
        cursor = page.nextCursor;
      } while (cursor);

      expect(found).toEqual(
        listed.map(({ backendConversationId }) => backendConversationId),
      );
      expect(enumerate).toHaveBeenCalledOnce();
    },
  );

  it("keeps later pages stable when the Pi store changes and observes changes on the next scan", async () => {
    const fixture = await workspace();
    const store = new PiSessionStore({ sessionDirectory: fixture.sessions });
    const record = (id: number): PiStoredConversationWithAncestry => ({
      backendConversationId: `stable-${id}`,
      canonicalWorkspacePath: fixture.workspace.canonicalPath,
      updatedAt: new Date(10_000 - id).toISOString(),
      sessionFile: path.join(fixture.sessions, `${id}.jsonl`),
    });
    let backing = Array.from({ length: 101 }, (_, index) => record(index));
    const enumerate = vi
      .spyOn(store, "listWithAncestry")
      .mockImplementation(async () => backing);
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      store,
      sessionFactory: fakeSessionFactory(),
    });

    const first = await driver.discover({
      scope,
      workspace: fixture.workspace,
      signal: new AbortController().signal,
      limit: 100,
    });
    backing = [record(999)];
    const terminal = await driver.discover({
      scope,
      workspace: fixture.workspace,
      signal: new AbortController().signal,
      cursor: first.nextCursor!,
      limit: 100,
    });
    expect(
      terminal.conversations.map((item) => item.backendConversationId),
    ).toEqual(["stable-100"]);
    expect(enumerate).toHaveBeenCalledOnce();

    const nextScan = await driver.discover({
      scope,
      workspace: fixture.workspace,
      signal: new AbortController().signal,
      limit: 100,
    });
    expect(
      nextScan.conversations.map((item) => item.backendConversationId),
    ).toEqual(["stable-999"]);
    expect(enumerate).toHaveBeenCalledTimes(2);
  });

  it.each([
    "present",
    "missing",
    "empty",
    "symlink",
    "directory",
    "wrong_identity",
  ] as const)(
    "checks checkpoint persistence without a second lookup (%s)",
    async (state) => {
      const fixture = await workspace();
      const store = new PiSessionStore({ sessionDirectory: fixture.sessions });
      const reserved = await store.reserve(fixture.workspace, "checkpoint-source");
      appendBranchableSessionTurn(reserved.manager, "Ready to fork");
      const driver = new PiConversationBackendDriver({
        instance,
        connection,
        usage: NO_USAGE_SINK,
        nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
        toolProvenanceKey,
        agentTools: noAgentTools,
        toolAccessPolicy: fullToolAccessPolicy,
        store,
        sessionFactory: fakeSessionFactory(),
      });
      const list = vi.spyOn(store, "list");
      const openPersisted = vi.spyOn(store, "openPersisted");
      const open = store.open.bind(store);
      vi.spyOn(store, "open").mockImplementationOnce(async (...args) => {
        const manager = await open(...args);
        const file = manager.getSessionFile()!;
        if (state === "wrong_identity") {
          const lines = (await readFile(file, "utf8")).split("\n");
          const header = JSON.parse(lines[0]!);
          lines[0] = JSON.stringify({ ...header, id: "replaced-source" });
          await writeFile(file, lines.join("\n"));
          manager.setSessionFile(file);
        }
        if (state === "missing") await rm(file);
        if (state === "empty") await writeFile(file, "");
        if (state === "directory") {
          await rm(file);
          await mkdir(file);
        }
        if (state === "symlink") {
          const replacement = path.join(fixture.root, "replacement.jsonl");
          await writeFile(replacement, await readFile(file));
          await rm(file);
          await symlink(replacement, file);
        }
        return manager;
      });
      const result = driver.resolveBranchCheckpoint({
        scope,
        workspace: fixture.workspace,
        binding: binding("checkpoint-source"),
        opaqueBindingDetail: reserved.opaqueBindingDetail,
        selection: { kind: "latest_completed" },
      });
      if (state === "present") {
        await expect(result).resolves.toMatchObject({ kind: "conversation_leaf" });
      } else {
        await expect(result).rejects.toMatchObject({
          backendCode: "pi_checkpoint_unavailable",
        });
      }
      expect(list).toHaveBeenCalledOnce();
      expect(openPersisted).not.toHaveBeenCalled();
    },
  );

  it("projects ancestry for the entire snapshot before page one and never repeats it", async () => {
    const fixture = await workspace();
    const store = new PiSessionStore({ sessionDirectory: fixture.sessions });
    const listed: readonly PiStoredConversationWithAncestry[] = Array.from(
      { length: 3 },
      (_, index) => ({
        backendConversationId: `child-${index}`,
        canonicalWorkspacePath: fixture.workspace.canonicalPath,
        updatedAt: new Date(10_000 - index).toISOString(),
        sessionFile: path.join(fixture.sessions, `child-${index}.jsonl`),
        nativeAncestry: {
          parentBackendConversationId: `parent-${index}`,
          sourceLeafEntryId: "source-leaf",
          sourceBackendTurnId: "source-turn",
          applicationOperationId: `branch-${index}`,
        },
      }),
    );
    const enumerate = vi
      .spyOn(store, "listWithAncestry")
      .mockResolvedValue(listed);
    const openSource = vi.spyOn(store, "openPersisted");
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      store,
      sessionFactory: fakeSessionFactory(),
    });

    const first = await driver.discover({
      scope,
      workspace: fixture.workspace,
      signal: new AbortController().signal,
      limit: 1,
    });
    expect(enumerate).toHaveBeenCalledOnce();
    expect(openSource).not.toHaveBeenCalled();
    expect(first.conversations[0]?.nativeAncestry?.sourceBackendTurnId).toBe(
      "source-turn",
    );
    const second = await driver.discover({
      scope,
      workspace: fixture.workspace,
      signal: new AbortController().signal,
      cursor: first.nextCursor!,
      limit: 1,
    });
    const terminal = await driver.discover({
      scope,
      workspace: fixture.workspace,
      signal: new AbortController().signal,
      cursor: second.nextCursor!,
      limit: 1,
    });
    expect(terminal.conversations[0]?.nativeAncestry?.sourceBackendTurnId).toBe(
      "source-turn",
    );
    expect(enumerate).toHaveBeenCalledOnce();
    expect(openSource).not.toHaveBeenCalled();
  });

  it("rejects an over-count scan before ancestry projection", async () => {
    const fixture = await workspace();
    const store = new PiSessionStore({ sessionDirectory: fixture.sessions });
    const listed: readonly PiStoredConversationWithAncestry[] = [
      {
        backendConversationId: "too-many",
        canonicalWorkspacePath: fixture.workspace.canonicalPath,
        updatedAt: new Date().toISOString(),
        sessionFile: path.join(fixture.sessions, "too-many.jsonl"),
        nativeAncestry: {
          parentBackendConversationId: "parent",
          sourceLeafEntryId: "leaf",
        },
      },
      {
        backendConversationId: "also-too-many",
        canonicalWorkspacePath: fixture.workspace.canonicalPath,
        updatedAt: new Date().toISOString(),
        sessionFile: path.join(fixture.sessions, "also-too-many.jsonl"),
      },
    ];
    vi.spyOn(store, "listWithAncestry").mockResolvedValue(listed);
    const openSource = vi.spyOn(store, "openPersisted");
    const snapshots = new PiDiscoverySnapshotStore({ maximumConversations: 1 });
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      discoverySnapshots: snapshots,
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      store,
      sessionFactory: fakeSessionFactory(),
    });

    await expect(
      driver.discover({
        scope,
        workspace: fixture.workspace,
        signal: new AbortController().signal,
        limit: 1,
      }),
    ).rejects.toMatchObject({
      backendCode: "pi_discovery_snapshot_conversation_limit_exceeded",
    });
    expect(openSource).not.toHaveBeenCalled();
  });

  it("does not retain a snapshot when cancellation wins during enumeration", async () => {
    const fixture = await workspace();
    const store = new PiSessionStore({ sessionDirectory: fixture.sessions });
    const listed: readonly PiStoredConversationWithAncestry[] = [0, 1].map(
      (index) => ({
        backendConversationId: `cancelled-${index}`,
        canonicalWorkspacePath: fixture.workspace.canonicalPath,
        updatedAt: new Date(10_000 - index).toISOString(),
        sessionFile: path.join(fixture.sessions, `cancelled-${index}.jsonl`),
      }),
    );
    let resolveEnumeration!: (
      value: readonly PiStoredConversationWithAncestry[],
    ) => void;
    const deferredEnumeration = new Promise<
      readonly PiStoredConversationWithAncestry[]
    >((resolve) => {
      resolveEnumeration = resolve;
    });
    vi.spyOn(store, "listWithAncestry")
      .mockReturnValueOnce(deferredEnumeration)
      .mockResolvedValueOnce(listed);
    const snapshots = new PiDiscoverySnapshotStore({
      maximumConcurrentSnapshots: 1,
    });
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      discoverySnapshots: snapshots,
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      store,
      sessionFactory: fakeSessionFactory(),
    });
    const controller = new AbortController();
    const cancellation = new Error("cancel discovery");
    const pending = driver.discover({
      scope,
      workspace: fixture.workspace,
      signal: controller.signal,
      limit: 1,
    });
    controller.abort(cancellation);
    resolveEnumeration(listed);

    await expect(pending).rejects.toBe(cancellation);
    await expect(
      driver.discover({
        scope,
        workspace: fixture.workspace,
        signal: new AbortController().signal,
        limit: 1,
      }),
    ).resolves.toMatchObject({ nextCursor: expect.any(String) });
  });

  it("persists a discovery-canonical binding detail for titled creations and branches", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "titled-create-thread",
      applicationOperationId: "titled-create",
      source: { kind: "user" },
      title: "Fireworks",
    });
    expect(created.opaqueBindingDetail).not.toContain("reservedTitle");
    expect(created.opaqueBindingDetail).not.toContain("creationOperationId");

    const discovered = await driver.discover({
      scope,
      workspace: fixture.workspace,
      signal: new AbortController().signal,
      limit: 10,
    });
    const found = discovered.conversations.find(
      ({ backendConversationId }) =>
        backendConversationId === created.backendConversationId,
    );
    // Discovery recomputes exactly the persisted detail, so the repository's
    // immutability guard accepts the refresh by construction.
    expect(found?.opaqueBindingDetail).toBe(created.opaqueBindingDetail);
    expect(found?.title).toBe("Fireworks");

    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const events: SequencedBackendEvent[] = [];
    const initial = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const unsubscribe = initial.subscribeFromNext((event) =>
      events.push(event),
    );
    await handle.submit({
      applicationOperationId: "titled-branch-source-submit",
      source: { kind: "user" },
      mutationId: "titled-branch-source-submit",
      reconciliationToken: "titled-branch-source-submit",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Seed the branch source",
    });
    await vi.waitFor(() =>
      expect(events.some(({ event }) => event.type === "turn_completed")).toBe(
        true,
      ),
    );
    unsubscribe();
    const checkpoint = await driver.resolveBranchCheckpoint({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
      selection: { kind: "latest_completed" },
    });
    const child = await driver.branchConversation({
      scope,
      workspace: fixture.workspace,
      applicationOperationId: "titled-branch",
      childApplicationThreadId: "titled-branch-thread",
      source: { kind: "user" },
      sourceBinding: binding(created.backendConversationId),
      sourceOpaqueBindingDetail: created.opaqueBindingDetail,
      sourceCheckpoint: checkpoint,
      requestedBackendConversationId: "titled-branch-child",
      title: "Branched Fireworks",
      inheritedSettings: { toolAccess: "full" },
    });
    expect(child.opaqueBindingDetail).not.toContain("reservedTitle");
    const rediscovered = await driver.discover({
      scope,
      workspace: fixture.workspace,
      signal: new AbortController().signal,
      limit: 10,
    });
    const foundChild = rediscovered.conversations.find(
      ({ backendConversationId }) =>
        backendConversationId === child.backendConversationId,
    );
    expect(foundChild?.opaqueBindingDetail).toBe(child.opaqueBindingDetail);
    await handle.close();
  });

  it("reimports persisted compaction as exactly one replacement projection", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(1, false, (manager) => {
        const firstKeptEntryId = manager
          .getBranch()
          .find(
            (entry) =>
              entry.type === "message" && entry.message.role === "assistant",
          )?.id;
        if (!firstKeptEntryId) {
          throw new Error("expected_assistant_before_compaction");
        }
        manager.appendCompaction(
          "Persisted compact summary",
          firstKeptEntryId,
          42,
        );
      }),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "compact-projection-create",
      applicationOperationId: "compact-projection-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const initial = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: SequencedBackendEvent[] = [];
    const unsubscribe = initial.subscribeFromNext((event) =>
      events.push(event),
    );

    await handle.submit({
      applicationOperationId: "compact-projection-submit",
      source: { kind: "user" },
      mutationId: "compact-projection-submit",
      reconciliationToken: "compact-projection-submit",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Seed the conversation",
    });
    await vi.waitFor(() =>
      expect(events.some(({ event }) => event.type === "turn_completed")).toBe(
        true,
      ),
    );
    const action = {
      applicationOperationId: "compact-projection-action",
      action: "compact" as const,
      instructions: "Keep only the decisions.",
    };
    await handle.perform(action);
    await handle.perform(action);

    expect(
      events.filter(({ event }) => event.type === "resnapshot_required"),
    ).toHaveLength(1);
    unsubscribe();
    const replacement = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const compacted = Object.values(replacement.snapshot.itemsById).filter(
      (item) => item.semanticKind === "compaction",
    );
    expect(compacted).toHaveLength(1);
    expect(compacted[0]).toMatchObject({
      semanticKind: "compaction",
      summary: { text: "Persisted compact summary" },
    });
    await handle.close();
  });

  it("defers an automatic post-tool compaction replacement until the provider run settles", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        true,
        () => undefined,
        0,
        undefined,
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        false,
        (manager, emit) => {
          const firstKeptEntryId = manager
            .getBranch()
            .find(
              (entry) =>
                entry.type === "message" && entry.message.role === "assistant",
            )?.id;
          if (!firstKeptEntryId) {
            throw new Error("expected_tool_assistant_before_compaction");
          }
          emit({ type: "compaction_start", reason: "threshold" } as never);
          manager.appendCompaction(
            "Automatic post-tool summary",
            firstKeptEntryId,
            84,
          );
          emit({
            type: "compaction_end",
            reason: "threshold",
            result: {
              summary: "Automatic post-tool summary",
              firstKeptEntryId,
              tokensBefore: 84,
              estimatedTokensAfter: 21,
            },
            aborted: false,
            willRetry: false,
          } as never);
        },
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "automatic-compact-projection-create",
      applicationOperationId: "automatic-compact-projection-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const initial = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: SequencedBackendEvent[] = [];
    const unsubscribe = initial.subscribeFromNext((event) =>
      events.push(event),
    );

    await handle.submit({
      applicationOperationId: "automatic-compact-projection-submit",
      source: { kind: "user" },
      mutationId: "automatic-compact-projection-submit",
      reconciliationToken: "automatic-compact-projection-submit",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Read enough context to compact",
    });
    await vi.waitFor(() =>
      expect(
        events.filter(({ event }) => event.type === "resnapshot_required"),
      ).toHaveLength(1),
    );

    const replacementIndex = events.findIndex(
      ({ event }) => event.type === "resnapshot_required",
    );
    const resumedAssistantIndex = events.findIndex(
      ({ event }) =>
        event.type === "item_completed" &&
        event.item.semanticKind === "assistant_message" &&
        event.item.markdown.text === "done",
    );
    expect(resumedAssistantIndex).toBeGreaterThanOrEqual(0);
    expect(replacementIndex).toBeGreaterThan(resumedAssistantIndex);
    expect(
      events.filter(({ event }) => event.type === "resnapshot_required"),
    ).toHaveLength(1);
    expect(events.at(-1)?.event).toMatchObject({
      type: "resnapshot_required",
      reason: "persistence_pending",
    });

    unsubscribe();
    const replacement = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(
      Object.values(replacement.snapshot.itemsById).filter(
        (item) => item.semanticKind === "compaction",
      ),
    ).toHaveLength(1);
    expect(
      Object.values(replacement.snapshot.itemsById).find(
        (item) =>
          item.semanticKind === "assistant_message" &&
          item.markdown.text === "done",
      ),
    ).toBeDefined();
    expect(
      Object.values(replacement.snapshot.itemsById).filter(
        (item) => item.semanticKind === "file_read",
      ),
    ).toHaveLength(1);
    await handle.close();
  });

  it("requests one replacement when idle auto-compaction precedes prompt preflight rejection", async () => {
    const fixture = await workspace();
    const preflightFailure = new Error("before_agent_start rejected");
    let firstKeptEntryId: string | undefined;
    let emitAfterPreflight: ((event: never) => void) | undefined;
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        false,
        () => undefined,
        0,
        undefined,
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        false,
        undefined,
        (manager, emit) => {
          if (!firstKeptEntryId) {
            throw new Error("expected_preflight_compaction_seed");
          }
          manager.appendCompaction(
            "Idle preflight summary",
            firstKeptEntryId,
            84,
          );
          emit({ type: "compaction_start", reason: "threshold" } as never);
          emit({
            type: "compaction_end",
            reason: "threshold",
            result: {
              summary: "Idle preflight summary",
              firstKeptEntryId,
              tokensBefore: 84,
              estimatedTokensAfter: 21,
            },
            aborted: false,
            willRetry: false,
          } as never);
          emitAfterPreflight = emit;
          return preflightFailure;
        },
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "idle-automatic-compact-create",
      applicationOperationId: "idle-automatic-compact-create",
      source: { kind: "user" },
    });
    const manager = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    firstKeptEntryId = manager!.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Prior interrupted turn" }],
      timestamp: Date.now(),
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const initial = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: SequencedBackendEvent[] = [];
    const unsubscribe = initial.subscribeFromNext((event) =>
      events.push(event),
    );

    await expect(
      handle.submit({
        applicationOperationId: "idle-automatic-compact-submit",
        source: { kind: "user" },
        mutationId: "idle-automatic-compact-submit",
        reconciliationToken: "idle-automatic-compact-submit",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: "Reject after compaction",
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "pi_prompt_rejected",
    });

    expect(
      events.filter(({ event }) => event.type === "resnapshot_required"),
    ).toEqual([
      expect.objectContaining({
        event: {
          type: "resnapshot_required",
          reason: "persistence_pending",
        },
      }),
    ]);
    emitAfterPreflight?.({ type: "agent_settled" } as never);
    expect(
      events.filter(({ event }) => event.type === "resnapshot_required"),
    ).toHaveLength(1);

    unsubscribe();
    await handle.close();
  });

  it("surfaces an automatic compaction failure without replacing persisted history", async () => {
    const fixture = await workspace();
    const failure = `Auto-compaction failed: ${"summary unavailable ".repeat(40)}`;
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        true,
        () => undefined,
        0,
        undefined,
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        false,
        (_manager, emit) => {
          emit({ type: "compaction_start", reason: "threshold" } as never);
          emit({
            type: "compaction_end",
            reason: "threshold",
            result: undefined,
            aborted: false,
            willRetry: false,
            errorMessage: failure,
          } as never);
        },
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "automatic-compact-failure-create",
      applicationOperationId: "automatic-compact-failure-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const initial = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: SequencedBackendEvent[] = [];
    const unsubscribe = initial.subscribeFromNext((event) =>
      events.push(event),
    );

    await handle.submit({
      applicationOperationId: "automatic-compact-failure-submit",
      source: { kind: "user" },
      mutationId: "automatic-compact-failure-submit",
      reconciliationToken: "automatic-compact-failure-submit",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Continue even if compaction fails",
    });
    await vi.waitFor(() =>
      expect(
        events.filter(({ event }) => event.type === "notice"),
      ).toHaveLength(1),
    );

    const notices = events.flatMap(({ event }) =>
      event.type === "notice" ? [event.notice] : [],
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      tone: "warning",
      message: {
        text: expect.stringContaining("Auto-compaction failed"),
        truncation: { truncated: true },
      },
    });
    expect(
      events.filter(({ event }) => event.type === "resnapshot_required"),
    ).toEqual([]);
    unsubscribe();
    expect(
      Object.values(
        (
          await handle.establishProjection({
            signal: new AbortController().signal,
          })
        ).snapshot.itemsById,
      ).find(
        (item) =>
          item.semanticKind === "assistant_message" &&
          item.markdown.text === "done",
      ),
    ).toBeDefined();
    expect(
      (await new PiSessionStore({
        sessionDirectory: fixture.sessions,
      }).openPersisted(fixture.workspace, created.backendConversationId))!
        .getBranch()
        .filter((entry) => entry.type === "compaction"),
    ).toEqual([]);
    await handle.close();
  });

  it("persists one exact tool identity marker and reuses it after reopen", async () => {
    const fixture = await workspace();
    const options: PiDriverOptions = {
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(1, true),
    };
    const driver = new PiConversationBackendDriver(options);
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "tool-marker-create",
      applicationOperationId: "tool-marker-create",
      source: { kind: "user" },
    });
    const target = binding(created.backendConversationId);
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const live = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const liveEvents: BackendConversationEvent[] = [];
    const unsubscribeLive = live.subscribeFromNext(({ event }) =>
      liveEvents.push(event),
    );

    await handle.submit({
      applicationOperationId: "tool-marker-submit",
      source: { kind: "user" },
      mutationId: "tool-marker-mutation",
      reconciliationToken: "tool-marker-token",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Read the file",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      liveEvents.filter((event) => event.type === "resnapshot_required"),
    ).toEqual([]);
    expect(
      new Set(
        liveEvents.flatMap((event) =>
          (event.type === "item_started" ||
            event.type === "item_updated" ||
            event.type === "item_completed") &&
          event.item.semanticKind === "file_read"
            ? [event.item.backendItemId]
            : [],
        ),
      ).size,
    ).toBe(1);
    const liveFileReadId = liveEvents.flatMap((event) =>
      (event.type === "item_started" ||
        event.type === "item_updated" ||
        event.type === "item_completed") &&
      event.item.semanticKind === "file_read"
        ? [event.item.backendItemId]
        : [],
    )[0]!;
    unsubscribeLive();
    const settled = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(
      Object.values(settled.snapshot.itemsById).find(
        (item) => item.semanticKind === "file_read",
      )?.backendItemId,
    ).toBe(liveFileReadId);
    const branch = handle.binding.backendConversationId
      ? (await new PiSessionStore({
          sessionDirectory: fixture.sessions,
        }).openPersisted(
          fixture.workspace,
          created.backendConversationId,
        ))!.getBranch()
      : [];
    const markerEntries = branch.filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === piToolIdentityMarkerType,
    );
    expect(markerEntries).toHaveLength(1);
    expect(
      piToolIdentityMarker(markerEntries[0]!, {
        conversationId: created.backendConversationId,
        installationKey: toolProvenanceKey,
      }),
    ).toMatchObject({
      toolCallId: "call-read",
      toolName: "read",
      identity: {
        registrationId: "pi:builtin:read",
        origin: "pi_builtin",
        canonicalKind: "read",
      },
    });
    await handle.close();

    const reopened = new PiConversationBackendDriver(options);
    const reopenedHandle = await reopened.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const read = await reopenedHandle.establishProjection({
      signal: new AbortController().signal,
    });
    expect(
      Object.values(read.snapshot.itemsById).find(
        (item) => item.semanticKind === "file_read",
      ),
    ).toMatchObject({
      semanticKind: "file_read",
      phase: "completed",
      path: { text: "README.md" },
    });
    expect(reopenedHandle.binding.backendConversationId).toBe(
      created.backendConversationId,
    );
    await reopenedHandle.close();
  });

  it("preserves authenticated historical semantic tools in a cloned conversation", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(1, true),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "semantic-clone-source-create",
      applicationOperationId: "semantic-clone-source-create",
      source: { kind: "user" },
    });
    const sourceBinding = binding(created.backendConversationId);
    const sourceHandle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: sourceBinding,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    await sourceHandle.submit({
      applicationOperationId: "semantic-clone-source-submit",
      source: { kind: "user" },
      mutationId: "semantic-clone-source-mutation",
      reconciliationToken: "semantic-clone-source-token",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Read the file before cloning.",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sourceCheckpoint = await driver.resolveBranchCheckpoint({
      scope,
      workspace: fixture.workspace,
      binding: sourceBinding,
      opaqueBindingDetail: created.opaqueBindingDetail,
      selection: { kind: "latest_completed" },
    });
    const cloned = await driver.branchConversation({
      scope,
      workspace: fixture.workspace,
      applicationOperationId: "semantic-clone-create",
      childApplicationThreadId: "semantic-clone-thread",
      source: { kind: "user" },
      sourceBinding,
      sourceOpaqueBindingDetail: created.opaqueBindingDetail,
      sourceCheckpoint,
      requestedBackendConversationId: "semantic-clone-target",
      inheritedSettings: { toolAccess: "full" },
    });
    const clonedRead = await driver.read({
      scope,
      workspace: fixture.workspace,
      binding: {
        ...sourceBinding,
        applicationThreadId: "cloned-thread",
        backendConversationId: cloned.backendConversationId,
      },
      opaqueBindingDetail: cloned.opaqueBindingDetail,
    });

    expect(
      Object.values(clonedRead.snapshot.itemsById).find(
        (item) => item.semanticKind === "file_read",
      ),
    ).toMatchObject({
      semanticKind: "file_read",
      phase: "completed",
      path: { text: "README.md" },
      contentPreview: { text: "project readme" },
    });
    expect(
      Object.values(clonedRead.snapshot.itemsById).find(
        (item) => item.semanticKind === "user_message",
      ),
    ).toMatchObject({
      semanticKind: "user_message",
      deliveryOperationId: "semantic-clone-source-submit",
    });
    await sourceHandle.close();
  });

  it("branches inclusively from a selected completed turn and excludes later turns", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(1, true),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "selected-source-thread",
      applicationOperationId: "selected-source-create",
      source: { kind: "user" },
      requestedBackendConversationId: "selected-source-native",
    });
    const sourceBinding = binding(
      created.backendConversationId,
      "selected-source-thread",
    );
    const sourceHandle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: sourceBinding,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    for (const index of [1, 2, 3]) {
      await sourceHandle.submit({
        applicationOperationId: `selected-submit-${index}`,
        source: { kind: "user" },
        mutationId: `selected-mutation-${index}`,
        reconciliationToken: `selected-token-${index}`,
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: `Turn ${index}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const sourceRead = await driver.read({
      scope,
      workspace: fixture.workspace,
      binding: sourceBinding,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    expect(sourceRead.snapshot.orderedBackendTurnIds).toHaveLength(3);
    const selectedBackendTurnId = sourceRead.snapshot.orderedBackendTurnIds[1]!;
    const checkpoint = await driver.resolveBranchCheckpoint({
      scope,
      workspace: fixture.workspace,
      binding: sourceBinding,
      opaqueBindingDetail: created.opaqueBindingDetail,
      selection: {
        kind: "selected_completed_turn",
        backendTurnId: selectedBackendTurnId,
        boundary: "completed_turn_inclusive",
      },
    });
    await expect(
      driver.branchConversation({
        scope,
        workspace: fixture.workspace,
        applicationOperationId: "selected-missing-settings",
        childApplicationThreadId: "selected-missing-settings-thread",
        source: { kind: "user" },
        sourceBinding,
        sourceOpaqueBindingDetail: created.opaqueBindingDetail,
        sourceCheckpoint: checkpoint,
        requestedBackendConversationId: "selected-missing-settings-child",
      }),
    ).rejects.toMatchObject({ backendCode: "pi_branch_settings_required" });
    const child = await driver.branchConversation({
      scope,
      workspace: fixture.workspace,
      applicationOperationId: "selected-branch-operation",
      childApplicationThreadId: "selected-child-thread",
      source: { kind: "user" },
      sourceBinding,
      sourceOpaqueBindingDetail: created.opaqueBindingDetail,
      sourceCheckpoint: checkpoint,
      requestedBackendConversationId: "selected-child-native",
      inheritedSettings: {
        model: { provider: "test", id: "model" },
        thinkingLevel: "high",
        toolAccess: "full",
      },
    });
    const replay = await driver.branchConversation({
      scope,
      workspace: fixture.workspace,
      applicationOperationId: "selected-branch-operation",
      childApplicationThreadId: "selected-child-thread",
      source: { kind: "user" },
      sourceBinding,
      sourceOpaqueBindingDetail: created.opaqueBindingDetail,
      sourceCheckpoint: checkpoint,
      requestedBackendConversationId: "selected-child-native",
      inheritedSettings: {
        model: { provider: "test", id: "model" },
        thinkingLevel: "high",
        toolAccess: "full",
      },
    });
    expect(replay).toEqual(child);
    const policyChangedDriver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      modelPolicy: compileBackendModelPolicy(
        {
          type: "allowlist",
          allowed: [
            {
              providerIds: ["other"],
              modelIds: ["replacement-model"],
            },
          ],
        },
        "provider_model_effort",
      ),
    });
    await expect(
      policyChangedDriver.branchConversation({
        scope,
        workspace: fixture.workspace,
        applicationOperationId: "selected-branch-operation",
        childApplicationThreadId: "selected-child-thread",
        source: { kind: "user" },
        sourceBinding,
        sourceOpaqueBindingDetail: created.opaqueBindingDetail,
        sourceCheckpoint: checkpoint,
        requestedBackendConversationId: "selected-child-native",
        inheritedSettings: {
          model: { provider: "test", id: "model" },
          thinkingLevel: "high",
          toolAccess: "full",
        },
      }),
    ).resolves.toEqual(child);
    await expect(
      driver.branchConversation({
        scope,
        workspace: fixture.workspace,
        applicationOperationId: "selected-branch-operation",
        childApplicationThreadId: "selected-child-thread",
        source: { kind: "user" },
        sourceBinding,
        sourceOpaqueBindingDetail: created.opaqueBindingDetail,
        sourceCheckpoint: checkpoint,
        requestedBackendConversationId: "selected-child-native",
        inheritedSettings: {
          model: { provider: "test", id: "model" },
          thinkingLevel: "low",
          toolAccess: "full",
        },
      }),
    ).rejects.toMatchObject({ backendCode: "pi_branch_id_collision" });
    const childRead = await driver.read({
      scope,
      workspace: fixture.workspace,
      binding: binding(child.backendConversationId, "selected-child-thread"),
      opaqueBindingDetail: child.opaqueBindingDetail,
    });
    expect(childRead.snapshot.orderedBackendTurnIds).toEqual(
      sourceRead.snapshot.orderedBackendTurnIds.slice(0, 2),
    );
    for (const [index, childId] of [
      [0, "selected-first-child"],
      [2, "selected-latest-child"],
    ] as const) {
      const boundary = sourceRead.snapshot.orderedBackendTurnIds[index]!;
      const boundaryCheckpoint = await driver.resolveBranchCheckpoint({
        scope,
        workspace: fixture.workspace,
        binding: sourceBinding,
        opaqueBindingDetail: created.opaqueBindingDetail,
        selection: {
          kind: "selected_completed_turn",
          backendTurnId: boundary,
          boundary: "completed_turn_inclusive",
        },
      });
      const boundaryChild = await driver.branchConversation({
        scope,
        workspace: fixture.workspace,
        applicationOperationId: `${childId}-operation`,
        childApplicationThreadId: `${childId}-thread`,
        source: { kind: "user" },
        sourceBinding,
        sourceOpaqueBindingDetail: created.opaqueBindingDetail,
        sourceCheckpoint: boundaryCheckpoint,
        requestedBackendConversationId: childId,
        inheritedSettings: { toolAccess: "full" },
      });
      const boundaryRead = await driver.read({
        scope,
        workspace: fixture.workspace,
        binding: binding(
          boundaryChild.backendConversationId,
          `${childId}-thread`,
        ),
        opaqueBindingDetail: boundaryChild.opaqueBindingDetail,
      });
      expect(boundaryRead.snapshot.orderedBackendTurnIds).toEqual(
        sourceRead.snapshot.orderedBackendTurnIds.slice(0, index + 1),
      );
    }
    expect(
      Object.values(childRead.snapshot.itemsById).find(
        (item) =>
          item.backendTurnId === selectedBackendTurnId &&
          item.semanticKind === "file_read",
      ),
    ).toMatchObject({
      phase: "completed",
      contentPreview: { text: "project readme" },
    });
    const persistedChild = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, child.backendConversationId);
    expect(
      persistedChild
        ?.getBranch()
        .some(
          (entry) =>
            entry.type === "thinking_level_change" &&
            entry.thinkingLevel === "high",
        ),
    ).toBe(true);
    expect(
      persistedChild
        ?.getBranch()
        .some(
          (entry) =>
            entry.type === "model_change" &&
            entry.provider === "test" &&
            entry.modelId === "model",
        ),
    ).toBe(true);
    const discovered = await driver.discover({
      scope,
      workspace: fixture.workspace,
      signal: new AbortController().signal,
      limit: 10,
    });
    expect(
      discovered.conversations.find(
        ({ backendConversationId }) =>
          backendConversationId === child.backendConversationId,
      )?.nativeAncestry,
    ).toMatchObject({
      method: "provider_native",
      parentBackendConversationId: created.backendConversationId,
      sourceBackendTurnId: selectedBackendTurnId,
      applicationOperationId: "selected-branch-operation",
    });
    await sourceHandle.close();
  });

  it("forks an earlier completed checkpoint while the source continues an active turn", async () => {
    const fixture = await workspace();
    let releaseActivePrompt!: () => void;
    const activePrompt = new Promise<void>((resolve) => {
      releaseActivePrompt = resolve;
    });
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        false,
        () => undefined,
        0,
        undefined,
        0,
        undefined,
        undefined,
        async (text) => {
          if (text === "Active turn") await activePrompt;
        },
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "active-fork-source-thread",
      applicationOperationId: "active-fork-source-create",
      source: { kind: "user" },
      requestedBackendConversationId: "active-fork-source-native",
    });
    const sourceBinding = binding(
      created.backendConversationId,
      "active-fork-source-thread",
    );
    const sourceHandle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: sourceBinding,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const readSource = () =>
      driver.read({
        scope,
        workspace: fixture.workspace,
        binding: sourceBinding,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
    expect((await sourceHandle.backendCapabilities()).branching).toMatchObject({
      availability: "available",
      sourceMustBeIdle: false,
    });
    for (const index of [1, 2]) {
      await sourceHandle.submit({
        applicationOperationId: `active-fork-completed-${index}`,
        source: { kind: "user" },
        mutationId: `active-fork-completed-mutation-${index}`,
        reconciliationToken: `active-fork-completed-token-${index}`,
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: `Completed turn ${index}`,
      });
      await vi.waitFor(async () => {
        expect((await readSource()).snapshot.runState).toBe("idle");
      });
    }
    const settled = await readSource();
    const selectedBackendTurnId = settled.snapshot.orderedBackendTurnIds[0]!;

    await sourceHandle.submit({
      applicationOperationId: "active-fork-running-submit",
      source: { kind: "user" },
      mutationId: "active-fork-running-mutation",
      reconciliationToken: "active-fork-running-token",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Active turn",
    });
    const whileActive = await readSource();
    expect(whileActive.snapshot.runState).toBe("running");
    expect(whileActive.snapshot.orderedBackendTurnIds).toHaveLength(3);
    const activeBackendTurnId = whileActive.snapshot.activeBackendTurnId!;
    expect(activeBackendTurnId).toBe(
      whileActive.snapshot.orderedBackendTurnIds.at(-1),
    );

    await expect(
      driver.resolveBranchCheckpoint({
        scope,
        workspace: fixture.workspace,
        binding: sourceBinding,
        opaqueBindingDetail: created.opaqueBindingDetail,
        selection: { kind: "latest_provider_snapshot" },
      }),
    ).rejects.toMatchObject({
      category: "invalid_state",
      backendCode: "pi_provider_snapshot_fork_unsupported",
      retryable: false,
      crossedSubmissionBoundary: false,
    });
    await expect(
      driver.resolveBranchCheckpoint({
        scope,
        workspace: fixture.workspace,
        binding: sourceBinding,
        opaqueBindingDetail: created.opaqueBindingDetail,
        selection: { kind: "latest_completed" },
      }),
    ).rejects.toMatchObject({
      category: "invalid_state",
      backendCode: "pi_latest_checkpoint_requires_idle",
      retryable: true,
    });
    await expect(
      driver.resolveBranchCheckpoint({
        scope,
        workspace: fixture.workspace,
        binding: sourceBinding,
        opaqueBindingDetail: created.opaqueBindingDetail,
        selection: {
          kind: "selected_completed_turn",
          backendTurnId: activeBackendTurnId,
          boundary: "completed_turn_inclusive",
        },
      }),
    ).rejects.toMatchObject({ backendCode: "pi_checkpoint_unavailable" });

    const checkpoint = await driver.resolveBranchCheckpoint({
      scope,
      workspace: fixture.workspace,
      binding: sourceBinding,
      opaqueBindingDetail: created.opaqueBindingDetail,
      selection: {
        kind: "selected_completed_turn",
        backendTurnId: selectedBackendTurnId,
        boundary: "completed_turn_inclusive",
      },
    });
    const childInput = {
      scope,
      workspace: fixture.workspace,
      applicationOperationId: "active-fork-child-operation",
      childApplicationThreadId: "active-fork-child-thread",
      source: { kind: "user" as const },
      sourceBinding,
      sourceOpaqueBindingDetail: created.opaqueBindingDetail,
      sourceCheckpoint: checkpoint,
      requestedBackendConversationId: "active-fork-child-native",
      inheritedSettings: { toolAccess: "full" as const },
    };
    const child = await driver.branchConversation(childInput);
    expect(await driver.branchConversation(childInput)).toEqual(child);
    const readChild = () =>
      driver.read({
        scope,
        workspace: fixture.workspace,
        binding: binding(
          child.backendConversationId,
          "active-fork-child-thread",
        ),
        opaqueBindingDetail: child.opaqueBindingDetail,
      });
    const childWhileParentActive = await readChild();
    expect(childWhileParentActive.snapshot.orderedBackendTurnIds).toEqual([
      selectedBackendTurnId,
    ]);
    expect(childWhileParentActive.snapshot.orderedBackendTurnIds).not.toContain(
      activeBackendTurnId,
    );
    const childPersisted = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, child.backendConversationId);
    const childEntries = childPersisted!.getBranch();
    const branchMarkerIndex = childEntries.findIndex(
      (entry) =>
        entry.type === "custom" && entry.customType === piBranchMarkerType,
    );
    expect(branchMarkerIndex).toBeGreaterThanOrEqual(0);
    expect(childEntries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "custom_message",
          customType: "sedes.fork_context_boundary.v1",
        }),
      ]),
    );
    const sourcePersisted = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    expect(sourcePersisted!.getBranch()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "custom_message",
          customType: "sedes.fork_context_boundary.v1",
        }),
      ]),
    );

    releaseActivePrompt();
    await vi.waitFor(async () => {
      const source = await readSource();
      expect(source.snapshot.runState).toBe("idle");
      expect(source.snapshot.orderedBackendTurnIds).toHaveLength(3);
      expect(source.snapshot.turnsById[activeBackendTurnId]).toMatchObject({
        status: "completed",
        endedBy: "agent_settled",
      });
    });
    await sourceHandle.submit({
      applicationOperationId: "active-fork-parent-continues",
      source: { kind: "user" },
      mutationId: "active-fork-parent-continues-mutation",
      reconciliationToken: "active-fork-parent-continues-token",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Parent continues",
    });
    await vi.waitFor(async () => {
      const source = await readSource();
      expect(source.snapshot.runState).toBe("idle");
      expect(source.snapshot.orderedBackendTurnIds).toHaveLength(4);
    });
    expect((await readChild()).snapshot).toEqual(
      childWhileParentActive.snapshot,
    );
    await sourceHandle.close();
  });

  it("replays and discovers only the immediate edge of a nested selected branch", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(1, true),
    });
    const source = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "nested-source-thread",
      applicationOperationId: "nested-source-create",
      source: { kind: "user" },
      requestedBackendConversationId: "nested-source-native",
    });
    const sourceBinding = binding(
      source.backendConversationId,
      "nested-source-thread",
    );
    const sourceHandle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: sourceBinding,
      opaqueBindingDetail: source.opaqueBindingDetail,
    });
    await sourceHandle.submit({
      applicationOperationId: "nested-source-submit",
      source: { kind: "user" },
      mutationId: "nested-source-mutation",
      reconciliationToken: "nested-source-token",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Source turn",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sourceRead = await driver.read({
      scope,
      workspace: fixture.workspace,
      binding: sourceBinding,
      opaqueBindingDetail: source.opaqueBindingDetail,
    });
    const sourceTurnId = sourceRead.snapshot.orderedBackendTurnIds.at(-1)!;
    const sourceCheckpoint = await driver.resolveBranchCheckpoint({
      scope,
      workspace: fixture.workspace,
      binding: sourceBinding,
      opaqueBindingDetail: source.opaqueBindingDetail,
      selection: {
        kind: "selected_completed_turn",
        backendTurnId: sourceTurnId,
        boundary: "completed_turn_inclusive",
      },
    });
    const child = await driver.branchConversation({
      scope,
      workspace: fixture.workspace,
      applicationOperationId: "nested-child-create",
      childApplicationThreadId: "nested-child-thread",
      source: { kind: "user" },
      sourceBinding,
      sourceOpaqueBindingDetail: source.opaqueBindingDetail,
      sourceCheckpoint,
      requestedBackendConversationId: "nested-child-native",
      inheritedSettings: { toolAccess: "full" },
    });
    const childBinding = binding(
      child.backendConversationId,
      "nested-child-thread",
    );
    const childHandle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: childBinding,
      opaqueBindingDetail: child.opaqueBindingDetail,
    });
    await childHandle.submit({
      applicationOperationId: "nested-child-submit",
      source: { kind: "user" },
      mutationId: "nested-child-mutation",
      reconciliationToken: "nested-child-token",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Child-only turn",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const childRead = await driver.read({
      scope,
      workspace: fixture.workspace,
      binding: childBinding,
      opaqueBindingDetail: child.opaqueBindingDetail,
    });
    const childTurnId = childRead.snapshot.orderedBackendTurnIds.at(-1)!;
    const childCheckpoint = await driver.resolveBranchCheckpoint({
      scope,
      workspace: fixture.workspace,
      binding: childBinding,
      opaqueBindingDetail: child.opaqueBindingDetail,
      selection: {
        kind: "selected_completed_turn",
        backendTurnId: childTurnId,
        boundary: "completed_turn_inclusive",
      },
    });
    const grandchildInput = {
      scope,
      workspace: fixture.workspace,
      applicationOperationId: "nested-grandchild-create",
      childApplicationThreadId: "nested-grandchild-thread",
      source: { kind: "user" as const },
      sourceBinding: childBinding,
      sourceOpaqueBindingDetail: child.opaqueBindingDetail,
      sourceCheckpoint: childCheckpoint,
      requestedBackendConversationId: "nested-grandchild-native",
      inheritedSettings: { toolAccess: "full" as const },
    };
    const grandchild = await driver.branchConversation(grandchildInput);
    await expect(driver.branchConversation(grandchildInput)).resolves.toEqual(
      grandchild,
    );

    const discovery = await driver.discover({
      scope,
      workspace: fixture.workspace,
      signal: new AbortController().signal,
      limit: 10,
    });
    expect(
      discovery.conversations.find(
        ({ backendConversationId }) =>
          backendConversationId === grandchild.backendConversationId,
      )?.nativeAncestry,
    ).toEqual({
      method: "provider_native",
      parentBackendConversationId: child.backendConversationId,
      sourceBackendTurnId: childTurnId,
      applicationOperationId: "nested-grandchild-create",
      childIdentity: "application_reserved",
      creationRecovery: "idempotent",
    });

    const store = new PiSessionStore({
      sessionDirectory: fixture.sessions,
    });
    const persistedGrandchild = await store.openPersisted(
      fixture.workspace,
      grandchild.backendConversationId,
    );
    const authenticatedMarkers = persistedGrandchild!
      .getBranch()
      .flatMap((entry) => {
        const result = readPiBranchMarker(entry, toolProvenanceKey);
        return result.status === "authenticated" ? [result.marker] : [];
      });
    expect(authenticatedMarkers).toHaveLength(2);
    expect(
      authenticatedMarkers.map((marker) => [
        marker.sourceBackendConversationId,
        marker.targetBackendConversationId,
      ]),
    ).toEqual([
      [source.backendConversationId, child.backendConversationId],
      [child.backendConversationId, grandchild.backendConversationId],
    ]);
    const immediate = authenticatedMarkers[1]!;
    persistedGrandchild!.appendCustomEntry(piBranchMarkerType, {
      ...immediate,
      applicationOperationId: "tampered-immediate-operation",
    });
    await expect(
      driver.branchConversation(grandchildInput),
    ).rejects.toMatchObject({ backendCode: "pi_branch_id_collision" });
    persistedGrandchild!.appendCustomEntry(
      piBranchMarkerType,
      createPiBranchMarker(
        {
          sourceBackendConversationId: immediate.sourceBackendConversationId,
          targetBackendConversationId: immediate.targetBackendConversationId,
          sourceLeafEntryId: immediate.sourceLeafEntryId,
          applicationOperationId: "conflicting-immediate-operation",
          inheritedSettingsFingerprint: immediate.inheritedSettingsFingerprint,
        },
        toolProvenanceKey,
      ),
    );
    await expect(
      driver.branchConversation(grandchildInput),
    ).rejects.toMatchObject({ backendCode: "pi_branch_id_collision" });
    const conflictedDiscovery = await driver.discover({
      scope,
      workspace: fixture.workspace,
      signal: new AbortController().signal,
      limit: 10,
    });
    expect(
      conflictedDiscovery.conversations.find(
        ({ backendConversationId }) =>
          backendConversationId === grandchild.backendConversationId,
      )?.nativeAncestry,
    ).toEqual({
      method: "provider_native",
      parentBackendConversationId: child.backendConversationId,
    });

    await childHandle.close();
    await sourceHandle.close();
  });

  it("includes an authenticated steer and tool boundary but excludes the next ordinary turn", async () => {
    const fixture = await workspace();
    const store = new PiSessionStore({ sessionDirectory: fixture.sessions });
    const source = await store.reserve(
      fixture.workspace,
      "selected-steer-source-native",
    );
    const sourceAuthentication = {
      conversationId: "selected-steer-source-native",
      installationKey: toolProvenanceKey,
    };
    const initialContextExcerpt = {
      id: "21957f80-ddea-4feb-a334-075a49a6765e",
      excerpt: "const initial = true;",
      note: "Keep this invariant.",
      source: {
        kind: "workspace_file" as const,
        rootId: "primary" as const,
        path: "src/initial.ts",
        revision: "initial-revision",
      },
      locator: { kind: "line_range" as const, startLine: 4, endLine: 4 },
    };
    const steerContextExcerpt = {
      id: "ce988e2f-42b0-49d6-9384-a7cf14ff0d3a",
      excerpt: "const steered = true;",
      source: {
        kind: "workspace_file" as const,
        rootId: "primary" as const,
        path: "src/steered.ts",
        revision: "steered-revision",
      },
      locator: { kind: "line_range" as const, startLine: 8, endLine: 8 },
    };
    const appendSubmission = (
      applicationOperationId: string,
      mode: "submit" | "steer",
      text: string,
      backendTurnId?: string,
      contextExcerpts: readonly (
        typeof initialContextExcerpt | typeof steerContextExcerpt
      )[] = [],
    ) => {
      const marker = createPiSubmissionMarker({
        applicationOperationId,
        reconciliationToken: `${applicationOperationId}-token`,
        mutationId: `${applicationOperationId}-mutation`,
        mode,
        contextExcerpts,
        attachments: [],
        taskContexts: [],
        text,
        ...(backendTurnId ? { backendTurnId } : {}),
      });
      if (contextExcerpts.length > 0) {
        source.manager.appendCustomEntry(
          piContextExcerptMarkerType,
          createPiContextExcerptMarker(
            {
              applicationOperationId,
              requestFingerprint: marker.requestFingerprint,
              contextExcerpts,
            },
            sourceAuthentication,
          ),
        );
      }
      source.manager.appendCustomEntry(piSubmissionMarkerType, marker);
    };
    const assistant = (
      content:
        | [{ readonly type: "text"; readonly text: string }]
        | [
            {
              readonly type: "toolCall";
              readonly id: string;
              readonly name: string;
              readonly arguments: { readonly path: string };
            },
          ],
      stopReason: "stop" | "toolUse",
    ) => ({
      role: "assistant" as const,
      content,
      api: "test",
      provider: "test",
      model: "model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason,
      timestamp: Date.now(),
    });

    appendSubmission(
      "selected-steer-submit",
      "submit",
      "Initial request",
      undefined,
      [initialContextExcerpt],
    );
    const sourceTurnId = source.manager.appendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: formatPiContextExcerptPrompt(
            [initialContextExcerpt],
            "Initial request",
          ),
        },
      ],
      timestamp: Date.now(),
    });
    const toolAssistantId = source.manager.appendMessage(
      assistant(
        [
          {
            type: "toolCall",
            id: "selected-steer-tool-call",
            name: "read",
            arguments: { path: "README.md" },
          },
        ],
        "toolUse",
      ),
    );
    source.manager.appendCustomEntry(
      piToolIdentityMarkerType,
      createPiToolIdentityMarker(
        {
          assistantEntryId: toolAssistantId,
          toolCallId: "selected-steer-tool-call",
          toolName: "read",
          identity: {
            registrationId: "pi:builtin:read",
            origin: "pi_builtin",
            canonicalKind: "read",
            displayName: "read",
          },
        },
        {
          conversationId: "selected-steer-source-native",
          installationKey: toolProvenanceKey,
        },
      ),
    );
    source.manager.appendMessage({
      role: "toolResult",
      toolCallId: "selected-steer-tool-call",
      toolName: "read",
      content: [{ type: "text", text: "project readme" }],
      details: {},
      isError: false,
      timestamp: Date.now(),
    });
    appendSubmission(
      "selected-steer-operation",
      "steer",
      "Include this steer",
      sourceTurnId,
      [steerContextExcerpt],
    );
    source.manager.appendMessage({
      role: "user",
      content: [
        {
          type: "text",
          text: formatPiContextExcerptPrompt(
            [steerContextExcerpt],
            "Include this steer",
          ),
        },
      ],
      timestamp: Date.now(),
    });
    source.manager.appendMessage(
      assistant([{ type: "text", text: "Steered completion" }], "stop"),
    );
    appendSubmission(
      "selected-steer-next-submit",
      "submit",
      "Next ordinary turn",
    );
    source.manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Next ordinary turn" }],
      timestamp: Date.now(),
    });
    source.manager.appendMessage(
      assistant([{ type: "text", text: "Later completion" }], "stop"),
    );

    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    });
    const sourceBinding = binding(
      "selected-steer-source-native",
      "selected-steer-source-thread",
    );
    const sourceRead = await driver.read({
      scope,
      workspace: fixture.workspace,
      binding: sourceBinding,
      opaqueBindingDetail: source.opaqueBindingDetail,
    });
    expect(sourceRead.snapshot.orderedBackendTurnIds).toHaveLength(2);
    const selectedBackendTurnId = sourceRead.snapshot.orderedBackendTurnIds[0]!;
    const checkpoint = await driver.resolveBranchCheckpoint({
      scope,
      workspace: fixture.workspace,
      binding: sourceBinding,
      opaqueBindingDetail: source.opaqueBindingDetail,
      selection: {
        kind: "selected_completed_turn",
        backendTurnId: selectedBackendTurnId,
        boundary: "completed_turn_inclusive",
      },
    });
    const child = await driver.branchConversation({
      scope,
      workspace: fixture.workspace,
      applicationOperationId: "selected-steer-branch",
      childApplicationThreadId: "selected-steer-child-thread",
      source: { kind: "user" },
      sourceBinding,
      sourceOpaqueBindingDetail: source.opaqueBindingDetail,
      sourceCheckpoint: checkpoint,
      requestedBackendConversationId: "selected-steer-child-native",
      inheritedSettings: { toolAccess: "full" },
    });
    const childRead = await driver.read({
      scope,
      workspace: fixture.workspace,
      binding: binding(
        child.backendConversationId,
        "selected-steer-child-thread",
      ),
      opaqueBindingDetail: child.opaqueBindingDetail,
    });
    expect(childRead.snapshot.orderedBackendTurnIds).toEqual([
      selectedBackendTurnId,
    ]);
    expect(
      Object.values(childRead.snapshot.itemsById).flatMap((item) =>
        item.semanticKind === "user_message"
          ? item.content.flatMap((part) =>
              part.kind === "text" ? [part.text.text] : [],
            )
          : [],
      ),
    ).toEqual(["Initial request", "Include this steer"]);
    expect(
      Object.values(childRead.snapshot.itemsById).flatMap((item) =>
        item.semanticKind === "user_message"
          ? item.content.flatMap((part) =>
              part.kind === "context_excerpt" ? [part.excerpt] : [],
            )
          : [],
      ),
    ).toEqual([initialContextExcerpt, steerContextExcerpt]);
    expect(JSON.stringify(childRead.snapshot)).not.toContain(
      "sedes-context-excerpts",
    );
    expect(
      Object.values(childRead.snapshot.itemsById).find(
        (item) => item.semanticKind === "file_read",
      ),
    ).toMatchObject({
      backendTurnId: selectedBackendTurnId,
      phase: "completed",
      contentPreview: { text: "project readme" },
    });
    const persistedChild = await store.openPersisted(
      fixture.workspace,
      child.backendConversationId,
    );
    const childAuthentication = {
      conversationId: child.backendConversationId,
      installationKey: toolProvenanceKey,
    };
    const childContextMarkers = persistedChild!.getBranch().flatMap((entry) => {
      const result = readPiContextExcerptMarker(entry, childAuthentication);
      return result.status === "authenticated" ? [result.marker] : [];
    });
    expect(
      childContextMarkers.flatMap(({ contextExcerpts }) =>
        contextExcerpts.map(({ id }) => id),
      ),
    ).toEqual([initialContextExcerpt.id, steerContextExcerpt.id]);
    expect(
      persistedChild!.getBranch().some((entry) => {
        const result = readPiContextExcerptMarker(entry, sourceAuthentication);
        return result.status === "authenticated";
      }),
    ).toBe(false);
    expect(JSON.stringify(persistedChild?.getBranch())).toContain(
      "Include this steer",
    );
    expect(JSON.stringify(persistedChild?.getBranch())).not.toContain(
      "Next ordinary turn",
    );
  });

  it("assigns stable monotonic source order across multiple assistant messages in one turn", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        2, false, undefined, 0, undefined, 0, undefined, undefined,
        undefined, undefined, undefined, false, false, undefined, undefined,
        undefined, ["First block", "Second block"],
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "source-order-create",
      applicationOperationId: "source-order-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const projection = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const events: BackendConversationEvent[] = [];
    const normalized = new ConversationProjector({
      backendInstanceId: instance.id,
      bindingIdentity: created.backendConversationId,
    });
    normalized.replace(projection.snapshot, projection.handleSequence);
    const projectionResults: ReturnType<ConversationProjector["apply"]>[] = [];
    const unsubscribe = projection.subscribeFromNext((event) => {
      events.push(event.event);
      projectionResults.push(normalized.apply(event));
    });

    await handle.submit({
      applicationOperationId: "source-order-submit",
      source: { kind: "user" },
      mutationId: "source-order-mutation",
      reconciliationToken: "source-order-token",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Respond twice",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const userTurnStart = events.find((event) => event.type === "turn_started");
    const userItem = events.find(
      (event) =>
        event.type === "item_completed" &&
        event.item.semanticKind === "user_message",
    );
    expect(userTurnStart).toMatchObject({
      type: "turn_started",
      turn: { orderedBackendItemIds: [] },
    });
    expect(events.indexOf(userTurnStart!)).toBeLessThan(
      events.indexOf(userItem!),
    );
    const assistantStarts = events.filter(
      (event) =>
        event.type === "item_started" &&
        event.item.semanticKind === "assistant_message",
    );
    expect(
      assistantStarts.map((event) =>
        event.type === "item_started" ? event.item.sourceOrder : -1,
      ),
    ).toEqual([1, 2, 1_001, 1_002]);
    expect(
      projectionResults.filter(({ kind }) => kind === "resnapshot_required"),
    ).toEqual([]);
    const liveAssistantIds = assistantStarts.flatMap((event) =>
      event.type === "item_started" ? [event.item.backendItemId] : [],
    );
    unsubscribe();
    const settled = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const settledAssistantItems = Object.values(settled.snapshot.itemsById)
      .filter((item) => item.semanticKind === "assistant_message")
      .sort((left, right) => left.sourceOrder - right.sourceOrder);
    expect(
      settledAssistantItems.map(({ backendItemId }) => backendItemId),
    ).toEqual(liveAssistantIds);
    expect(settledAssistantItems.map(({ sourceOrder }) => sourceOrder)).toEqual(
      [1, 2, 1_001, 1_002],
    );
    expect(settledAssistantItems.map(item => item.responsePhase)).toEqual([
      "provisional", "provisional", "final", "final",
    ]);
    const completionIndex = events.findIndex(event => event.type === "turn_completed");
    const finalUpdates = events.filter(event => event.type === "item_updated" &&
      event.item.semanticKind === "assistant_message" && event.item.responsePhase === "final");
    expect(finalUpdates).toHaveLength(2);
    expect(finalUpdates.every(event => events.indexOf(event) < completionIndex)).toBe(true);
    await handle.close();
    const reopened = await driver.attach({
      scope, workspace: fixture.workspace,
      binding: binding(created.backendConversationId), opaqueBindingDetail: created.opaqueBindingDetail,
    });
    try {
      const replay = await reopened.establishProjection({ signal: new AbortController().signal });
      expect(Object.values(replay.snapshot.itemsById)
        .filter(item => item.semanticKind === "assistant_message")
        .sort((left, right) => left.sourceOrder - right.sourceOrder)
        .map(item => [item.markdown.text, item.responsePhase]))
        .toEqual(settledAssistantItems.map(item => [item.markdown.text, item.responsePhase]));
    } finally {
      await reopened.close();
    }
  });

  it("waits for authoritative user-message persistence after Pi accepts preflight", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(1, false, () => undefined, 10),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "delayed-persistence-create",
      applicationOperationId: "delayed-persistence-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });

    await expect(
      handle.submit({
        applicationOperationId: "delayed-persistence-submit",
        source: { kind: "user" },
        mutationId: "delayed-persistence-mutation",
        reconciliationToken: "delayed-persistence-token",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: "Persist me after preflight.",
      }),
    ).resolves.toMatchObject({
      accepted: true,
      completionCorrelation: "delayed-persistence-submit",
    });
    await handle.close();
  });

  it("accepts the positionally owned user entry when Pi transforms submitted input", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(
        1,
        false,
        () => undefined,
        0,
        undefined,
        0,
        undefined,
        (text) => [`Transformed: ${text}`],
      ),
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "steer-correlation-create",
      applicationOperationId: "steer-correlation-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });

    await expect(
      handle.submit({
        applicationOperationId: "submit-transform-operation",
        source: { kind: "user" },
        mutationId: "submit-transform-mutation",
        reconciliationToken: "submit-transform-token",
        contextExcerpts: [],
        attachments: [],
        taskContexts: [],
        text: "/literal command text",
      }),
    ).resolves.toMatchObject({
      accepted: true,
      completionCorrelation: "submit-transform-operation",
    });
    const persisted = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const userTexts = persisted!
      .getBranch()
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "user"
          ? [entry.message.content]
          : [],
      )
      .flatMap((content) =>
        typeof content === "string"
          ? [content]
          : content.flatMap((part) =>
              part.type === "text" ? [part.text] : [],
            ),
      );
    expect(userTexts).toEqual(["Transformed: /literal command text"]);
    await handle.close();
  });

  it("uses a pre-submission history anchor to classify a hard restart safely", async () => {
    const fixture = await workspace();
    const options: PiDriverOptions = {
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    };
    const first = new PiConversationBackendDriver(options);
    const created = await first.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "anchor-create",
      applicationOperationId: "anchor-create",
      source: { kind: "user" },
    });
    const target = binding(created.backendConversationId);
    const handle = await first.attach({
      scope,
      workspace: fixture.workspace,
      binding: target,
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const retryAnchor = await handle.captureSubmissionRetryAnchor();
    expect(Buffer.byteLength(retryAnchor, "utf8")).toBeLessThanOrEqual(4_096);
    await handle.close();

    const restarted = new PiConversationBackendDriver(options);
    await expect(
      restarted.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: target,
        applicationOperationId: "crashed-before-marker",
        reconciliationToken: "crashed-before-marker",
        retryAnchor,
      }),
    ).resolves.toEqual({ status: "not_accepted", retryable: true });

    const persisted = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    persisted!.appendCustomEntry("unrelated.external.history", {
      changed: true,
    });
    await expect(
      restarted.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: target,
        applicationOperationId: "crashed-before-marker",
        reconciliationToken: "crashed-before-marker",
        retryAnchor,
      }),
    ).resolves.toMatchObject({ status: "unresolved" });
    await expect(
      restarted.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: target,
        applicationOperationId: "invalid-anchor",
        reconciliationToken: "invalid-anchor",
        retryAnchor: "x".repeat(4_097),
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "pi_retry_anchor_invalid",
    });
  });

  it("does not reconcile orphaned, displaced, or arbitrarily hinted steer markers as accepted", async () => {
    const fixture = await workspace();
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
    });
    const store = new PiSessionStore({ sessionDirectory: fixture.sessions });
    const cases = ["orphan", "displaced", "hinted"] as const;

    for (const kind of cases) {
      const applicationOperationId = `${kind}-steer-operation`;
      const created = await driver.create({
        scope,
        workspace: fixture.workspace,
        applicationThreadId: `${kind}-steer-create`,
        applicationOperationId: `${kind}-steer-create`,
        source: { kind: "user" },
      });
      const manager = await store.openPersisted(
        fixture.workspace,
        created.backendConversationId,
      );
      if (kind === "displaced") {
        manager!.appendMessage({
          role: "user",
          content: [{ type: "text", text: "Prior root" }],
          timestamp: Date.now(),
        });
      }
      manager!.appendCustomEntry(
        piSubmissionMarkerType,
        createPiSubmissionMarker({
          applicationOperationId,
          mutationId: `${kind}-steer-mutation`,
          reconciliationToken: `${kind}-steer-token`,
          mode: "steer",
          contextExcerpts: [],
          attachments: [],
          taskContexts: [],
          text: `${kind} steer`,
          ...(kind === "hinted"
            ? { backendTurnId: "arbitrary-hinted-user" }
            : {}),
        }),
      );
      if (kind === "displaced") {
        manager!.appendCustomEntry(
          piSubmissionMarkerType,
          createPiSubmissionMarker({
            applicationOperationId: "true-next-submit",
            mutationId: "true-next-submit",
            reconciliationToken: "true-next-submit",
            mode: "submit",
            contextExcerpts: [],
            attachments: [],
            taskContexts: [],
            text: "True next submit",
          }),
        );
      }
      manager!.appendMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: kind === "displaced" ? "True next submit" : `${kind} steer`,
          },
        ],
        timestamp: Date.now(),
      });

      await expect(
        driver.reconcileSubmission({
          scope,
          workspace: fixture.workspace,
          binding: binding(created.backendConversationId),
          applicationOperationId,
          reconciliationToken: `${kind}-steer-token`,
        }),
      ).resolves.toEqual({ status: "not_accepted", retryable: true });
    }
  });

  it("uses deterministic create IDs and reconciles a persisted accepted submission", async () => {
    const fixture = await workspace();
    const options: PiDriverOptions = {
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: fakeSessionFactory(),
      now: () => "2026-07-30T12:00:00.000Z",
    };
    const driver = new PiConversationBackendDriver(options);
    const createInput = {
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "create-operation",
      applicationOperationId: "create-operation",
      source: { kind: "user" as const },
      title: "Conversation",
    };
    const created = await driver.create(createInput);
    expect(await driver.create(createInput)).toEqual(created);
    await expect(
      driver.create({
        ...createInput,
        applicationThreadId: "different-create-operation",
        applicationOperationId: "different-create-operation",
        source: { kind: "user" },
        requestedBackendConversationId: created.backendConversationId,
      }),
    ).rejects.toMatchObject({
      category: "rejected",
      backendCode: "pi_session_id_collision",
    });
    await expect(
      driver.create({
        ...createInput,
        workspace: {
          ...fixture.workspace,
          summary: {
            ...fixture.workspace.summary,
            environmentId: "another-environment",
          },
        },
      }),
    ).rejects.toMatchObject({
      category: "permission_denied",
      backendCode: "pi_workspace_target_mismatch",
    });

    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const projection = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const liveCompletions: BackendTurn[] = [];
    const unsubscribeProjection = projection.subscribeFromNext(({ event }) => {
      if (event.type === "turn_completed") {
        liveCompletions.push(event.turn);
      }
    });
    expect(projection.snapshot.runState).toBe("idle");
    await expect(
      driver.resolveBranchCheckpoint({
        scope,
        workspace: fixture.workspace,
        binding: binding(created.backendConversationId),
        opaqueBindingDetail: created.opaqueBindingDetail,
        selection: { kind: "latest_completed" },
      }),
    ).rejects.toMatchObject({
      category: "invalid_state",
      backendCode: "pi_checkpoint_unavailable",
    });
    expect(
      await driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: binding(created.backendConversationId),
        applicationOperationId: "submit-operation",
      }),
    ).toMatchObject({ status: "unresolved" });

    const accepted = await handle.submit({
      applicationOperationId: "submit-operation",
      source: { kind: "user" },
      mutationId: "submit-mutation",
      reconciliationToken: "durable-submit-token",
      contextExcerpts: [],
      attachments: [],
      taskContexts: [],
      text: "Do the work",
    });
    expect(accepted.reconciliationToken).toBe("durable-submit-token");
    expect(accepted.completionCorrelation).toBe("submit-operation");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(liveCompletions).toContainEqual(
      expect.objectContaining({
        completionCorrelations: ["submit-operation"],
        status: "completed",
      }),
    );
    await expect(
      driver.resolveBranchCheckpoint({
        scope,
        workspace: fixture.workspace,
        binding: binding(created.backendConversationId),
        opaqueBindingDetail: created.opaqueBindingDetail,
        selection: { kind: "latest_completed" },
      }),
    ).resolves.toMatchObject({
      backendInstanceId: instance.id,
      kind: "conversation_leaf",
    });

    expect(
      await driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: binding(created.backendConversationId),
        applicationOperationId: "submit-operation",
      }),
    ).toMatchObject({
      status: "accepted",
      backendTurn: {
        completionCorrelations: ["submit-operation"],
        status: "completed",
      },
    });
    expect(
      await driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: binding(created.backendConversationId),
        applicationOperationId: "submit-operation",
        reconciliationToken: "wrong-token",
      }),
    ).toEqual({ status: "not_accepted", retryable: true });
    const persisted = await new PiSessionStore({
      sessionDirectory: fixture.sessions,
    }).openPersisted(fixture.workspace, created.backendConversationId);
    const branch = persisted!.getBranch();
    expect(
      await driver.reconcileSubmission({
        scope,
        workspace: fixture.workspace,
        binding: binding(created.backendConversationId),
        applicationOperationId: "never-submitted",
        retryAnchor: JSON.stringify({
          version: 1,
          entryId: persisted!.getLeafId(),
          entryCount: branch.length,
        }),
      }),
    ).toEqual({ status: "not_accepted", retryable: true });
    expect(
      (
        await driver.discover({
          scope,
          workspace: fixture.workspace,
          signal: new AbortController().signal,
          limit: 10,
        })
      ).conversations,
    ).toMatchObject([
      {
        backendConversationId: created.backendConversationId,
        title: "Conversation",
      },
    ]);
    unsubscribeProjection();
    await handle.close();
  });

  it("waits for an active Pi abort before completing close", async () => {
    const fixture = await workspace();
    const base = fakeSessionFactory();
    let markAbortStarted!: () => void;
    let releaseAbort!: () => void;
    const abortStarted = new Promise<void>((resolve) => {
      markAbortStarted = resolve;
    });
    const abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: {
        async create(input) {
          const session = await base.create(input);
          return {
            ...session,
            isIdle: false,
            async abort() {
              markAbortStarted();
              await abortGate;
            },
          };
        },
      },
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "close-create",
      applicationOperationId: "close-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    let closed = false;
    const closing = handle.close().then(() => {
      closed = true;
    });
    await abortStarted;
    expect(closed).toBe(false);
    releaseAbort();
    await closing;
    expect(closed).toBe(true);
  });

  it("cancels a pending tool approval before awaiting active Pi abort", async () => {
    const fixture = await workspace();
    const base = fakeSessionFactory();
    let pendingApproval!: Promise<"approve_once" | "deny" | undefined>;
    const abort = vi.fn(async () => {
      await pendingApproval;
    });
    const driver = new PiConversationBackendDriver({
      instance,
      connection,
      usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
      toolProvenanceKey,
      agentTools: noAgentTools,
      toolAccessPolicy: fullToolAccessPolicy,
      sessionDirectory: fixture.sessions,
      sessionFactory: {
        async create(input) {
          const session = await base.create(input);
          pendingApproval = input.interactions.requestToolApproval({
            title: "Pi tool approval",
            detail: "bash: long-running-command",
          });
          return {
            ...session,
            isIdle: false,
            abort,
          };
        },
      },
    });
    const created = await driver.create({
      scope,
      workspace: fixture.workspace,
      applicationThreadId: "close-pending-approval-create",
      applicationOperationId: "close-pending-approval-create",
      source: { kind: "user" },
    });
    const handle = await driver.attach({
      scope,
      workspace: fixture.workspace,
      binding: binding(created.backendConversationId),
      opaqueBindingDetail: created.opaqueBindingDetail,
    });
    const events: BackendConversationEvent[] = [];
    handle.subscribe((event) => events.push(event));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "interaction_opened" }),
    );

    await expect(handle.close()).resolves.toBeUndefined();

    await expect(pendingApproval).resolves.toBeUndefined();
    expect(abort).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "interaction_resolved" }),
    );
  });
});
