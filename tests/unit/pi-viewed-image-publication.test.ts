import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PiConversationBackendDriver,
  type PiDriverOptions,
} from "../../src/server/backends/pi/pi-conversation-driver.js";
import type {
  PiSdkSession,
  PiSdkSessionFactory,
} from "../../src/server/backends/pi/pi-sdk-session.js";
import { PiSessionStore } from "../../src/server/backends/pi/pi-session-store.js";
import {
  createPiToolIdentityMarker,
  piToolIdentityMarkerType,
} from "../../src/server/backends/pi/pi-tool-identity-marker.js";
import { PiUsageAccounting } from "../../src/server/backends/pi/pi-usage-accounting.js";
import {
  PI_NON_VISION_IMAGE_NOTE,
  piViewedImagePublicationKey,
} from "../../src/server/backends/pi/pi-viewed-image.js";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  BackendEventListener,
  ConversationBinding,
  ConversationHandle,
} from "../../src/server/backends/contracts.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import type { BackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { ConversationProjector } from "../../src/server/conversations/conversation-projector.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import type {
  OutputArtifactPublisher,
  PublishOutputImageInput,
} from "../../src/server/output-artifacts/contracts.js";
import {
  NO_USAGE_SINK,
  type UsageSink,
} from "../../src/server/usage/contracts.js";
import type {
  BackendConversationSnapshot,
  BackendItem,
  SequencedBackendEvent,
} from "../../src/shared/protocol/backend.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";
import { createInMemoryOutputArtifactPublisher } from "../helpers/output-artifact-publisher.js";

const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const toolProvenanceKey = new Uint8Array(32).fill(0x42);
const scope = { tenantId: "tenant", principalId: "principal" };
const readIdentity = {
  registrationId: "pi:builtin:read",
  origin: "pi_builtin",
  canonicalKind: "read",
  displayName: "read",
} as const;
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
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-pi-viewed-"));
  roots.push(root);
  const project = path.join(root, "project");
  const sessions = path.join(root, "sessions");
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(sessions, { recursive: true }),
  ]);
  const canonicalPath = await realpath(project);
  return {
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
    } satisfies ValidatedWorkspace,
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
    createdAt: "2026-09-27T12:00:00.000Z",
  };
}

interface Read {
  readonly id: string;
  readonly path: string;
  readonly content?: readonly unknown[];
  readonly isError?: boolean;
}
type Block = { readonly text: string } | { readonly read: Read };

function imageContent(note?: string, data = pixel): unknown[] {
  return [
    { type: "text", text: `Read image file [image/png]${note ? `\n${note}` : ""}` },
    { type: "image", data, mimeType: "image/png" },
  ];
}

