import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentSession,
  SessionManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiHistoryProjector } from "../../src/server/backends/pi/pi-history-projector.js";
import { PiSessionStore } from "../../src/server/backends/pi/pi-session-store.js";
import {
  DefaultPiSdkSessionFactory,
  PiInteractionBridge,
  type PiSdkSession,
} from "../../src/server/backends/pi/pi-sdk-session.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import { PiConversationBackendDriver } from "../../src/server/backends/pi/pi-conversation-driver.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import type { BackendConversationEvent } from "../../src/shared/protocol/backend.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";
import { createInMemoryOutputArtifactPublisher } from "../helpers/output-artifact-publisher.js";

type ProviderContext = Parameters<
  AgentSession["modelRuntime"]["streamSimple"]
>[1];

const roots: string[] = [];
const sessions: PiSdkSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.clearQueue();
    await session.abort();
    session.dispose();
  }
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-pi-transcript-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  const sessionDirectory = path.join(root, "sessions");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(sessionDirectory)]);
  await writeFile(path.join(cwd, "AGENTS.md"), "PRIVATE_INSTRUCTIONS_ORIGINAL");
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      cacheWarming: "off",
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
      retry: { enabled: false },
    }),
  );
  const workspace = {
    canonicalPath: cwd,
    summary: { trustState: "trusted" },
  } as ValidatedWorkspace;
  const store = new PiSessionStore({ sessionDirectory });
  const reserved = await store.reserve(
    workspace,
    "transcript-source",
    "Transcript source",
  );
  const bind = vi.spyOn(AgentSession.prototype, "bindExtensions");
  const factory = new DefaultPiSdkSessionFactory({ agentDir });
  const open = async (manager: SessionManager, targetWorkspace = workspace,
    options: Partial<Parameters<DefaultPiSdkSessionFactory["create"]>[0]> = {}) => {
    const session = await factory.create({
      ...options,
      manager,
      workspace: targetWorkspace,
      interactions: options.interactions ?? new PiInteractionBridge(),
    });
    sessions.push(session);
    await session.ready();
    const native = bind.mock.instances.at(-1)! as AgentSession;
    const model = native.modelRuntime.getModels()[0]!;
    expect(model).toBeDefined();
    native.agent.state.model = model;
    vi.spyOn(native.modelRuntime, "hasConfiguredAuth").mockReturnValue(true);
    vi.spyOn(native.modelRuntime, "getAuth").mockResolvedValue(undefined);
    const outbound: ProviderContext[] = [];
    const reply = (text: string): AssistantMessage => ({
      role: "assistant",
      content: [{ type: "text", text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const stream = vi
      .spyOn(native.modelRuntime, "streamSimple")
      .mockImplementation((_model, context) => {
        outbound.push(structuredClone(context));
        const message = reply("Visible response");
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "done", reason: "stop", message };
          },
          result: async () => message,
        } as unknown as ReturnType<typeof native.modelRuntime.streamSimple>;
      });
    const prompt = async (text: string) => {
      const preflightResult = vi.fn();
      await session.prompt(text, { source: "rpc", preflightResult });
      expect(preflightResult).toHaveBeenCalledWith(true);
      expect(native.agent.state.errorMessage).toBeUndefined();
      return outbound.at(-1)!;
    };
    return { session, native, outbound, stream, reply, prompt };
  };
  return { root, cwd, workspace, store, reserved, open };
}

function assertPrivateProjection(manager: SessionManager) {
  const projection = new PiHistoryProjector({}).project(manager.getBranch());
  const browser = JSON.stringify(projection);
  expect(browser).toContain("Visible response");
  expect(browser).not.toContain("PRIVATE_INSTRUCTIONS");
  expect(browser).not.toContain("toolsAdded");
  expect(browser).not.toContain("toolsRemoved");
  expect(browser).not.toContain("systemMessage");
}

function assertLoadout(
  context: { readonly messages: readonly { role: string }[] },
  instruction: string,
  tools: string[],
) {
  expect(getCurrentSystemPrompt(context.messages)).toContain(instruction);
  expect(
    getCurrentTools(context.messages)
      .map(({ name }) => name)
      .sort(),
  ).toEqual(tools.toSorted());
}

