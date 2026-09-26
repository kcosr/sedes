import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";
import type { ClaudeConversationHandle } from "../../src/server/backends/claude/claude-conversation-handle.js";
import type {
  EffortLevel,
  Query,
  SDKControlInitializeResponse,
  SDKMessage,
  SDKSessionInfo,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  ConversationBinding,
} from "../../src/server/backends/contracts.js";
import { BackendError } from "../../src/server/backends/contracts.js";
import { ClaudeConversationBackendDriver } from "../../src/server/backends/claude/claude-conversation-driver.js";
import {
  OfficialClaudeSdkFacade,
  type ClaudeQueryInput,
  type ClaudeSdkFacade,
} from "../../src/server/backends/claude/claude-sdk-facade.js";
import { ClaudeTranscriptFixture } from "../helpers/claude-native-transcript-fixture.js";
import { ClaudeSdkRuntimeAdapter, type ClaudeRuntimeClient } from "../../src/server/backends/claude/claude-runtime-client.js";
import type { ClaudeInputQueue } from "../../src/server/backends/claude/claude-input-queue.js";
import type { ClaudeThreadRepository } from "../../src/server/backends/claude/claude-thread-repository.js";
import type { ClaudePermissionMode } from "../../src/server/backends/claude/claude-permission-policy.js";
import { projectClaudeHistory } from "../../src/server/backends/claude/claude-history-projector.js";
import { USER_FORK_CONTEXT_BOUNDARY } from "../../src/server/backends/fork-context-boundary.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { createFakeAgentToolSourceCapabilities } from "../helpers/fake-agent-tool-source-capabilities.js";
import type { AgentToolCliAvailability } from "../../src/server/backends/module.js";
import type { AgentToolSourceCapabilityIssuer } from "../../src/server/agent-tools/application/database-agent-tool-source-authority.js";
import type { BackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";

const agentToolSourceCapabilities =
  createFakeAgentToolSourceCapabilities().issuer;
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
    throw new Error("claude_test_agent_tool_invocation_unexpected");
  },
};
import type { BackendModelPolicy } from "../../src/server/backends/model-policy.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const instance: AgentBackendInstance = {
  id: "claude-1",
  tenantId: scope.tenantId,
  kind: "claude_agent_sdk",
  label: "Claude",
  enabled: true,
  configurationRevision: 1,
  protocolRelease: "0.3.274",
};
const connection: AgentConnectionProfile = {
  id: "claude-profile-1",
  tenantId: scope.tenantId,
  ownerPrincipalId: scope.principalId,
  templateId: "claude-template-1",
  kind: "claude_agent_sdk",
  backendInstanceId: instance.id,
  executionEnvironmentId: "environment-1",
  label: "Local Claude",
  enabled: true,
  configurationRevision: 1,
};
const workspace = {
  authorityRevision: 1,
  summary: {
    id: "workspace-1",
    environmentId: connection.executionEnvironmentId,
    displayName: "Workspace",
    displayPath: "/workspace",
    availability: "available" as const,
    trustState: "trusted" as const,
    revision: 1,
  },
  canonicalPath: "/workspace",
};
const sessionId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";