function assistantMessage(content: unknown[], stopReason: "toolUse" | "stop") {
  return {
    role: "assistant" as const,
    content,
    api: "test",
    provider: "test",
    model: "model",
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

function nativeBlock(block: Block): unknown {
  return "text" in block
    ? { type: "text", text: block.text }
    : { type: "toolCall", id: block.read.id, name: "read", arguments: { path: block.read.path } };
}

interface PromptScript {
  /** Tool-read assistant messages, each followed by its tool results. */
  readonly messages: readonly (readonly Block[])[];
  /**
   * Runs after a message's tools end and before Pi persists their results,
   * which it does together once the whole batch finishes.
   */
  readonly beforeResults?: (
    messageIndex: number,
    emit: (event: unknown) => void,
  ) => void | Promise<void>;
  /** Ends the run after the hook without persisting results or answering. */
  readonly settleWithoutResults?: boolean;
}

/** Wraps one tool-read message as a prompt script. */
function single(blocks: readonly Block[]): PromptScript {
  return { messages: [blocks] };
}

/** A Pi session whose prompts run the next scripted tool-read messages. */
function scriptedSessionFactory(
  script: PromptScript[],
  managers: SessionManager[] = [],
): PiSdkSessionFactory {
  return {
    async create({ manager, customTools = [] }) {
      managers.push(manager);
      const listeners = new Set<Parameters<PiSdkSession["subscribe"]>[0]>();
      const emit = (event: unknown): void => {
        for (const listener of listeners) listener(event as never);
      };
      let idle = true;
      const session = {
        sessionId: manager.getSessionId(),
        get sessionName() {
          return manager.getSessionName();
        },
        get isIdle() {
          return idle;
        },
        model: { provider: "test", id: "model", input: ["text", "image"] },
        thinkingLevel: "low",
        sessionManager: manager,
        ready: async () => undefined,
        subscribe(listener: Parameters<PiSdkSession["subscribe"]>[0]) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async prompt(text: string, options: { preflightResult(accepted: boolean): void }) {
          options.preflightResult(true);
          idle = false;
          emit({ type: "agent_start" });
          const user = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
          manager.appendMessage(user);
          emit({ type: "message_end", message: user });
          await Promise.resolve();
          const prompt = script.shift() ?? { messages: [] };
          for (const [messageIndex, blocks] of prompt.messages.entries()) {
          const content = blocks.map(nativeBlock);
          const assistant = assistantMessage(content, "toolUse");
          emit({ type: "message_start", message: assistant });
          for (const [contentIndex, block] of blocks.entries()) {
            const partial = { role: "assistant", content: content.slice(0, contentIndex + 1) };
            if ("text" in block) {
              emit({
                type: "message_update",
                message: assistant,
                assistantMessageEvent: { type: "text_delta", contentIndex, delta: block.text, partial },
              });
              continue;
            }
            const call = content[contentIndex] as { id: string; name: string };
            const withArguments = (argumentsValue: unknown) => ({
              role: "assistant",
              content: [...content.slice(0, contentIndex), { ...call, type: "toolCall", arguments: argumentsValue }],
            });
            emit({
              type: "message_update",
              message: assistant,
              assistantMessageEvent: { type: "toolcall_start", contentIndex, partial: withArguments({}) },
            });
            emit({
              type: "message_update",
              message: assistant,
              assistantMessageEvent: {
                type: "toolcall_delta",
                contentIndex,
                delta: "",
                partial: withArguments({ path: block.read.path.slice(0, -2) }),
              },
            });
            emit({
              type: "message_update",
              message: assistant,
              assistantMessageEvent: {
                type: "toolcall_end",
                contentIndex,
                toolCall: content[contentIndex],
                partial: withArguments({ path: block.read.path }),
              },
            });
          }
          manager.appendMessage(assistant as never);
          emit({ type: "message_end", message: assistant });
          await Promise.resolve();
          const results: unknown[] = [];
          for (const block of blocks) {
            if (!("read" in block)) continue;
            const { id, path: readPath } = block.read;
            emit({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: readPath } });
            const resultContent = block.read.content ?? imageContent();
            const isError = block.read.isError ?? false;
            emit({
              type: "tool_execution_end",
              toolCallId: id,
              toolName: "read",
              result: { content: resultContent, details: undefined },
              isError,
            });
            results.push({
              role: "toolResult" as const,
              toolCallId: id,
              toolName: "read",
              content: resultContent,
              isError,
              timestamp: Date.now(),
            });
          }
          await prompt.beforeResults?.(messageIndex, emit);
          if (prompt.settleWithoutResults) {
            idle = true;
            emit({ type: "agent_settled" });
            return;
          }
          for (const result of results) {
            manager.appendMessage(result as never);
            emit({ type: "message_end", message: result });
            await Promise.resolve();
          }
          }
          const final = assistantMessage([{ type: "text", text: "done" }], "stop");
          emit({ type: "message_start", message: final });
          emit({
            type: "message_update",
            message: final,
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done", partial: final },
          });
          manager.appendMessage(final as never);
          emit({ type: "message_end", message: final });
          await Promise.resolve();
          idle = true;
          emit({ type: "agent_settled" });
        },
        async steer() {
          return { queued: false };
        },
        clearQueue: () => ({ steering: [], followUp: [] }),
        async abort() {},
        async compact() {
          manager.appendCompaction("Compacted.", manager.getLeafId()!, 1);
        },
        async skillPrompt() {
          throw new Error("unexpected_skill");
        },
        setSessionName(title: string) {
          manager.appendSessionInfo(title);
        },
        async setModel() {},
        setThinkingLevel() {},
        getActiveToolNames: () => ["read"],
        getAllTools: () => [
          {
            name: "read",
            description: "Read a file",
            parameters: {},
            promptGuidelines: [],
            sourceInfo: { source: "builtin", path: "<builtin:read>" },
          },
          ...customTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            promptGuidelines: tool.promptGuidelines ?? [],
            sourceInfo: { source: "sdk", path: `<sdk:${tool.name}>` },
          })),
        ],
        setActiveToolsByName() {},
        getSessionStats: () => ({
          sessionFile: manager.getSessionFile(),
          sessionId: manager.getSessionId(),
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
          cost: 0,
          contextUsage: { tokens: 2, contextWindow: 128_000, percent: 0.0015625 },
        }),
        availableModels: async () => [{ provider: "test", id: "model", name: "Test model" }],
        providerDisplayName: () => "Test Provider",
        catalog: () => ({ models: [], commands: [], skills: [], notices: [] }),
        dispose() {
          listeners.clear();
        },
      };
      return session as unknown as PiSdkSession;
    },
  };
}

/** Records publications and can hold them open to force late delivery. */
function recordingPublisher() {
  const base = createInMemoryOutputArtifactPublisher();
  const published: PublishOutputImageInput[] = [];
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  let failing = false;
  const publisher: OutputArtifactPublisher = {
    findImage: (...args) => base.findImage(...args),
    publishImage: async (input) => {
      published.push(input);
      await gate;
      if (failing) throw new Error("test_publication_failed");
      return await base.publishImage(input);
    },
  };
  return {
    publisher,
    published,
    fail(value = true) {
      failing = value;
    },
    hold() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      gate = undefined;
      open?.();
    },
  };
}

function driverWith(
  fixture: Awaited<ReturnType<typeof workspace>>,
  outputArtifacts: OutputArtifactPublisher,
  script: PromptScript[] = [],
  extra: Partial<PiDriverOptions> = {},
) {
  return new PiConversationBackendDriver({
    instance,
    connection,
    usage: NO_USAGE_SINK,
    nativeDiscoveryNamespaceKey: "pi-test-native-namespace",
    toolProvenanceKey,
    agentTools: noAgentTools,
    agentToolSourceCapabilities: createFakeAgentToolSourceCapabilities().issuer,
    toolAccessPolicy: () => "full",
    modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "provider_model_effort"),
    sessionDirectory: fixture.sessions,
    sessionFactory: scriptedSessionFactory(script),
    outputArtifacts,
    ...extra,
  });
}

