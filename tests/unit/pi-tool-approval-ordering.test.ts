import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  ConversationActor,
  ConversationActorListener,
} from "../../src/server/conversations/conversation-actor.js";
import { InteractionBroker } from "../../src/server/conversations/interaction-broker.js";
import type { ConversationEventBridge } from "../../src/server/events/conversation-event-bridge.js";
import {
  ScopedThreadEventHubRegistry,
  ThreadRuntimeCoordinator,
} from "../../src/server/events/thread-runtime-coordinator.js";
import {
  createPiToolApprovalExtension,
  type PiToolApprovalRequester,
} from "../../src/server/backends/pi/pi-tool-approval-extension.js";
import {
  PI_TOOL_APPROVAL_TITLE,
  PiToolAccessController,
} from "../../src/server/backends/pi/pi-tool-access.js";
import { PiInteractionBridge } from "../../src/server/backends/pi/pi-sdk-session.js";

type ToolCallEvent = {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
};

type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: {
    sessionManager: { getBranch: () => readonly unknown[] };
    ui: object;
  },
) => Promise<{ block: true; reason?: string } | undefined>;

function loadApprovalHandler(
  toolAccess: PiToolAccessController,
  requestApproval: PiToolApprovalRequester = vi.fn(),
): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  const extension = createPiToolApprovalExtension({
    toolAccess,
    workspacePath: "/workspace",
    requestApproval,
  });
  if (typeof extension === "function" || !("factory" in extension)) {
    throw new Error("expected named inline extension");
  }
  extension.factory({
    on(event: string, registered: ToolCallHandler) {
      if (event === "tool_call") handler = registered;
    },
  } as unknown as ExtensionAPI);
  if (!handler) throw new Error("missing handler");
  return handler;
}

function branchFor(toolCallId: string, name: string) {
  return {
    getBranch: () => [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: toolCallId, name }],
        },
      },
    ],
  };
}

/**
 * Simulate Pi's sequential tool_call ordering: ordinary handlers first, then
 * the managed approval hook last.
 */
async function runOrderedHandlers(
  ordinary: ToolCallHandler,
  managed: ToolCallHandler,
  event: ToolCallEvent,
  ctx: Parameters<ToolCallHandler>[1],
): Promise<{ block: true; reason?: string } | undefined> {
  const early = await ordinary(event, ctx);
  if (early?.block) return early;
  return managed(event, ctx);
}