describe("ClaudeConversationBackendDriver", () => {
  it("probes the external subscription CLI and exposes exact model identities", async () => {
    const sdk = fakeSdk();
    const driver = createDriver(sdk);
    expect(await driver.health()).toEqual({
      available: true,
      checkedAt: "2026-08-08T12:00:00.000Z",
    });
    const catalog = await driver.catalog({ scope, workspace });
    expect(catalog.models).toEqual([
      {
        provider: connection.id,
        id: "claude-sonnet-5",
        label: "Sonnet alias",
        inputModalities: ["text", "image"],
        isDefault: true,
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "low",
      },
    ]);
    expect(catalog.commands).toEqual([]);
    expect(sdk.createQuery).toHaveBeenCalled();
    expect(sdk.readCliAuthStatus).toHaveBeenCalledWith(
      "/usr/local/bin/claude",
      1_000,
      { HOME: "/operator", CLAUDE_CONFIG_DIR: "/operator/.claude" },
      "/workspace",
      undefined,
    );
    expect(sdk.createQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: {
            HOME: "/operator",
            CLAUDE_CONFIG_DIR: "/operator/.claude",
          },
        }),
      }),
    );
  });

  it("advertises only stream-classified nonterminal Claude skills", async () => {
    const sdk = fakeSdk({
      streamSkills: ["review", "doctor"],
      terminalCommands: ["doctor"],
    });
    const driver = createDriver(sdk);

    const catalog = await driver.catalog({ scope, workspace });
    expect(catalog.commands).toEqual([
      {
        invocation: "/review",
        source: "prompt",
        description: "Review changes",
        argumentHint: "<path>",
      },
    ]);
    expect(catalog.skills).toEqual([
      expect.objectContaining({
        name: "review",
        reference: "/review",
      }),
    ]);
  });

  it("filters exact model and effort intersections without using the connection namespace", async () => {
    const sdk = fakeSdk();
    const driver = createDriver(sdk, {
      modelPolicy: {
        type: "allowlist",
        allowed: [
          {
            modelIds: ["claude-sonnet-5"],
            reasoningEfforts: ["medium"],
          },
        ],
      },
    });

    await expect(driver.catalog({ scope, workspace })).resolves.toMatchObject({
      models: [
        {
          id: "claude-sonnet-5",
          supportedReasoningEfforts: ["medium"],
          defaultReasoningEffort: "medium",
        },
      ],
    });
  });

  it("uses the explicit exact row when the moving default alias has stale effort metadata", async () => {
    const catalog = await createDriver(
      fakeSdk({ defaultAliasEfforts: ["low"] }),
    ).catalog({ scope, workspace });

    expect(catalog.models).toEqual([
      expect.objectContaining({
        id: "claude-sonnet-5",
        label: "Sonnet alias",
        isDefault: true,
        supportedReasoningEfforts: ["low", "medium", "high"],
      }),
    ]);
  });

  it("keeps an effortless model and labels a default alias by its explicit row", async () => {
    const sdk = fakeSdk({ includeEffortless: true });
    const catalog = await createDriver(sdk).catalog({ scope, workspace });

    expect(catalog.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "claude-sonnet-5",
          label: "Sonnet alias",
          isDefault: true,
        }),
        expect.objectContaining({
          id: "claude-haiku-4-5",
          label: "Haiku",
        }),
      ]),
    );
    expect(
      catalog.models.find(({ id }) => id === "claude-haiku-4-5"),
    ).not.toHaveProperty("supportedReasoningEfforts");
  });

  it("creates a pure idempotent application UUID reservation", async () => {
    const sdk = fakeSdk();
    const driver = createDriver(sdk);
    const input = {
      scope,
      applicationThreadId: "thread-1",
      applicationOperationId: operationId,
      source: { kind: "user" as const },
      workspace,
      requestedBackendConversationId: sessionId,
    };
    const first = await driver.create(input);
    const second = await driver.create(input);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      backendConversationId: sessionId,
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
    });
    expect(sdk.getSessionInfo).not.toHaveBeenCalled();
    await expect(
      driver.create({ ...input, requestedBackendConversationId: undefined }),
    ).rejects.toMatchObject({ backendCode: "claude_create_identity_invalid" });
  });

  it("pages discovery from one stable prefix and rejects drift", async () => {
    const sdk = fakeSdk();
    const sessions = [session(1), session(2), session(3)];
    sdk.listSessions.mockImplementation(async ({ limit = 50 }) =>
      sessions.slice(0, limit),
    );
    const driver = createDriver(sdk);
    const first = await driver.discover({
      scope,
      workspace,
      signal: new AbortController().signal,
      limit: 2,
    });
    expect(
      first.conversations.map((item) => item.backendConversationId),
    ).toEqual(sessions.slice(0, 2).map((item) => item.sessionId));
    expect(sdk.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ dir: "/workspace", includeWorktrees: false }),
      { HOME: "/operator", CLAUDE_CONFIG_DIR: "/operator/.claude" },
    );
    expect(first.nextCursor).toBeTruthy();

    sessions[0] = {
      ...sessions[0]!,
      lastModified: sessions[0]!.lastModified + 1,
    };
    await expect(
      driver.discover({
        scope,
        workspace,
        signal: new AbortController().signal,
        cursor: first.nextCursor,
        limit: 2,
      }),
    ).rejects.toMatchObject({
      backendCode: "claude_discovery_snapshot_changed",
      retryable: true,
    });
  });

  it("does not return discovery results after cancellation", async () => {
    const sdk = fakeSdk();
    const controller = new AbortController();
    sdk.listSessions.mockImplementation(async () => {
      controller.abort(new Error("cancelled"));
      return [session(1)];
    });
    const driver = createDriver(sdk);
    await expect(
      driver.discover({
        scope,
        workspace,
        signal: controller.signal,
        limit: 1,
      }),
    ).rejects.toThrow("cancelled");
  });

  it("reads projected history and reconciles exactly by the user UUID", async () => {
    const sdk = fakeSdk();
    sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    exposeSessionMessages(sdk, [
      user(operationId, "hello"),
      assistant("33333333-3333-4333-8333-333333333333", "hello back"),
    ]);
    const driver = createDriver(sdk);
    const read = await driver.read({
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
    });
    expect(read.snapshot.orderedBackendTurnIds).toHaveLength(1);
    expect(read.usage).toMatchObject({
      counters: { userMessages: 1, assistantMessages: 1 },
    });

    const reconciliation = await driver.reconcileSubmission({
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      applicationOperationId: operationId,
    });
    expect(reconciliation).toMatchObject({
      status: "accepted",
      backendTurn: {
        status: "completed",
        completionCorrelations: [operationId],
      },
    });
  });

  it("only retries an absent submission against an unchanged strict retry anchor", async () => {
    const sdk = fakeSdk();
    const messages = [
      user("44444444-4444-4444-8444-444444444444", "prior"),
      assistant("55555555-5555-4555-8555-555555555555", "done"),
    ];
    sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    sdk.getSessionMessages.mockResolvedValue(messages);
    const driver = createDriver(sdk);
    const input = {
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      applicationOperationId: operationId,
    };

    await expect(driver.reconcileSubmission(input)).resolves.toMatchObject({
      status: "unresolved",
    });
    await expect(
      driver.reconcileSubmission({ ...input, retryAnchor: "{}" }),
    ).resolves.toMatchObject({ status: "unresolved" });

    const anchor = retryAnchor(messages);
    await expect(
      driver.reconcileSubmission({ ...input, retryAnchor: anchor }),
    ).resolves.toEqual({ status: "not_accepted", retryable: true });

    sdk.getSessionMessages.mockResolvedValue([
      ...messages,
      user("66666666-6666-4666-8666-666666666666", "external change"),
    ]);
    await expect(
      driver.reconcileSubmission({ ...input, retryAnchor: anchor }),
    ).resolves.toMatchObject({ status: "unresolved" });
  });

  it("does not authorize retry while a newly accepted session may still be invisible", async () => {
    const sdk = fakeSdk();
    sdk.getSessionInfo.mockResolvedValue(undefined);
    const driver = createDriver(sdk);

    await expect(
      driver.reconcileSubmission({
        scope,
        workspace,
        binding: binding(),
        opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
        applicationOperationId: operationId,
        retryAnchor: retryAnchor([]),
      }),
    ).resolves.toMatchObject({ status: "unresolved" });
  });

  it.each(["submitted", "unknown"] as const)(
    "keeps remote reconciliation unresolved when native history lags and the runtime reports %s",
    async (disposition) => {
      const sdk = fakeSdk();
      sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
      sdk.getSessionMessages.mockResolvedValue([]);
      const submissionDisposition = vi.fn(async () => disposition);
      const driver = createDriver(sdk, { submissionDisposition });
      await expect(driver.reconcileSubmission({
        scope, workspace, binding: binding(),
        opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
        applicationOperationId: operationId, retryAnchor: retryAnchor([]),
      })).resolves.toMatchObject({ status: "unresolved" });
      expect(submissionDisposition).toHaveBeenCalledExactlyOnceWith({
        sessionId, operationId, cwd: workspace.canonicalPath,
      });
      expect(sdk.createQuery).not.toHaveBeenCalled();
    },
  );

  it("requires exact remote not-sent evidence before authorizing a native-anchor retry", async () => {
    const sdk = fakeSdk();
    sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    sdk.getSessionMessages.mockResolvedValue([]);
    const submissionDisposition = vi.fn(async () => "not_sent" as const);
    const driver = createDriver(sdk, { submissionDisposition });
    const input = {
      scope, workspace, binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      applicationOperationId: operationId, retryAnchor: retryAnchor([]),
    };
    await expect(driver.reconcileSubmission(input)).resolves.toEqual({
      status: "not_accepted", retryable: true,
    });
    submissionDisposition.mockRejectedValue(new Error("sidecar_disconnected"));
    await expect(driver.reconcileSubmission(input)).resolves.toMatchObject({ status: "unresolved" });
    expect(sdk.createQuery).not.toHaveBeenCalled();
  });

  it("uses exact owner not-sent proof without requiring a submit anchor and removes only pending steer metadata", async () => {
    const sdk = fakeSdk(); sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    sdk.getSessionMessages.mockResolvedValue([]);
    const submissionDisposition = vi.fn(async () => "not_sent" as const);
    const forgetUnconsumedSteerOperation = vi.fn();
    const driver = createDriver(sdk, { submissionDisposition, forgetUnconsumedSteerOperation,
      steerOperations: new Map([[operationId, null]]) });
    await expect(driver.reconcileSubmission({ scope, workspace, binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }), applicationOperationId: operationId }))
      .resolves.toEqual({ status: "not_accepted", retryable: true });
    expect(submissionDisposition).toHaveBeenCalledWith({ sessionId, operationId, cwd: workspace.canonicalPath });
    expect(forgetUnconsumedSteerOperation).toHaveBeenCalledWith(scope, binding().applicationThreadId, operationId);
    expect(sdk.createQuery).not.toHaveBeenCalled();
  });

  it.each(["submitted", "unknown"] as const)("does not infer nonacceptance without an anchor when the owner reports %s", async disposition => {
    const sdk = fakeSdk(); sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    sdk.getSessionMessages.mockResolvedValue([]);
    const submissionDisposition = vi.fn(async () => disposition); const forgetUnconsumedSteerOperation = vi.fn();
    const driver = createDriver(sdk, { submissionDisposition, forgetUnconsumedSteerOperation,
      steerOperations: new Map([[operationId, null]]) });
    await expect(driver.reconcileSubmission({ scope, workspace, binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }), applicationOperationId: operationId }))
      .resolves.toMatchObject({ status: "unresolved" });
    expect(submissionDisposition).toHaveBeenCalledOnce();
    expect(forgetUnconsumedSteerOperation).not.toHaveBeenCalled();
  });

  it("ends lost local tracking without claiming consumption or nonconsumption after restart", async () => {
    const sdk = fakeSdk(); sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    const nativeMessages = [user(operationId, "queued steer")];
    sdk.getSessionMessages.mockResolvedValue(nativeMessages);
    const forgetUnconsumedSteerOperation = vi.fn();
    const driver = createDriver(sdk, { forgetUnconsumedSteerOperation, steerOperations: new Map([[operationId, null]]) });
    const input = { scope, workspace, binding: binding(), opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }), applicationOperationId: operationId };
    await expect(driver.reconcileSubmission(input)).resolves.toMatchObject({ status: "failed_unknown" });
    // Even a forged idle-submit anchor is not proof about a queued next input.
    sdk.getSessionMessages.mockResolvedValue([]);
    await expect(driver.reconcileSubmission({ ...input, retryAnchor: retryAnchor([]) })).resolves.toMatchObject({ status: "failed_unknown" });
    expect(forgetUnconsumedSteerOperation).not.toHaveBeenCalled();
    expect(sdk.createQuery).not.toHaveBeenCalled();
  });

  it.each(["local", "not_sent", "session_ended"] as const)("reconciles an ordinary retained waiter using %s authority without inferring absence from the old anchor", async authority => {
    const sdk = fakeSdk();
    sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId, cwd: workspace.canonicalPath });
    sdk.getSessionMessages.mockResolvedValue([]);
    const driver = createDriver(sdk, { confirmSettings: true,
      ...(authority === "local" ? {} : { submissionDisposition: async () => authority }),
    });
    const attachment = { scope, workspace, binding: binding(), opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }) };
    const handle = await driver.attach(attachment);
    await handle.establishProjection({ signal: new AbortController().signal });
    const input = { applicationOperationId: operationId, mutationId: "ordinary-retained", reconciliationToken: "ordinary-receipt",
      source: { kind: "user" as const }, text: "Ordinary request", contextExcerpts: [], attachments: [], taskContexts: [] };
    vi.useFakeTimers();
    try {
      const submitted = expect(handle.submit(input)).rejects.toMatchObject({ category: "submission_unknown" });
      await vi.advanceTimersByTimeAsync(30_001);
      await submitted;
      expect(handle.retirementBlocked).toBe(true);
      const reconcile = { ...attachment, applicationOperationId: operationId, retryAnchor: retryAnchor([]) };
      await expect(driver.reconcileSubmission(reconcile)).resolves.toMatchObject({
        status: authority === "not_sent" ? "not_accepted" : authority === "session_ended" ? "failed_unknown" : "unresolved",
      });
      expect(handle.retirementBlocked).toBe(authority === "local");
      if (authority === "not_sent") {
        // A legitimate explicit retry must reach the session, rather than
        // rethrow the previous acknowledgment timeout forever.
        const retried = expect(handle.submit(input)).resolves.toMatchObject({ accepted: true });
        sdk.getSessionMessages.mockResolvedValue([user(operationId, input.text)]);
        await vi.advanceTimersByTimeAsync(30_001);
        await retried;
        await expect(handle.submit(input)).resolves.toMatchObject({ accepted: true });
        expect(nativeInputCount(sdk)).toBe(2);
      } else {
        await expect(handle.submit(input)).rejects.toMatchObject({ category: "submission_unknown" });
        expect(nativeInputCount(sdk)).toBe(1);
        if (authority === "local") {
          // The runtime may end before its callback closes the handle. Release
          // its retirement hold, but keep the outcome unknown and forbid retry.
          vi.spyOn(handle as ClaudeConversationHandle, "hasPendingSubmissionObservation").mockReturnValue(false);
          await expect(driver.reconcileSubmission(reconcile)).resolves.toMatchObject({ status: "unresolved" });
          expect(handle.retirementBlocked).toBe(false);
          await expect(handle.submit(input)).rejects.toMatchObject({ backendCode: "claude_submission_tracking_ended" });
          expect(nativeInputCount(sdk)).toBe(1);
        }
      }
    } finally { vi.useRealTimers(); await driver.close(); }
  });

  it("keeps a live local queued steer unresolved, then exposes terminal uncertainty after its handle closes", async () => {
    const sdk = fakeSdk(); sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId, cwd: workspace.canonicalPath });
    sdk.getSessionMessages.mockResolvedValue([]);
    const steerOperations = new Map<string, string | null>([[operationId, null]]);
    const driver = createDriver(sdk, { steerOperations, confirmSettings: true });
    const input = { scope, workspace, binding: binding(), opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }) };
    const handle = await driver.attach(input);
    try {
      await handle.establishProjection({ signal: new AbortController().signal });
      await handle.steer({ applicationOperationId: operationId, mutationId: "test-steer", reconciliationToken: "test-receipt",
        target: { kind: "conversation" }, text: "Correction", contextExcerpts: [], attachments: [], taskContexts: [] });
      await expect(driver.reconcileSubmission({ ...input, applicationOperationId: operationId })).resolves.toMatchObject({ status: "unresolved" });
      // A dead runtime may be observed before its failure callback closes the
      // handle. Terminal recovery must release that remaining retirement hold.
      vi.spyOn(handle as ClaudeConversationHandle, "hasPendingSubmissionObservation").mockReturnValue(false);
      await expect(driver.reconcileSubmission({ ...input, applicationOperationId: operationId })).resolves.toMatchObject({ status: "failed_unknown" });
      expect(handle.retirementBlocked).toBe(false);
      await handle.close();
      await expect(driver.reconcileSubmission({ ...input, applicationOperationId: operationId })).resolves.toMatchObject({
        status: "failed_unknown", diagnostic: { text: expect.stringContaining("may have received") },
      });
      expect(steerOperations.get(operationId)).toBeNull();
    } finally { await driver.close(); }
  });

  it.each([
    ["steer", "steering message could be confirmed. Claude may have received it."],
    ["ordinary", "history shows no acceptance. Claude may still have received it."],
  ] as const)("ends %s delivery tracking without retry permission when the exact admitted owner session ended", async (kind, diagnostic) => {
    const sdk = fakeSdk(); sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    sdk.getSessionMessages.mockResolvedValue([]);
    const steerOperations = new Map<string, string | null>(kind === "steer" ? [[operationId, null]] : []);
    const forgetUnconsumedSteerOperation = vi.fn();
    const driver = createDriver(sdk, { steerOperations, forgetUnconsumedSteerOperation,
      submissionDisposition: async () => "session_ended" });
    // Even a matching idle-submit anchor cannot prove the ended owner never delivered it.
    await expect(driver.reconcileSubmission({ scope, workspace, binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }), applicationOperationId: operationId,
      retryAnchor: retryAnchor([]) }))
      .resolves.toMatchObject({ status: "failed_unknown", diagnostic: { text: expect.stringContaining(diagnostic) } });
    expect(forgetUnconsumedSteerOperation).not.toHaveBeenCalled();
    expect(sdk.createQuery).not.toHaveBeenCalled();
  });

  it("preserves exact consumption that races an ended-owner response", async () => {
    const sdk = fakeSdk(); sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    sdk.getSessionMessages.mockResolvedValue([]);
    const steerOperations = new Map<string, string | null>([[operationId, null]]);
    const driver = createDriver(sdk, { steerOperations,
      submissionDisposition: async () => {
        steerOperations.set(operationId, operationId);
        return "session_ended";
      } });
    await expect(driver.reconcileSubmission({ scope, workspace, binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }), applicationOperationId: operationId }))
      .resolves.toMatchObject({ status: "unresolved" });
  });

  it("does not authorize retry if native consumption arrives while owner disposition is pending", async () => {
    const sdk = fakeSdk(); sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    sdk.getSessionMessages.mockResolvedValue([]);
    const steerOperations = new Map<string, string | null>([[operationId, null]]);
    const forgetUnconsumedSteerOperation = vi.fn();
    const driver = createDriver(sdk, { steerOperations, forgetUnconsumedSteerOperation,
      submissionDisposition: async () => {
        // The durable exact UUID association arrives after the earlier history
        // snapshot, before this contradictory owner response returns.
        steerOperations.set(operationId, operationId);
        return "not_sent";
      } });
    await expect(driver.reconcileSubmission({ scope, workspace, binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }), applicationOperationId: operationId }))
      .resolves.toMatchObject({ status: "unresolved" });
    expect(forgetUnconsumedSteerOperation).not.toHaveBeenCalled();
  });

  it("fails closed when owner not-sent evidence contradicts a retained steering echo", async () => {
    const sdk = fakeSdk(); sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    sdk.getSessionMessages.mockResolvedValue([user(operationId, "queued steer")]);
    const forgetUnconsumedSteerOperation = vi.fn();
    const driver = createDriver(sdk, { submissionDisposition: async () => "not_sent", forgetUnconsumedSteerOperation,
      steerOperations: new Map([[operationId, null]]) });
    await expect(driver.reconcileSubmission({ scope, workspace, binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }), applicationOperationId: operationId }))
      .resolves.toMatchObject({ status: "unresolved" });
    expect(forgetUnconsumedSteerOperation).not.toHaveBeenCalled();
  });

  it("accepts exact native submission history without requiring a surviving remote dispatch journal", async () => {
    const sdk = fakeSdk();
    sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    sdk.getSessionMessages.mockResolvedValue([
      user(operationId, "hello"),
      assistant("33333333-3333-4333-8333-333333333333", "done"),
    ]);
    const submissionDisposition = vi.fn(async () => { throw new Error("old_runtime_missing"); });
    const driver = createDriver(sdk, { submissionDisposition });
    await expect(driver.reconcileSubmission({
      scope, workspace, binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      applicationOperationId: operationId, retryAnchor: retryAnchor([]),
    })).resolves.toMatchObject({ status: "accepted", backendTurn: { completionCorrelations: [operationId] } });
    expect(submissionDisposition).not.toHaveBeenCalled();
    expect(sdk.createQuery).not.toHaveBeenCalled();
  });

  it("denies wrong-scope reconciliation before reading remote submission evidence", async () => {
    const sdk = fakeSdk();
    const submissionDisposition = vi.fn(async () => "not_sent" as const);
    const driver = createDriver(sdk, { submissionDisposition });
    await expect(driver.reconcileSubmission({
      scope: { ...scope, principalId: "other-principal" }, workspace, binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      applicationOperationId: operationId, retryAnchor: retryAnchor([]),
    })).rejects.toBeInstanceOf(BackendError);
    expect(submissionDisposition).not.toHaveBeenCalled();
    expect(sdk.getSessionInfo).not.toHaveBeenCalled();
  });

  it("returns unresolved when Claude exposes a duplicate operation UUID", async () => {
    const sdk = fakeSdk();
    sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    sdk.getSessionMessages.mockResolvedValue([
      user(operationId, "first"),
      assistant("77777777-7777-4777-8777-777777777777", "done"),
      user(operationId, "duplicate"),
    ]);
    const driver = createDriver(sdk);
    await expect(
      driver.reconcileSubmission({
        scope,
        workspace,
        binding: binding(),
        opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
        applicationOperationId: operationId,
      }),
    ).resolves.toMatchObject({ status: "unresolved" });
  });

  it("retains a failed metadata read cause without changing its safe classification", async () => {
    const sdk = fakeSdk();
    const cause = new Error("sidecar_request_timeout");
    sdk.getSessionInfo.mockRejectedValue(cause);
    const driver = createDriver(sdk);
    const input = {
      scope, workspace, binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
    };
    for (const operation of [() => driver.attach(input), () => driver.read(input)]) {
      await expect(operation()).rejects.toMatchObject({
        backendCode: "claude_sdk_read_failed", category: "unavailable",
        retryable: true, cause,
      });
    }
  });

  it("rejects metadata and history returned for another native session", async () => {
    const sdk = fakeSdk();
    sdk.getSessionInfo.mockResolvedValue(session(1));
    const driver = createDriver(sdk);
    const input = {
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
    };
    await expect(driver.attach(input)).rejects.toMatchObject({
      backendCode: "claude_session_identity_mismatch",
    });
    await expect(driver.read(input)).rejects.toMatchObject({
      backendCode: "claude_session_identity_mismatch",
    });

    sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    exposeSessionMessages(sdk, [
      {
        ...user(operationId, "wrong history"),
        session_id: "99999999-9999-4999-8999-999999999999",
      },
    ]);
    await expect(driver.attach(input)).rejects.toMatchObject({
      backendCode: "claude_session_identity_mismatch",
    });
    await expect(driver.read(input)).rejects.toMatchObject({
      backendCode: "claude_session_identity_mismatch",
    });
  });

  it("reads and attaches valid history beyond the former cumulative turn ceiling", async () => {
    const sdk = fakeSdk();
    sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    const messages = Array.from({ length: 1_001 }, (_, index) => [
      user(
        `60000000-0000-4000-8000-${String(index * 2 + 1).padStart(12, "0")}`,
        `prompt ${index}`,
      ),
      assistant(
        `60000000-0000-4000-8000-${String(index * 2 + 2).padStart(12, "0")}`,
        `answer ${index}`,
      ),
    ]).flat();
    exposeSessionMessages(sdk, messages);
    const driver = createDriver(sdk);
    const input = {
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
    };

    await expect(driver.read(input)).resolves.toMatchObject({
      snapshot: { orderedBackendTurnIds: expect.any(Array) },
    });
    sdk.getSessionMessages.mockClear();
    const handle = await driver.attach(input);
    const established = await handle.establishProjection({
      signal: new AbortController().signal,
    });
    const acquisitionReads = sdk.getSessionMessages.mock.calls.length;
    expect(acquisitionReads).toBe(1);
    await handle.history({
      ...(established.history.previousCursor
        ? { cursor: established.history.previousCursor }
        : {}),
      limit: 10,
    });
    expect(sdk.getSessionMessages).toHaveBeenCalledTimes(acquisitionReads);
    await handle.close();

    exposeSessionMessages(sdk, [{ session_id: sessionId } as SessionMessage]);
    await expect(driver.read(input)).rejects.toMatchObject({
      category: "incompatible_protocol",
      backendCode: "claude_history_invalid",
      retryable: false,
      safeMessage: "Claude returned incomplete or invalid session history.",
    });
  });

  it("classifies oversized authoritative message text as nonretryable on read and attach", async () => {
    const sdk = fakeSdk();
    sdk.getSessionInfo.mockResolvedValue({ ...session(1), sessionId });
    exposeSessionMessages(sdk, [user(operationId, "x".repeat(16 * 1024 * 1024))]);
    const driver = createDriver(sdk);
    const input = {
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
    };
    for (const operation of [() => driver.read(input), () => driver.attach(input)]) {
      await expect(operation()).rejects.toMatchObject({
        category: "incompatible_protocol",
        backendCode: "claude_message_payload_too_large",
        retryable: false,
      });
    }
  });

  it("classifies a Claude session from another workspace as terminal", async () => {
    const sdk = fakeSdk();
    sdk.getSessionInfo.mockResolvedValue({
      ...session(1),
      sessionId,
      cwd: "/another/workspace",
    });
    const driver = createDriver(sdk);
    const input = {
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
    };

    for (const operation of [
      () => driver.attach(input),
      () => driver.read(input),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        category: "invalid_state",
        backendCode: "claude_session_workspace_mismatch",
        retryable: false,
        safeMessage: "The Claude session belongs to another workspace.",
      });
    }
  });

  it("acquires shared admission before attach and releases it on handle close", async () => {
    const sdk = fakeSdk();
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    const driver = createDriver(sdk, { acquireSession: acquire });
    const handle = await driver.attach({
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
    });
    expect(acquire).toHaveBeenCalledWith(sessionId);
    expect(release).not.toHaveBeenCalled();
    expect(sdk.createQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: {
            HOME: "/operator",
            CLAUDE_CONFIG_DIR: "/operator/.claude",
            // Sedes-owned: every launch reports Claude's own run state.
            CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
          },
        }),
      }),
    );
    await handle.close();
    expect(release).toHaveBeenCalledOnce();
  });

  it("provisions local CLI authority with disabled access and no selected tools", async () => {
    const capabilities = createFakeAgentToolSourceCapabilities();
    const sdk = fakeSdk();
    const driver = createDriver(sdk, {
      sourceCapabilities: capabilities.issuer,
      agentToolCli: {
        availability: "available",
        endpoint: "http://127.0.0.1:4784",
        executableDirectory: "/opt/sedes/bin",
        inheritedPath: "/usr/bin",
      },
    });
    const handle = await driver.attach({
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
    });
    expect(sdk.createQuery.mock.calls[0]![0].options.env).toMatchObject({
      SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY: expect.any(String),
      SEDES_AGENT_TOOL_CLI_MODE: "progressive",
    });
    expect(capabilities.issue).toHaveBeenCalledWith(
      {
        scope,
        sourceThreadId: "thread-1",
        sourceWorkspaceId: workspace.summary.id,
        sourceEnvironmentId: workspace.summary.environmentId,
        backendKind: "claude_agent_sdk",
      },
      "management_http",
      "cli",
    );
    expect(sdk.createQuery.mock.calls[0]![0].options).not.toHaveProperty(
      "mcpServers",
    );
    await handle.close();
    await handle.close();
    expect(capabilities.issue).toHaveBeenCalledOnce();
  });

  it("starts the Sedes MCP server instead of CLI context for Native presentation", async () => {
    const capabilities = createFakeAgentToolSourceCapabilities();
    const sdk = fakeSdk();
    const driver = createDriver(sdk, {
      sourceCapabilities: capabilities.issuer,
      presentation: { surface: "native", mode: "individual" },
      agentToolCli: {
        availability: "available",
        endpoint: "http://127.0.0.1:4784",
        executableDirectory: "/opt/sedes/bin",
        inheritedPath: "/usr/bin",
      },
    });
    const handle = await driver.attach({
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
    });
    const options = sdk.createQuery.mock.calls[0]![0].options;
    // The SDK serializes MCP servers into the CLI command line, so the entry
    // carries only a placeholder that Claude expands from the query env.
    expect(options.mcpServers).toEqual({
      sedes: {
        type: "stdio",
        command: "/opt/sedes/bin/sedes",
        args: ["mcp", "--mode", "individual"],
        env: {
          SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY:
            "${SEDES_AGENT_TOOL_SOURCE_CAPABILITY}",
        },
      },
    });
    expect(JSON.stringify(options.mcpServers)).not.toContain("htr2_");
    expect(
      Object.keys(options.env ?? {}).filter((name) => name.startsWith("SEDES_")),
    ).toEqual(["SEDES_AGENT_TOOL_SOURCE_CAPABILITY"]);
    expect(options.env).toMatchObject({
      HOME: "/operator",
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "htr2_" + "a".repeat(64),
    });
    expect(options.env).not.toHaveProperty("PATH");
    expect(capabilities.issue).toHaveBeenCalledWith(
      expect.objectContaining({ backendKind: "claude_agent_sdk" }),
      "management_http",
      "mcp",
    );
    await handle.close();
  });

  it("runs the sidecar binary as the Native MCP server on a managed host", async () => {
    const sdk = fakeSdk();
    const capabilities = createFakeAgentToolSourceCapabilities();
    const release = vi.fn();
    const driver = createDriver(sdk, {
      sourceCapabilities: capabilities.issuer,
      presentation: { surface: "native", mode: "progressive" },
      agentToolCli: {
        availability: "managed",
        provider: {
          acquire: async () => ({
            availability: "available" as const,
            endpoint: "unix:///home/remote/.local/state/sedes/agent-tools.sock",
            executableDirectory: "/remote/sedes/sidecar",
            inheritedPath: "/remote/usr/bin",
            closed: new Promise<unknown>(() => undefined),
            release,
          }),
        },
      },
    });
    const handle = await driver.attach({
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
    });
    expect(sdk.createQuery.mock.calls[0]![0].options.mcpServers).toMatchObject({
      sedes: {
        command: "/remote/sedes/sidecar/sedes",
        args: ["mcp", "--mode", "progressive"],
        env: {
          SEDES_AGENT_TOOL_ENDPOINT:
            "unix:///home/remote/.local/state/sedes/agent-tools.sock",
        },
      },
    });
    expect(capabilities.issue).toHaveBeenCalledWith(
      expect.any(Object),
      "execution_environment_sidecar",
      "mcp",
    );
    await handle.close();
    expect(release).toHaveBeenCalledOnce();
  });

  it("provisions managed CLI authority with disabled access and no selected tools", async () => {
    const sdk = fakeSdk();
    const capabilities = createFakeAgentToolSourceCapabilities();
    const release = vi.fn();
    const acquire = vi.fn(async () => ({
      availability: "available" as const,
      endpoint: "unix:///home/remote/.local/state/sedes/agent-tools.sock",
      executableDirectory: "/remote/sedes/bin",
      inheritedPath: "/remote/usr/bin",
      closed: new Promise<unknown>(() => undefined),
      release,
    }));
    const driver = createDriver(sdk, {
      sourceCapabilities: capabilities.issuer,
      agentToolCli: {
        availability: "managed",
        provider: { acquire },
      },
    });

    const handle = await driver.attach({
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
    });

    expect(acquire).toHaveBeenCalledOnce();
    expect(sdk.createQuery.mock.calls[0]![0].options.env).toMatchObject({
      SEDES_AGENT_TOOL_ENDPOINT:
        "unix:///home/remote/.local/state/sedes/agent-tools.sock",
      PATH: "/remote/sedes/bin:/remote/usr/bin",
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY: expect.any(String),
      SEDES_AGENT_TOOL_CLI_MODE: "progressive",
    });
    expect(capabilities.issue).toHaveBeenCalledWith(
      expect.any(Object),
      "execution_environment_sidecar",
      "cli",
    );
    expect(release).not.toHaveBeenCalled();
    await handle.close();
    await handle.close();
    expect(release).toHaveBeenCalledOnce();
  });

  it("attaches an all-null imported thread and adopts its observed mode", async () => {
    const sdk = fakeSdk();
    const adopted = vi.fn();
    const driver = createDriver(sdk, {
      importedSettings: true,
      onAdoptPermissionMode: adopted,
    });

    const handle = await driver.attach({
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
    });

    const options = sdk.createQuery.mock.calls[0]![0].options;
    expect(options).not.toHaveProperty("model");
    expect(options).not.toHaveProperty("effort");
    expect(options).not.toHaveProperty("permissionMode");
    expect(adopted).toHaveBeenCalledWith("default");
    await handle.close();
  });

  it("forks an exact older completed turn with an application-reserved child and no model turn", async () => {
    const sdk = fakeSdk();
    const copySkillInvocationsForFork = vi.fn(() => undefined);
    const releaseForkAdmission = vi.fn();
    const acquireForkAdmission = vi.fn(() => releaseForkAdmission);
    const childSessionId = "33333333-3333-4333-8333-333333333333";
    const sourceMessages = Array.from({ length: 12 }, (_, index) => [
      user(
        `40000000-0000-4000-8000-${String(index * 2 + 1).padStart(12, "0")}`,
        `prompt ${index}`,
      ),
      assistant(
        `40000000-0000-4000-8000-${String(index * 2 + 2).padStart(12, "0")}`,
        `answer ${index}`,
      ),
    ]).flat();
    const selectedTurnId = [
      ...projectClaudeHistory(
        sourceMessages,
      ).terminalCheckpointUuidByBackendTurnId.keys(),
    ][0]!;
    const selectedLeaf =
      projectClaudeHistory(
        sourceMessages,
      ).terminalCheckpointUuidByBackendTurnId.get(selectedTurnId)!;
    sdk.getSessionInfo.mockImplementation(async (id) => {
      if (
        id === childSessionId &&
        !sdk.createQuery.mock.calls.some(
          ([call]) => call.options.forkSession === true,
        )
      ) {
        return undefined;
      }
      return {
        sessionId: id,
        summary: "Session",
        lastModified: 1,
        cwd: workspace.canonicalPath,
      };
    });
    sdk.getSessionMessages.mockImplementation(async (id) => {
      const prefix = sourceMessages.slice(
        0,
        sourceMessages.findIndex(({ uuid }) => uuid === selectedLeaf) + 1,
      );
      return id === sessionId
        ? sourceMessages
        : prefix.map((message, index) => ({
            ...message,
            uuid: `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
            session_id: childSessionId,
          }));
    });
    const driver = createDriver(sdk, {
      acquireSession: acquireForkAdmission,
      copySkillInvocationsForFork,
    });
    const checkpoint = await driver.resolveBranchCheckpoint({
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      selection: {
        kind: "selected_completed_turn",
        backendTurnId: selectedTurnId,
        boundary: "completed_turn_inclusive",
      },
    });
    const created = await driver.branchConversation({
      scope,
      childApplicationThreadId: "child-thread",
      applicationOperationId: operationId,
      sourceBinding: binding(),
      sourceOpaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      workspace,
      sourceCheckpoint: checkpoint,
      requestedBackendConversationId: childSessionId,
      inheritedSettings: {
        model: { provider: connection.id, id: "claude-sonnet-5" },
        thinkingLevel: "low",
      },
      source: { kind: "user" },
    });
    expect(created.backendConversationId).toBe(childSessionId);
    expect(acquireForkAdmission).toHaveBeenCalledWith(childSessionId);
    expect(releaseForkAdmission).toHaveBeenCalledOnce();
    expect(sdk.createQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          resume: sessionId,
          forkSession: true,
          sessionId: childSessionId,
          resumeSessionAt: selectedLeaf,
        }),
      }),
    );
    expect(copySkillInvocationsForFork).toHaveBeenCalledWith(scope, {
      sourceApplicationThreadId: "thread-1",
      childApplicationThreadId: "child-thread",
      nativeUserMessageMappings: [
        {
          sourceUuid: "40000000-0000-4000-8000-000000000001",
          childUuid: "50000000-0000-4000-8000-000000000001",
        },
      ],
    });
  });

  it.each([false, true])("copies only retained main-thread tool receipts when fork recovery is %s", async (recover) => {
    const sdk = fakeSdk();
    const copyTaskLifecycleReceiptsForFork = vi.fn(() => undefined);
    const childSessionId = "33333333-3333-4333-8333-333333333333";
    const call = (id: string): SessionMessage => ({ ...assistant(crypto.randomUUID(), ""),
      message: { role: "assistant", content: [{ type: "tool_use", id, name: "Agent", input: { description: "Audit", prompt: "Audit" } }] } });
    const result = (id: string): SessionMessage => ({ ...user(crypto.randomUUID(), ""),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Done" }] } });
    const sourceMessages = [user(operationId, "First"), call("retained-call"), result("retained-call"),
      assistant(crypto.randomUUID(), "First answer"), user(crypto.randomUUID(), "Later"),
      call("excluded-call"), result("excluded-call"), assistant(crypto.randomUUID(), "Later answer")];
    const prefix = sourceMessages.slice(0, 4);
    sdk.getSessionInfo.mockImplementation(async (id) => id === childSessionId && !recover && !sdk.createQuery.mock.calls.length
      ? undefined : { sessionId: id, summary: "Session", lastModified: 1, cwd: workspace.canonicalPath });
    sdk.getSessionMessages.mockImplementation(async (id) => id === sessionId ? sourceMessages
      : prefix.map(message => ({ ...message, uuid: crypto.randomUUID(), session_id: childSessionId })));
    const driver = createDriver(sdk, { copyTaskLifecycleReceiptsForFork });
    const selectedTurnId = [...projectClaudeHistory(sourceMessages).terminalCheckpointUuidByBackendTurnId.keys()][0]!;
    const checkpoint = await driver.resolveBranchCheckpoint({ scope, workspace, binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      selection: { kind: "selected_completed_turn", backendTurnId: selectedTurnId, boundary: "completed_turn_inclusive" } });
    await driver.branchConversation({ scope, workspace, childApplicationThreadId: "child-thread", applicationOperationId: operationId,
      sourceBinding: binding(), sourceOpaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      sourceCheckpoint: checkpoint, requestedBackendConversationId: childSessionId,
      inheritedSettings: { model: { provider: connection.id, id: "claude-sonnet-5" }, thinkingLevel: "low" }, source: { kind: "user" } });
    expect(copyTaskLifecycleReceiptsForFork).toHaveBeenCalledExactlyOnceWith(scope, {
      sourceApplicationThreadId: "thread-1", sourceNativeSessionId: sessionId,
      childApplicationThreadId: "child-thread", childNativeSessionId: childSessionId,
      nativeToolUseIds: new Set(["retained-call"]),
    });
  });

  it("forks a compacted conversation only after its latest summary and verifies the child from there", async () => {
    const sdk = fakeSdk();
    const copyTaskLifecycleReceiptsForFork = vi.fn(() => undefined);
    const childSessionId = "33333333-3333-4333-8333-333333333333";
    const call = (id: string): SessionMessage => ({ ...assistant(crypto.randomUUID(), ""),
      message: { role: "assistant", content: [{ type: "tool_use", id, name: "Agent", input: { description: "Audit", prompt: "Audit" } }] } });
    const result = (id: string): SessionMessage => ({ ...user(crypto.randomUUID(), ""),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Done" }] } });
    const summary = { ...user(crypto.randomUUID(), "This session is being continued. Summary: synthetic."), isCompactSummary: true } as SessionMessage;
    // Sedes reads across the boundary; Claude Code resumes, and copies, only from the summary.
    const sourceMessages = [user(operationId, "First"), call("summarized-call"), result("summarized-call"),
      assistant(crypto.randomUUID(), "First answer"), user(crypto.randomUUID(), "Later"), summary,
      call("retained-call"), result("retained-call"), assistant(crypto.randomUUID(), "Later answer")];
    const resumable = sourceMessages.slice(5);
    sdk.getSessionInfo.mockImplementation(async (id) => id === childSessionId && !sdk.createQuery.mock.calls.length
      ? undefined : { sessionId: id, summary: "Session", lastModified: 1, cwd: workspace.canonicalPath });
    sdk.getSessionMessages.mockImplementation(async (id) => id === sessionId ? sourceMessages
      : resumable.map(message => ({ ...message, session_id: childSessionId })));
    const driver = createDriver(sdk, { copyTaskLifecycleReceiptsForFork });
    const [summarizedTurn, compactedTurn] = projectClaudeHistory(sourceMessages).snapshot.orderedBackendTurnIds;
    const resolve = (backendTurnId: string) => driver.resolveBranchCheckpoint({ scope, workspace, binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      selection: { kind: "selected_completed_turn", backendTurnId, boundary: "completed_turn_inclusive" } });
    await expect(resolve(summarizedTurn!)).rejects.toMatchObject({ backendCode: "claude_fork_checkpoint_unavailable" });
    const checkpoint = await resolve(compactedTurn!);
    expect(JSON.parse(Buffer.from(checkpoint.opaqueReference, "base64url").toString())).toMatchObject({ retainedPrefixCount: resumable.length });
    await driver.branchConversation({ scope, workspace, childApplicationThreadId: "child-thread", applicationOperationId: operationId,
      sourceBinding: binding(), sourceOpaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      sourceCheckpoint: checkpoint, requestedBackendConversationId: childSessionId,
      inheritedSettings: { model: { provider: connection.id, id: "claude-sonnet-5" }, thinkingLevel: "low" }, source: { kind: "user" } });
    expect(copyTaskLifecycleReceiptsForFork).toHaveBeenCalledExactlyOnceWith(scope, expect.objectContaining({
      nativeToolUseIds: new Set(["retained-call"]) }));
  });

  it("rejects provider-snapshot checkpoints before reading Claude history", async () => {
    const sdk = fakeSdk();
    const driver = createDriver(sdk);

    await expect(
      driver.resolveBranchCheckpoint({
        scope,
        workspace,
        binding: binding(),
        opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
        selection: { kind: "latest_provider_snapshot" },
      }),
    ).rejects.toMatchObject({
      category: "invalid_state",
      backendCode: "claude_provider_snapshot_fork_unsupported",
      retryable: false,
      crossedSubmissionBoundary: false,
    });
    expect(sdk.getSessionMessages).not.toHaveBeenCalled();
  });

  it("recovers an existing reserved child idempotently and rejects a semantic identity conflict", async () => {
    const sdk = fakeSdk();
    const copySkillInvocationsForFork = vi.fn(() => undefined);
    const childSessionId = "33333333-3333-4333-8333-333333333333";
    const childUserUuid = "55555555-5555-4555-8555-555555555555";
    const sourceMessages = [
      user(operationId, "prompt"),
      assistant("44444444-4444-4444-8444-444444444444", "answer"),
    ];
    let childText = "answer";
    sdk.getSessionInfo.mockImplementation(async (id) => ({
      sessionId: id,
      summary: "Session",
      lastModified: 1,
      cwd: workspace.canonicalPath,
    }));
    sdk.getSessionMessages.mockImplementation(async (id) =>
      id === sessionId
        ? sourceMessages
        : [
            { ...user(childUserUuid, "prompt"), session_id: id },
            {
              ...assistant(crypto.randomUUID(), childText),
              session_id: id,
            },
          ],
    );
    const driver = createDriver(sdk, { copySkillInvocationsForFork });
    const checkpoint = await driver.resolveBranchCheckpoint({
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      selection: { kind: "latest_completed" },
    });
    const branchInput = {
      scope,
      childApplicationThreadId: "child-thread",
      applicationOperationId: operationId,
      sourceBinding: binding(),
      sourceOpaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      workspace,
      sourceCheckpoint: checkpoint,
      requestedBackendConversationId: childSessionId,
      inheritedSettings: {
        model: { provider: connection.id, id: "claude-sonnet-5" },
        thinkingLevel: "low",
      },
      source: { kind: "user" as const },
    };
    await expect(driver.branchConversation(branchInput)).resolves.toMatchObject(
      { backendConversationId: childSessionId },
    );
    expect(sdk.createQuery).not.toHaveBeenCalled();
    expect(copySkillInvocationsForFork).toHaveBeenCalledWith(scope, {
      sourceApplicationThreadId: "thread-1",
      childApplicationThreadId: "child-thread",
      nativeUserMessageMappings: [
        { sourceUuid: operationId, childUuid: childUserUuid },
      ],
    });

    childText = "different history";
    await expect(driver.branchConversation(branchInput)).rejects.toMatchObject({
      category: "invalid_state",
      backendCode: "claude_fork_identity_conflict",
      crossedSubmissionBoundary: false,
    });
  });

  it.each([
    [
      "model mismatch",
      { streamModel: "claude-opus-5" },
      "claude_fork_effective_settings_mismatch",
    ],
    [
      "permission mismatch",
      { streamPermissionMode: "acceptEdits" as const },
      "claude_fork_effective_settings_mismatch",
    ],
    [
      "effort rejection",
      { effortError: new Error("effort rejected") },
      "claude_fork_effort_unconfirmed",
    ],
  ])("fails a new fork closed on %s", async (_label, options, backendCode) => {
    const sdk = fakeSdk(options);
    const childSessionId = "33333333-3333-4333-8333-333333333333";
    const sourceMessages = [
      user(operationId, "prompt"),
      assistant("44444444-4444-4444-8444-444444444444", "answer"),
    ];
    sdk.getSessionInfo.mockImplementation(async (id) =>
      id === childSessionId && sdk.createQuery.mock.calls.length === 0
        ? undefined
        : {
            sessionId: id,
            summary: "Session",
            lastModified: 1,
            cwd: workspace.canonicalPath,
          },
    );
    sdk.getSessionMessages.mockImplementation(async (id) =>
      id === sessionId
        ? sourceMessages
        : sourceMessages.map((message) => ({
            ...message,
            session_id: childSessionId,
          })),
    );
    const driver = createDriver(sdk);
    const checkpoint = await driver.resolveBranchCheckpoint({
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      selection: { kind: "latest_completed" },
    });

    await expect(
      driver.branchConversation({
        scope,
        childApplicationThreadId: "child-thread",
        applicationOperationId: operationId,
        sourceBinding: binding(),
        sourceOpaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
        workspace,
        sourceCheckpoint: checkpoint,
        requestedBackendConversationId: childSessionId,
        inheritedSettings: {
          model: { provider: connection.id, id: "claude-sonnet-5" },
          thinkingLevel: "low",
        },
        source: { kind: "user" },
      }),
    ).rejects.toMatchObject({ backendCode, crossedSubmissionBoundary: false });
  });

  it("rejects source-prefix drift before mutation and denies attachment-ended checkpoints", async () => {
    const sdk = fakeSdk();
    const sourceMessages = [
      user(operationId, "prompt"),
      assistant("44444444-4444-4444-8444-444444444444", "answer"),
    ];
    sdk.getSessionInfo.mockImplementation(async (id) => ({
      sessionId: id,
      summary: "Session",
      lastModified: 1,
      cwd: workspace.canonicalPath,
    }));
    sdk.getSessionMessages.mockImplementation(async () => sourceMessages);
    const driver = createDriver(sdk);
    const checkpoint = await driver.resolveBranchCheckpoint({
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      selection: { kind: "latest_completed" },
    });
    sourceMessages[1] = assistant(
      "44444444-4444-4444-8444-444444444444",
      "changed after capture",
    );
    await expect(
      driver.branchConversation({
        scope,
        childApplicationThreadId: "child-thread",
        applicationOperationId: operationId,
        sourceBinding: binding(),
        sourceOpaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
        workspace,
        sourceCheckpoint: checkpoint,
        requestedBackendConversationId: "33333333-3333-4333-8333-333333333333",
        inheritedSettings: {
          model: { provider: connection.id, id: "claude-sonnet-5" },
          thinkingLevel: "low",
        },
        source: { kind: "user" },
      }),
    ).rejects.toMatchObject({
      backendCode: "claude_fork_checkpoint_changed",
      crossedSubmissionBoundary: false,
    });
    expect(sdk.createQuery).not.toHaveBeenCalled();

    const toolMessages: SessionMessage[] = [
      user("88888888-8888-4888-8888-888888888888", "ordinary prompt"),
      assistant("99999999-9999-4999-8999-999999999999", "ordinary answer"),
      user(operationId, "structured output"),
      {
        type: "assistant",
        uuid: "66666666-6666-4666-8666-666666666666",
        session_id: sessionId,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool-1", name: "Result", input: {} },
          ],
          usage: {},
        },
      },
      {
        type: "user",
        uuid: "77777777-7777-4777-8777-777777777777",
        session_id: sessionId,
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
          ],
        },
      },
    ];
    sdk.getSessionMessages.mockImplementation(async () => toolMessages);
    await expect(
      driver.resolveBranchCheckpoint({
        scope,
        workspace,
        binding: binding(),
        opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
        selection: { kind: "latest_completed" },
      }),
    ).rejects.toMatchObject({
      backendCode: "claude_fork_checkpoint_unavailable",
    });
  });

  it("classifies a failed fork boot as crossed and releases child admission", async () => {
    const sdk = fakeSdk();
    const childSessionId = "33333333-3333-4333-8333-333333333333";
    const sourceMessages = [
      user(operationId, "prompt"),
      assistant("44444444-4444-4444-8444-444444444444", "answer"),
    ];
    sdk.getSessionInfo.mockImplementation(async (id) =>
      id === childSessionId
        ? undefined
        : {
            sessionId: id,
            summary: "Source",
            lastModified: 1,
            cwd: workspace.canonicalPath,
          },
    );
    sdk.getSessionMessages.mockImplementation(async () => sourceMessages);
    sdk.createQuery.mockImplementation(() => {
      throw new Error("fork boot failed after admission");
    });
    const release = vi.fn();
    const driver = createDriver(sdk, { acquireSession: () => release });
    const checkpoint = await driver.resolveBranchCheckpoint({
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      selection: { kind: "latest_completed" },
    });
    await expect(
      driver.branchConversation({
        scope,
        childApplicationThreadId: "child-thread",
        applicationOperationId: operationId,
        sourceBinding: binding(),
        sourceOpaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
        workspace,
        sourceCheckpoint: checkpoint,
        requestedBackendConversationId: childSessionId,
        inheritedSettings: {
          model: { provider: connection.id, id: "claude-sonnet-5" },
          thinkingLevel: "low",
        },
        source: {
          kind: "automation",
          automationId: "automation-1",
          automationRunId: "run-1",
        },
      }),
    ).rejects.toMatchObject({
      category: "submission_unknown",
      backendCode: "claude_fork_outcome_unknown",
      crossedSubmissionBoundary: true,
      retryable: false,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("classifies a post-fork verification read failure as crossed", async () => {
    const sdk = fakeSdk();
    const childSessionId = "33333333-3333-4333-8333-333333333333";
    const sourceMessages = [
      user(operationId, "prompt"),
      assistant("44444444-4444-4444-8444-444444444444", "answer"),
    ];
    sdk.getSessionInfo.mockImplementation(async (id) => {
      if (
        id === childSessionId &&
        !sdk.createQuery.mock.calls.some(
          ([call]) => call.options.forkSession === true,
        )
      ) {
        return undefined;
      }
      return {
        sessionId: id,
        summary: "Session",
        lastModified: 1,
        cwd: workspace.canonicalPath,
      };
    });
    sdk.getSessionMessages.mockImplementation(async (id) => {
      if (id === childSessionId) {
        throw new BackendError({
          category: "not_found",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "The fork child is not visible yet.",
          backendCode: "claude_session_not_found",
        });
      }
      return sourceMessages;
    });
    const release = vi.fn();
    const driver = createDriver(sdk, { acquireSession: () => release });
    const checkpoint = await driver.resolveBranchCheckpoint({
      scope,
      workspace,
      binding: binding(),
      opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      selection: { kind: "latest_completed" },
    });

    await expect(
      driver.branchConversation({
        scope,
        childApplicationThreadId: "child-thread",
        applicationOperationId: operationId,
        sourceBinding: binding(),
        sourceOpaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
        workspace,
        sourceCheckpoint: checkpoint,
        requestedBackendConversationId: childSessionId,
        inheritedSettings: {
          model: { provider: connection.id, id: "claude-sonnet-5" },
          thinkingLevel: "low",
        },
        source: { kind: "user" },
      }),
    ).rejects.toMatchObject({
      category: "submission_unknown",
      backendCode: "claude_fork_outcome_unknown",
      crossedSubmissionBoundary: true,
      retryable: false,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails closed for a wrong principal scope", async () => {
    const driver = createDriver(fakeSdk());
    await expect(
      driver.read({
        scope: { ...scope, principalId: "other" },
        workspace,
        binding: binding(),
        opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }),
      }),
    ).rejects.toBeInstanceOf(BackendError);
  });
});

describe("ClaudeConversationBackendDriver native history", () => {
  let configDirectory: string;

  beforeEach(async () => {
    configDirectory = await realpath(await mkdtemp(path.join(tmpdir(), "sedes-claude-driver-native-")));
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDirectory);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(configDirectory, { recursive: true, force: true });
  });

  /** Query fakes over the real native store: SDK session info and Sedes' tip-correct reader. */
  function nativeStoreDriver(options: Parameters<typeof createDriver>[1] = {}) {
    const sdk = fakeSdk();
    const native = new OfficialClaudeSdkFacade();
    sdk.getSessionInfo.mockImplementation((...input) => native.getSessionInfo(...input));
    sdk.getSessionMessages.mockImplementation((...input) => native.getSessionMessages(...input));
    sdk.hasSessionTranscript.mockImplementation((...input) => native.hasSessionTranscript(...input));
    const driver = createDriver(sdk, { ...options, childEnvironment: { HOME: "/operator", CLAUDE_CONFIG_DIR: configDirectory } });
    return { sdk, driver };
  }

  function transcript(id = sessionId): ClaudeTranscriptFixture {
    const fixture = new ClaudeTranscriptFixture(workspace.canonicalPath);
    Object.defineProperty(fixture, "sessionId", { value: id });
    return fixture;
  }

  const attachment = () => ({ scope, workspace, binding: binding(), opaqueBindingDetail: JSON.stringify({ version: 1, sessionId }) });

  it("resumes and reads a session whose transcript holds only startup messages", async () => {
    const fixture = transcript();
    fixture.startupMessage();
    await fixture.write(configDirectory, workspace.canonicalPath);
    const { sdk, driver } = nativeStoreDriver();
    // The SDK exposes no metadata for this transcript, but Claude Code rejects a fresh launch reusing its ID.
    await expect(sdk.getSessionInfo(sessionId, { dir: workspace.canonicalPath }, process.env)).resolves.toBeUndefined();

    await expect(driver.read(attachment())).resolves.toMatchObject({ snapshot: { orderedBackendTurnIds: [] } });
    const handle = await driver.attach(attachment());
    try {
      const options = sdk.createQuery.mock.calls.at(-1)![0].options;
      expect(options).toMatchObject({ resume: sessionId });
      expect(options).not.toHaveProperty("sessionId");
      expect(sdk.getSessionMessages).toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it("launches a new session only when no native transcript exists", async () => {
    const { sdk, driver } = nativeStoreDriver();
    await expect(driver.read(attachment())).rejects.toMatchObject({ backendCode: "claude_session_not_found" });
    const handle = await driver.attach(attachment());
    try {
      const options = sdk.createQuery.mock.calls.at(-1)![0].options;
      expect(options).toMatchObject({ sessionId });
      expect(options).not.toHaveProperty("resume");
      expect(sdk.getSessionMessages).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it("resolves creation reconciliation from a transcript holding only the startup message", async () => {
    const fixture = transcript();
    fixture.startupMessage();
    await fixture.write(configDirectory, workspace.canonicalPath);
    const { driver } = nativeStoreDriver();
    const input = { ...attachment(), applicationOperationId: operationId, retryAnchor: retryAnchor([]) };
    // The first prompt never reached the transcript before its process ended.
    await expect(driver.reconcileSubmission(input)).resolves.toEqual({ status: "not_accepted", retryable: true });

    fixture.prompt("First prompt.", { uuid: operationId });
    fixture.text("First answer.");
    await fixture.write(configDirectory, workspace.canonicalPath);
    await expect(driver.reconcileSubmission(input)).resolves.toMatchObject({ status: "accepted" });
  });

  it("never authorizes a resend of a prompt persisted before a later startup message", async () => {
    // Earlier turns with parallel tool calls leave dead-end tool results.
    const fixture = transcript();
    fixture.startupMessage();
    fixture.prompt("Survey the synthetic repository.");
    fixture.parallelToolCalls("survey");
    fixture.text("Two modules found.");
    fixture.startupMessage();
    fixture.prompt("Compare them.");
    fixture.parallelToolCalls("compare");
    fixture.text("They differ in one function.");
    fixture.startupMessage();
    await fixture.write(configDirectory, workspace.canonicalPath);
    const { driver } = nativeStoreDriver();
    const view = await readViaDriver(driver);
    // The SDK's leaf heuristic reads this transcript only to its last dead end.
    const sdkView = await getSessionMessages(sessionId, { dir: workspace.canonicalPath });
    expect(sdkView.length).toBeLessThan(view.length);

    // Sedes submits; Claude Code persists the prompt, then the process dies
    // before replying. The next attach appends another startup message.
    fixture.prompt("Rename the differing function.", { uuid: operationId });
    fixture.startupMessage();
    await fixture.write(configDirectory, workspace.canonicalPath);
    // The SDK's truncated view still matches an anchor captured from itself.
    expect(uuids(await getSessionMessages(sessionId, { dir: workspace.canonicalPath }))).toEqual(uuids(sdkView));

    for (const anchor of [retryAnchor(view), retryAnchor(sdkView)]) {
      await expect(driver.reconcileSubmission({ ...attachment(), applicationOperationId: operationId, retryAnchor: anchor }))
        .resolves.toMatchObject({ status: "accepted", backendTurn: { completionCorrelations: [operationId] } });
    }
  });

  it("reconciles a prompt Claude Code closed unanswered on resume as interrupted, not completed", async () => {
    const fixture = transcript();
    fixture.startupMessage();
    const anchor = retryAnchor([]);
    fixture.prompt("Rename the synthetic function.", { uuid: operationId });
    // The process died before replying; the next attach resumes the session.
    expect(fixture.resume().closure).toBeDefined();
    await fixture.write(configDirectory, workspace.canonicalPath);
    const { driver } = nativeStoreDriver();
    const reconciled = await driver.reconcileSubmission({ ...attachment(), applicationOperationId: operationId, retryAnchor: anchor });
    expect(reconciled).toMatchObject({ status: "accepted", backendTurn: { status: "interrupted", completionCorrelations: [operationId] } });
    expect(reconciled.status === "accepted" && reconciled.completionIdentity).toMatch(/:interrupted$/u);
    expect(JSON.stringify(reconciled)).not.toContain("No response requested.");
  });

  async function readViaDriver(driver: ClaudeConversationBackendDriver): Promise<SessionMessage[]> {
    const native = new OfficialClaudeSdkFacade();
    await driver.read(attachment());
    return await native.getSessionMessages(sessionId, { dir: workspace.canonicalPath }, process.env);
  }
});

function uuids(messages: readonly SessionMessage[]): string[] {
  return messages.map(({ uuid }) => uuid);
}

function createDriver(
  sdk: ReturnType<typeof fakeSdk>,
  options: {
    readonly acquireSession?: (sessionId: string) => () => void;
    readonly importedSettings?: boolean;
    readonly confirmSettings?: boolean;
    readonly onAdoptPermissionMode?: (mode: string) => void;
    readonly modelPolicy?: BackendModelPolicy;
    readonly agentToolCli?: AgentToolCliAvailability;
    readonly presentation?: ReturnType<BackendAgentToolFacade["readPolicy"]>["presentation"];
    readonly sourceCapabilities?: AgentToolSourceCapabilityIssuer;
    readonly copySkillInvocationsForFork?: ClaudeThreadRepository["copySkillInvocationsForFork"];
    readonly copyTaskLifecycleReceiptsForFork?: ClaudeThreadRepository["copyTaskLifecycleReceiptsForFork"];
    readonly submissionDisposition?: ClaudeRuntimeClient["submissionDisposition"];
    readonly steerOperations?: ReadonlyMap<string, string | null>;
    readonly forgetUnconsumedSteerOperation?: ClaudeThreadRepository["forgetUnconsumedSteerOperation"];
    readonly childEnvironment?: Readonly<Record<string, string | undefined>>;
  } = {},
) {
  let settingsRecord: Partial<ReturnType<ClaudeThreadRepository["get"]>> & {
    model: string | null;
    effort: string | null;
    permissionMode: ClaudePermissionMode | null;
    revision: number;
    effectiveModelGeneration: number | null;
    effectiveEffortGeneration: number | null;
    effectivePermissionGeneration: number | null;
  } = {
    model: options.importedSettings ? null : "claude-sonnet-5",
    effort: options.importedSettings ? null : "low",
    permissionMode: options.importedSettings ? null : ("default" as const),
    revision: 0,
    effectiveModelGeneration: null,
    effectiveEffortGeneration: null,
    effectivePermissionGeneration: null,
  };
  return new ClaudeConversationBackendDriver({
      usage: NO_USAGE_SINK,
      nativeNamespace: "claude-test-native",
    instance,
    connection,
    runtimeClient: Object.assign(new ClaudeSdkRuntimeAdapter(sdk), {
      ...(options.submissionDisposition ? { submissionDisposition: options.submissionDisposition } : {}),
    }),
    executablePath: "/usr/local/bin/claude",
    initializationTimeoutMs: 1_000,
    probeDirectory: "/operator/.claude",
    permissionPolicy: { allowedModes: ["default"] },
    modelPolicy: compileBackendModelPolicy(
      options.modelPolicy ?? { type: "catalog" },
      "model_effort",
    ),
    toolProvenanceKey: new Uint8Array(32).fill(7),
    agentToolSourceCapabilities:
      options.sourceCapabilities ?? agentToolSourceCapabilities,
    agentTools: options.presentation
      ? {
          ...agentTools,
          readPolicy: () => ({
            ...agentTools.readPolicy(undefined as never),
            presentation: options.presentation!,
          }),
        }
      : agentTools,
    ...(options.agentToolCli ? { agentToolCli: options.agentToolCli } : {}),
    attachmentProvenanceKey: new Uint8Array(32).fill(0x42),
    childEnvironment: options.childEnvironment ?? {
      HOME: "/operator",
      CLAUDE_CONFIG_DIR: "/operator/.claude",
    },
    settings: {
      get: vi.fn(() => settingsRecord),
      markEffectiveUnknown: vi.fn(() => settingsRecord),
      confirmEffectiveModel: vi.fn((_scope, _threadId, input) => {
        if (options.confirmSettings) Object.assign(settingsRecord, { effectiveModel: input.model, effectiveModelState: "confirmed", effectiveModelGeneration: input.queryGeneration });
        return settingsRecord;
      }),
      confirmEffectiveEffort: vi.fn((_scope, _threadId, input) => {
        if (options.confirmSettings) Object.assign(settingsRecord, { effectiveEffort: input.effort, effectiveEffortState: "confirmed", effectiveEffortGeneration: input.queryGeneration });
        return settingsRecord;
      }),
      confirmEffectivePermissionMode: vi.fn((_scope, _threadId, input) => {
        if (options.confirmSettings) Object.assign(settingsRecord, { effectivePermissionMode: input.permissionMode, effectivePermissionState: "confirmed", effectivePermissionClassification: "recognized", effectivePermissionGeneration: input.queryGeneration });
        return settingsRecord;
      }),
      adoptImportedPermissionMode: vi.fn((_scope, _threadId, input) => {
        options.onAdoptPermissionMode?.(input.permissionMode);
        settingsRecord = {
          ...settingsRecord,
          permissionMode: input.permissionMode,
          revision: settingsRecord.revision + 1,
          effectivePermissionGeneration: input.queryGeneration,
        };
        return settingsRecord;
      }),
      freezeOperationSnapshot: vi.fn((_scope, input) => ({
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        applicationThreadId: input.applicationThreadId,
        applicationOperationId: input.applicationOperationId,
        settingsRevision: 0,
        model: "claude-sonnet-5",
        effort: "low",
        permissionMode: "default",
        createdAt: 0,
      })),
      hasOperationSnapshot: vi.fn(() => false),
      copyOperationSnapshotsForFork: vi.fn(() => undefined),
      findSkillInvocation: vi.fn(() => undefined),
      copySkillInvocationsForFork:
        options.copySkillInvocationsForFork ?? vi.fn(() => undefined),
      copyTaskLifecycleReceiptsForFork: options.copyTaskLifecycleReceiptsForFork ?? vi.fn(() => undefined),
      listTaskLifecycleReceipts: vi.fn(() => []),
      listSteerOperations: vi.fn(() => new Map(options.steerOperations ?? [])),
      recordSteerOperation: vi.fn(),
      forgetUnconsumedSteerOperation: options.forgetUnconsumedSteerOperation ?? vi.fn(),
      copySteerOperationsForFork: vi.fn(),
      associateSteerOperation: vi.fn(),
      listTerminalReceipts: vi.fn(() => []),
      findTerminalReceipt: vi.fn(() => undefined),
      findUsageLedger: vi.fn(() => undefined),
      writeUsageLedger: vi.fn((_scope, applicationThreadId, usage) => ({
        tenantId: scope.tenantId,
        ownerPrincipalId: scope.principalId,
        applicationThreadId,
        ...usage,
        updatedAt: usage.now,
      })),
    } as unknown as ClaudeThreadRepository,
    ...(options.acquireSession
      ? { acquireSession: options.acquireSession }
      : {}),
    now: () => "2026-08-08T12:00:00.000Z",
  });
}

function fakeSdk(
  options: {
    readonly streamModel?: string;
    readonly streamPermissionMode?: "default" | "acceptEdits";
    readonly effortError?: Error;
    readonly streamSkills?: readonly string[];
    readonly terminalCommands?: readonly string[];
    readonly includeEffortless?: boolean;
    readonly defaultAliasEfforts?: readonly EffortLevel[];
  } = {},
) {
  const initialization = {
    commands: [
      {
        name: "review",
        description: "Review changes",
        argumentHint: "<path>",
      },
    ],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: [
      {
        value: "default",
        resolvedModel: "claude-sonnet-5",
        displayName: "Claude Sonnet 5",
        description: "Balanced",
        supportsEffort: true,
        supportedEffortLevels: [
          ...(options.defaultAliasEfforts ?? ["low", "medium", "high"]),
        ],
      },
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet alias",
        description: "Alias",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
      },
      ...(options.includeEffortless
        ? [
            {
              value: "haiku",
              resolvedModel: "claude-haiku-4-5",
              displayName: "Haiku",
              description: "Fast",
              supportsEffort: false,
              supportedEffortLevels: [],
            },
          ]
        : []),
    ],
    account: {
      apiProvider: "firstParty",
      subscriptionType: "Claude Max",
      tokenSource: "oauth",
    },
  } satisfies SDKControlInitializeResponse;
  const sdk = {
    readCliRelease: vi.fn(async () => "2.1.283"),
    readCliAuthStatus: vi.fn(async () => ({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      subscriptionType: "Claude Max",
    })),
    createQuery: vi.fn((input: ClaudeQueryInput) => {
      const querySessionId =
        input.options.sessionId ?? input.options.resume ?? sessionId;
      let close!: () => void;
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
      const stream = (async function* (): AsyncGenerator<SDKMessage, void> {
        yield {
          type: "system",
          subtype: "init",
          apiKeySource: "oauth",
          claude_code_version: "2.1.283",
          cwd: "/workspace",
          tools: [],
          mcp_servers: [],
          model: options.streamModel ?? "claude-sonnet-5",
          permissionMode: options.streamPermissionMode ?? "default",
          slash_commands: options.streamSkills ? [...options.streamSkills] : [],
          ...(options.terminalCommands
            ? { terminal_slash_commands: [...options.terminalCommands] }
            : {}),
          output_style: "default",
          skills: options.streamSkills ? [...options.streamSkills] : [],
          plugins: [],
          uuid: crypto.randomUUID(),
          session_id: querySessionId,
        };
        await closed;
      })();
      return Object.assign(stream, {
        initializationResult: async () => initialization,
        setModel: vi.fn(async () => undefined),
        setPermissionMode: vi.fn(async () => undefined),
        applyFlagSettings: vi.fn(async () => {
          if (options.effortError) throw options.effortError;
        }),
        close,
      }) as unknown as Query;
    }),
    listSessions: vi.fn<ClaudeSdkFacade["listSessions"]>(async () => []),
    getSessionInfo: vi.fn<ClaudeSdkFacade["getSessionInfo"]>(
      async () => undefined,
    ),
    getSessionMessages: vi.fn<ClaudeSdkFacade["getSessionMessages"]>(
      async () => [],
    ),
    hasSessionTranscript: vi.fn<ClaudeSdkFacade["hasSessionTranscript"]>(
      async () => false,
    ),
    renameSession: vi.fn<ClaudeSdkFacade["renameSession"]>(
      async () => undefined,
    ),
  } satisfies ClaudeSdkFacade;
  return sdk;
}

/** Inputs written to the unread fake query, excluding the startup probe. */
function nativeInputCount(sdk: ReturnType<typeof fakeSdk>): number {
  return (sdk.createQuery.mock.calls.at(-1)![0].prompt as ClaudeInputQueue<unknown>).size - 1;
}

function exposeSessionMessages(
  sdk: ReturnType<typeof fakeSdk>,
  messages: readonly SessionMessage[],
): void {
  sdk.getSessionMessages.mockImplementation(async (_id, options) => {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? messages.length;
    return messages.slice(offset, offset + limit);
  });
}

function binding(): ConversationBinding {
  return {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    applicationThreadId: "thread-1",
    backendConversationId: sessionId,
    backendInstanceId: instance.id,
    connectionProfileId: connection.id,
    executionEnvironmentId: connection.executionEnvironmentId,
    createdAt: "2026-08-08T12:00:00.000Z",
  };
}

function session(index: number): SDKSessionInfo {
  return {
    sessionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    summary: `Session ${index}`,
    lastModified: Date.UTC(2026, 7, 8, 12, index),
    cwd: workspace.canonicalPath,
  };
}

function user(uuid: string, text: string): SessionMessage {
  return {
    type: "user",
    uuid,
    session_id: sessionId,
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    parent_agent_id: null,
  };
}

function assistant(uuid: string, text: string): SessionMessage {
  return {
    type: "assistant",
    uuid,
    session_id: sessionId,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    parent_tool_use_id: null,
    parent_agent_id: null,
  };
}

function retryAnchor(messages: readonly SessionMessage[]): string {
  const hash = createHash("sha256");
  for (const message of messages) hash.update(message.uuid).update("\0");
  return JSON.stringify({
    version: 1,
    messageCount: messages.length,
    lastMessageUuid: messages.at(-1)?.uuid ?? null,
    transcriptFingerprint: hash.digest("base64url"),
  });
}
