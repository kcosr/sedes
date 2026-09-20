import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseGrokBackendConfiguration } from "../../src/server/backends/grok/grok-backend-configuration.js";
import { grokNativeNamespaceKey } from "../../src/server/backends/grok/grok-native-namespace.js";
import { GrokOwnedStdioTransportFactory } from "../../src/server/backends/grok/grok-owned-stdio-transport.js";
import {
  GROK_ACP_REVIEWED_PROFILE_FLOOR,
  GROK_RUNTIME_TESTED_THROUGH_VERSION,
} from "../../src/server/backends/grok/grok-release-guard.js";
import { resolveGrokWorkspaceRuntimeConfiguration } from "../../src/server/backends/grok/grok-runtime-config.js";
import { GrokSessionLifecycle } from "../../src/server/backends/grok/grok-session-lifecycle.js";
import { GrokSessionRegistry } from "../../src/server/backends/grok/grok-session-registry.js";
import {
  projectGrokLatestHistory,
  recoverableInterruptedGrokPromptId,
} from "../../src/server/backends/grok/grok-normalized-history.js";
import { grokSubmissionPromptId } from "../../src/server/backends/grok/grok-submission-correlation.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import type {
  FramedMessageTransport,
  InboundTextFrame,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";

const LIVE_GATE = "SEDES_REAL_GROK";
const EXECUTABLE_OVERRIDE = "SEDES_REAL_GROK_EXECUTABLE";
const LIVE_DEADLINE_MILLISECONDS = 240_000;
const INTERRUPTED_RECOVERY_EVIDENCE_DEADLINE_MILLISECONDS = 30_000;
const TOOL_CANARY = "sedes-grok-unrestricted-canary";
const PROMPT_CANARY =
  "Use the terminal to run `printf '%02048d\\n' 0 && printf 'sedes-grok-unrestricted-canary' > unrestricted-canary.txt`, then reply with exactly `sedes-grok-unrestricted-canary`.";
const SUBAGENT_CANARY = "sedes-grok-subagent-canary";
const SUBAGENT_PROMPT =
  "Use the Task tool to launch exactly one reviewer subagent. Ask it to read unrestricted-canary.txt and report its contents. Wait for it to finish, then reply with exactly `sedes-grok-subagent-canary`.";
const INTERRUPT_PROMPT =
  "Use the terminal to run `sleep 30`, then reply with exactly `this response should be interrupted`.";
const temporaryRoots: string[] = [];

function startPromptText(
  lifecycle: GrokSessionLifecycle,
  sessionId: string,
  promptId: string,
  text: string,
  input?: { readonly signal?: AbortSignal },
) {
  return lifecycle.startPrompt(
    sessionId,
    promptId,
    [{ type: "text", text }],
    input,
  );
}

const scope = Object.freeze({
  tenantId: "real-grok-tenant",
  principalId: "real-grok-principal",
});
const backendInstanceId = "real-grok-instance";
const connectionProfileId = "real-grok-connection";
const executionEnvironmentId = "real-grok-local-environment";