describe("Pi tool approval extension ordering", () => {
  it("shows final mutated arguments and binds the fingerprint to that set", async () => {
    const toolAccess = new PiToolAccessController("ask");
    const requestApproval = vi.fn().mockResolvedValue("approve_once");
    const managed = loadApprovalHandler(toolAccess, requestApproval);
    const event: ToolCallEvent = {
      toolName: "bash",
      toolCallId: "bash-mutated",
      input: { command: "echo original" },
    };
    const ordinary: ToolCallHandler = async (current) => {
      current.input.command = "echo final-args";
      return undefined;
    };
    const ctx = {
      sessionManager: branchFor("bash-mutated", "bash"),
      ui: {},
    };
    await expect(
      runOrderedHandlers(ordinary, managed, event, ctx),
    ).resolves.toBeUndefined();
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        title: PI_TOOL_APPROVAL_TITLE,
        detail: expect.stringContaining("echo final-args"),
      }),
    );
    expect(requestApproval.mock.calls[0]![0].detail).not.toContain(
      "echo original",
    );
  });

  it("does not open an approval when an ordinary extension already blocks", async () => {
    const toolAccess = new PiToolAccessController("ask");
    const requestApproval = vi.fn();
    const managed = loadApprovalHandler(toolAccess, requestApproval);
    const ordinary: ToolCallHandler = async () => ({
      block: true,
      reason: "blocked by ordinary extension",
    });
    await expect(
      runOrderedHandlers(
        ordinary,
        managed,
        {
          toolName: "bash",
          toolCallId: "bash-blocked",
          input: { command: "rm -rf /" },
        },
        {
          sessionManager: branchFor("bash-blocked", "bash"),
          ui: {},
        },
      ),
    ).resolves.toEqual({
      block: true,
      reason: "blocked by ordinary extension",
    });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("keeps an unattended ask-mode approval pending until the user responds", async () => {
    vi.useFakeTimers();
    try {
      const toolAccess = new PiToolAccessController("ask");
      const bridge = new PiInteractionBridge();
      let backendInteractionId: string | undefined;
      bridge.setPublisher((event) => {
        if (event.type === "interaction_opened") {
          backendInteractionId = event.interaction.backendInteractionId;
        }
      });
      const managed = loadApprovalHandler(toolAccess, (input) =>
        bridge.requestToolApproval(input),
      );
      const pending = managed(
        {
          toolName: "bash",
          toolCallId: "bash-automation",
          input: { command: "npm test" },
        },
        {
          sessionManager: branchFor("bash-automation", "bash"),
          ui: {},
        },
      );
      expect(toolAccess.mode).toBe("ask");
      await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1_000);
      expect(backendInteractionId).toBeDefined();
      expect(bridge.hasPending(backendInteractionId!)).toBe(true);
      bridge.respond({
        applicationOperationId: "late-tool-approval-response",
        interactionId: backendInteractionId!,
        kind: "decision",
        selectedActionId: "approve_once",
      });
      await expect(pending).resolves.toBeUndefined();
      expect(toolAccess.mode).toBe("ask");
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("denies a pending approval through local runtime release before actor release", async () => {
    const scope = { tenantId: "tenant", principalId: "principal" };
    const toolAccess = new PiToolAccessController("ask");
    const piInteractions = new PiInteractionBridge();
    const managed = loadApprovalHandler(toolAccess, (input) =>
      piInteractions.requestToolApproval(input),
    );
    const actorListeners = new Set<ConversationActorListener>();
    const releaseOrder: string[] = [];
    let backendInteractionId: string | undefined;
    piInteractions.setPublisher((event) => {
      if (
        event.type !== "interaction_opened" &&
        event.type !== "interaction_resolved"
      ) {
        return;
      }
      if (event.type === "interaction_opened") {
        backendInteractionId = event.interaction.backendInteractionId;
      }
      for (const listener of actorListeners) {
        listener({ type: "backend_event", generation: "generation-1", event });
      }
    });
    const actorRelease = vi.fn(() => releaseOrder.push("actor"));
    const actor = {
      timeline: { runState: "waiting_for_approval" },
      canEvict: false,
      subscribe(listener: ConversationActorListener) {
        actorListeners.add(listener);
        return () => actorListeners.delete(listener);
      },
      ensureProjectionCurrent: vi.fn(async () => undefined),
      respond: vi.fn(async (input) => {
        releaseOrder.push("cancel");
        piInteractions.respond(input);
      }),
    } as unknown as ConversationActor;
    const broker = new InteractionBroker();
    const coordinator = new ThreadRuntimeCoordinator({
      actors: {
        acquire: vi.fn(async () => ({ actor, release: actorRelease })),
        runWithRuntimesStopped: async () => { throw new Error("unexpected_explicit_runtime_stop"); },
        runWithRuntimeRetired: async (input) => {
          await input.detachCoordinatorRuntime();
          return input.operation();
        },
      },
      targets: {
        resolve: vi.fn(
          async () =>
            ({
              scope,
              binding: {
                tenantId: scope.tenantId,
                ownerPrincipalId: scope.principalId,
                applicationThreadId: "thread-approval",
                backendConversationId: "backend-thread-approval",
                backendInstanceId: "pi",
                connectionProfileId: "local",
                executionEnvironmentId: "environment",
                createdAt: "2026-07-31T12:00:00.000Z",
              },
              workspace: {
                canonicalPath: "/workspace",
                summary: {
                  id: "workspace",
                  environmentId: "environment",
                  displayName: "Workspace",
                  displayPath: "/workspace",
                  availability: "available",
                  trustState: "trusted",
                  revision: 0,
                },
              },
              driver: {},
              opaqueBindingDetail: "opaque",
            }) as never,
        ),
      },
      bridge: {
        bind: () => ({
          ready: Promise.resolve(),
          publishAuthoritativeReplacement: vi.fn(),
          release: vi.fn(async () => undefined),
        }),
      } as unknown as ConversationEventBridge,
      interactions: broker,
      hubs: new ScopedThreadEventHubRegistry(),
      retentionMilliseconds: 0,
    });
    await coordinator.acquire(scope, "thread-approval");
    const execute = vi.fn();
    const approval = managed(
      {
        toolName: "bash",
        toolCallId: "bash-release",
        input: { command: "touch /tmp/should-not-run" },
      },
      {
        sessionManager: branchFor("bash-release", "bash"),
        ui: {},
      },
    ).then((decision) => {
      if (!decision?.block) execute();
      return decision;
    });
    await vi.waitFor(() =>
      expect(broker.listPending(scope, "thread-approval")).toHaveLength(1),
    );

    await coordinator.close();

    await expect(approval).resolves.toEqual({
      block: true,
      reason: "Tool call denied: approval was cancelled.",
    });
    expect(actorRelease).toHaveBeenCalledOnce();
    expect(actor.respond).toHaveBeenCalledOnce();
    expect(actor.respond).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cancel" }),
    );
    expect(releaseOrder).toEqual(["cancel", "actor"]);
    expect(execute).not.toHaveBeenCalled();
    expect(backendInteractionId).toBeDefined();
    expect(() =>
      piInteractions.respond({
        applicationOperationId: "late-approval",
        interactionId: backendInteractionId!,
        kind: "decision",
        selectedActionId: "approve_once",
      }),
    ).toThrow("pi_interaction_not_found");
    expect(execute).not.toHaveBeenCalled();
    await broker.close();
    piInteractions.close();
  });
});