async function created(
  driver: PiConversationBackendDriver,
  fixture: Awaited<ReturnType<typeof workspace>>,
  applicationThreadId = "thread",
) {
  const result = await driver.create({
    scope,
    workspace: fixture.workspace,
    applicationThreadId,
    applicationOperationId: `${applicationThreadId}-create`,
    source: { kind: "user" },
  });
  const attach = {
    scope,
    workspace: fixture.workspace,
    binding: binding(result.backendConversationId, applicationThreadId),
    opaqueBindingDetail: result.opaqueBindingDetail,
  };
  return { ...result, attach };
}

/** Follows one handle generation through the shared application projector. */
async function follow(handle: ConversationHandle, bindingIdentity: string) {
  const projection = await handle.establishProjection({
    signal: new AbortController().signal,
  });
  const normalized = new ConversationProjector({
    backendInstanceId: instance.id,
    bindingIdentity,
  });
  normalized.replace(projection.snapshot, projection.handleSequence);
  const events: SequencedBackendEvent[] = [];
  const results: ReturnType<ConversationProjector["apply"]>[] = [];
  const listener: BackendEventListener = (event) => {
    events.push(event);
    results.push(normalized.apply(event));
  };
  const unsubscribe = projection.subscribeFromNext(listener);
  return { projection, normalized, events, results, unsubscribe };
}

function submit(handle: ConversationHandle, name: string) {
  return handle.submit({
    applicationOperationId: name,
    source: { kind: "user" },
    mutationId: name,
    reconciliationToken: name,
    contextExcerpts: [],
    attachments: [],
    taskContexts: [],
    text: name,
  });
}

/** Item kinds of one turn in order, with the viewed pairs spelled out. */
function turnShape(snapshot: BackendConversationSnapshot, backendTurnId: string) {
  return snapshot.turnsById[backendTurnId]!.orderedBackendItemIds.map((id) => {
    const item = snapshot.itemsById[id]!;
    return item.semanticKind === "viewed_image"
      ? `viewed:${item.status}:${item.fileName?.text ?? ""}`
      : item.semanticKind === "image"
        ? `image:${item.origin.kind === "viewed" ? item.origin.capture : item.origin.kind}`
        : item.semanticKind;
  });
}

function childImages(items: Record<string, BackendItem>) {
  return Object.values(items).filter(
    (item): item is Extract<BackendItem, { semanticKind: "image" }> =>
      item.semanticKind === "image",
  );
}

/** Appends a persisted image-read turn with an authenticated read marker. */
function appendImageReadTurn(
  manager: SessionManager,
  conversationId: string,
  index: number,
  read: Omit<Read, "id"> = { path: `/private/shots/turn-${index}.png` },
): { assistantEntryId: string; toolCallId: string } {
  const toolCallId = `call-${index}`;
  manager.appendMessage({ role: "user", content: [{ type: "text", text: `turn ${index}` }], timestamp: Date.now() });
  const assistantEntryId = manager.appendMessage(
    assistantMessage(
      [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: read.path } }],
      "toolUse",
    ) as never,
  );
  manager.appendCustomEntry(
    piToolIdentityMarkerType,
    createPiToolIdentityMarker(
      { assistantEntryId, toolCallId, toolName: "read", identity: readIdentity },
      { conversationId, installationKey: toolProvenanceKey },
    ),
  );
  manager.appendMessage({
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: read.content ?? imageContent(),
    isError: read.isError ?? false,
    timestamp: Date.now(),
  } as never);
  manager.appendMessage(assistantMessage([{ type: "text", text: `turn ${index} done` }], "stop") as never);
  return { assistantEntryId, toolCallId };
}

async function persisted(
  fixture: Awaited<ReturnType<typeof workspace>>,
  backendConversationId: string,
) {
  const manager = await new PiSessionStore({
    sessionDirectory: fixture.sessions,
  }).openPersisted(fixture.workspace, backendConversationId);
  if (!manager) throw new Error("missing_persisted_session");
  return manager;
}

