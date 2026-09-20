import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackendError,
  type ConversationBinding,
} from "../../src/server/backends/contracts.js";
import { GrokConversationBackendDriver } from "../../src/server/backends/grok/grok-conversation-driver.js";
import {
  parseGrokConversationBindingDetail,
  serializeGrokConversationBindingDetail,
} from "../../src/server/backends/grok/grok-conversation-binding.js";
import { GrokDiscoverySnapshotStore } from "../../src/server/backends/grok/grok-discovery-snapshot-store.js";
import { grokNativeNamespaceKey } from "../../src/server/backends/grok/grok-native-namespace.js";
import {
  grokSubmissionPromptId,
  grokSubmissionPromptIdReadCandidates,
} from "../../src/server/backends/grok/grok-submission-correlation.js";
import { GrokRuntimeAdvisorySource } from "../../src/server/backends/grok/grok-runtime-advisories.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import type { BackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";

const fixture = fileURLToPath(
  new URL(
    "../fixtures/grok/fake-grok-conversation-driver-peer.mjs",
    import.meta.url,
  ),
);
const roots: string[] = [];
const scope = Object.freeze({
  tenantId: "tenant-grok",
  principalId: "principal-grok",
});
const backendInstanceId = "grok-private-driver";
const connectionProfileId = "grok-private-connection";
const executionEnvironmentId = "10000000-0000-4000-8000-000000000081";
const submissionCorrelationKey = new Uint8Array(32).fill(0x47);
const agentTools: BackendAgentToolFacade = {
  eligibleCatalog: () => [],
  catalogSummaries: () => [],
  describeMany: () => [],
  readPolicy: () => ({
    enabled: false,
    presentation: { surface: "cli", mode: "progressive" },
    accessBoundary: "environment",
    enabledToolIds: [],
  }),
  invoke: async () => {
    throw new Error("grok_test_agent_tool_invocation_unexpected");
  },
};

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("normalized Grok conversation driver", () => {
  it("projects the live initialize model catalog through the configured policy", async () => {
    const fixtureState = await openDriver([]);
    try {
      await expect(fixtureState.driver.health()).resolves.toEqual({
        available: true,
        checkedAt: "2026-08-16T12:00:00.000Z",
      });
      await expect(
        fixtureState.driver.catalog({
          scope,
          workspace: fixtureState.workspace,
        }),
      ).resolves.toEqual({
        models: [
          {
            provider: connectionProfileId,
            id: "grok-build",
            label: "Grok Build",
            inputModalities: ["text", "image"],
            isDefault: true,
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "low",
          },
        ],
        commands: [],
        skills: [],
        notices: [],
      });
    } finally {
      await fixtureState.close();
    }
  });

  it("pages an immutable full discovery scan and fences its cursor by exact workspace", async () => {
    const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fixtureState = await openDriver([
      session(firstId, "First"),
      session(secondId, "Second"),
    ]);
    const otherWorkspace = await createWorkspace(fixtureState.root, "other");
    try {
      const first = await fixtureState.driver.discover({
        scope,
        workspace: fixtureState.workspace,
        signal: new AbortController().signal,
        limit: 1,
      });
      expect(
        first.conversations.map(
          ({ backendConversationId }) => backendConversationId,
        ),
      ).toEqual([firstId]);
      expect(first.nextCursor).toMatch(/^grok-discovery:v1:/u);

      const state = await readState(fixtureState.workspace.canonicalPath);
      state.sessions.push(
        session("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "Later"),
      );
      await writeState(fixtureState.workspace.canonicalPath, state);

      await expect(
        fixtureState.driver.discover({
          scope,
          workspace: otherWorkspace,
          signal: new AbortController().signal,
          limit: 1,
          cursor: first.nextCursor,
        }),
      ).rejects.toMatchObject({ backendCode: "grok_discovery_cursor_invalid" });
      const second = await fixtureState.driver.discover({
        scope,
        workspace: fixtureState.workspace,
        signal: new AbortController().signal,
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(second).toMatchObject({
        conversations: [{ backendConversationId: secondId }],
      });
      expect(second.nextCursor).toBeUndefined();
    } finally {
      await fixtureState.close();
    }
  });

  it("injects Sedes CLI authority only into the exact attached thread process", async () => {
    const sessionId = "abababab-abab-4bab-8bab-abababababab";
    const issued: unknown[] = [];
    const fixtureState = await openDriver([session(sessionId, "CLI scope")], {
      agentToolCli: {
        availability: "available",
        endpoint: "http://127.0.0.1:4784",
        executableDirectory: "/opt/sedes/bin",
        inheritedPath: process.env.PATH ?? "/usr/bin",
      },
      issueSourceCapability: (input) => {
        issued.push(input);
        return "grok-exact-thread-source-capability-7Qx2P9vK4nR8sT6wY";
      },
    });
    try {
      await fixtureState.driver.catalog({
        scope,
        workspace: fixtureState.workspace,
      });
      const handle = await fixtureState.driver.attach({
        scope,
        workspace: fixtureState.workspace,
        binding: conversationBinding(sessionId),
        opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
      });
      await handle.close();

      expect(issued).toEqual([
        expect.objectContaining({
          sourceThreadId: `thread-${sessionId}`,
          sourceWorkspaceId: fixtureState.workspace.summary.id,
          sourceEnvironmentId: executionEnvironmentId,
          backendKind: "grok_build",
        }),
      ]);
      expect(
        (await readState(fixtureState.workspace.canonicalPath))
          .observedSedesAuthority,
      ).toEqual([
        {
          endpointPresent: false,
          sourceCapabilityPresent: false,
          clientTokenPresent: false,
        },
        {
          endpointPresent: true,
          sourceCapabilityPresent: true,
          clientTokenPresent: false,
        },
      ]);
    } finally {
      await fixtureState.close();
    }
  });

  it("creates one provider-assigned session, unloads it, and attaches normalized", async () => {
    const fixtureState = await openDriver([]);
    try {
      const created = await fixtureState.driver.create({
        scope,
        workspace: fixtureState.workspace,
        applicationThreadId: "thread-created",
        applicationOperationId: "operation-created",
        creationCorrelation: "correlation-created",
        source: { kind: "user" },
      });
      const detail = parseGrokConversationBindingDetail(
        created.opaqueBindingDetail,
      );
      expect(detail).toMatchObject({
        sessionId: created.backendConversationId,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId,
        connectionProfileId,
        executionEnvironmentId,
        canonicalWorkspacePath: fixtureState.workspace.canonicalPath,
      });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0],
      ).toMatchObject({
        sessionId: created.backendConversationId,
        closeCount: 1,
      });

      const binding = conversationBinding(created.backendConversationId);
      const handle = await fixtureState.driver.attach({
        scope,
        workspace: fixtureState.workspace,
        binding,
        opaqueBindingDetail: created.opaqueBindingDetail,
      });
      expect(await handle.backendCapabilities()).toMatchObject({
        actions: ["rename"],
        deliveryModes: ["submit"],
        steerTarget: null,
        supportsHistory: true,
        branching: { availability: "unavailable" },
        effectiveSettings: {
          model: { provider: connectionProfileId, id: "grok-build" },
          thinkingLevel: "low",
        },
      });
      await expect(
        handle.steer({
          applicationOperationId: "steer-operation",
          mutationId: "steer-mutation",
          reconciliationToken: "steer-reconciliation-token",
          target: { kind: "turn", turnId: "grok-turn:active" },
          text: "change direction",
          contextExcerpts: [],
          taskContexts: [],
          attachments: [],
        }),
      ).rejects.toMatchObject({
        category: "rejected",
        backendCode: "grok_operation_unsupported",
        crossedSubmissionBoundary: false,
      });
      await expect(
        handle.submit({ ...submitInput(), text: "/rename unsafe" }),
      ).rejects.toMatchObject({
        backendCode: "grok_slash_command_unsupported",
      });
      await handle.close();
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0],
      ).toMatchObject({
        closeCount: 2,
      });
    } finally {
      await fixtureState.close();
    }
  });

  it("renames through the reviewed native route and preserves the title across reattach", async () => {
    const sessionId = "12121212-1212-4212-8212-121212121212";
    const fixtureState = await openDriver([session(sessionId, "Before")]);
    const action = {
      applicationOperationId: "rename-operation",
      action: "rename" as const,
      title: "After rename",
    };
    let handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      await expect(handle.reconcileAction(action)).resolves.toEqual({
        outcome: "not_applied",
      });
      await expect(handle.perform(action)).resolves.toEqual({ accepted: true });
      await expect(handle.perform(action)).resolves.toEqual({ accepted: true });
      const renamed = (await readState(fixtureState.workspace.canonicalPath))
        .sessions[0];
      expect(renamed).toMatchObject({
        title: "After rename",
        renameCalls: 1,
        lastRenameRequest: {
          sessionId,
          title: "After rename",
          cwd: fixtureState.workspace.canonicalPath,
          kind: "build",
          resetToAuto: false,
        },
      });
      await handle.close();
      handle = await fixtureState.driver.attach({
        scope,
        workspace: fixtureState.workspace,
        binding: conversationBinding(sessionId),
        opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
      });
      await expect(handle.reconcileAction(action)).resolves.toEqual({
        outcome: "accepted",
      });
    } finally {
      await handle.close().catch(() => undefined);
      await fixtureState.close();
    }
  });

  it("renames through the independent title lane while a prompt is active", async () => {
    const sessionId = "16161616-1616-4616-8616-161616161616";
    const fixtureState = await openDriver([
      { ...session(sessionId, "Active turn"), promptDelayMs: 5_000 },
    ]);
    let handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      const submitted = await handle.submit(submitInput());
      await expect(
        handle.perform({
          applicationOperationId: "rename-active-turn",
          action: "rename",
          title: "Renamed while running",
        }),
      ).resolves.toEqual({ accepted: true });
      await handle.interrupt({
        applicationOperationId: "interrupt-after-rename",
        expectedBackendTurnId: submitted.backendTurnId!,
      });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0],
      ).toMatchObject({ title: "Renamed while running", renameCalls: 1 });
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  });

  it("projects a valid long Sedes title into Grok's native title bound", async () => {
    const sessionId = "17171717-1717-4717-8717-171717171717";
    const fixtureState = await openDriver([session(sessionId, "Before long")]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    const title = "🙂".repeat(120);
    try {
      await expect(
        handle.perform({
          applicationOperationId: "rename-long-title",
          action: "rename",
          title,
        }),
      ).resolves.toEqual({ accepted: true });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .title,
      ).toBe("🙂".repeat(100));
      await expect(
        handle.reconcileAction({
          applicationOperationId: "rename-long-title-after-restart",
          action: "rename",
          title,
        }),
      ).resolves.toEqual({ outcome: "accepted" });
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  });

  it("reconciles a lost native rename response without retrying the mutation", async () => {
    const sessionId = "13131313-1313-4313-8313-131313131313";
    const fixtureState = await openDriver([
      {
        ...session(sessionId, "Before unknown"),
        renameBehavior: "unknown_after_apply",
      },
    ]);
    const action = {
      applicationOperationId: "rename-lost-response",
      action: "rename" as const,
      title: "Applied despite disconnect",
    };
    const first = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    const events: unknown[] = [];
    first.subscribe((event) => events.push(event));
    await expect(first.perform(action)).rejects.toMatchObject({
      category: "submission_unknown",
      crossedSubmissionBoundary: true,
      retryable: false,
    });
    expect(events).toContainEqual({
      type: "resnapshot_required",
      reason: "provider_handle_closed",
    });
    const state = await readState(fixtureState.workspace.canonicalPath);
    state.sessions[0].renameBehavior = undefined;
    await writeState(fixtureState.workspace.canonicalPath, state);
    const recovered = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      await expect(recovered.reconcileAction(action)).resolves.toEqual({
        outcome: "accepted",
      });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .renameCalls,
      ).toBe(1);
    } finally {
      await recovered.close();
      await fixtureState.close();
    }
  });

  it("rejects invalid and mismatched replay titles before another provider mutation", async () => {
    const sessionId = "14141414-1414-4414-8414-141414141414";
    const fixtureState = await openDriver([session(sessionId, "Strict title")]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      await expect(
        handle.perform({
          applicationOperationId: "invalid-title",
          action: "rename",
          title: "bad\ntitle",
        }),
      ).rejects.toMatchObject({ backendCode: "grok_rename_title_invalid" });
      await handle.perform({
        applicationOperationId: "rename-replay",
        action: "rename",
        title: "First title",
      });
      await handle.perform({
        applicationOperationId: "rename-replay",
        action: "rename",
        title: "First title",
      });
      await expect(
        handle.perform({
          applicationOperationId: "rename-replay",
          action: "rename",
          title: "Different title",
        }),
      ).rejects.toMatchObject({ backendCode: "grok_rename_replay_mismatch" });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .renameCalls,
      ).toBe(1);
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  });

  it("keeps only current rename settlement evidence across more than 128 sequential renames", async () => {
    const sessionId = "19191919-1919-4919-8919-191919191919";
    const fixtureState = await openDriver([session(sessionId, "Rename many")]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      for (let index = 0; index < 129; index += 1) {
        await handle.perform({
          applicationOperationId: `rename-many-${index}`,
          action: "rename",
          title: `Rename ${index}`,
        });
      }
      await expect(
        handle.perform({
          applicationOperationId: "rename-many-128",
          action: "rename",
          title: "Rename 128",
        }),
      ).resolves.toEqual({ accepted: true });
      await expect(
        handle.perform({
          applicationOperationId: "rename-many-128",
          action: "rename",
          title: "Conflicting rename",
        }),
      ).rejects.toMatchObject({ backendCode: "grok_rename_replay_mismatch" });
      await expect(
        handle.perform({
          applicationOperationId: "rename-satisfied-postcondition",
          action: "rename",
          title: "Rename 128",
        }),
      ).resolves.toEqual({ accepted: true });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0],
      ).toMatchObject({ title: "Rename 128", renameCalls: 129 });
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  });

  it("keeps a native rename rejection payload behind the safe backend boundary", async () => {
    const sessionId = "15151515-1515-4515-8515-151515151515";
    const fixtureState = await openDriver([
      {
        ...session(sessionId, "Rejected title"),
        renameBehavior: "remote_error",
      },
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      let failure: unknown;
      try {
        await handle.perform({
          applicationOperationId: "rename-rejected",
          action: "rename",
          title: "Rejected by provider",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        category: "rejected",
        safeMessage: "Grok rejected the requested title.",
        crossedSubmissionBoundary: false,
      });
      expect((failure as Error).message).not.toContain("rename rejected");
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  });

  it("loads correlated native history with stable IDs and unloads ephemeral reads", async () => {
    const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const fixtureState = await openDriver([
      { ...session(sessionId, "History"), history: "correlated" },
    ]);
    try {
      const discovered = await fixtureState.driver.discover({
        scope,
        workspace: fixtureState.workspace,
        signal: new AbortController().signal,
        limit: 10,
      });
      const conversation = discovered.conversations[0]!;
      const binding = conversationBinding(sessionId);
      const handle = await fixtureState.driver.attach({
        scope,
        workspace: fixtureState.workspace,
        binding,
        opaqueBindingDetail: conversation.opaqueBindingDetail,
      });
      const projection = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(projection.snapshot).toMatchObject({
        runState: "idle",
        orderedBackendTurnIds: [expect.stringMatching(/^grok-turn:/u)],
      });
      expect(Object.values(projection.snapshot.itemsById)).toMatchObject([
        { semanticKind: "user_message" },
        { semanticKind: "reasoning" },
        { semanticKind: "assistant_message" },
      ]);
      const firstIds = {
        turns: projection.snapshot.orderedBackendTurnIds,
        items: Object.keys(projection.snapshot.itemsById),
      };
      handle.subscribe(() => {
        throw new Error("legacy observer failure");
      });
      const sequenced = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      sequenced.subscribeFromNext(() => {
        throw new Error("sequenced observer failure");
      });
      (
        handle as unknown as { providerHistoryChanged(): void }
      ).providerHistoryChanged();
      expect(
        (await handle.history({ limit: 10 })).orderedBackendTurnIds,
      ).toEqual(firstIds.turns);

      const residentRead = await fixtureState.driver.read({
        scope,
        workspace: fixtureState.workspace,
        binding,
        opaqueBindingDetail: conversation.opaqueBindingDetail,
      });
      expect(residentRead.snapshot.orderedBackendTurnIds).toEqual(
        firstIds.turns,
      );
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0],
      ).toMatchObject({ closeCount: 0 });
      await handle.close();

      const read = await fixtureState.driver.read({
        scope,
        workspace: fixtureState.workspace,
        binding,
        opaqueBindingDetail: conversation.opaqueBindingDetail,
      });
      expect(read.snapshot.orderedBackendTurnIds).toEqual(firstIds.turns);
      expect(Object.keys(read.snapshot.itemsById)).toEqual(firstIds.items);
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0],
      ).toMatchObject({
        closeCount: 2,
      });
    } finally {
      await fixtureState.close();
    }
  });

  it("honors latest history limits and binds each cursor to the actual first returned turn", async () => {
    const sessionId = "edededed-eded-4ded-8ded-edededededed";
    const submissions = Array.from({ length: 13 }, (_, index) =>
      index === 6
        ? { promptId: "native-prompt-ignored", ignored: true }
        : {
            promptId: `native-prompt-${index}`,
            text: `question-${index}`,
            answer: `answer-${index}`,
            completed: true,
            stopReason: "end_turn",
          },
    );
    const fixtureState = await openDriver([
      { ...session(sessionId, "Paged history"), submissions },
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      await handle.establishProjection({
        signal: new AbortController().signal,
      });
      const one = await handle.history({ limit: 1 });
      const five = await handle.history({ limit: 5 });
      const ten = await handle.history({ limit: 10 });
      expect(one.orderedBackendTurnIds).toHaveLength(1);
      expect(five.orderedBackendTurnIds).toHaveLength(5);
      expect(ten.orderedBackendTurnIds).toHaveLength(10);
      expect(one.previousCursor).toBeDefined();
      expect(five.previousCursor).toBeDefined();
      expect(ten.previousCursor).toBeDefined();
      expect(
        new Set([one.previousCursor, five.previousCursor, ten.previousCursor])
          .size,
      ).toBe(3);
      const older = await handle.history({
        cursor: ten.previousCursor,
        limit: 2,
      });
      expect(older.orderedBackendTurnIds).toHaveLength(2);
      expect(older.previousCursor).toBeUndefined();

      const state = await readState(fixtureState.workspace.canonicalPath);
      state.sessions[0].submissions.push({
        promptId: "native-prompt-12",
        text: "question-12",
        answer: "answer-12",
        completed: true,
        stopReason: "end_turn",
      });
      await writeState(fixtureState.workspace.canonicalPath, state);
      await expect(
        handle.history({ cursor: ten.previousCursor, limit: 2 }),
      ).resolves.toMatchObject({
        orderedBackendTurnIds: older.orderedBackendTurnIds,
      });
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  });

  it("locates exactly one retained turn and reports an older retained boundary", async () => {
    const sessionId = "abababab-abab-4bab-8bab-abababababab";
    const submissions = Array.from({ length: 13 }, (_, index) => ({
      promptId: `located-prompt-${index}`,
      text: `located-question-${index}`,
      answer: `located-answer-${index}`,
      completed: true,
      stopReason: "end_turn",
    }));
    const fixtureState = await openDriver([
      { ...session(sessionId, "Located history"), submissions },
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      const retained = await handle.history({ limit: 10 });
      const targetBackendTurnId = retained.orderedBackendTurnIds.at(-2)!;
      const visited: string[] = [];
      const located = await handle.locateTurn({
        matchesBackendTurnId: (candidate) => {
          visited.push(candidate);
          return candidate === targetBackendTurnId;
        },
        maximumTurnCandidates: 3,
      });
      expect(visited).toEqual([
        retained.orderedBackendTurnIds.at(-1),
        targetBackendTurnId,
      ]);
      expect(located).toMatchObject({
        status: "found",
        page: {
          orderedBackendTurnIds: [targetBackendTurnId],
          turnsById: {
            [targetBackendTurnId]: { backendTurnId: targetBackendTurnId },
          },
        },
      });
      if (located.status !== "found") throw new Error("expected located turn");
      expect(located.page).not.toHaveProperty("previousCursor");
      expect(Object.keys(located.page.itemsById)).toEqual(
        located.page.turnsById[targetBackendTurnId]!.orderedBackendItemIds,
      );

      await expect(
        handle.locateTurn({
          matchesBackendTurnId: () => false,
          maximumTurnCandidates: 100,
        }),
      ).resolves.toEqual({ status: "search_limit_reached" });
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  });

  it("returns authoritative not-found only when retained history reaches its beginning", async () => {
    const sessionId = "acacacac-acac-4cac-8cac-acacacacacac";
    const fixtureState = await openDriver([
      {
        ...session(sessionId, "Exhaustive retained history"),
        submissions: [
          {
            promptId: "only-prompt",
            text: "only question",
            answer: "only answer",
            completed: true,
            stopReason: "end_turn",
          },
        ],
      },
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      await expect(
        handle.locateTurn({
          matchesBackendTurnId: () => false,
          maximumTurnCandidates: 10,
        }),
      ).resolves.toEqual({ status: "not_found" });

      const cancellation = new AbortController();
      cancellation.abort(new Error("cancel retained lookup"));
      await expect(
        handle.locateTurn({
          matchesBackendTurnId: () => false,
          maximumTurnCandidates: 10,
          signal: cancellation.signal,
        }),
      ).rejects.toThrow("cancel retained lookup");
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  });

  it("projects same-turn post-response history as incremental events", async () => {
    const sessionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const fixtureState = await openDriver([
      { ...session(sessionId, "Post response"), history: "post_response" },
    ]);
    try {
      const detail = fixtureState.bindingDetail(sessionId);
      const handle = await fixtureState.driver.attach({
        scope,
        workspace: fixtureState.workspace,
        binding: conversationBinding(sessionId),
        opaqueBindingDetail: detail,
      });
      const baseline = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      if (baseline.snapshot.orderedBackendTurnIds.length === 0) {
        const historyChanged = new Promise<void>((resolve) => {
          baseline.subscribeFromNext((event) => {
            if (event.event.type === "item_started") resolve();
          });
        });
        await historyChanged;
      }
      const updated = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(updated.snapshot).toMatchObject({
        runState: "running",
        orderedBackendTurnIds: [expect.stringMatching(/^grok-turn:/u)],
      });
      expect(Object.values(updated.snapshot.itemsById)).toMatchObject([
        {
          semanticKind: "assistant_message",
          markdown: { text: "after response" },
        },
      ]);
      await handle.close();
    } finally {
      await fixtureState.close();
    }
  });

  it("classifies malformed discovery and native load rejection deterministically", async () => {
    const methodMissingId = "33333333-3333-4333-8333-333333333333";
    const invalidTimestamp = await openDriver([
      {
        ...session("11111111-1111-4111-8111-111111111111", "Invalid date"),
        updatedAt: "2026-08-16T12:00:00Z",
      },
      {
        ...session(methodMissingId, "Missing method"),
        history: "method_missing",
      },
    ]);
    try {
      await expect(
        invalidTimestamp.driver.discover({
          scope,
          workspace: invalidTimestamp.workspace,
          signal: new AbortController().signal,
          limit: 10,
        }),
      ).rejects.toMatchObject({
        category: "incompatible_protocol",
        backendCode: "grok_discovery_timestamp_invalid",
        retryable: false,
      });

      const missingId = "22222222-2222-4222-8222-222222222222";
      await expect(
        invalidTimestamp.driver.attach({
          scope,
          workspace: invalidTimestamp.workspace,
          binding: conversationBinding(missingId),
          opaqueBindingDetail: invalidTimestamp.bindingDetail(missingId),
        }),
      ).rejects.toMatchObject({
        category: "rejected",
        backendCode: "grok_remote_-32602",
        retryable: false,
      });

      await expect(
        invalidTimestamp.driver.attach({
          scope,
          workspace: invalidTimestamp.workspace,
          binding: conversationBinding(methodMissingId),
          opaqueBindingDetail: invalidTimestamp.bindingDetail(methodMissingId),
        }),
      ).rejects.toMatchObject({
        category: "incompatible_protocol",
        backendCode: "grok_remote_method_not_found",
        retryable: false,
      });
    } finally {
      await invalidTimestamp.close();
    }
  });

  it("classifies runtime admission failures as non-retryable incompatibility", async () => {
    for (const [version, build, backendCode] of [
      ["1.0.3", "abcdef1", "grok_runtime_version_incompatible"],
      ["1.1.0", "abc", "grok_runtime_build_invalid"],
    ] as const) {
      const runtimeRoot = await mkdtemp(
        path.join(os.tmpdir(), "grok-driver-runtime-"),
      );
      roots.push(runtimeRoot);
      const executablePath = path.join(runtimeRoot, "grok");
      await writeVersionOnlyExecutable(executablePath, version, build);
      const fixtureState = await openDriver([], { executablePath });
      try {
        await expect(
          fixtureState.driver.catalog({
            scope,
            workspace: fixtureState.workspace,
          }),
        ).rejects.toMatchObject({
          category: "incompatible_protocol",
          backendCode,
          retryable: false,
        });
        await expect(
          fixtureState.driver.create({
            scope,
            workspace: fixtureState.workspace,
            applicationThreadId: `thread-${version}`,
            applicationOperationId: `operation-${version}`,
            creationCorrelation: `correlation-${version}`,
            source: { kind: "user" },
          }),
        ).rejects.toMatchObject({
          category: "incompatible_protocol",
          backendCode,
          retryable: false,
        });
      } finally {
        await fixtureState.close();
      }
    }
  });

  it.each(["incompatible", "malformed", "missing"] as const)(
    "clears a newer-runtime advisory after a later %s executable probe failure",
    async (failure) => {
      const runtimeRoot = await mkdtemp(
        path.join(os.tmpdir(), "grok-driver-advisory-"),
      );
      roots.push(runtimeRoot);
      const executablePath = path.join(runtimeRoot, "grok.mjs");
      await writeConversationPeerExecutable(executablePath, "1.2.0", "abcdef1");
      const runtimeAdvisories = new GrokRuntimeAdvisorySource();
      const fixtureState = await openDriver([], {
        executablePath,
        runtimeAdvisories,
      });
      try {
        await expect(fixtureState.driver.health()).resolves.toMatchObject({
          available: true,
        });
        expect(runtimeAdvisories.active()).toHaveLength(1);

        if (failure === "incompatible") {
          await writeVersionOnlyExecutable(executablePath, "1.0.3", "abcdef1");
        } else if (failure === "malformed") {
          await writeFile(
            executablePath,
            "#!/usr/bin/env node\nprocess.stdout.write('not-json\\n');\n",
          );
          await chmod(executablePath, 0o755);
        } else {
          await rm(executablePath);
        }

        await expect(fixtureState.driver.health()).resolves.toMatchObject({
          available: false,
        });
        expect(runtimeAdvisories.active()).toEqual([]);
      } finally {
        await fixtureState.close();
        runtimeAdvisories.close();
      }
    },
  );

  it("preserves unknown create outcome after provider contact", async () => {
    const fixtureState = await openDriver([]);
    try {
      const state = await readState(fixtureState.workspace.canonicalPath);
      state.createResponseInvalid = true;
      await writeState(fixtureState.workspace.canonicalPath, state);
      await expect(
        fixtureState.driver.create({
          scope,
          workspace: fixtureState.workspace,
          applicationThreadId: "thread-unknown",
          applicationOperationId: "operation-unknown",
          creationCorrelation: "correlation-unknown",
          source: { kind: "user" },
        }),
      ).rejects.toMatchObject({
        category: "submission_unknown",
        crossedSubmissionBoundary: true,
        retryable: false,
      });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions,
      ).toHaveLength(1);
    } finally {
      await fixtureState.close();
    }
  });

  it("admits a final promptless user turn but rejects wrong authority before process acquisition", async () => {
    const sessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const fixtureState = await openDriver([
      { ...session(sessionId, "Uncorrelated"), history: "uncorrelated" },
    ]);
    try {
      const detail = fixtureState.bindingDetail(sessionId);
      const before = (await readState(fixtureState.workspace.canonicalPath))
        .processStarts;
      await expect(
        fixtureState.driver.attach({
          scope: { ...scope, principalId: "other-principal" },
          workspace: fixtureState.workspace,
          binding: conversationBinding(sessionId),
          opaqueBindingDetail: detail,
        }),
      ).rejects.toMatchObject({ backendCode: "grok_scope_mismatch" });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).processStarts,
      ).toBe(before);

      const handle = await fixtureState.driver.attach({
        scope,
        workspace: fixtureState.workspace,
        binding: conversationBinding(sessionId),
        opaqueBindingDetail: detail,
      });
      const projection = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(projection.snapshot).toMatchObject({ runState: "running" });
      expect(Object.values(projection.snapshot.itemsById)).toMatchObject([
        {
          semanticKind: "user_message",
          content: [{ kind: "text", text: { text: "uncorrelated" } }],
        },
      ]);
      await handle.close();
    } finally {
      await fixtureState.close();
    }
  });

  it("recovers an authenticated Sedes prompt abandoned by restart as interrupted", async () => {
    const sessionId = "e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1";
    const fixtureState = await openDriver([
      session(sessionId, "Interrupted by restart"),
    ]);
    const original = submitInput();
    const promptId = fixtureState.submissionPromptId(
      sessionId,
      original.applicationOperationId,
      original.reconciliationToken,
    );
    const binding = conversationBinding(sessionId);
    const detail = fixtureState.bindingDetail(sessionId);
    let handle:
      Awaited<ReturnType<typeof fixtureState.driver.attach>> | undefined;
    try {
      const state = await readState(fixtureState.workspace.canonicalPath);
      state.sessions[0].submissions = [
        { promptId, text: original.text, completed: false },
      ];
      await writeState(fixtureState.workspace.canonicalPath, state);

      handle = await fixtureState.driver.attach({
        scope,
        workspace: fixtureState.workspace,
        binding,
        opaqueBindingDetail: detail,
      });
      const recovered = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      const recoveredTurnId = recovered.snapshot.orderedBackendTurnIds.at(-1)!;
      expect(recovered.snapshot).toMatchObject({ runState: "idle" });
      expect(recovered.snapshot.turnsById[recoveredTurnId]).toMatchObject({
        status: "interrupted",
        endedBy: "interrupted",
        completionCorrelations: [original.applicationOperationId],
      });
      const originalTurnIds = [...recovered.snapshot.orderedBackendTurnIds];
      const originalItemIds = Object.keys(recovered.snapshot.itemsById);

      await handle.close();
      handle = await fixtureState.driver.attach({
        scope,
        workspace: fixtureState.workspace,
        binding,
        opaqueBindingDetail: detail,
      });
      const repeated = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(repeated.snapshot.runState).toBe("idle");
      expect(repeated.snapshot.orderedBackendTurnIds).toEqual(originalTurnIds);
      expect(Object.keys(repeated.snapshot.itemsById)).toEqual(originalItemIds);
      expect(repeated.snapshot.turnsById[recoveredTurnId]).toMatchObject({
        status: "interrupted",
        endedBy: "interrupted",
      });

      const next = {
        ...submitInput(),
        applicationOperationId: "submit-after-restart",
        mutationId: "submit-after-restart-mutation",
        reconciliationToken: "submit-after-restart-token",
        text: "continue after restart",
      };
      await expect(handle.submit(next)).resolves.toMatchObject({
        accepted: true,
        completionCorrelation: next.applicationOperationId,
      });
      await waitFor(async () => {
        const latest = (
          await readState(fixtureState.workspace.canonicalPath)
        ).sessions[0]?.submissions.at(-1);
        return latest?.text === next.text && latest.completed === true;
      });
      await expect(
        handle.establishProjection({
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ snapshot: { runState: "idle" } });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .submissions,
      ).toMatchObject([
        { promptId, completed: false },
        { text: next.text, completed: true, stopReason: "end_turn" },
      ]);
    } finally {
      await handle?.close().catch(() => undefined);
      await fixtureState.close();
    }
  });

  it("leaves an imported non-Sedes incomplete prompt active", async () => {
    const sessionId = "e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2";
    const fixtureState = await openDriver([
      {
        ...session(sessionId, "Imported active prompt"),
        submissions: [
          {
            promptId: "provider-native-active-prompt",
            text: "still running elsewhere",
            completed: false,
          },
        ],
      },
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      await expect(
        handle.establishProjection({ signal: new AbortController().signal }),
      ).resolves.toMatchObject({ snapshot: { runState: "running" } });
      await expect(handle.submit(submitInput())).rejects.toMatchObject({
        backendCode: "grok_turn_already_active",
      });
    } finally {
      await handle.close().catch(() => undefined);
      await fixtureState.close();
    }
  });

  it("accepts correlated text before completion, streams incrementally, and replays durably", async () => {
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const fixtureState = await openDriver([
      { ...session(sessionId, "Submit"), promptDelayMs: 150 },
    ]);
    const binding = conversationBinding(sessionId);
    const detail = fixtureState.bindingDetail(sessionId);
    let handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding,
      opaqueBindingDetail: detail,
    });
    try {
      const anchor = await handle.captureSubmissionRetryAnchor();
      expect(Buffer.byteLength(anchor)).toBeLessThanOrEqual(4_096);
      expect(anchor).not.toContain(sessionId);
      const baseline = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      const events: string[] = [];
      baseline.subscribeFromNext((event) => events.push(event.event.type));

      const input = submitInput();
      const accepted = await handle.submit(input);
      expect(accepted).toMatchObject({
        accepted: true,
        reconciliationToken: input.reconciliationToken,
        completionCorrelation: input.applicationOperationId,
        backendTurnId: expect.stringMatching(/^grok-turn:/u),
      });
      const acceptedState = await readState(
        fixtureState.workspace.canonicalPath,
      );
      expect(acceptedState.sessions[0]).toMatchObject({
        promptCalls: 1,
        submissions: [{ text: input.text, completed: false }],
      });
      const active = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      const activeTurn = active.snapshot.turnsById[accepted.backendTurnId!]!;
      expect(active.snapshot.runState).toBe("running");
      expect(activeTurn.completionCorrelations).toEqual([
        input.applicationOperationId,
      ]);
      expect(
        activeTurn.orderedBackendItemIds.some((itemId) => {
          const item = active.snapshot.itemsById[itemId];
          return (
            item?.semanticKind === "user_message" &&
            item.deliveryOperationId === input.applicationOperationId
          );
        }),
      ).toBe(true);

      await waitFor(async () => {
        const state = await readState(fixtureState.workspace.canonicalPath);
        return state.sessions[0]?.submissions?.[0]?.completed === true;
      });
      await waitFor(async () => {
        const projection = await handle.establishProjection({
          signal: new AbortController().signal,
        });
        return projection.snapshot.runState === "idle";
      }, 10_000);
      expect(events).toContain("turn_started");
      expect(events).toContain("item_started");
      expect(events).toContain("item_completed");
      expect(events).toContain("turn_completed");
      expect(events).not.toContain("resnapshot_required");
      await expect(handle.submit(input)).resolves.toEqual(accepted);
      await expect(
        handle.submit({ ...input, text: "different" }),
      ).rejects.toMatchObject({
        backendCode: "grok_submission_replay_mismatch",
      });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .promptCalls,
      ).toBe(1);

      await handle.close();
      handle = await fixtureState.driver.attach({
        scope,
        workspace: fixtureState.workspace,
        binding,
        opaqueBindingDetail: detail,
      });
      await expect(handle.submit(input)).resolves.toEqual(accepted);
      await expect(
        handle.submit({ ...input, text: "different after restart" }),
      ).rejects.toMatchObject({
        backendCode: "grok_submission_replay_mismatch",
      });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .promptCalls,
      ).toBe(1);
    } finally {
      await handle.close().catch(() => undefined);
      await fixtureState.close();
    }
  });

  it("releases settled submission evidence and reports an overflowed projection gap after more than 128 submissions", async () => {
    const sessionId = "44444444-5555-4555-8555-444444444444";
    const fixtureState = await openDriver([
      { ...session(sessionId, "Submit many"), promptDelayMs: 0 },
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      const baseline = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      for (let index = 0; index < 129; index += 1) {
        await handle.submit({
          ...submitInput(),
          applicationOperationId: `submit-many-${index}`,
          mutationId: `submit-many-mutation-${index}`,
          reconciliationToken: `submit-many-token-${index}`,
          text: `submission ${index}`,
        });
        await waitFor(async () => {
          const projection = await handle.establishProjection({
            signal: new AbortController().signal,
          });
          return projection.snapshot.runState === "idle";
        });
      }

      const gapEvents: Parameters<
        Parameters<typeof baseline.subscribeFromNext>[0]
      >[0][] = [];
      baseline.subscribeFromNext((event) => gapEvents.push(event));
      expect(gapEvents).toEqual([
        {
          handleSequence: expect.any(Number),
          event: {
            type: "resnapshot_required",
            reason: "buffer_overflow",
          },
        },
      ]);
      expect(gapEvents[0]!.handleSequence).toBeGreaterThan(
        baseline.handleSequence,
      );
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .submissions,
      ).toHaveLength(129);
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  }, 30_000);

  it("sends optional text followed by multiple canonical images in exact order", async () => {
    const sessionId = "45454545-4545-4545-8545-454545454545";
    const fixtureState = await openDriver([session(sessionId, "Images")]);
    let handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    const delivery = imageDelivery([
      {
        id: "11111111-1111-4111-8111-111111111111",
        fileName: "first.png",
        mediaType: "image/png",
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]),
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        fileName: "second.jpg",
        mediaType: "image/jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0x02]),
      },
    ]);
    const input = {
      ...submitInput(),
      text: "inspect in order",
      ...delivery.input,
    };
    try {
      const retryAnchor = await handle.captureSubmissionRetryAnchor();
      await expect(handle.submit(input)).resolves.toMatchObject({
        accepted: true,
        completionCorrelation: input.applicationOperationId,
      });
      const state = await readState(fixtureState.workspace.canonicalPath);
      expect(state.sessions[0].submissions[0]).toMatchObject({
        promptId: fixtureState.submissionPromptId(
          sessionId,
          input.applicationOperationId,
          input.reconciliationToken,
        ),
        prompt: [
          {
            type: "text",
            text: "inspect in order",
          },
          {
            type: "image",
            mimeType: "image/png",
            data: delivery.entries[0]!.bytes.toString("base64"),
          },
          {
            type: "image",
            mimeType: "image/jpeg",
            data: delivery.entries[1]!.bytes.toString("base64"),
          },
        ],
      });
      expect(delivery.readOrder).toEqual([
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ]);
      await waitFor(async () => {
        const projection = await handle.establishProjection({
          signal: new AbortController().signal,
        });
        return projection.snapshot.runState === "idle";
      });
      await handle.close();
      await expect(
        fixtureState.driver.reconcileSubmission(
          reconcileInput(fixtureState, sessionId, retryAnchor),
        ),
      ).resolves.toMatchObject({ status: "accepted" });
      await expect(
        fixtureState.driver.reconcileSubmission(
          reconcileInput(fixtureState, sessionId, retryAnchor),
        ),
      ).resolves.toMatchObject({ status: "accepted" });
      handle = await fixtureState.driver.attach({
        scope,
        workspace: fixtureState.workspace,
        binding: conversationBinding(sessionId),
        opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
      });
      await expect(handle.submit(input)).resolves.toMatchObject({
        accepted: true,
      });
      expect(delivery.readOrder).toHaveLength(2);
    } finally {
      await handle.close().catch(() => undefined);
      await fixtureState.close();
    }
  });

  it("sends mixed files and images in descriptor order without reading file bytes", async () => {
    const sessionId = "45454545-4545-4545-8545-555555555555";
    const fixtureState = await openDriver([session(sessionId, "Mixed files")]);
    let handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    const imageBytes = Buffer.from("canonical-mixed-image");
    const fileBytes = Buffer.from("path-native-file");
    const filePath = "/remote/ssh/staging/notes.bin";
    const file = {
      id: "21212121-2121-4121-8121-212121212121",
      kind: "file" as const,
      fileName: "notes.bin",
      mediaType: "application/octet-stream" as const,
      byteSize: fileBytes.byteLength,
      sha256: createHash("sha256").update(fileBytes).digest("hex"),
      agentPath: filePath,
    };
    const image = {
      id: "31313131-3131-4131-8131-313131313131",
      kind: "image" as const,
      fileName: "diagram.png",
      mediaType: "image/png" as const,
      byteSize: imageBytes.byteLength,
      sha256: createHash("sha256").update(imageBytes).digest("hex"),
      agentPath: "/remote/ssh/staging/diagram.png",
    };
    const readOrder: string[] = [];
    const input = {
      ...submitInput(),
      applicationOperationId: "mixed-attachment-operation",
      mutationId: "mixed-attachment-mutation",
      reconciliationToken: "mixed-attachment-token",
      text: "inspect both",
      attachments: [file, image],
      attachmentEvidence: {
        resolve: () => [
          (({ agentPath: _agentPath, ...evidence }) => evidence)(file),
          (({ agentPath: _agentPath, ...evidence }) => evidence)(image),
        ],
      },
      attachmentBytes: {
        read: async (attachment: typeof file | typeof image) => {
          readOrder.push(attachment.id);
          if (attachment.kind === "file") {
            throw new Error("file bytes must remain path-native");
          }
          return Buffer.from(imageBytes);
        },
      },
    };
    try {
      const accepted = await handle.submit(input);
      expect(accepted).toMatchObject({ accepted: true });
      expect(readOrder).toEqual([image.id]);
      const state = await readState(fixtureState.workspace.canonicalPath);
      expect(state.sessions[0].submissions[0].prompt).toEqual([
        {
          type: "text",
          text: "inspect both",
        },
        {
          type: "resource_link",
          name: "notes.bin",
          uri: `file://${filePath}`,
          mimeType: "application/octet-stream",
          size: fileBytes.byteLength,
        },
        {
          type: "image",
          mimeType: "image/png",
          data: imageBytes.toString("base64"),
        },
      ]);
      await waitFor(async () => {
        const projection = await handle.establishProjection({
          signal: new AbortController().signal,
        });
        return projection.snapshot.runState === "idle";
      });
      await handle.close();
      handle = await fixtureState.driver.attach({
        scope,
        workspace: fixtureState.workspace,
        binding: conversationBinding(sessionId),
        opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
      });
      const replay = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(JSON.stringify(replay.snapshot)).not.toContain(filePath);
      expect(JSON.stringify(replay.snapshot)).not.toContain(
        imageBytes.toString("base64"),
      );
      await expect(handle.submit(input)).resolves.toEqual(accepted);
      expect(readOrder).toEqual([image.id]);
    } finally {
      await handle.close().catch(() => undefined);
      await fixtureState.close();
    }
  });

  it("classifies invalid file resource content as a pre-boundary rejection", async () => {
    const sessionId = "45454545-4545-4545-8545-565656565656";
    const fixtureState = await openDriver([
      session(sessionId, "Invalid file resource"),
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    const file = {
      id: "41414141-4141-4141-8141-414141414141",
      kind: "file" as const,
      fileName: "notes.bin",
      mediaType: "application/octet-stream" as const,
      byteSize: 0,
      sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      agentPath: "/remote/invalid\tpath/notes.bin",
    };
    try {
      await expect(
        handle.submit({
          ...submitInput(),
          applicationOperationId: "invalid-file-resource-operation",
          mutationId: "invalid-file-resource-mutation",
          reconciliationToken: "invalid-file-resource-token",
          attachments: [file],
          attachmentEvidence: {
            resolve: () => [
              (({ agentPath: _agentPath, ...evidence }) => evidence)(file),
            ],
          },
        }),
      ).rejects.toMatchObject({
        backendCode: "grok_prompt_content_invalid",
        category: "rejected",
        retryable: false,
        crossedSubmissionBoundary: false,
      });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .promptCalls ?? 0,
      ).toBe(0);
    } finally {
      await handle.close().catch(() => undefined);
      await fixtureState.close();
    }
  });

  it("accepts image-only input while omitting image echo bytes from normalized history", async () => {
    const sessionId = "46464646-4646-4646-8646-464646464646";
    const fixtureState = await openDriver([session(sessionId, "Image only")]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    const delivery = imageDelivery([
      {
        id: "33333333-3333-4333-8333-333333333333",
        fileName: "only.webp",
        mediaType: "image/webp",
        bytes: Buffer.from("raw-image-only-sentinel"),
      },
    ]);
    const base64 = delivery.entries[0]!.bytes.toString("base64");
    const input = { ...submitInput(), text: " \n\t ", ...delivery.input };
    try {
      const accepted = await handle.submit(input);
      expect(accepted).toMatchObject({ accepted: true });
      await waitFor(async () => {
        const projection = await handle.establishProjection({
          signal: new AbortController().signal,
        });
        return projection.snapshot.runState === "idle";
      });
      const projection = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(
        projection.snapshot.turnsById[accepted.backendTurnId!],
      ).toBeDefined();
      expect(JSON.stringify(projection.snapshot)).not.toContain(base64);
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .submissions[0].prompt,
      ).toEqual([{ type: "image", mimeType: "image/webp", data: base64 }]);
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  });

  it("keeps explicit selected-model image false authoritative", async () => {
    const sessionId = "47474747-4747-4747-8747-474747474747";
    const fixtureState = await openDriver([session(sessionId, "Text only")], {
      modelImageInput: false,
    });
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      await expect(
        fixtureState.driver.catalog({
          scope,
          workspace: fixtureState.workspace,
        }),
      ).resolves.toMatchObject({
        models: [{ inputModalities: ["text"] }],
      });
      await expect(handle.backendCapabilities()).resolves.toMatchObject({
        composerAttachments: { fileStaging: true, nativeImage: false },
        nonblockingQuestions: false,
        providerOutputArtifacts: { nativeImage: true },
      });
      const fileBytes = Buffer.from("file-only-content");
      const file = {
        id: "41414141-4141-4141-8141-414141414141",
        kind: "file" as const,
        fileName: "file-only.bin",
        mediaType: "application/octet-stream" as const,
        byteSize: fileBytes.byteLength,
        sha256: createHash("sha256").update(fileBytes).digest("hex"),
        agentPath: "/remote/model-false/file-only.bin",
      };
      let fileByteReads = 0;
      await expect(
        handle.submit({
          ...submitInput(),
          applicationOperationId: "file-only-operation",
          mutationId: "file-only-mutation",
          reconciliationToken: "file-only-token",
          text: "",
          attachments: [file],
          attachmentEvidence: {
            resolve: () => {
              const { agentPath: _agentPath, ...evidence } = file;
              return [evidence];
            },
          },
          attachmentBytes: {
            read: async () => {
              fileByteReads += 1;
              throw new Error("ordinary files must not use canonical bytes");
            },
          },
        }),
      ).resolves.toMatchObject({ accepted: true });
      expect(fileByteReads).toBe(0);
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .submissions[0].prompt,
      ).toEqual([
        {
          type: "resource_link",
          name: file.fileName,
          uri: `file://${file.agentPath}`,
          mimeType: file.mediaType,
          size: file.byteSize,
        },
      ]);
      const delivery = imageDelivery([
        {
          id: "44444444-4444-4444-8444-444444444444",
          fileName: "denied.png",
          mediaType: "image/png",
          bytes: Buffer.from("denied"),
        },
      ]);
      await expect(
        handle.submit({ ...submitInput(), ...delivery.input }),
      ).rejects.toMatchObject({
        backendCode: "grok_model_image_input_unsupported",
        crossedSubmissionBoundary: false,
      });
      expect(delivery.readOrder).toEqual([]);
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  });

  it("interrupts only the exact active Grok turn and never re-sends against an adjacent turn", async () => {
    const sessionId = "45454545-1111-4111-8111-454545454545";
    const fixtureState = await openDriver([
      {
        ...session(sessionId, "Interrupt"),
        promptDelayMs: 250,
        promptResponseDelayMs: 100,
        emitRelativeToolLocation: true,
      },
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      const baseline = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      const events: string[] = [];
      const runStates: string[] = [];
      baseline.subscribeFromNext((event) => {
        events.push(event.event.type);
        if (event.event.type === "run_state_changed") {
          runStates.push(event.event.state);
        }
      });

      const accepted = await handle.submit(submitInput());
      const interrupt = {
        applicationOperationId: "interrupt-operation",
        expectedBackendTurnId: accepted.backendTurnId!,
      };
      await expect(handle.interrupt(interrupt)).resolves.toBeUndefined();
      await expect(handle.reconcileInterrupt(interrupt)).resolves.toEqual({
        outcome: "accepted",
      });
      await expect(handle.interrupt(interrupt)).resolves.toBeUndefined();
      await expect(
        handle.interrupt({
          ...interrupt,
          expectedBackendTurnId: "grok-turn:other",
        }),
      ).rejects.toMatchObject({
        backendCode: "grok_interrupt_replay_mismatch",
        crossedSubmissionBoundary: false,
      });
      await waitFor(async () => {
        const projection = await handle.establishProjection({
          signal: new AbortController().signal,
        });
        return projection.snapshot.runState === "idle";
      });
      const interruptedProjection = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      expect(
        interruptedProjection.snapshot.turnsById[accepted.backendTurnId!],
      ).toMatchObject({
        status: "interrupted",
        endedBy: "interrupted",
      });
      const relativeLocationTool = Object.values(
        interruptedProjection.snapshot.itemsById,
      ).find((item) => item.semanticKind === "tool");
      expect(relativeLocationTool).toMatchObject({
        semanticKind: "tool",
        status: "streaming",
        phase: "preflight_or_executing",
        title: { text: "Inspect repository file" },
        category: "filesystem",
      });
      expect(JSON.stringify(relativeLocationTool)).toContain("src/example.ts");
      expect(events).toContain("run_state_changed");
      expect(events).toContain("turn_completed");
      expect(runStates).toContain("stopping");
      await expect(
        handle.interrupt({
          applicationOperationId: "stale-interrupt-operation",
          expectedBackendTurnId: accepted.backendTurnId!,
        }),
      ).rejects.toMatchObject({
        backendCode: "grok_interrupt_target_changed",
        crossedSubmissionBoundary: false,
      });

      const adjacentInput = {
        ...submitInput(),
        applicationOperationId: "adjacent-submit-operation",
        mutationId: "adjacent-submit-mutation",
        reconciliationToken: "adjacent-submit-token",
        text: "continue normally",
      };
      await expect(handle.submit(adjacentInput)).resolves.toMatchObject({
        accepted: true,
      });
      await expect(handle.interrupt(interrupt)).rejects.toMatchObject({
        backendCode: "grok_interrupt_target_changed",
        crossedSubmissionBoundary: false,
      });
      await waitFor(async () => {
        const projection = await handle.establishProjection({
          signal: new AbortController().signal,
        });
        return projection.snapshot.runState === "idle";
      });
      // The peer publishes turn completion before persisting its test ledger.
      // Observe that independent write before asserting the adjacent turn's result.
      await waitFor(async () => {
        const persisted = await readState(fixtureState.workspace.canonicalPath);
        return persisted.sessions[0]?.submissions?.[1]?.completed === true;
      });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0],
      ).toMatchObject({
        cancelCalls: 1,
        submissions: [
          { completed: true, stopReason: "cancelled", answer: null },
          { completed: true, stopReason: "end_turn", answer: "done" },
        ],
      });
    } finally {
      await handle.close().catch(() => undefined);
      await fixtureState.close();
    }
  });

  it("prunes current interrupt evidence across more than 128 sequential turns", async () => {
    const sessionId = "45454545-3333-4333-8333-454545454545";
    const fixtureState = await openDriver([
      {
        ...session(sessionId, "Interrupt many"),
        promptDelayMs: 5_000,
      },
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    let firstInterrupt:
      | {
          readonly applicationOperationId: string;
          readonly expectedBackendTurnId: string;
        }
      | undefined;
    try {
      for (let index = 0; index < 129; index += 1) {
        const accepted = await handle.submit({
          ...submitInput(),
          applicationOperationId: `interrupt-submit-${index}`,
          mutationId: `interrupt-submit-mutation-${index}`,
          reconciliationToken: `interrupt-submit-token-${index}`,
          text: `interrupt turn ${index}`,
        });
        const interrupt = {
          applicationOperationId: `interrupt-many-${index}`,
          expectedBackendTurnId: accepted.backendTurnId!,
        };
        firstInterrupt ??= interrupt;
        await handle.interrupt(interrupt);
        await expect(handle.reconcileInterrupt(interrupt)).resolves.toEqual({
          outcome: "accepted",
        });
        await waitFor(async () => {
          const projection = await handle.establishProjection({
            signal: new AbortController().signal,
          });
          return projection.snapshot.runState === "idle";
        });
      }
      await expect(handle.interrupt(firstInterrupt!)).rejects.toMatchObject({
        backendCode: "grok_interrupt_target_changed",
        crossedSubmissionBoundary: false,
      });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .cancelCalls,
      ).toBe(129);
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  }, 30_000);

  it("retains only the current interrupt operation during one long turn", async () => {
    const sessionId = "45454545-3434-4343-8343-454545454545";
    const fixtureState = await openDriver([
      {
        ...session(sessionId, "Interrupt one turn many times"),
        promptDelayMs: 30_000,
        ignoreCancel: true,
      },
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      const accepted = await handle.submit({
        ...submitInput(),
        applicationOperationId: "interrupt-plateau-submit",
        mutationId: "interrupt-plateau-mutation",
        reconciliationToken: "interrupt-plateau-token",
        text: "remain active while interrupts repeat",
      });
      const first = {
        applicationOperationId: "interrupt-plateau-0",
        expectedBackendTurnId: accepted.backendTurnId!,
      };
      let latest = first;
      for (let index = 0; index < 129; index += 1) {
        latest = {
          applicationOperationId: `interrupt-plateau-${index}`,
          expectedBackendTurnId: accepted.backendTurnId!,
        };
        await expect(handle.interrupt(latest)).resolves.toBeUndefined();
      }

      await expect(handle.interrupt(latest)).resolves.toBeUndefined();
      await expect(
        handle.interrupt({
          ...latest,
          expectedBackendTurnId: "grok-turn:mismatch",
        }),
      ).rejects.toMatchObject({
        backendCode: "grok_interrupt_replay_mismatch",
      });
      await expect(
        handle.interrupt({
          ...first,
          expectedBackendTurnId: "grok-turn:mismatch",
        }),
      ).rejects.toMatchObject({
        backendCode: "grok_interrupt_target_changed",
      });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .cancelCalls,
      ).toBe(1);
    } finally {
      await handle.close().catch(() => undefined);
      await fixtureState.close();
    }
  }, 30_000);

  it("fences a terminal prompt whose RPC response never settles before an adjacent submit", async () => {
    const sessionId = "45454545-1212-4121-8121-454545454545";
    const fixtureState = await openDriver(
      [
        {
          ...session(sessionId, "Missing prompt response"),
          omitPromptResponse: true,
        },
      ],
      { promptPostTerminalSettlementDeadlineMilliseconds: 500 },
    );
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      await expect(handle.submit(submitInput())).resolves.toMatchObject({
        accepted: true,
      });
      await waitFor(async () => {
        const projection = await handle.establishProjection({
          signal: new AbortController().signal,
        });
        return projection.snapshot.runState === "idle";
      });
      let adjacentSettled = false;
      const adjacent = handle
        .submit({
          ...submitInput(),
          applicationOperationId: "adjacent-after-missing-response",
          mutationId: "adjacent-after-missing-response-mutation",
          reconciliationToken: "adjacent-after-missing-response-token",
          text: "do not send this prompt",
        })
        .finally(() => {
          adjacentSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(adjacentSettled).toBe(false);
      await expect(adjacent).rejects.toMatchObject({
        backendCode: expect.stringMatching(
          /grok_(submission_completion_failed|conversation_handle_closed)/u,
        ),
      });
      await expect(handle.close()).resolves.toBeUndefined();
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .promptCalls,
      ).toBe(1);
    } finally {
      await handle.close().catch(() => undefined);
      await fixtureState.close();
    }
  });

  it("contains a post-acceptance protocol fence without leaking an owner mismatch", async () => {
    const sessionId = "45454545-2222-4222-8222-454545454545";
    const fixtureState = await openDriver([
      {
        ...session(sessionId, "Fence containment"),
        promptBehavior: "invalid_after_acceptance",
      },
    ]);
    const detail = fixtureState.bindingDetail(sessionId);
    const binding = conversationBinding(sessionId);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding,
      opaqueBindingDetail: detail,
    });
    const eventTypes: string[] = [];
    handle.subscribe((event) => eventTypes.push(event.type));
    try {
      await expect(handle.submit(submitInput())).resolves.toMatchObject({
        accepted: true,
      });
      await waitFor(async () => {
        try {
          await handle.history({ limit: 10 });
          return false;
        } catch (error) {
          return (
            typeof error === "object" &&
            error !== null &&
            "backendCode" in error &&
            error.backendCode === "grok_conversation_handle_closed"
          );
        }
      });
      expect(eventTypes).toContain("resnapshot_required");
      await expect(handle.close()).resolves.toBeUndefined();

      const recovered = await fixtureState.driver.attach({
        scope,
        workspace: fixtureState.workspace,
        binding,
        opaqueBindingDetail: detail,
      });
      const recoveredProjection = await recovered.establishProjection({
        signal: new AbortController().signal,
      });
      const recoveredTurnId =
        recoveredProjection.snapshot.orderedBackendTurnIds.at(-1)!;
      expect(recoveredProjection.snapshot).toMatchObject({ runState: "idle" });
      expect(
        recoveredProjection.snapshot.turnsById[recoveredTurnId],
      ).toMatchObject({ status: "interrupted", endedBy: "interrupted" });
      await recovered.close();
    } finally {
      await handle.close().catch(() => undefined);
      await fixtureState.close();
    }
  });

  it("coalesces a high-rate parent text burst without history-wide work per chunk", async () => {
    const sessionId = "45454545-4545-4545-8545-454545454545";
    const fixtureState = await openDriver([
      {
        ...session(sessionId, "Burst"),
        promptChunkCount: 12_000,
        promptDelayMs: 100,
      },
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      const baseline = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      const eventTypes: string[] = [];
      baseline.subscribeFromNext((event) => eventTypes.push(event.event.type));

      await handle.submit(submitInput());
      await waitFor(async () => {
        const projection = await handle.establishProjection({
          signal: new AbortController().signal,
        });
        return projection.snapshot.runState === "idle";
      }, 10_000);

      const projection = await handle.establishProjection({
        signal: new AbortController().signal,
      });
      const reasoning = Object.values(projection.snapshot.itemsById).find(
        (item) => item.semanticKind === "reasoning",
      );
      expect(reasoning).toMatchObject({
        semanticKind: "reasoning",
        markdown: { text: "x".repeat(12_000) },
      });
      expect(
        eventTypes.filter((event) => event === "item_updated").length,
      ).toBeLessThan(100);
      expect(eventTypes).not.toContain("resnapshot_required");
    } finally {
      await handle.close().catch(() => undefined);
      await fixtureState.close();
    }
  });

  it("rejects every unsupported composer field before provider submission", async () => {
    const sessionId = "55555555-5555-4555-8555-555555555555";
    const fixtureState = await openDriver([session(sessionId, "Strict")]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      const base = submitInput();
      const invalid = [
        { ...base, text: "" },
        { ...base, text: "/compact now" },
        {
          ...base,
          source: {
            kind: "automation" as const,
            automationId: "automation",
            automationRunId: "run",
          },
        },
        { ...base, selectedSkillId: "skill" },
        { ...base, contextExcerpts: [{} as never] },
        { ...base, taskContexts: [{} as never] },
        { ...base, attachments: [{} as never] },
      ];
      for (const input of invalid) {
        await expect(handle.submit(input)).rejects.toMatchObject({
          category: "rejected",
          crossedSubmissionBoundary: false,
        });
      }
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .promptCalls,
      ).toBeUndefined();
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  });

  it("fails attachment ownership, evidence, integrity, and read errors before provider delivery", async () => {
    const sessionId = "56565656-5656-4565-8565-565656565656";
    const fixtureState = await openDriver([session(sessionId, "Failures")]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    const delivery = imageDelivery([
      {
        id: "55555555-5555-4555-8555-555555555555",
        fileName: "failure.png",
        mediaType: "image/png",
        bytes: Buffer.from("canonical-image"),
      },
    ]);
    const operation = (suffix: string) => ({
      ...submitInput(),
      applicationOperationId: `attachment-${suffix}`,
      mutationId: `attachment-${suffix}`,
      reconciliationToken: `attachment-${suffix}`,
    });
    try {
      await expect(
        handle.submit({
          ...operation("missing-file-authority"),
          attachments: [
            {
              id: "66666666-6666-4666-8666-666666666666",
              kind: "file",
              fileName: "ordinary.bin",
              mediaType: "application/octet-stream",
              byteSize: 1,
              sha256: "a".repeat(64),
              agentPath: "/remote/ordinary.bin",
            },
          ],
        }),
      ).rejects.toMatchObject({
        category: "invalid_state",
        backendCode: "grok_attachment_delivery_authority_missing",
        crossedSubmissionBoundary: false,
      });
      await expect(
        handle.submit({
          ...operation("ownership"),
          ...delivery.input,
          attachmentEvidence: {
            resolve: () => {
              throw new BackendError({
                category: "permission_denied",
                retryable: false,
                crossedSubmissionBoundary: false,
                safeMessage: "Wrong owner.",
              });
            },
          },
        }),
      ).rejects.toMatchObject({
        category: "permission_denied",
        crossedSubmissionBoundary: false,
      });
      await expect(
        handle.submit({
          ...operation("read"),
          ...delivery.input,
          attachmentBytes: {
            read: async () => {
              throw new Error("canonical read failed");
            },
          },
        }),
      ).rejects.toMatchObject({
        backendCode: "grok_attachment_read_failed",
        crossedSubmissionBoundary: false,
      });
      await expect(
        handle.submit({
          ...operation("integrity"),
          ...delivery.input,
          attachmentBytes: { read: async () => Buffer.from("wrong") },
        }),
      ).rejects.toMatchObject({
        backendCode: "grok_attachment_integrity_mismatch",
        crossedSubmissionBoundary: false,
      });
      await expect(
        handle.submit({
          ...operation("digest"),
          ...delivery.input,
          attachmentEvidence: {
            resolve: () => [
              { ...delivery.evidence[0]!, sha256: "0".repeat(64) },
            ],
          },
        }),
      ).rejects.toMatchObject({
        backendCode: "grok_attachment_evidence_mismatch",
        crossedSubmissionBoundary: false,
      });
      for (const [name, malformedEvidence] of [
        [
          "malformed-mime",
          { ...delivery.evidence[0]!, mediaType: "text/plain" },
        ],
        [
          "malformed-digest",
          { ...delivery.evidence[0]!, sha256: "not-a-sha256" },
        ],
        ["malformed-size", { ...delivery.evidence[0]!, byteSize: -1 }],
      ] as const) {
        await expect(
          handle.submit({
            ...operation(name),
            ...delivery.input,
            attachmentEvidence: {
              resolve: () => [malformedEvidence] as never,
            },
          }),
        ).rejects.toMatchObject({
          category: "invalid_state",
          retryable: false,
          backendCode: "grok_attachment_evidence_mismatch",
          crossedSubmissionBoundary: false,
        });
      }
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .promptCalls,
      ).toBeUndefined();
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  });

  it("distinguishes clean prompt rejection from a sent-unknown outcome and never resends unknown", async () => {
    const remoteId = "66666666-6666-4666-8666-666666666666";
    const remote = await openDriver([
      { ...session(remoteId, "Remote"), promptBehavior: "remote_error" },
    ]);
    const remoteHandle = await remote.driver.attach({
      scope,
      workspace: remote.workspace,
      binding: conversationBinding(remoteId),
      opaqueBindingDetail: remote.bindingDetail(remoteId),
    });
    try {
      await expect(remoteHandle.submit(submitInput())).rejects.toMatchObject({
        category: "rejected",
        crossedSubmissionBoundary: false,
      });
    } finally {
      await remoteHandle.close();
      await remote.close();
    }

    const unknownId = "77777777-7777-4777-8777-777777777777";
    const unknown = await openDriver([
      { ...session(unknownId, "Unknown"), promptBehavior: "unknown" },
    ]);
    const unknownHandle = await unknown.driver.attach({
      scope,
      workspace: unknown.workspace,
      binding: conversationBinding(unknownId),
      opaqueBindingDetail: unknown.bindingDetail(unknownId),
    });
    const input = submitInput();
    try {
      await expect(unknownHandle.submit(input)).rejects.toMatchObject({
        category: "submission_unknown",
        crossedSubmissionBoundary: true,
        retryable: false,
      });
      await expect(unknownHandle.submit(input)).rejects.toMatchObject({
        category: "submission_unknown",
        crossedSubmissionBoundary: true,
      });
      expect(
        (await readState(unknown.workspace.canonicalPath)).sessions[0]
          .promptCalls,
      ).toBe(1);
    } finally {
      await expect(unknownHandle.close()).resolves.toBeUndefined();
      const recovered = await unknown.driver.attach({
        scope,
        workspace: unknown.workspace,
        binding: conversationBinding(unknownId),
        opaqueBindingDetail: unknown.bindingDetail(unknownId),
      });
      await expect(recovered.submit(input)).resolves.toMatchObject({
        accepted: true,
        completionCorrelation: input.applicationOperationId,
      });
      expect(
        (await readState(unknown.workspace.canonicalPath)).sessions[0]
          .promptCalls,
      ).toBe(1);
      await recovered.close();
      await unknown.close();
    }
  });

  it("joins and aborts an owned terminal continuation during handle close", async () => {
    const sessionId = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
    const fixtureState = await openDriver([
      { ...session(sessionId, "Close active"), promptDelayMs: 5_000 },
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      await expect(handle.submit(submitInput())).resolves.toMatchObject({
        accepted: true,
      });
      await expect(handle.close()).resolves.toBeUndefined();
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0],
      ).toMatchObject({
        promptCalls: 1,
        submissions: [{ completed: false }],
      });
    } finally {
      await fixtureState.close();
    }
  });

  it("retains submission uncertainty when the handle closes after provider acceptance", async () => {
    const sessionId = "bcbcbcbc-1111-4111-8111-bcbcbcbcbcbc";
    const fixtureState = await openDriver([
      { ...session(sessionId, "Acceptance close"), promptDelayMs: 5_000 },
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    let closePromise: Promise<void> | undefined;
    handle.subscribe((event) => {
      if (event.type !== "run_state_changed" || event.state !== "running") {
        return;
      }
      // Acceptance is resolved after this exact projected reasoning update.
      // Queue close first so the handle boundary races the acceptance handler,
      // not the provider write or user evidence.
      queueMicrotask(() => {
        closePromise = handle.close();
        void closePromise.catch(() => undefined);
      });
    });
    try {
      await expect(handle.submit(submitInput())).rejects.toMatchObject({
        category: "submission_unknown",
        crossedSubmissionBoundary: true,
        retryable: false,
      });
      await expect(closePromise).resolves.toBeUndefined();
    } finally {
      await handle.close().catch(() => undefined);
      await fixtureState.close();
    }
  });

  it.each(["remote_after_user", "remote_after_partial_user"])(
    "treats %s as sent-unknown and retains the exact replay",
    async (promptBehavior) => {
      const sessionId =
        promptBehavior === "remote_after_user"
          ? "cccccccc-1111-4111-8111-cccccccccccc"
          : "dddddddd-1111-4111-8111-dddddddddddd";
      const fixtureState = await openDriver([
        { ...session(sessionId, "Remote traffic"), promptBehavior },
      ]);
      const handle = await fixtureState.driver.attach({
        scope,
        workspace: fixtureState.workspace,
        binding: conversationBinding(sessionId),
        opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
      });
      const input = submitInput();
      try {
        await expect(handle.submit(input)).rejects.toMatchObject({
          category: "submission_unknown",
          crossedSubmissionBoundary: true,
          retryable: false,
        });
        await expect(handle.submit(input)).rejects.toMatchObject({
          category: "submission_unknown",
          crossedSubmissionBoundary: true,
        });
        expect(
          (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
            .promptCalls,
        ).toBe(1);
        await expect(handle.close()).resolves.toBeUndefined();
      } finally {
        await fixtureState.close();
      }
    },
  );

  it("accepts composer text above the removed Grok-only 16 KiB ceiling", async () => {
    const sessionId = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
    const fixtureState = await openDriver([
      { ...session(sessionId, "Bounded text"), promptDelayMs: 0 },
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    const exactText = `line\r\n\t${"x".repeat(16_377)}`;
    expect(Buffer.byteLength(exactText, "utf8")).toBe(16_384);
    try {
      await expect(
        handle.submit({ ...submitInput(), text: exactText }),
      ).resolves.toMatchObject({ accepted: true });
      await waitFor(async () => {
        const projection = await handle.establishProjection({
          signal: new AbortController().signal,
        });
        return projection.snapshot.runState === "idle";
      });
      await expect(
        handle.submit({
          ...submitInput(),
          applicationOperationId: "oversize-operation",
          mutationId: "oversize-mutation",
          reconciliationToken: "oversize-token",
          text: "x".repeat(16_385),
        }),
      ).resolves.toMatchObject({ accepted: true });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).sessions[0]
          .promptCalls,
      ).toBe(2);
    } finally {
      await handle.close();
      await fixtureState.close();
    }
  });

  it("maps post-attach forged history and close races through the safe BackendError boundary", async () => {
    const sessionId = "ffffffff-1111-4111-8111-ffffffffffff";
    const fixtureState = await openDriver([
      {
        ...session(sessionId, "Forged later"),
        history: "post_response_forged",
      },
    ]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await expect(handle.submit(submitInput())).rejects.toMatchObject({
        category: "incompatible_protocol",
        crossedSubmissionBoundary: false,
      });
      await expect(handle.close()).resolves.toBeUndefined();
      await expect(
        handle.submit({
          ...submitInput(),
          applicationOperationId: "after-close",
          mutationId: "after-close",
          reconciliationToken: "after-close",
        }),
      ).rejects.toMatchObject({
        category: "invalid_state",
        crossedSubmissionBoundary: false,
      });
    } finally {
      await fixtureState.close();
    }
  });

  it("reconciles only exact authenticated history against a scoped semantic anchor", async () => {
    const firstId = "88888888-8888-4888-8888-888888888888";
    const secondId = "99999999-9999-4999-8999-999999999999";
    const fixtureState = await openDriver([
      session(firstId, "First"),
      session(secondId, "Second"),
    ]);
    try {
      const firstHandle = await fixtureState.driver.attach({
        scope,
        workspace: fixtureState.workspace,
        binding: conversationBinding(firstId),
        opaqueBindingDetail: fixtureState.bindingDetail(firstId),
      });
      const anchor = await firstHandle.captureSubmissionRetryAnchor();
      await firstHandle.close();

      await expect(
        fixtureState.driver.reconcileSubmission(
          reconcileInput(fixtureState, firstId, anchor),
        ),
      ).resolves.toEqual({ status: "not_accepted", retryable: true });
      const afterNotAccepted = (
        await readState(fixtureState.workspace.canonicalPath)
      ).processStarts;
      await expect(
        fixtureState.driver.reconcileSubmission(
          reconcileInput(fixtureState, secondId, anchor),
        ),
      ).resolves.toMatchObject({ status: "unresolved" });
      expect(
        (await readState(fixtureState.workspace.canonicalPath)).processStarts,
      ).toBe(afterNotAccepted);

      const diverged = await readState(fixtureState.workspace.canonicalPath);
      diverged.sessions[0].history = "correlated";
      await writeState(fixtureState.workspace.canonicalPath, diverged);
      await expect(
        fixtureState.driver.reconcileSubmission(
          reconcileInput(fixtureState, firstId, anchor),
        ),
      ).resolves.toMatchObject({ status: "unresolved" });
    } finally {
      await fixtureState.close();
    }
  });

  it("reconciles in-progress and terminal submissions and preserves authoritative evidence through cleanup failure", async () => {
    const sessionId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const fixtureState = await openDriver([session(sessionId, "Reconcile")]);
    const handle = await fixtureState.driver.attach({
      scope,
      workspace: fixtureState.workspace,
      binding: conversationBinding(sessionId),
      opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    });
    const anchor = await handle.captureSubmissionRetryAnchor();
    await handle.close();
    const input = submitInput();
    const promptId = fixtureState.submissionPromptId(
      sessionId,
      input.applicationOperationId,
      input.reconciliationToken,
    );
    try {
      const state = await readState(fixtureState.workspace.canonicalPath);
      state.sessions[0].submissions = [
        { promptId, text: input.text, completed: false },
      ];
      await writeState(fixtureState.workspace.canonicalPath, state);

      const inProgress = await fixtureState.driver.reconcileSubmission(
        reconcileInput(fixtureState, sessionId, anchor),
      );
      expect(inProgress).toMatchObject({
        status: "accepted",
        backendTurn: { status: "in_progress" },
      });
      expect(inProgress).not.toHaveProperty("completionIdentity");

      const completedState = await readState(
        fixtureState.workspace.canonicalPath,
      );
      completedState.sessions[0].submissions[0].completed = true;
      await writeState(fixtureState.workspace.canonicalPath, completedState);
      await expect(
        fixtureState.driver.reconcileSubmission(
          reconcileInput(fixtureState, sessionId, anchor),
        ),
      ).resolves.toMatchObject({
        status: "accepted",
        backendTurn: { status: "completed", endedBy: "agent_settled" },
        completionIdentity: expect.stringMatching(/:completed$/u),
      });

      const nativeNamespaceKey = parseGrokConversationBindingDetail(
        fixtureState.bindingDetail(sessionId),
      ).nativeNamespaceKey;
      const legacyPromptId = grokSubmissionPromptIdReadCandidates({
        installationKey: submissionCorrelationKey,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId,
        connectionProfileId,
        executionEnvironmentId,
        nativeNamespaceKey,
        canonicalWorkspacePath: fixtureState.workspace.canonicalPath,
        sessionId,
        applicationOperationId: input.applicationOperationId,
        reconciliationToken: input.reconciliationToken,
      })[1];
      const parsedAnchor = JSON.parse(anchor) as {
        readonly version: 1;
        readonly transcriptFingerprint: string;
      };
      const legacyAnchor = JSON.stringify({
        version: 1,
        scopeFingerprint: createHash("sha256")
          .update("harness.grok-submission.anchor-scope.v1\n")
          .update(
            JSON.stringify([
              scope.tenantId,
              scope.principalId,
              backendInstanceId,
              connectionProfileId,
              executionEnvironmentId,
              nativeNamespaceKey,
              fixtureState.workspace.canonicalPath,
              sessionId,
            ]),
          )
          .digest("base64url"),
        transcriptFingerprint: parsedAnchor.transcriptFingerprint,
      });
      const legacyState = await readState(fixtureState.workspace.canonicalPath);
      legacyState.sessions[0].submissions = [
        {
          promptId: legacyPromptId,
          text: input.text,
          completed: true,
        },
      ];
      await writeState(fixtureState.workspace.canonicalPath, legacyState);
      await expect(
        fixtureState.driver.reconcileSubmission(
          reconcileInput(fixtureState, sessionId, legacyAnchor),
        ),
      ).resolves.toMatchObject({
        status: "accepted",
        backendTurn: { status: "completed", endedBy: "agent_settled" },
      });

      const duplicateState = await readState(
        fixtureState.workspace.canonicalPath,
      );
      duplicateState.sessions[0].submissions.push({
        promptId: fixtureState.submissionPromptId(
          sessionId,
          input.applicationOperationId,
          "alternate-token",
        ),
        text: input.text,
        completed: true,
      });
      await writeState(fixtureState.workspace.canonicalPath, duplicateState);
      await expect(
        fixtureState.driver.reconcileSubmission(
          reconcileInput(fixtureState, sessionId, anchor),
        ),
      ).resolves.toMatchObject({ status: "unresolved" });

      const forgedState = await readState(fixtureState.workspace.canonicalPath);
      const forged = `${promptId.slice(0, -1)}${promptId.endsWith("A") ? "B" : "A"}`;
      forgedState.sessions[0].submissions = [
        { promptId: forged, text: input.text, completed: true },
      ];
      await writeState(fixtureState.workspace.canonicalPath, forgedState);
      await expect(
        fixtureState.driver.reconcileSubmission(
          reconcileInput(fixtureState, sessionId, anchor),
        ),
      ).resolves.toMatchObject({ status: "unresolved" });

      const cleanupState = await readState(
        fixtureState.workspace.canonicalPath,
      );
      cleanupState.sessions[0].submissions = [
        { promptId, text: input.text, completed: true },
      ];
      cleanupState.sessions[0].closeBehavior = "remote_error";
      await writeState(fixtureState.workspace.canonicalPath, cleanupState);
      await expect(
        fixtureState.driver.reconcileSubmission(
          reconcileInput(fixtureState, sessionId, anchor),
        ),
      ).resolves.toMatchObject({
        status: "accepted",
        backendTurn: { status: "completed", endedBy: "agent_settled" },
        completionIdentity: expect.stringMatching(/:completed$/u),
      });
    } finally {
      await fixtureState.close();
    }
  });

  it("uses a strict versioned opaque binding codec", () => {
    const detail = {
      version: 1 as const,
      sessionId: "session",
      tenantId: "tenant",
      principalId: "principal",
      backendInstanceId: "backend",
      connectionProfileId: "connection",
      executionEnvironmentId: "environment",
      canonicalWorkspacePath: "/workspace",
      nativeNamespaceKey: "namespace",
    };
    expect(
      parseGrokConversationBindingDetail(
        serializeGrokConversationBindingDetail(detail),
      ),
    ).toEqual(detail);
    expect(() =>
      parseGrokConversationBindingDetail(
        JSON.stringify({ ...detail, version: 2 }),
      ),
    ).toThrow("grok_conversation_binding_invalid");
    expect(() =>
      parseGrokConversationBindingDetail(
        JSON.stringify({ ...detail, extra: true }),
      ),
    ).toThrow("grok_conversation_binding_invalid");
  });
});

async function openDriver(
  sessions: Record<string, unknown>[],
  options: {
    readonly agentToolCli?:
      | {
          readonly availability: "available";
          readonly endpoint: string;
          readonly executableDirectory: string;
          readonly inheritedPath: string;
        }
      | {
          readonly availability: "unavailable";
          readonly reason: "cli_unavailable";
        };
    readonly issueSourceCapability?: (input: unknown) => string;
    readonly executablePath?: string;
    readonly runtimeAdvisories?: GrokRuntimeAdvisorySource;
    readonly promptPostTerminalSettlementDeadlineMilliseconds?: number;
    readonly modelImageInput?: boolean;
  } = {},
) {
  await chmod(fixture, 0o755);
  const root = await mkdtemp(path.join(os.tmpdir(), "grok-driver-"));
  roots.push(root);
  const workspace = await createWorkspace(root, "workspace");
  const nativeHome = path.join(root, "native-home");
  await mkdir(nativeHome);
  const environment = { PATH: process.env.PATH, HOME: nativeHome };
  await writeState(workspace.canonicalPath, {
    nextId: 1,
    processStarts: 0,
    sessions,
    ...(options.modelImageInput !== undefined
      ? { modelImageInput: options.modelImageInput }
      : {}),
  });
  const channels = new LocalEnvironmentChannelProvider({
    scope,
    executionEnvironmentId,
    environment,
  });
  const snapshots = new GrokDiscoverySnapshotStore({
    createId: () => "a".repeat(32),
  });
  const settings = {
    get: (_scope: typeof scope, applicationThreadId: string) => ({
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      applicationThreadId,
      backendInstanceId,
      connectionProfileId,
      executionEnvironmentId,
      model: "grok-build",
      effort: "low",
      effectiveModel: "grok-build",
      effectiveEffort: "low",
      effectiveState: "confirmed" as const,
      revision: 0,
      createdAt: 0,
      updatedAt: 0,
    }),
    confirmEffective: (
      _scope: typeof scope,
      applicationThreadId: string,
      _input: {
        readonly model: string;
        readonly effort: string;
        readonly now: number;
      },
    ) => settings.get(scope, applicationThreadId),
  };
  const driver = new GrokConversationBackendDriver({
    configuration: configuration(options.executablePath),
    instance: {
      id: backendInstanceId,
      tenantId: scope.tenantId,
      kind: "grok_build",
      label: "Grok",
      enabled: true,
      configurationRevision: 1,
      protocolRelease: "1.x",
    },
    connection: {
      id: connectionProfileId,
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      templateId: connectionProfileId,
      kind: "grok_acp",
      backendInstanceId,
      executionEnvironmentId,
      label: "Grok local",
      enabled: true,
      configurationRevision: 1,
    },
    environmentChannel: channels,
    environment,
    submissionCorrelationKey,
    agentToolCli: options.agentToolCli ?? {
      availability: "unavailable",
      reason: "cli_unavailable",
    },
    agentToolSourceCapabilities: {
      issue: options.issueSourceCapability ?? (() => "a".repeat(32)),
    },
    agentTools,
    discoverySnapshots: snapshots,
    settings,
    outputArtifacts: {
      findImage: () => undefined,
      publishImage: () => {
        throw new Error("unexpected_grok_output_artifact_publication");
      },
    },
    ...(options.runtimeAdvisories
      ? {
          beginRuntimeAssessmentObservation: () =>
            options.runtimeAdvisories!.beginObservation(),
        }
      : {}),
    ...(options.promptPostTerminalSettlementDeadlineMilliseconds !== undefined
      ? {
          promptPostTerminalSettlementDeadlineMilliseconds:
            options.promptPostTerminalSettlementDeadlineMilliseconds,
        }
      : {}),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  return {
    root,
    workspace,
    driver,
    bindingDetail: (sessionId: string) =>
      serializeGrokConversationBindingDetail({
        version: 1,
        sessionId,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId,
        connectionProfileId,
        executionEnvironmentId,
        canonicalWorkspacePath: workspace.canonicalPath,
        nativeNamespaceKey: grokNativeNamespaceKey(
          executionEnvironmentId,
          environment,
        ),
      }),
    submissionPromptId: (
      sessionId: string,
      applicationOperationId: string,
      reconciliationToken: string,
    ) =>
      grokSubmissionPromptId({
        installationKey: submissionCorrelationKey,
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId,
        connectionProfileId,
        executionEnvironmentId,
        nativeNamespaceKey: grokNativeNamespaceKey(
          executionEnvironmentId,
          environment,
        ),
        canonicalWorkspacePath: workspace.canonicalPath,
        sessionId,
        applicationOperationId,
        reconciliationToken,
      }),
    close: async () => {
      try {
        await driver.close();
      } finally {
        channels.close();
      }
    },
  };
}

function configuration(executablePath = fixture) {
  return {
    backend: {
      id: backendInstanceId,
      kind: "grok_build" as const,
      protocolRelease: "1.x",
      enabled: true,
      modelPolicy: { type: "catalog" as const },
      moduleConfiguration: {
        connection: {
          ownership: "owned",
          channel: {
            type: "process_stdio",
            executablePath,
            workingDirectoryPolicy: "workspace",
          },
        },
        authentication: { type: "native" },
        security: {
          profile: "unrestricted_v1",
          sandboxProfile: "off",
          networkAccess: "enabled",
          approvalMode: "full_access",
        },
      },
    },
    connections: [
      {
        id: connectionProfileId,
        kind: "grok_acp" as const,
        backendInstanceId,
        executionEnvironmentId,
        enabled: true,
        moduleConfiguration: {
          defaults: {
            model: { type: "catalogDefault" },
            reasoningEffort: { type: "modelDefault" },
          },
        },
      },
    ],
    executionEnvironments: [
      { id: executionEnvironmentId, kind: "local" as const },
    ],
  };
}

async function writeVersionOnlyExecutable(
  executable: string,
  version: string,
  build: string,
): Promise<void> {
  await writeFile(
    executable,
    `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ currentVersion: ${JSON.stringify(`${version} (${build})`)} }) + "\\n");\n`,
  );
  await chmod(executable, 0o755);
}

async function writeConversationPeerExecutable(
  executable: string,
  version: string,
  build: string,
): Promise<void> {
  const source = await readFile(fixture, "utf8");
  await writeFile(
    executable,
    source.replace(
      'currentVersion: "1.0.4 (d846eb93d9)"',
      `currentVersion: ${JSON.stringify(`${version} (${build})`)}`,
    ),
  );
  await chmod(executable, 0o755);
}

function conversationBinding(sessionId: string): ConversationBinding {
  return {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    applicationThreadId: `thread-${sessionId}`,
    backendInstanceId,
    connectionProfileId,
    executionEnvironmentId,
    backendConversationId: sessionId,
    createdAt: "2026-08-16T12:00:00.000Z",
  };
}

function submitInput() {
  return {
    applicationOperationId: "submit-operation",
    mutationId: "submit-mutation",
    source: { kind: "user" as const },
    reconciliationToken: "submit-reconciliation-token",
    text: "hello Grok",
    contextExcerpts: [],
    taskContexts: [],
    attachments: [],
  };
}

function imageDelivery(
  entries: readonly {
    readonly id: string;
    readonly fileName: string;
    readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
    readonly bytes: Buffer;
  }[],
) {
  const readOrder: string[] = [];
  const evidence = Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        id: entry.id,
        kind: "image" as const,
        fileName: entry.fileName,
        mediaType: entry.mediaType,
        byteSize: entry.bytes.byteLength,
        sha256: createHash("sha256").update(entry.bytes).digest("hex"),
      }),
    ),
  );
  const attachments = Object.freeze(
    evidence.map((entry) =>
      Object.freeze({
        ...entry,
        agentPath: `/remote/grok/${entry.id}`,
      }),
    ),
  );
  const bytesById = new Map(entries.map((entry) => [entry.id, entry.bytes]));
  return {
    entries,
    evidence,
    readOrder,
    input: {
      attachments,
      attachmentEvidence: { resolve: () => evidence },
      attachmentBytes: {
        read: async (attachment: (typeof attachments)[number]) => {
          readOrder.push(attachment.id);
          const bytes = bytesById.get(attachment.id);
          if (!bytes) throw new Error("missing fixture image");
          return Buffer.from(bytes);
        },
      },
    },
  };
}