afterAll(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe.sequential("real Grok native-account lifecycle", () => {
  it("prompts once and reconstructs durable history in a second process", async () => {
    const executablePath = requireLiveExecutable();
    const root = await mkdtemp(
      path.join(os.tmpdir(), "sedes-real-grok-lifecycle-"),
    );
    temporaryRoots.push(root);
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    const workspace = await realpath(workspacePath);
    const ambientEnvironment = Object.freeze({ ...process.env });

    const configuration = parseGrokBackendConfiguration({
      backend: {
        id: backendInstanceId,
        kind: "grok_build",
        enabled: true,
        modelPolicy: { type: "catalog" },
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
          kind: "grok_acp",
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
      executionEnvironments: [{ id: executionEnvironmentId, kind: "local" }],
    });
    const channels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId,
      environment: ambientEnvironment,
    });
    const controller = new AbortController();
    const deadline = setTimeout(
      () =>
        controller.abort(new Error("real_grok_lifecycle_deadline_exceeded")),
      LIVE_DEADLINE_MILLISECONDS,
    );
    let lifecycle: GrokSessionLifecycle | undefined;
    const privateCarrierShapes = new Set<string>();
    try {
      const runtime = await resolveGrokWorkspaceRuntimeConfiguration({
        scope,
        backendInstanceId: configuration.backendInstanceId,
        executionEnvironmentId,
        executablePath: configuration.runtime.connection.channel.executablePath,
        canonicalWorkspace: workspace,
        environmentChannel: channels,
        environment: ambientEnvironment,
      });
      expect(runtime.executable.path).toBe(await realpath(executablePath));
      expect(runtime.executable.version).toMatch(
        /^1\.\d+\.\d+(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
      );
      expect(
        compareStableCoreVersions(
          runtime.executable.version,
          GROK_ACP_REVIEWED_PROFILE_FLOOR,
        ),
      ).toBeGreaterThanOrEqual(0);
      expect(runtime.executable.build).toMatch(/^[0-9a-f]{7,64}$/u);
      expect(runtime.executable.compatibilityRelease).toBe("1.x");
      expect(runtime.executable.assessment).toEqual({
        observedVersion: runtime.executable.version,
        minimumVersion: GROK_ACP_REVIEWED_PROFILE_FLOOR,
        testedThroughVersion: GROK_RUNTIME_TESTED_THROUGH_VERSION,
        newerThanTested:
          compareStableCoreVersions(
            runtime.executable.version,
            GROK_RUNTIME_TESTED_THROUGH_VERSION,
          ) > 0,
      });
      expect(runtime.executable.newerThanTested).toBe(
        runtime.executable.assessment.newerThanTested,
      );
      expect(runtime.environment.HOME).toBe(
        ambientEnvironment.HOME ?? os.homedir(),
      );
      if (ambientEnvironment.GROK_HOME === undefined) {
        expect(runtime.environment).not.toHaveProperty("GROK_HOME");
      } else {
        expect(runtime.environment.GROK_HOME).toBe(
          ambientEnvironment.GROK_HOME,
        );
      }

      const registry = new GrokSessionRegistry();
      const transportFactory = new GrokOwnedStdioTransportFactory({
        runtime,
        channels,
      });
      const connectionGeneration = 1;
      const transport = observePrivateCarrierShapes(
        await transportFactory.open(connectionGeneration, controller.signal),
        privateCarrierShapes,
      );
      lifecycle = await GrokSessionLifecycle.open({
        transport,
        owner: {
          scope: transportFactory.scope,
          nativeNamespaceKey: grokNativeNamespaceKey(
            executionEnvironmentId,
            ambientEnvironment,
          ),
          workspace,
          connectionGeneration,
          processOwnerId: randomUUID(),
        },
        registry,
        inlineSessionUpdates: true,
        signal: controller.signal,
      });

      // Successful open proves the reviewed initialize profile and native
      // cached_token authentication before any provider session is created.
      const baseline = await lifecycle.listSessions({
        signal: controller.signal,
      });
      expect(baseline).toEqual([]);

      const currentModelId = lifecycle.modelCatalog.currentModelId;
      const defaultModel = lifecycle.modelCatalog.availableModels.find(
        ({ modelId }) => modelId === currentModelId,
      );
      expect(defaultModel).toBeDefined();
      const created = await lifecycle.newSession({
        configuration: {
          modelId: currentModelId,
          ...(defaultModel?.defaultReasoningEffort
            ? { reasoningEffort: defaultModel.defaultReasoningEffort }
            : {}),
        },
        signal: controller.signal,
      });
      expect(created.state).toMatchObject({ residency: "resident" });
      expect(created.history).toEqual([]);
      const sessionId = created.state.sessionId;
      const renamedTitle = `Sedes real Grok ${randomUUID().slice(0, 8)}`;
      await lifecycle.renameSession(sessionId, renamedTitle, {
        signal: controller.signal,
      });
      await expect(
        lifecycle.listSessions({ signal: controller.signal }),
      ).resolves.toContainEqual(
        expect.objectContaining({ sessionId, title: renamedTitle }),
      );

      const promptOperation = startPromptText(
        lifecycle,
        sessionId,
        `sedes-grok-live-${randomUUID()}`,
        PROMPT_CANARY,
        { signal: controller.signal },
      );
      const accepted = await promptOperation.accepted;
      expect(accepted.promptId).toBe(promptOperation.promptId);
      const prompted = await promptOperation.completed;
      expect(prompted.response.stopReason).toBe("end_turn");
      const firstPromptBlocks = semanticPromptBlocks(prompted.history);
      expect(firstPromptBlocks.userText).toBe(PROMPT_CANARY);
      expect(firstPromptBlocks.assistantText).toContain(TOOL_CANARY);
      await expect(
        readFile(path.join(workspace, "unrestricted-canary.txt"), "utf8"),
      ).resolves.toBe(TOOL_CANARY);
      expect(firstPromptBlocks.terminals).toEqual([
        {
          promptId: prompted.promptId,
          stopReason: prompted.response.stopReason,
        },
      ]);

      const interruptOperation = startPromptText(
        lifecycle,
        sessionId,
        `sedes-grok-live-interrupt-${randomUUID()}`,
        INTERRUPT_PROMPT,
        { signal: controller.signal },
      );
      await expect(interruptOperation.accepted).resolves.toMatchObject({
        promptId: interruptOperation.promptId,
      });
      await lifecycle.interruptPrompt(sessionId, interruptOperation.promptId);
      const interrupted = await interruptOperation.completed;
      expect(interrupted.response.stopReason).toBe("cancelled");
      expect(
        interrupted.history.findLast(
          (record) => record.kind === "turn_completed",
        ),
      ).toMatchObject({
        kind: "turn_completed",
        identity: { promptId: interruptOperation.promptId },
        stopReason: "cancelled",
      });

      const subagentOperation = startPromptText(
        lifecycle,
        sessionId,
        `sedes-grok-live-subagent-${randomUUID()}`,
        SUBAGENT_PROMPT,
        { signal: controller.signal },
      );
      await expect(subagentOperation.accepted).resolves.toMatchObject({
        promptId: subagentOperation.promptId,
      });
      const reviewed = await subagentOperation.completed;
      expect(reviewed.response.stopReason).toBe("end_turn");
      expect(
        reviewed.history.some(
          (record) =>
            record.kind === "collaboration" &&
            record.action === "result" &&
            record.status === "completed" &&
            record.identity.promptId === subagentOperation.promptId,
        ),
      ).toBe(true);
      const liveBlocks = semanticPromptBlocks(reviewed.history);
      expect(liveBlocks.assistantText).toContain(SUBAGENT_CANARY);
      expect(liveBlocks.terminals).toHaveLength(3);

      await expect(
        lifecycle.closeSession(sessionId, { signal: controller.signal }),
      ).resolves.toMatchObject({ residency: "dormant", sessionId });
      await lifecycle.close("real_grok_first_process_complete");
      lifecycle = undefined;

      const secondFactory = new GrokOwnedStdioTransportFactory({
        runtime,
        channels,
      });
      const secondTransport = observePrivateCarrierShapes(
        await secondFactory.open(2, controller.signal),
        privateCarrierShapes,
      );
      lifecycle = await GrokSessionLifecycle.open({
        transport: secondTransport,
        owner: {
          scope: secondFactory.scope,
          nativeNamespaceKey: grokNativeNamespaceKey(
            executionEnvironmentId,
            ambientEnvironment,
          ),
          workspace,
          connectionGeneration: 2,
          processOwnerId: randomUUID(),
        },
        registry,
        inlineSessionUpdates: true,
        signal: controller.signal,
      });
      const loaded = await lifecycle.loadSession(sessionId, {
        signal: controller.signal,
      });
      expect(semanticPromptBlocks(loaded.history)).toEqual(liveBlocks);

      // Simulate Sedes terminating while an authenticated prompt still owns
      // native work. A fresh process must recover only that exact Sedes turn
      // as interrupted, without rewriting Grok's native transcript, and then
      // accept a following prompt normally.
      const nativeNamespaceKey = grokNativeNamespaceKey(
        executionEnvironmentId,
        ambientEnvironment,
      );
      const submissionCorrelation = {
        installationKey: new Uint8Array(32).fill(7),
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        backendInstanceId,
        connectionProfileId,
        executionEnvironmentId,
        nativeNamespaceKey,
        canonicalWorkspacePath: workspace,
        sessionId,
      };
      const abandonedPromptId = grokSubmissionPromptId({
        ...submissionCorrelation,
        applicationOperationId: "real-grok-abandoned-prompt",
        reconciliationToken: randomUUID(),
      });
      const abandoned = startPromptText(
        lifecycle,
        sessionId,
        abandonedPromptId,
        INTERRUPT_PROMPT,
        { signal: controller.signal },
      );
      await expect(abandoned.accepted).resolves.toMatchObject({
        promptId: abandonedPromptId,
      });
      const abandonedCompletion = abandoned.completed.catch(
        (error: unknown) => error,
      );
      await waitFor(
        () => {
          const history = lifecycle!.history(sessionId);
          return (
            history.some(
              (record) =>
                record.kind !== "user_text" &&
                record.identity.promptId === abandonedPromptId,
            ) &&
            recoverableInterruptedGrokPromptId(
              history,
              submissionCorrelation,
            ) === abandonedPromptId
          );
        },
        "real_grok_interrupted_recovery_evidence_unavailable",
        controller.signal,
        INTERRUPTED_RECOVERY_EVIDENCE_DEADLINE_MILLISECONDS,
      );
      const abandonedBeforeRestart = projectGrokLatestHistory(
        lifecycle.history(sessionId),
        submissionCorrelation,
      ).snapshot;
      expect(
        abandonedBeforeRestart.turnsById[
          abandonedBeforeRestart.orderedBackendTurnIds.at(-1)!
        ],
      ).toMatchObject({ status: "in_progress" });
      await lifecycle.close("real_grok_simulated_sedes_restart");
      lifecycle = undefined;
      await expect(abandonedCompletion).resolves.toBeInstanceOf(Error);

      const thirdFactory = new GrokOwnedStdioTransportFactory({
        runtime,
        channels,
      });
      const thirdTransport = observePrivateCarrierShapes(
        await thirdFactory.open(3, controller.signal),
        privateCarrierShapes,
      );
      lifecycle = await GrokSessionLifecycle.open({
        transport: thirdTransport,
        owner: {
          scope: thirdFactory.scope,
          nativeNamespaceKey,
          workspace,
          connectionGeneration: 3,
          processOwnerId: randomUUID(),
        },
        registry,
        inlineSessionUpdates: true,
        signal: controller.signal,
      });
      const abandonedLoaded = await lifecycle.loadSession(sessionId, {
        signal: controller.signal,
      });
      expect(
        recoverableInterruptedGrokPromptId(
          abandonedLoaded.history,
          submissionCorrelation,
        ),
      ).toBe(abandonedPromptId);
      const recoveredHistory = await lifecycle.recoverInterruptedSedesPrompt(
        sessionId,
        abandonedPromptId,
      );
      const recovered = projectGrokLatestHistory(
        recoveredHistory,
        submissionCorrelation,
      ).snapshot;
      expect(recovered.runState).toBe("idle");
      expect(
        recovered.turnsById[recovered.orderedBackendTurnIds.at(-1)!],
      ).toMatchObject({ status: "interrupted", endedBy: "interrupted" });

      const continued = startPromptText(
        lifecycle,
        sessionId,
        `sedes-grok-live-after-restart-${randomUUID()}`,
        "Reply with exactly `sedes-grok-restart-recovered`.",
        { signal: controller.signal },
      );
      await expect(continued.accepted).resolves.toMatchObject({
        promptId: continued.promptId,
      });
      await expect(continued.completed).resolves.toMatchObject({
        response: { stopReason: "end_turn" },
      });
      await expect(
        lifecycle.closeSession(sessionId, { signal: controller.signal }),
      ).resolves.toMatchObject({ residency: "dormant", sessionId });

      const retained = await lifecycle.listSessions({
        signal: controller.signal,
      });
      expect(retained.map((session) => session.sessionId)).toContain(sessionId);
      expect([...privateCarrierShapes].sort()).toEqual([
        "_x.ai/session/prompt_complete:direct",
        "_x.ai/session_notification:direct",
      ]);
    } finally {
      try {
        await lifecycle?.close("real_grok_lifecycle_cleanup");
      } finally {
        clearTimeout(deadline);
        channels.close();
      }
    }
  });
});

function requireLiveExecutable(): string {
  if (process.env[LIVE_GATE] !== "1") {
    throw new Error(`Set ${LIVE_GATE}=1 to authorize the real Grok suite.`);
  }
  const executablePath = process.env[EXECUTABLE_OVERRIDE];
  if (
    !executablePath ||
    executablePath.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(executablePath) ||
    !path.isAbsolute(executablePath) ||
    path.resolve(executablePath) !== executablePath
  ) {
    throw new Error(
      `Set ${EXECUTABLE_OVERRIDE} to the canonical absolute installed Grok executable.`,
    );
  }
  return executablePath;
}

function compareStableCoreVersions(left: string, right: string): number {
  const leftParts = left.split("+", 1)[0]!.split(".").map(Number);
  const rightParts = right.split("+", 1)[0]!.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function observePrivateCarrierShapes(
  transport: FramedMessageTransport,
  observed: Set<string>,
): FramedMessageTransport {
  return {
    maximumFrameBytes: transport.maximumFrameBytes,
    assurance: transport.assurance,
    frames: observePrivateFrames(transport.frames, observed),
    closed: transport.closed,
    send: async (text, options) => await transport.send(text, options),
    close: async (reason) => await transport.close(reason),
  };
}

async function* observePrivateFrames(
  frames: FramedMessageTransport["frames"],
  observed: Set<string>,
): AsyncIterableIterator<InboundTextFrame> {
  for await (const frame of frames) {
    try {
      const value = JSON.parse(frame.text) as unknown;
      if (isRecord(value) && privateCarrierMethod(value.method)) {
        const params = value.params;
        const shape =
          isRecord(params) && typeof params.sessionId === "string"
            ? "direct"
            : isRecord(params) &&
                typeof params.method === "string" &&
                isRecord(params.params)
              ? "nested"
              : "other";
        observed.add(`${value.method}:${shape}`);
      }
    } catch {
      // The production binding remains authoritative for malformed frames.
    }
    yield frame;
  }
}

function privateCarrierMethod(value: unknown): value is string {
  return (
    value === "_x.ai/session/prompt_complete" ||
    value === "_x.ai/session_notification" ||
    value === "_x.ai/session/update"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitFor(
  predicate: () => boolean,
  failure: string,
  signal: AbortSignal,
  timeoutMilliseconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(failure);
}

function semanticPromptBlocks(
  records: readonly import("../../src/server/backends/grok/grok-history-projector.js").GrokHistoryRecord[],
) {
  const blocks = new Map<
    string,
    { blockId: string; kind: string; text: string }
  >();
  const terminals: Array<{ promptId?: string; stopReason: string }> = [];
  const toolStates = new Map<string, Record<string, unknown>>();
  let userText = "";
  let assistantText = "";
  for (const record of records) {
    if (record.kind === "turn_completed") {
      terminals.push({
        promptId: record.identity.promptId,
        stopReason: record.stopReason,
      });
      continue;
    }
    if (record.kind === "user_text") userText += record.text.text;
    if (record.kind === "assistant_text") assistantText += record.text.text;
    const key = `${record.identity.blockId}\0${record.kind}`;
    if (record.kind === "tool") {
      const state = toolStates.get(key) ?? {};
      for (const [field, value] of Object.entries(record.patch)) {
        if (value != null) state[field] = value;
      }
      // Grok's durable replay may omit live-only neutral presentation hints.
      // Compare the normalized semantics they produce rather than requiring
      // replay to reproduce optional wire fields that do not change the item.
      if (state.toolKind === "other") delete state.toolKind;
      if (Array.isArray(state.locations) && state.locations.length === 0) {
        delete state.locations;
      }
      delete state.rawOutputVariant;
      toolStates.set(key, state);
      blocks.set(key, {
        blockId: record.identity.blockId,
        kind: record.kind,
        text: JSON.stringify({ toolCallId: record.toolCallId, state }),
      });
      continue;
    }
    if (record.kind === "omission") continue;
    const text =
      record.kind === "collaboration"
        ? JSON.stringify({
            status: record.status,
            action: record.action,
            agentLabel: record.agentLabel,
            summary: record.summary,
            error: record.error,
          })
        : record.kind === "plan"
          ? JSON.stringify(record.replacement.entries)
          : record.text.text;
    const block = blocks.get(key) ?? {
      blockId: record.identity.blockId,
      kind: record.kind,
      text: "",
    };
    block.text += text;
    blocks.set(key, block);
  }
  const ordered = [...blocks.values()];
  const content = ordered.filter(
    (block) => block.kind !== "tool" && block.kind !== "collaboration",
  );
  const activity = ordered
    .filter((block) => block.kind === "tool" || block.kind === "collaboration")
    .sort((left, right) =>
      `${left.kind}\0${left.blockId}`.localeCompare(
        `${right.kind}\0${right.blockId}`,
      ),
    );
  // Private activity notifications are presentation metadata. The native
  // replay stream may persist a subagent marker before its consolidated tool
  // record even when live delivery observed the tool start first. Preserve
  // model-visible content order while comparing that activity set by stable
  // identity.
  return {
    blocks: [...content, ...activity],
    terminals,
    userText,
    assistantText,
  };
}