describe("Pi viewed-image publication", () => {
  it("adds a live child after its viewed item, in doubled order, without a resnapshot", async () => {
    const fixture = await workspace();
    const recorder = recordingPublisher();
    const driver = driverWith(fixture, recorder.publisher, [
      single([
        { text: "Looking" },
        { read: { id: "first", path: "/private/shots/one.png" } },
        { text: "Between" },
        { read: { id: "second", path: "/private/shots/TWO.BMP" } },
        { text: "After" },
      ]),
    ]);
    const conversation = await created(driver, fixture);
    const handle = await driver.attach(conversation.attach);
    const followed = await follow(handle, conversation.backendConversationId);
    // Hold publication so both children arrive after the turn completes.
    recorder.hold();
    const submitted = await submit(handle, "look");
    const turnId = submitted.backendTurnId!;
    await vi.waitFor(() =>
      expect(followed.events.some(({ event }) => event.type === "turn_completed")).toBe(true),
    );
    expect(recorder.published).toHaveLength(2);
    recorder.release();
    await vi.waitFor(() =>
      expect(
        followed.events.filter(
          ({ event }) => event.type === "item_completed" && event.item.semanticKind === "image",
        ),
      ).toHaveLength(2),
    );

    expect(followed.results.filter(({ kind }) => kind === "resnapshot_required")).toEqual([]);
    const lateChildren = followed.events.filter(
      ({ event }) => event.type === "item_completed" && event.item.semanticKind === "image",
    );
    const turnCompleted = followed.events.findIndex(({ event }) => event.type === "turn_completed");
    expect(lateChildren.every((event) => followed.events.indexOf(event) > turnCompleted)).toBe(true);
    // The children are new items only; the completed turn is never reopened.
    expect(
      followed.events
        .slice(turnCompleted + 1)
        .filter(({ event }) => event.type === "turn_updated" || event.type === "turn_started"),
    ).toEqual([]);

    const current = await driver.read(conversation.attach);
    expect(turnShape(current.snapshot, turnId)).toEqual([
      "user_message",
      "assistant_message",
      "viewed:completed:one.png",
      "image:provider_input",
      "assistant_message",
      "viewed:completed:TWO.BMP",
      "image:provider_input",
      "assistant_message",
      "assistant_message",
    ]);
    const ordered = current.snapshot.turnsById[turnId]!.orderedBackendItemIds.map(
      (id: string) => current.snapshot.itemsById[id]!.sourceOrder,
    );
    expect(ordered.slice(1, 8)).toEqual([1, 3, 4, 5, 7, 8, 9]);
    expect(current.snapshot.turnsById[turnId]).toMatchObject({ status: "completed" });
    expect(JSON.stringify(current.snapshot)).not.toContain("/private/shots");

    const timeline = followed.normalized.timeline();
    const applicationTurn = timeline.turnsById[timeline.orderedTurnIds.at(-1)!]!;
    expect(applicationTurn.status).toBe("completed");
    expect(applicationTurn.orderedItemIds.map((id) => timeline.itemsById[id]!.kind)).toEqual([
      "user_message",
      "assistant_message",
      "viewed_image",
      "image",
      "assistant_message",
      "viewed_image",
      "image",
      "assistant_message",
      "assistant_message",
    ]);

    const assistantEntryId = (await persisted(fixture, conversation.backendConversationId))
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant")!.id;
    expect(recorder.published.map(({ publicationKey, threadId, mediaType }) => ({ publicationKey, threadId, mediaType }))).toEqual([
      {
        publicationKey: piViewedImagePublicationKey({
          sessionId: conversation.backendConversationId,
          assistantEntryId,
          toolCallId: "first",
          imageIndex: 1,
        }),
        threadId: "thread",
        mediaType: "image/png",
      },
      expect.objectContaining({ threadId: "thread", mediaType: "image/png" }),
    ]);
    followed.unsubscribe();
    await handle.close();
  });

  it("hands live children over to persisted history with the same artifacts and no republication", async () => {
    const fixture = await workspace();
    const recorder = recordingPublisher();
    const driver = driverWith(fixture, recorder.publisher, [
      single([{ read: { id: "call", path: "diagram.png" } }]),
    ]);
    const conversation = await created(driver, fixture);
    const handle = await driver.attach(conversation.attach);
    const followed = await follow(handle, conversation.backendConversationId);
    const submitted = await submit(handle, "look");
    await vi.waitFor(async () =>
      expect(childImages((await driver.read(conversation.attach)).snapshot.itemsById)).toHaveLength(1),
    );
    const live = (await driver.read(conversation.attach)).snapshot;
    followed.unsubscribe();
    await handle.close();

    const reopened = await driver.attach(conversation.attach);
    const replay = await reopened.establishProjection({ signal: new AbortController().signal });
    expect(turnShape(replay.snapshot, submitted.backendTurnId!)).toEqual(
      turnShape(live, submitted.backendTurnId!),
    );
    expect(childImages(replay.snapshot.itemsById).map(({ image }) => image)).toEqual(
      childImages(live.itemsById).map(({ image }) => image),
    );
    const viewed = Object.values(replay.snapshot.itemsById).find((item) => item.semanticKind === "viewed_image")!;
    expect(childImages(replay.snapshot.itemsById)[0]).toMatchObject({
      backendItemId: `${viewed.backendItemId}:image`,
      sourceOrder: viewed.sourceOrder + 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recorder.published).toHaveLength(1);
    await reopened.close();
  });

  it("delivers a publication that finishes after a refresh to the new generation's identity", async () => {
    const fixture = await workspace();
    const recorder = recordingPublisher();
    const driver = driverWith(fixture, recorder.publisher, [
      single([{ read: { id: "call", path: "slow.png" } }]),
    ]);
    const conversation = await created(driver, fixture);
    const handle = await driver.attach(conversation.attach);
    const first = await follow(handle, conversation.backendConversationId);
    recorder.hold();
    await submit(handle, "look");
    await vi.waitFor(() =>
      expect(first.events.some(({ event }) => event.type === "turn_completed")).toBe(true),
    );
    await handle.perform({ applicationOperationId: "compact", action: "compact" });
    expect(first.events.at(-1)?.event).toMatchObject({ type: "resnapshot_required" });
    first.unsubscribe();

    const second = await follow(handle, conversation.backendConversationId);
    const viewed = Object.values(second.projection.snapshot.itemsById).find(
      (item) => item.semanticKind === "viewed_image",
    )!;
    expect(viewed.backendItemId).not.toMatch(/^live:/u);
    expect(childImages(second.projection.snapshot.itemsById)).toEqual([]);

    recorder.release();
    await vi.waitFor(() =>
      expect(
        second.events.filter(({ event }) => event.type === "item_completed"),
      ).toHaveLength(1),
    );
    expect(second.events[0]!.event).toMatchObject({
      type: "item_completed",
      item: {
        semanticKind: "image",
        backendItemId: `${viewed.backendItemId}:image`,
        sourceOrder: viewed.sourceOrder + 1,
      },
    });
    expect(second.results.filter(({ kind }) => kind === "resnapshot_required")).toEqual([]);
    expect(recorder.published).toHaveLength(1);
    second.unsubscribe();
    await handle.close();
  });

  it("backfills a pre-feature session in the background and a fork under its own thread", async () => {
    const fixture = await workspace();
    const recorder = recordingPublisher();
    const driver = driverWith(fixture, recorder.publisher);
    const conversation = await created(driver, fixture, "source");
    const manager = await persisted(fixture, conversation.backendConversationId);
    appendImageReadTurn(manager, conversation.backendConversationId, 1);

    recorder.hold();
    const handle = await driver.attach(conversation.attach);
    const followed = await follow(handle, conversation.backendConversationId);
    expect(childImages(followed.projection.snapshot.itemsById)).toEqual([]);
    recorder.release();
    await vi.waitFor(() => expect(followed.events).toHaveLength(1));
    expect(followed.events[0]!.event).toMatchObject({
      type: "item_completed",
      item: { semanticKind: "image", origin: { kind: "viewed", capture: "provider_input" } },
    });
    expect(followed.results).toEqual([expect.objectContaining({ kind: "events" })]);
    const timeline = followed.normalized.timeline();
    const turn = timeline.turnsById[timeline.orderedTurnIds.at(-1)!]!;
    expect(turn.status).toBe("completed");
    expect(turn.orderedItemIds.map((id) => timeline.itemsById[id]!.kind)).toEqual([
      "user_message",
      "viewed_image",
      "image",
      "assistant_message",
    ]);
    followed.unsubscribe();
    await handle.close();

    const { snapshot } = await driver.read(conversation.attach);
    const sourceTurn = snapshot.orderedBackendTurnIds.at(-1)!;
    const checkpoint = await driver.resolveBranchCheckpoint({
      ...conversation.attach,
      selection: { kind: "latest_completed", backendTurnId: sourceTurn },
    });
    const child = await driver.branchConversation({
      scope,
      workspace: fixture.workspace,
      applicationOperationId: "fork",
      childApplicationThreadId: "child",
      source: { kind: "user" },
      sourceBinding: conversation.attach.binding,
      sourceOpaqueBindingDetail: conversation.opaqueBindingDetail,
      sourceCheckpoint: checkpoint,
      requestedBackendConversationId: "fork-child",
      inheritedSettings: { toolAccess: "full" },
    });
    const forkAttach = {
      ...conversation.attach,
      binding: binding(child.backendConversationId, "child"),
      opaqueBindingDetail: child.opaqueBindingDetail,
    };
    const fork = await driver.attach(forkAttach);
    await vi.waitFor(async () =>
      expect(childImages((await driver.read(forkAttach)).snapshot.itemsById)).toHaveLength(1),
    );
    expect(recorder.published.map(({ threadId }) => threadId)).toEqual(["source", "child"]);
    expect(recorder.published[1]!.publicationKey).not.toBe(recorder.published[0]!.publicationKey);
    await fork.close();
  });

  it("publishes an older page's missing children within its budget before returning it", async () => {
    const fixture = await workspace();
    const recorder = recordingPublisher();
    const driver = driverWith(fixture, recorder.publisher);
    const conversation = await created(driver, fixture);
    const manager = await persisted(fixture, conversation.backendConversationId);
    for (let index = 0; index < 30; index += 1) {
      appendImageReadTurn(manager, conversation.backendConversationId, index);
    }
    const handle = await driver.attach(conversation.attach);
    const established = await handle.establishProjection({ signal: new AbortController().signal });
    expect(established.snapshot.orderedBackendTurnIds).toHaveLength(10);
    await vi.waitFor(async () =>
      expect(childImages((await driver.read(conversation.attach)).snapshot.itemsById)).toHaveLength(10),
    );
    expect(recorder.published).toHaveLength(10);

    const page = await handle.history({
      cursor: established.history.previousCursor!,
      limit: 20,
    });
    expect(page.orderedBackendTurnIds).toHaveLength(20);
    expect(recorder.published).toHaveLength(26);
    const pageChildren = childImages(page.itemsById);
    expect(pageChildren).toHaveLength(16);
    // The budget favours the newest turns of the page.
    const withChild = page.orderedBackendTurnIds.map((turnId) =>
      page.turnsById[turnId]!.orderedBackendItemIds.some((id) => page.itemsById[id]!.semanticKind === "image"),
    );
    expect(withChild).toEqual([...Array(4).fill(false), ...Array(16).fill(true)]);
    for (const turnId of page.orderedBackendTurnIds.slice(4)) {
      expect(turnShape(page as BackendConversationSnapshot, turnId)).toEqual([
        "user_message",
        expect.stringMatching(/^viewed:completed:turn-\d+\.png$/u),
        "image:provider_input",
        "assistant_message",
      ]);
    }
    const again = await handle.history({ cursor: established.history.previousCursor!, limit: 20 });
    expect(childImages(again.itemsById)).toHaveLength(20);
    expect(recorder.published).toHaveLength(30);
    await handle.close();
  });

  it("adds no child for failed, text-only, non-vision or invalid image reads", async () => {
    const fixture = await workspace();
    const recorder = recordingPublisher();
    const driver = driverWith(fixture, recorder.publisher, [
      single([
        {
          read: {
            id: "missing",
            path: "/private/missing.png",
            isError: true,
            content: [{ type: "text", text: "ENOENT: no such file or directory, access '/private/missing.png'" }],
          },
        },
        { read: { id: "text", path: "big.gif", content: [{ type: "text", text: "Read image file [image/gif]\n[Image omitted: could not be converted to a supported inline image format.]" }] } },
        { read: { id: "blind", path: "seen.webp", content: imageContent(PI_NON_VISION_IMAGE_NOTE) } },
        { read: { id: "corrupt", path: "corrupt.jpg", content: imageContent(undefined, "AAAA") } },
      ]),
    ]);
    const conversation = await created(driver, fixture);
    const handle = await driver.attach(conversation.attach);
    const followed = await follow(handle, conversation.backendConversationId);
    const submitted = await submit(handle, "look");
    await vi.waitFor(() =>
      expect(followed.events.some(({ event }) => event.type === "turn_completed")).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const current = (await driver.read(conversation.attach)).snapshot;
    expect(turnShape(current, submitted.backendTurnId!)).toEqual([
      "user_message",
      "viewed:failed:missing.png",
      "viewed:completed:big.gif",
      "viewed:completed:seen.webp",
      "viewed:completed:corrupt.jpg",
      "assistant_message",
    ]);
    const failed = Object.values(current.itemsById).find(
      (item: BackendItem) => item.status === "failed",
    );
    expect(failed?.error).toEqual({
      category: "unavailable",
      message: { text: "Pi could not read this image." },
      code: "pi_viewed_image_read_failed",
    });
    expect(JSON.stringify(current)).not.toContain("/private");
    expect(recorder.published).toEqual([]);
    followed.unsubscribe();
    await handle.close();

    const reopened = await driver.attach(conversation.attach);
    const replay = await reopened.establishProjection({ signal: new AbortController().signal });
    expect(turnShape(replay.snapshot, submitted.backendTurnId!)).toEqual(
      turnShape(current, submitted.backendTurnId!),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recorder.published).toEqual([]);
    await reopened.close();
  });

  it("reads an unattached conversation's published children without publishing", async () => {
    const fixture = await workspace();
    const recorder = recordingPublisher();
    const driver = driverWith(fixture, recorder.publisher);
    const conversation = await created(driver, fixture);
    const manager = await persisted(fixture, conversation.backendConversationId);
    appendImageReadTurn(manager, conversation.backendConversationId, 1);
    const unpublished = await driver.read(conversation.attach);
    expect(childImages(unpublished.snapshot.itemsById)).toEqual([]);
    expect(recorder.published).toEqual([]);

    const handle = await driver.attach(conversation.attach);
    await vi.waitFor(async () =>
      expect(childImages((await driver.read(conversation.attach)).snapshot.itemsById)).toHaveLength(1),
    );
    await handle.close();
    const published = await driver.read(conversation.attach);
    expect(childImages(published.snapshot.itemsById)).toHaveLength(1);
    expect(recorder.published).toHaveLength(1);
  });
});

describe("Pi viewed-image publication failures", () => {
  it("does not retry a key whose publication failed on later seeds or pages", async () => {
    const fixture = await workspace();
    const recorder = recordingPublisher();
    recorder.fail();
    const driver = driverWith(fixture, recorder.publisher);
    const conversation = await created(driver, fixture);
    const manager = await persisted(fixture, conversation.backendConversationId);
    appendImageReadTurn(manager, conversation.backendConversationId, 1);
    const handle = await driver.attach(conversation.attach);
    await handle.establishProjection({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(recorder.published).toHaveLength(1));

    const page = await handle.history({ limit: 5 });
    expect(childImages(page.itemsById)).toEqual([]);
    await handle.perform({ applicationOperationId: "compact", action: "compact" });
    const reseeded = await handle.establishProjection({ signal: new AbortController().signal });
    expect(childImages(reseeded.snapshot.itemsById)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recorder.published).toHaveLength(1);
    await handle.close();

    // A new attachment tries again.
    recorder.fail(false);
    const reopened = await driver.attach(conversation.attach);
    await vi.waitFor(async () =>
      expect(childImages((await driver.read(conversation.attach)).snapshot.itemsById)).toHaveLength(1),
    );
    expect(recorder.published).toHaveLength(2);
    await reopened.close();
  });
});

/** Publishes a persisted read's child up front, as an earlier attachment did. */
async function prepublish(
  publisher: OutputArtifactPublisher,
  sessionId: string,
  coordinates: { readonly assistantEntryId: string; readonly toolCallId: string },
) {
  await publisher.publishImage({
    scope,
    threadId: "thread",
    publicationKey: piViewedImagePublicationKey({ sessionId, ...coordinates, imageIndex: 1 }),
    mediaType: "image/png",
    bytes: Buffer.from(pixel, "base64"),
  });
}

/** A before-results hook that forces a resnapshot and waits for the test. */
function pauseWithResnapshot() {
  let reached!: () => void;
  let resume!: () => void;
  const atHook = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return {
    atHook,
    resume: () => resume(),
    async beforeResults(_messageIndex: number, emit: (event: unknown) => void) {
      // An execution update for an unknown call invalidates the live projection.
      emit({ type: "tool_execution_update", toolCallId: "unknown", toolName: "read", args: {}, partialResult: {} });
      reached();
      await paused;
    },
  };
}

describe("Pi viewed images seeded before their results persist", () => {
  const blocks: Block[] = [
    { read: { id: "shown", path: "shown.png" } },
    {
      read: {
        id: "broken",
        path: "broken.png",
        isError: true,
        content: [{ type: "text", text: "EACCES: permission denied, open '/private/broken.png'" }],
      },
    },
  ];

  it("completes the seeded rows and adds the child once Pi persists the results", async () => {
    const fixture = await workspace();
    const recorder = recordingPublisher();
    const pause = pauseWithResnapshot();
    const driver = driverWith(fixture, recorder.publisher, [
      { messages: [blocks], beforeResults: pause.beforeResults },
    ]);
    const conversation = await created(driver, fixture);
    const handle = await driver.attach(conversation.attach);
    const first = await follow(handle, conversation.backendConversationId);
    const submitted = await submit(handle, "look");
    await pause.atHook;
    expect(first.events.at(-1)?.event).toMatchObject({ type: "resnapshot_required" });
    first.unsubscribe();

    const second = await follow(handle, conversation.backendConversationId);
    const seeded = Object.values(second.projection.snapshot.itemsById).filter(
      (item) => item.semanticKind === "viewed_image",
    );
    expect(seeded.map(({ status }) => status)).toEqual(["streaming", "streaming"]);
    expect(seeded.every(({ backendItemId }) => !backendItemId.startsWith("live:"))).toBe(true);
    pause.resume();
    await vi.waitFor(() =>
      expect(second.events.some(({ event }) => event.type === "turn_completed")).toBe(true),
    );
    await vi.waitFor(async () =>
      expect(childImages((await driver.read(conversation.attach)).snapshot.itemsById)).toHaveLength(1),
    );

    expect(second.results.filter(({ kind }) => kind === "resnapshot_required")).toEqual([]);
    const current = (await driver.read(conversation.attach)).snapshot;
    expect(turnShape(current, submitted.backendTurnId!)).toEqual([
      "user_message",
      "viewed:completed:shown.png",
      "image:provider_input",
      "viewed:failed:broken.png",
      "assistant_message",
    ]);
    expect(JSON.stringify(current)).not.toContain("/private");
    const timeline = second.normalized.timeline();
    const turn = timeline.turnsById[timeline.orderedTurnIds.at(-1)!]!;
    expect(turn.orderedItemIds.map((id) => [timeline.itemsById[id]!.kind, timeline.itemsById[id]!.status])).toEqual([
      ["user_message", "completed"],
      ["viewed_image", "completed"],
      ["image", "completed"],
      ["viewed_image", "failed"],
      ["assistant_message", "completed"],
    ]);
    second.unsubscribe();
    await handle.close();
  });

  it("interrupts a seeded row whose result never persists before settlement", async () => {
    const fixture = await workspace();
    const recorder = recordingPublisher();
    const pause = pauseWithResnapshot();
    const driver = driverWith(fixture, recorder.publisher, [
      { messages: [blocks], beforeResults: pause.beforeResults, settleWithoutResults: true },
    ]);
    const conversation = await created(driver, fixture);
    const handle = await driver.attach(conversation.attach);
    const first = await follow(handle, conversation.backendConversationId);
    const submitted = await submit(handle, "look");
    await pause.atHook;
    first.unsubscribe();
    const second = await follow(handle, conversation.backendConversationId);
    pause.resume();
    await vi.waitFor(() =>
      expect(second.events.some(({ event }) => event.type === "turn_completed")).toBe(true),
    );
    expect(second.results.filter(({ kind }) => kind === "resnapshot_required")).toEqual([]);
    const current = (await driver.read(conversation.attach)).snapshot;
    const rows = current.turnsById[submitted.backendTurnId!]!.orderedBackendItemIds
      .map((id) => current.itemsById[id]!)
      .filter((item) => item.semanticKind === "viewed_image");
    expect(rows.map(({ status, error }) => [status, error?.code])).toEqual([
      ["interrupted", "pi_tool_result_missing"],
      ["interrupted", "pi_tool_result_missing"],
    ]);
    // The earlier generation published the image live; this one has no result to pair it with.
    expect(childImages(current.itemsById)).toEqual([]);
    second.unsubscribe();
    await handle.close();
  });
});

describe("Pi viewed-image publication and close", () => {
  it("waits for a started publication, starts no other, and delivers nothing after close", async () => {
    const fixture = await workspace();
    const recorder = recordingPublisher();
    const driver = driverWith(fixture, recorder.publisher);
    const conversation = await created(driver, fixture);
    const manager = await persisted(fixture, conversation.backendConversationId);
    for (let index = 0; index < 3; index += 1) {
      appendImageReadTurn(manager, conversation.backendConversationId, index);
    }
    recorder.hold();
    const handle = await driver.attach(conversation.attach);
    const received: string[] = [];
    handle.subscribe((event) => received.push(event.type));
    await vi.waitFor(() => expect(recorder.published).toHaveLength(1));

    let closed = false;
    const closing = handle.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    recorder.release();
    await closing;
    expect(recorder.published).toHaveLength(1);
    expect(received).toEqual([]);
  });

  it("stops publishing an older page when the handle closes", async () => {
    const fixture = await workspace();
    const recorder = recordingPublisher();
    const driver = driverWith(fixture, recorder.publisher);
    const conversation = await created(driver, fixture);
    const manager = await persisted(fixture, conversation.backendConversationId);
    for (let index = 0; index < 13; index += 1) {
      const coordinates = appendImageReadTurn(manager, conversation.backendConversationId, index);
      if (index >= 3) {
        await prepublish(recorder.publisher, conversation.backendConversationId, coordinates);
      }
    }
    const prepublished = recorder.published.length;
    const handle = await driver.attach(conversation.attach);
    const established = await handle.establishProjection({ signal: new AbortController().signal });
    expect(established.history.previousCursor).toBeDefined();
    recorder.hold();
    const page = handle.history({ cursor: established.history.previousCursor!, limit: 20 });
    await vi.waitFor(() => expect(recorder.published).toHaveLength(prepublished + 1));
    const closing = handle.close();
    recorder.release();
    await expect(page).rejects.toMatchObject({ backendCode: "pi_handle_closed" });
    await closing;
    expect(recorder.published).toHaveLength(prepublished + 1);
  });
});

describe("Pi viewed images near the per-turn item bound", () => {
  it("opens, reads and pages a turn whose children exceed Pi's item bound", async () => {
    const fixture = await workspace();
    const recorder = recordingPublisher();
    const driver = driverWith(fixture, recorder.publisher);
    const conversation = await created(driver, fixture);
    const manager = await persisted(fixture, conversation.backendConversationId);
    // 1 user + 260 x (text + 2 image reads) + final: 782 items, 1302 with children.
    const turnId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "look" }], timestamp: Date.now() });
    for (let index = 0; index < 260; index += 1) {
      const calls = [`a-${index}`, `b-${index}`];
      const assistantEntryId = manager.appendMessage(
        assistantMessage(
          [
            { type: "text", text: `step ${index}` },
            ...calls.map((id) => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.png` } })),
          ],
          "toolUse",
        ) as never,
      );
      for (const toolCallId of calls) {
        manager.appendCustomEntry(
          piToolIdentityMarkerType,
          createPiToolIdentityMarker(
            { assistantEntryId, toolCallId, toolName: "read", identity: readIdentity },
            { conversationId: conversation.backendConversationId, installationKey: toolProvenanceKey },
          ),
        );
      }
      for (const toolCallId of calls) {
        manager.appendMessage({ role: "toolResult", toolCallId, toolName: "read", content: imageContent(), isError: false, timestamp: Date.now() } as never);
        // Published before, as by an earlier attachment's backfill.
        await recorder.publisher.publishImage({
          scope,
          threadId: "thread",
          publicationKey: piViewedImagePublicationKey({
            sessionId: conversation.backendConversationId,
            assistantEntryId,
            toolCallId,
            imageIndex: 1,
          }),
          mediaType: "image/png",
          bytes: Buffer.from(pixel, "base64"),
        });
      }
    }
    manager.appendMessage(assistantMessage([{ type: "text", text: "done" }], "stop") as never);
    const publishedBefore = recorder.published.length;

    const unattached = await driver.read(conversation.attach);
    expect(unattached.snapshot.turnsById[turnId]!.orderedBackendItemIds).toHaveLength(1_302);
    const handle = await driver.attach(conversation.attach);
    const established = await handle.establishProjection({ signal: new AbortController().signal });
    expect(established.snapshot.turnsById[turnId]!.orderedBackendItemIds).toHaveLength(1_302);
    expect(childImages(established.snapshot.itemsById)).toHaveLength(520);
    const located = await handle.locateTurn({
      maximumTurnCandidates: 1,
      matchesBackendTurnId: (candidate) => candidate === turnId,
    });
    expect(located).toMatchObject({ status: "found" });
    const page = await handle.history({ limit: 5 });
    expect(page.turnsById[turnId]!.orderedBackendItemIds).toHaveLength(1_302);
    expect(recorder.published).toHaveLength(publishedBefore);
    await handle.close();
  });
});

describe("Pi usage accounting with viewed images", () => {
  it("attributes an image-read turn from the pure projection and never publishes", () => {
    const manager = SessionManager.inMemory("/workspace");
    const conversationId = manager.getSessionId();
    appendImageReadTurn(manager, conversationId, 1);
    const recorder = recordingPublisher();
    const findImage = vi.spyOn(recorder.publisher, "findImage");
    const registered: string[][] = [];
    const captured: unknown[] = [];
    const sink: UsageSink = {
      enabled: true,
      findSubagent: () => null,
      listSubagentRoots: () => ({ bindings: [], nextCursor: null }),
      listSubagents: () => [],
      open: () => ({
        registerTurns: (turns) => {
          registered.push(...turns.map((turn) => [...turn.orderedBackendItemIds]));
        },
        capture: (observations) => {
          captured.push(...observations);
          return true;
        },
        gap: () => {},
        reconcile: () => true,
        seal: () => {},
      }),
    };
    new PiUsageAccounting({
      sink,
      manager,
      nativeNamespace: "store",
      authentication: { conversationId, installationKey: toolProvenanceKey },
      binding: { ...binding(conversationId), backendConversationId: conversationId },
    });
    expect(captured).toHaveLength(2);
    const assistantEntryId = manager
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant")!.id;
    expect(registered.at(-1)).toContain(`${assistantEntryId}:0`);
    expect(registered.flat().some((id) => id.endsWith(":image"))).toBe(false);
    expect(recorder.published).toEqual([]);
    expect(findImage).not.toHaveBeenCalled();
  });
});