function reconcileInput(
  fixtureState: Awaited<ReturnType<typeof openDriver>>,
  sessionId: string,
  retryAnchor: string,
) {
  const input = submitInput();
  return {
    scope,
    workspace: fixtureState.workspace,
    binding: conversationBinding(sessionId),
    opaqueBindingDetail: fixtureState.bindingDetail(sessionId),
    applicationOperationId: input.applicationOperationId,
    reconciliationToken: input.reconciliationToken,
    retryAnchor,
  };
}

function session(sessionId: string, title: string) {
  return {
    sessionId,
    title,
    updatedAt: "2026-08-16T12:00:00.000Z",
    history: "empty",
    closeCount: 0,
  };
}

async function createWorkspace(root: string, name: string) {
  const directory = path.join(root, name);
  await mkdir(directory);
  const canonicalPath = await realpath(directory);
  return {
    canonicalPath,
    authorityRevision: 0,
    summary: {
      id: `${name}-id`,
      environmentId: executionEnvironmentId,
      displayName: name,
      displayPath: canonicalPath,
      availability: "available" as const,
      trustState: "trusted" as const,
      revision: 0,
    },
  };
}

async function readState(workspace: string) {
  return JSON.parse(
    await readFile(
      path.join(workspace, ".fake-grok-driver-state.json"),
      "utf8",
    ),
  );
}

async function writeState(workspace: string, state: unknown) {
  await writeFile(
    path.join(workspace, ".fake-grok-driver-state.json"),
    JSON.stringify(state),
  );
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("grok_driver_test_wait_timeout");
}