describe("Pi 0.86 transcript and lifecycle compatibility", () => {
  it("publishes real SDK tool-loop progress through the driver while a model-only stub holds the final response", async () => {
    const f = await fixture();
    const scope = { tenantId: "tenant", principalId: "principal" };
    const workspace: ValidatedWorkspace = { ...f.workspace, authorityRevision: 1, summary: {
      id: crypto.randomUUID(), environmentId: crypto.randomUUID(), displayName: "SDK progress",
      displayPath: f.cwd, availability: "available", trustState: "trusted", revision: 0,
    } };
    const instance = { id: "pi-progress", tenantId: scope.tenantId, kind: "pi" as const,
      label: "Pi", enabled: true, configurationRevision: 1, protocolRelease: "0.86.0" };
    const connection = { id: "pi-connection", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId,
      templateId: "pi-template", kind: "pi_sdk" as const, backendInstanceId: instance.id,
      executionEnvironmentId: workspace.summary.environmentId, label: "Pi", enabled: true, configurationRevision: 1 };
    let finishFinal: (() => void) | undefined;
    let requests = 0;
    const driver = new PiConversationBackendDriver({
      instance, connection, store: f.store, usage: NO_USAGE_SINK,
      nativeDiscoveryNamespaceKey: "sdk-progress", toolProvenanceKey: new Uint8Array(32).fill(7),
      toolAccessPolicy: () => "read_only", modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "provider_model_effort"),
      outputArtifacts: createInMemoryOutputArtifactPublisher(),
      agentToolSourceCapabilities: createFakeAgentToolSourceCapabilities().issuer,
      agentTools: { eligibleCatalog: () => [], catalogSummaries: () => [], describeMany: () => [],
        readPolicy: () => ({ enabled: false, presentation: { surface: "native", mode: "individual" }, accessBoundary: "environment", enabledToolIds: [] }),
        invoke: async () => { throw new Error("No application tools in this test"); } },
      sessionFactory: { create: async input => {
        const source = await f.open(input.manager, input.workspace, input);
        source.stream.mockImplementation(() => {
          requests += 1;
          const stream = new AssistantMessageEventStream();
          if (requests === 1) {
            const message: AssistantMessage = { ...source.reply("Inspecting AGENTS.md"), stopReason: "toolUse",
              content: [{ type: "text", text: "Inspecting AGENTS.md" },
                { type: "toolCall", id: "read-agents", name: "read", arguments: { path: "AGENTS.md" } }] };
            queueMicrotask(() => { stream.push({ type: "done", reason: "toolUse", message }); stream.end(message); });
          } else {
            const message = source.reply("Finished reading the instructions");
            finishFinal = () => { stream.push({ type: "done", reason: "stop", message }); stream.end(message); };
          }
          return stream;
        });
        return source.session;
      } },
    });
    const applicationThreadId = crypto.randomUUID();
    const created = await driver.create({ scope, workspace, applicationThreadId,
      applicationOperationId: crypto.randomUUID(), source: { kind: "user" } });
    const handle = await driver.attach({ scope, workspace, opaqueBindingDetail: created.opaqueBindingDetail,
      binding: { tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, applicationThreadId,
        backendInstanceId: instance.id, connectionProfileId: connection.id, executionEnvironmentId: workspace.summary.environmentId,
        backendConversationId: created.backendConversationId, createdAt: new Date().toISOString() } });
    try {
      const projection = await handle.establishProjection({ signal: new AbortController().signal });
      const events: BackendConversationEvent[] = [];
      projection.subscribeFromNext(({ event }) => events.push(event));
      await handle.submit({ applicationOperationId: crypto.randomUUID(), mutationId: crypto.randomUUID(), reconciliationToken: crypto.randomUUID(),
        source: { kind: "user" }, text: "Read AGENTS.md and report completion", contextExcerpts: [], attachments: [], taskContexts: [] });
      await vi.waitFor(() => expect(finishFinal).toBeDefined());
      const progress = events.filter(event => "liveProgress" in event && event.liveProgress);
      expect(progress).toEqual([expect.objectContaining({ type: "item_completed", item: expect.objectContaining({
        semanticKind: "assistant_message", status: "completed", responsePhase: "provisional", markdown: { text: "Inspecting AGENTS.md" },
      }) })]);
      expect(events.some(event => event.type === "turn_completed")).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: "item_completed", item: expect.objectContaining({ semanticKind: "file_read", phase: "completed" }) }));
      finishFinal!();
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "turn_completed", turn: expect.objectContaining({ status: "completed" }) })));
      expect(events.filter(event => "liveProgress" in event && event.liveProgress)).toEqual(progress);
      const history = await handle.history({ limit: 10 });
      expect(Object.values(history.itemsById)).toContainEqual(expect.objectContaining({ semanticKind: "assistant_message",
        responsePhase: "final", markdown: { text: "Finished reading the instructions" } }));
      expect(JSON.stringify(history)).not.toContain("liveProgress");
      expect(requests).toBe(2);
    } finally { finishFinal?.(); await handle.close(); }
  }, 30_000);

  it("correlates request timing with the exact SDK message, independently of history and later consumers", async () => {
    const f = await fixture();
    const source = await f.open(f.reserved.manager);
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      source.stream.mockImplementation(() => {
        const stream = new AssistantMessageEventStream();
        const response = source.reply("Measured response");
        response.usage.output = 100;
        response.usage.reasoning = 40;
        finish = () => {
          now = 1100;
          stream.push({ type: "done", reason: "stop", message: response });
          stream.end(response);
        };
        resolve();
        return stream;
      });
    });
    const measurements: unknown[] = [];
    source.session.subscribe((event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      now = 90_000;
      event.message.usage.output = 999; // An extension may mutate the same result object.
      measurements.push(source.session.takeRequestThroughput(event.message));
    });
    const running = source.prompt("Measure the response");
    await started;
    finish();
    await running;
    expect(measurements).toEqual([{ outputTokens: 100, requestDurationMs: 1000 }]);
    expect(JSON.stringify(source.session.sessionManager.getEntries())).not.toContain("requestDurationMs");
    const reopened = await f.open(source.session.sessionManager);
    const historical = source.session.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant");
    if (historical?.type !== "message" || historical.message.role !== "assistant") throw new Error("Expected assistant history");
    expect(reopened.session.takeRequestThroughput(historical.message)).toBeUndefined();
  });

  it.each([true, false])("persists a setup error as aborted only when its request was cancelled (%s)", async (cancelled) => {
    const f = await fixture();
    const source = await f.open(f.reserved.manager);
    const events: AgentSessionEvent[] = [];
    source.session.subscribe((event) => events.push(event));
    let signal: AbortSignal | undefined;
    let fail!: () => void;
    source.stream.mockImplementation((_model, _context, options) => {
      signal = options?.signal;
      const stream = new AssistantMessageEventStream();
      fail = () => {
        const message: AssistantMessage = {
          ...source.reply(""),
          stopReason: "error",
          errorMessage: "provider setup failed",
        };
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
      };
      signal!.addEventListener("abort", fail, { once: true });
      return stream;
    });
    const running = source.session.prompt("Visible cancellation target", {
      source: "rpc", preflightResult: vi.fn(),
    });
    await vi.waitFor(() => expect(signal).toBeDefined());
    if (cancelled) await source.session.abort();
    else fail();
    await running;
    expect(source.session.isIdle).toBe(true);
    const stopReason = cancelled ? "aborted" : "error";
    expect(events).toContainEqual(expect.objectContaining({
      type: "message_end", message: expect.objectContaining({ stopReason }),
    }));
    expect(events.filter((event) => event.type === "agent_settled")).toHaveLength(1);
    // Stopping after a completed failure cannot retroactively turn it into a cancellation.
    await source.session.abort();
    const reopened = await f.store.openPersisted(f.workspace, source.session.sessionId);
    expect(reopened).toBeDefined();
    const assistant = reopened!.getBranch().findLast((entry) =>
      entry.type === "message" && entry.message.role === "assistant",
    );
    expect(assistant).toMatchObject({ message: { stopReason } });
    const projection = new PiHistoryProjector({}).project(reopened!.getBranch());
    expect(Object.values(projection.snapshot.turnsById).at(-1)).toMatchObject({
      status: cancelled ? "interrupted" : "failed",
      endedBy: cancelled ? "interrupted" : "failed",
      ...(cancelled ? {} : { failure: { message: { text: "provider setup failed" } } }),
    });
  });

  it("replays instruction and tool changes through compaction, resume and a fork into a new environment without exposing native state", async () => {
    const f = await fixture();
    const source = await f.open(f.reserved.manager);
    source.session.setActiveToolsByName(["read", "write"]);
    assertLoadout(
      await source.prompt("First visible request"),
      "PRIVATE_INSTRUCTIONS_ORIGINAL",
      ["read", "write"],
    );

    await writeFile(
      path.join(f.cwd, "AGENTS.md"),
      "PRIVATE_INSTRUCTIONS_RELOADED",
    );
    await source.native.reload();
    source.session.setActiveToolsByName(["read"]);
    const reloadedContext = await source.prompt("Second visible request");
    assertLoadout(reloadedContext, "PRIVATE_INSTRUCTIONS_RELOADED", ["read"]);
    expect(getCurrentSystemPrompt(reloadedContext.messages)).not.toContain(
      "PRIVATE_INSTRUCTIONS_ORIGINAL",
    );
    expect(
      f.reserved.manager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "system" &&
            entry.message.toolsRemoved?.some(({ name }) => name === "write"),
        ),
    ).toBe(true);

    await source.session.compact();
    const checkpoint = f.reserved.manager
      .getBranch()
      .findLast((entry) => entry.type === "compaction");
    expect(checkpoint?.type).toBe("compaction");
    if (checkpoint?.type !== "compaction")
      throw new Error("Missing compaction checkpoint");
    expect(checkpoint.systemMessage).toBeDefined();
    assertLoadout(
      { messages: [checkpoint.systemMessage!] },
      "PRIVATE_INSTRUCTIONS_RELOADED",
      ["read"],
    );
    assertPrivateProjection(f.reserved.manager);

    source.session.dispose();
    sessions.splice(sessions.indexOf(source.session), 1);
    const reopenedManager = await f.store.open(
      f.workspace,
      "transcript-source",
      f.reserved.opaqueBindingDetail,
    );
    assertLoadout(
      reopenedManager.buildSessionContext(),
      "PRIVATE_INSTRUCTIONS_RELOADED",
      ["read"],
    );
    const resumed = await f.open(reopenedManager);
    // Sedes reapplies the current thread's tool grants when attaching a runtime.
    resumed.session.setActiveToolsByName(["read"]);
    assertLoadout(
      await resumed.prompt("Third visible request after resume"),
      "PRIVATE_INSTRUCTIONS_RELOADED",
      ["read"],
    );
    assertPrivateProjection(reopenedManager);

    const targetCwd = path.join(f.root, "fork-workspace");
    await mkdir(targetCwd);
    await writeFile(
      path.join(targetCwd, "AGENTS.md"),
      "PRIVATE_INSTRUCTIONS_FORK_ENVIRONMENT",
    );
    const targetWorkspace = { ...f.workspace, canonicalPath: targetCwd };
    const fork = await f.store.branch(
      f.workspace,
      "transcript-source",
      f.reserved.opaqueBindingDetail,
      reopenedManager.getLeafId()!,
      new Uint8Array(32).fill(0x42),
      "transcript-fork",
      "fork-operation",
      undefined,
      undefined,
      targetWorkspace,
    );
    // Historical native state remains intact in the fork and compaction checkpoint.
    assertLoadout(
      fork.manager.buildSessionContext(),
      "PRIVATE_INSTRUCTIONS_RELOADED",
      ["read"],
    );
    const child = await f.open(fork.manager, targetWorkspace);
    child.session.setActiveToolsByName(["read", "ls"]);
    const forkContext = await child.prompt("Visible request in fork");
    assertLoadout(forkContext, "PRIVATE_INSTRUCTIONS_FORK_ENVIRONMENT", [
      "read",
      "ls",
    ]);
    const effectivePrompt = getCurrentSystemPrompt(forkContext.messages);
    expect(effectivePrompt).not.toContain("PRIVATE_INSTRUCTIONS_RELOADED");
    expect(effectivePrompt).toContain(`<cwd>\n${targetCwd}\n</cwd>`);
    expect(effectivePrompt).not.toContain(`<cwd>\n${f.cwd}\n</cwd>`);
    assertPrivateProjection(fork.manager);
    expect(JSON.stringify(reopenedManager.getBranch())).not.toContain(
      "PRIVATE_INSTRUCTIONS_FORK_ENVIRONMENT",
    );
  });

  it("delivers RPC steering once after the active response with the current transcript loadout", async () => {
    const f = await fixture();
    const source = await f.open(f.reserved.manager);
    source.session.setActiveToolsByName(["read"]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.stream.mockImplementation((_model, context) => {
      source.outbound.push(structuredClone(context));
      const first = source.outbound.length === 1;
      const message = source.reply(
        first ? "Visible initial response" : "Visible steered response",
      );
      const result = async () => {
        if (first) await gate;
        return message;
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: "stop", message: await result() };
        },
        result,
      } as unknown as ReturnType<
        typeof source.native.modelRuntime.streamSimple
      >;
    });
    const running = source.prompt("Visible original request");
    try {
      await vi.waitFor(() => expect(source.outbound).toHaveLength(1));
      await source.session.steer("Visible steering request");
      expect(source.native.getSteeringMessages()).toEqual([
        "Visible steering request",
      ]);
      expect(source.outbound).toHaveLength(1);
    } finally {
      release();
      await running;
    }
    expect(source.outbound).toHaveLength(2);
    assertLoadout(source.outbound[1]!, "PRIVATE_INSTRUCTIONS_ORIGINAL", [
      "read",
    ]);
    const users = source.outbound[1]!.messages.filter(
      (message) => message.role === "user",
    );
    expect(
      JSON.stringify(users).match(/Visible steering request/g),
    ).toHaveLength(1);
    expect(source.native.getSteeringMessages()).toEqual([]);
    expect(source.session.isIdle).toBe(true);
  });

  function branchUserTexts(manager: SessionManager): string[] {
    return manager.getBranch().flatMap((entry) =>
      entry.type === "message" && entry.message.role === "user"
        ? [JSON.stringify(entry.message.content)]
        : [],
    );
  }

  it("queues several RPC steers and persists one user entry for each in FIFO order", async () => {
    const f = await fixture();
    const source = await f.open(f.reserved.manager);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.stream.mockImplementation((_model, context) => {
      source.outbound.push(structuredClone(context));
      const first = source.outbound.length === 1;
      const message = source.reply(
        first ? "Visible initial response" : "Visible steered response",
      );
      const result = async () => {
        if (first) await gate;
        return message;
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: "stop", message: await result() };
        },
        result,
      } as unknown as ReturnType<
        typeof source.native.modelRuntime.streamSimple
      >;
    });
    const steers = ["FIRST_STEER", "SECOND_STEER", "THIRD_STEER"];
    const running = source.prompt("Visible original request");
    try {
      await vi.waitFor(() => expect(source.outbound).toHaveLength(1));
      for (const steer of steers) {
        await expect(source.session.steer(steer)).resolves.toEqual({
          queued: true,
        });
      }
      expect(source.native.getSteeringMessages()).toEqual(steers);
    } finally {
      release();
      await running;
    }
    const users = branchUserTexts(f.reserved.manager);
    expect(users).toHaveLength(1 + steers.length);
    steers.forEach((steer, index) => {
      expect(users[index + 1]).toContain(steer);
    });
    expect(source.native.getSteeringMessages()).toEqual([]);
    expect(source.session.isIdle).toBe(true);
  });

  it("withdraws the unused queued steers on clearQueue before abort and keeps a used one", async () => {
    const f = await fixture();
    const source = await f.open(f.reserved.manager);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted!: () => void;
    const secondRequest = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    source.stream.mockImplementation((_model, context, options) => {
      source.outbound.push(structuredClone(context));
      if (source.outbound.length === 2) {
        // Pi used the first steer and now streams its response until Stop.
        const stream = new AssistantMessageEventStream();
        options?.signal?.addEventListener(
          "abort",
          () => {
            const message: AssistantMessage = {
              ...source.reply(""),
              stopReason: "error",
              errorMessage: "request cancelled",
            };
            stream.push({ type: "error", reason: "error", error: message });
            stream.end(message);
          },
          { once: true },
        );
        secondStarted();
        return stream;
      }
      const first = source.outbound.length === 1;
      const message = source.reply(
        first ? "Visible initial response" : "Visible later response",
      );
      const result = async () => {
        if (first) await firstGate;
        return message;
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: "stop", message: await result() };
        },
        result,
      } as unknown as ReturnType<
        typeof source.native.modelRuntime.streamSimple
      >;
    });
    const steers = ["USED_STEER", "UNUSED_STEER_ONE", "UNUSED_STEER_TWO"];
    const running = source.session.prompt("Visible original request", {
      source: "rpc",
      preflightResult: vi.fn(),
    });
    await vi.waitFor(() => expect(source.outbound).toHaveLength(1));
    for (const steer of steers) {
      await expect(source.session.steer(steer)).resolves.toEqual({
        queued: true,
      });
    }
    releaseFirst();
    await secondRequest;
    // Pi's default one-at-a-time mode used only the first steer so far.
    expect(source.session.clearQueue().steering).toEqual(steers.slice(1));
    await source.session.abort();
    await running;
    expect(source.session.isIdle).toBe(true);

    const users = branchUserTexts(f.reserved.manager);
    expect(users.filter((text) => text.includes("USED_STEER"))).toHaveLength(1);
    expect(users.join("\n")).not.toContain("UNUSED_STEER");
    // A withdrawn steer never reaches a later run.
    const next = await source.prompt("Visible next request");
    expect(JSON.stringify(next.messages)).not.toContain("UNUSED_STEER");
    expect(branchUserTexts(f.reserved.manager).join("\n")).not.toContain(
      "UNUSED_STEER",
    );
  });

  it("reports steering input an extension consumed as not queued", async () => {
    const f = await fixture();
    const extensions = path.join(f.root, "agent", "extensions");
    await mkdir(extensions);
    await writeFile(
      path.join(extensions, "consume-steer.ts"),
      [
        "export default function (pi: any) {",
        '  pi.on("input", (event: { text: string }) =>',
        '    event.text.includes("CONSUMED_BY_EXTENSION")',
        '      ? { action: "handled" }',
        '      : { action: "continue" },',
        "  );",
        "}",
        "",
      ].join("\n"),
    );
    const source = await f.open(f.reserved.manager);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.stream.mockImplementation((_model, context) => {
      source.outbound.push(structuredClone(context));
      const first = source.outbound.length === 1;
      const message = source.reply(
        first ? "Visible initial response" : "Visible steered response",
      );
      const result = async () => {
        if (first) await gate;
        return message;
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "done", reason: "stop", message: await result() };
        },
        result,
      } as unknown as ReturnType<
        typeof source.native.modelRuntime.streamSimple
      >;
    });
    const running = source.prompt("Visible original request");
    try {
      await vi.waitFor(() => expect(source.outbound).toHaveLength(1));
      await expect(
        source.session.steer("CONSUMED_BY_EXTENSION steer"),
      ).resolves.toEqual({ queued: false });
      await expect(source.session.steer("QUEUED_STEER")).resolves.toEqual({
        queued: true,
      });
      expect(source.native.getSteeringMessages()).toEqual(["QUEUED_STEER"]);
    } finally {
      release();
      await running;
    }
    const users = branchUserTexts(f.reserved.manager).join("\n");
    expect(users).toContain("QUEUED_STEER");
    expect(users).not.toContain("CONSUMED_BY_EXTENSION");
  });

  it("aborts an in-progress compaction and waits for idle without persisting a partial checkpoint", async () => {
    const f = await fixture();
    const source = await f.open(f.reserved.manager);
    await source.prompt("Visible request before compaction");
    const events: AgentSessionEvent[] = [];
    source.session.subscribe((event) => events.push(event));
    let observedSignal: AbortSignal | undefined;
    source.stream.mockImplementation((_model, _context, options) => {
      observedSignal = options?.signal;
      const result = new Promise<AssistantMessage>((_resolve, reject) => {
        observedSignal!.addEventListener(
          "abort",
          () => reject(new Error("Compaction cancelled")),
          { once: true },
        );
      });
      return { result: () => result } as ReturnType<
        typeof source.native.modelRuntime.streamSimple
      >;
    });
    const outcome = source.session.compact().then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    expect(source.session.isIdle).toBe(false);
    await source.session.abort();
    expect(observedSignal?.aborted).toBe(true);
    expect(await outcome).toBeInstanceOf(Error);
    expect(source.session.isIdle).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "compaction_end",
        reason: "manual",
        aborted: true,
      }),
    );
    expect(
      f.reserved.manager
        .getBranch()
        .some((entry) => entry.type === "compaction"),
    ).toBe(false);
  });
});
