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
  const open = async (manager: SessionManager, targetWorkspace = workspace) => {
    const session = await factory.create({
      manager,
      workspace: targetWorkspace,
      interactions: new PiInteractionBridge(),
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
