import { describe, expect, it } from "vitest";
import {
  codexC2NotificationSchemas,
  codexExperimentalFeatureListMethod,
  codexModelListMethod,
  codexSkillsListMethod,
  codexPermissionProfileListMethod,
  codexThreadCompactStartMethod,
  codexThreadSetNameMethod,
  codexThreadSettingsUpdateMethod,
  codexThreadStartMethod,
  codexTurnInterruptMethod,
  codexTurnStartMethod,
  codexTurnSteerMethod,
  decodeCodexC2Notification,
  decodeCodexC2ServerRequest,
  encodeCodexC2RoutedServerResponse,
  refineCodexSkillsChangedNotification,
  refineCodexC2ServerRequest,
} from "../../src/server/backends/codex/codex-c2-protocol.js";
import { CODEX_SERVER_REQUEST_METHODS } from "../../src/server/backends/codex/rpc/protocol.js";
import {
  decodeCodexServerNotificationParams,
  decodeCodexServerRequestParams,
} from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";

describe("Codex C2 pinned protocol", () => {
  it("encodes a positive fixture through every adopted C2 client request route", () => {
    const fixtures = [
      [codexThreadStartMethod, { cwd: "/workspace" }],
      [codexTurnStartMethod, { threadId: "thread-1", input: [] }],
      [codexThreadSettingsUpdateMethod, { threadId: "thread-1" }],
      [codexTurnSteerMethod, { threadId: "thread-1", expectedTurnId: "turn-1", input: [] }],
      [codexTurnInterruptMethod, { threadId: "thread-1", turnId: "turn-1" }],
      [codexThreadSetNameMethod, { threadId: "thread-1", name: "name" }],
      [codexThreadCompactStartMethod, { threadId: "thread-1" }],
      [codexModelListMethod, {}],
      [codexExperimentalFeatureListMethod, {}],
      [codexSkillsListMethod, { cwds: ["/workspace"] }],
      [codexPermissionProfileListMethod, {}],
    ] as const;
    for (const [route, params] of fixtures) {
      expect(
        (route as { encodeParams(value: unknown): unknown }).encodeParams(params),
      ).toEqual(params);
    }
  });

  it("keeps native text bounds in UTF-16 code units below the wire ceiling", () => {
    const underFrameAstral = "😀".repeat(1_900_000);
    expect(
      codexThreadSetNameMethod.encodeParams({
        threadId: "thread-1",
        name: underFrameAstral,
      }),
    ).toEqual({ threadId: "thread-1", name: underFrameAstral });
    expect(() =>
      codexThreadSetNameMethod.encodeParams({
        threadId: "thread-1",
        name: "x".repeat(7 * 1024 * 1024 + 1),
      }),
    ).toThrow();
  });

  it("freezes the stable interactive mutation and catalog methods", () => {
    expect([
      codexThreadStartMethod.method,
      codexTurnStartMethod.method,
      codexTurnSteerMethod.method,
      codexTurnInterruptMethod.method,
      codexThreadSetNameMethod.method,
      codexThreadCompactStartMethod.method,
      codexModelListMethod.method,
      codexExperimentalFeatureListMethod.method,
      codexSkillsListMethod.method,
      codexPermissionProfileListMethod.method,
    ]).toEqual([
      "thread/start",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
      "thread/name/set",
      "thread/compact/start",
      "model/list",
      "experimentalFeature/list",
      "skills/list",
      "permissionProfile/list",
    ]);

    expect(
      codexThreadStartMethod.encodeParams({
        cwd: "/workspace",
        serviceTier: "priority",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
        config: { model_reasoning_effort: "low" },
        ephemeral: false,
        historyMode: "paginated",
        threadSource: "sedes-create-1",
      }),
    ).toEqual({
      cwd: "/workspace",
      serviceTier: "priority",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      config: { model_reasoning_effort: "low" },
      ephemeral: false,
      historyMode: "paginated",
      threadSource: "sedes-create-1",
    });
    expect(() =>
      codexThreadStartMethod.encodeParams({
        cwd: "/workspace",
        historyMode: "future-mode",
      } as never),
    ).toThrow();
    expect(() =>
      codexThreadStartMethod.encodeParams({
        cwd: "/workspace",
        input: [{ type: "text", text: "prompt" }],
      } as never),
    ).toThrow();

    expect(
      codexTurnStartMethod.encodeParams({
        threadId: "thread-1",
        clientUserMessageId: "operation-1",
        input: [{ type: "text", text: "hello", text_elements: [] }],
        model: "gpt-5.6",
        serviceTier: "priority",
        effort: "low",
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      }),
    ).toEqual({
      threadId: "thread-1",
      clientUserMessageId: "operation-1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      model: "gpt-5.6",
      serviceTier: "priority",
      effort: "low",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
    expect(() =>
      codexTurnSteerMethod.encodeParams({
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "steer", text_elements: [] }],
        extra: true,
      } as never),
    ).toThrow();
    expect(codexThreadCompactStartMethod.decodeResult({})).toEqual({});
    expect(() =>
      codexThreadCompactStartMethod.decodeResult({ unexpected: true }),
    ).toThrow();
  });

  it("strictly contracts paginated experimental feature discovery", () => {
    expect(codexExperimentalFeatureListMethod.method).toBe(
      "experimentalFeature/list",
    );
    expect(
      codexExperimentalFeatureListMethod.encodeParams({
        cursor: "8",
        limit: 16,
        threadId: "thread-1",
      }),
    ).toEqual({ cursor: "8", limit: 16, threadId: "thread-1" });
    expect(
      codexExperimentalFeatureListMethod.decodeResult({
        data: [
          {
            name: "fast_mode",
            stage: "stable",
            displayName: null,
            description: null,
            announcement: null,
            enabled: true,
            defaultEnabled: true,
            futureMetadata: "ignored",
          },
        ],
        nextCursor: null,
        futureResponseMetadata: true,
      }),
    ).toEqual({
      data: [
        {
          name: "fast_mode",
          stage: "stable",
          displayName: null,
          description: null,
          announcement: null,
          enabled: true,
          defaultEnabled: true,
        },
      ],
      nextCursor: null,
    });
    expect(() =>
      codexExperimentalFeatureListMethod.encodeParams({
        threadId: "thread-1",
        unknown: true,
      } as never),
    ).toThrow();
    expect(() =>
      codexExperimentalFeatureListMethod.decodeResult({
        data: [
          {
            name: "fast_mode",
            stage: "stable",
            displayName: null,
            description: null,
            announcement: null,
            defaultEnabled: true,
          },
        ],
        nextCursor: null,
      }),
    ).toThrow();
  });

  it("validates and strips 0.148 model catalog compatibility metadata", () => {
    const model = {
      id: "gpt-5.6",
      model: "gpt-5.6",
      upgrade: null,
      upgradeInfo: {
        model: "gpt-5.7",
        upgradeCopy: "Upgrade available",
        modelLink: null,
        migrationMarkdown: null,
        retirementAt: 1_800_000_000,
      },
      availabilityNux: null,
      displayName: "GPT-5.6",
      description: "Fixture model",
      modelSpecialty: null,
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Low" },
      ],
      defaultReasoningEffort: "low",
      inputModalities: ["text"],
      supportsPersonality: false,
      multiAgentVersion: "v2",
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: true,
    } as const;
    const decoded = codexModelListMethod.decodeResult({
      data: [model],
      nextCursor: null,
    });
    expect(decoded.data[0]).not.toHaveProperty("multiAgentVersion");
    expect(decoded.data[0]?.upgradeInfo).toEqual({
      model: "gpt-5.7",
      upgradeCopy: "Upgrade available",
      modelLink: null,
      migrationMarkdown: null,
    });
    const {
      upgradeInfo: _upgradeInfo,
      multiAgentVersion: _multiAgentVersion,
      availabilityNux: _availabilityNux,
      ...modelWithoutOptionalMetadata
    } = model;
    const decodedWithoutOptionalMetadata = codexModelListMethod.decodeResult({
      data: [modelWithoutOptionalMetadata],
      nextCursor: null,
    } as never);
    expect(decodedWithoutOptionalMetadata.data[0]?.upgradeInfo).toBeNull();
    expect(decodedWithoutOptionalMetadata.data[0]?.availabilityNux).toBeUndefined();
    expect(() =>
      codexModelListMethod.decodeResult({
        data: [{ ...model, multiAgentVersion: "v3" }],
        nextCursor: null,
      } as never),
    ).toThrow("codex_app_server_client_request_result_invalid");
    expect(() =>
      codexModelListMethod.decodeResult({
        data: [
          {
            ...model,
            upgradeInfo: { ...model.upgradeInfo, retirementAt: -1 },
          },
        ],
        nextCursor: null,
      }),
    ).toThrow("codex_app_server_client_request_result_invalid");
  });

  it("strictly contracts only the adopted experimental settings update shape", () => {
    expect(codexThreadSettingsUpdateMethod.method).toBe(
      "thread/settings/update",
    );
    const params = {
      threadId: "thread-1",
      cwd: "/workspace",
      model: "gpt-5.6-luna",
      effort: "low",
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "user" as const,
      sandboxPolicy: {
        type: "workspaceWrite" as const,
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
      },
      serviceTier: null,
    };
    expect(codexThreadSettingsUpdateMethod.encodeParams(params)).toEqual(
      params,
    );
    expect(codexThreadSettingsUpdateMethod.decodeResult({})).toEqual({});
    expect(() =>
      codexThreadSettingsUpdateMethod.encodeParams({
        threadId: "thread-1",
        permissions: ":workspace",
      } as never),
    ).toThrow();
    expect(() =>
      codexThreadSettingsUpdateMethod.encodeParams({
        threadId: "thread-1",
        approvalsReviewer: "guardian_subagent",
      } as never),
    ).toThrow();
    expect(() =>
      codexThreadSettingsUpdateMethod.decodeResult({ accepted: true }),
    ).toThrow();
  });

  it("has an exact decoder for every stable ID-bearing server request", () => {
    expect(CODEX_SERVER_REQUEST_METHODS).toHaveLength(10);
    const fixtures = {
      "account/chatgptAuthTokens/refresh": {
        reason: "unauthorized",
        previousAccountId: null,
      },
      applyPatchApproval: {
        conversationId: "thread-1",
        callId: "call-legacy-file",
        fileChanges: {},
        reason: null,
        grantRoot: null,
      },
      "attestation/generate": {},
      execCommandApproval: {
        conversationId: "thread-1",
        callId: "call-legacy-command",
        approvalId: null,
        command: ["pwd"],
        cwd: "/workspace",
        reason: null,
        parsedCmd: [],
      },
      "item/commandExecution/requestApproval": {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-command",
        startedAtMs: 1,
        environmentId: null,
        availableDecisions: [
          "accept",
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ["npm", "test"],
            },
          },
          "cancel",
        ],
      },
      "item/fileChange/requestApproval": {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-file",
        startedAtMs: 2,
      },
      "item/permissions/requestApproval": {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-permission",
        environmentId: null,
        startedAtMs: 3,
        cwd: "/workspace",
        reason: null,
        permissions: { network: null, fileSystem: null },
      },
      "item/tool/call": {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-tool",
        namespace: null,
        tool: "future_sedes_tool",
        arguments: {},
      },
      "item/tool/requestUserInput": {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-input",
        questions: [],
        isBlocking: true,
      },
      "mcpServer/elicitation/request": {
        threadId: "thread-1",
        turnId: null,
        serverName: "provider",
        mode: "url",
        _meta: null,
        message: "Authenticate",
        url: "https://example.test",
        elicitationId: "elicitation-1",
      },
    } as const;

    for (const method of CODEX_SERVER_REQUEST_METHODS) {
      expect(decodeCodexC2ServerRequest(method, fixtures[method])).toEqual({
        method,
        params: fixtures[method],
      });
    }
    expect(() =>
      decodeCodexC2ServerRequest("item/fileChange/requestApproval", {
        ...fixtures["item/fileChange/requestApproval"],
        providerSecret: "must not pass",
      }),
    ).toThrow();
    expect(
      decodeCodexC2ServerRequest("item/tool/requestUserInput", {
        ...fixtures["item/tool/requestUserInput"],
        autoResolutionMs: null,
      }),
    ).toEqual({
      method: "item/tool/requestUserInput",
      params: {
        ...fixtures["item/tool/requestUserInput"],
        autoResolutionMs: null,
      },
    });
  });

  it("rejects semantically unsupported attested refresh reasons and empty decision sets", () => {
    expect(() => decodeCodexC2ServerRequest(
      "account/chatgptAuthTokens/refresh",
      { reason: "expired", previousAccountId: null },
    )).toThrow();

    const approval = decodeCodexServerRequestParams(
      "item/commandExecution/requestApproval",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 1,
        environmentId: null,
        availableDecisions: [],
      },
    );
    expect(() => refineCodexC2ServerRequest(
      "item/commandExecution/requestApproval",
      approval,
    )).toThrow();
  });

  it("accepts legacy command approvals without kind and closes the writeStdin shape", () => {
    const legacyCommand = {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-command",
      startedAtMs: 1,
      environmentId: null,
    };
    expect(
      decodeCodexC2ServerRequest(
        "item/commandExecution/requestApproval",
        legacyCommand,
      ).params,
    ).toEqual(legacyCommand);

    const writeStdin = {
      ...legacyCommand,
      kind: "writeStdin" as const,
      approvalId: "stdin-approval-1",
      environmentId: "environment-1",
      reason: "Terminal input needs broader permissions",
      command: "write_stdin --session-id 42 confirm",
      cwd: "/workspace",
      commandActions: [
        {
          type: "unknown" as const,
          command: "write_stdin --session-id 42 confirm",
        },
      ],
      availableDecisions: ["accept", "cancel"] as const,
    };
    expect(
      decodeCodexC2ServerRequest(
        "item/commandExecution/requestApproval",
        writeStdin,
      ).params,
    ).toEqual(writeStdin);
    for (const approvalId of [undefined, null, ""] as const) {
      expect(() =>
        decodeCodexC2ServerRequest("item/commandExecution/requestApproval", {
          ...writeStdin,
          approvalId,
        }),
      ).toThrow();
    }
    for (const invalid of [
      { ...writeStdin, environmentId: null },
      { ...writeStdin, reason: null },
      { ...writeStdin, command: null },
      { ...writeStdin, cwd: null },
      { ...writeStdin, commandActions: null },
      {
        ...writeStdin,
        networkApprovalContext: {
          host: "example.test",
          protocol: "https" as const,
        },
      },
      { ...writeStdin, proposedExecpolicyAmendment: ["write_stdin"] },
      { ...writeStdin, proposedNetworkPolicyAmendments: [] },
      { ...writeStdin, availableDecisions: undefined },
      {
        ...writeStdin,
        availableDecisions: ["accept", "acceptForSession"] as const,
      },
      { ...writeStdin, availableDecisions: ["cancel", "accept"] as const },
    ]) {
      expect(() =>
        decodeCodexC2ServerRequest(
          "item/commandExecution/requestApproval",
          invalid,
        ),
      ).toThrow();
    }
  });

  it("keeps additional command permissions structurally closed", () => {
    const approval = {
      kind: "command" as const,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-command",
      startedAtMs: 1,
      environmentId: null,
      additionalPermissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/workspace"],
          write: null,
          globScanMaxDepth: 3,
          entries: [
            {
              path: {
                type: "special" as const,
                value: { kind: "project_roots" as const, subpath: null },
              },
              access: "read" as const,
            },
          ],
        },
      },
    };
    expect(
      decodeCodexC2ServerRequest(
        "item/commandExecution/requestApproval",
        approval,
      ).params,
    ).toEqual(approval);

    expect(() =>
      decodeCodexC2ServerRequest(
        "item/commandExecution/requestApproval",
        {
          ...approval,
          additionalPermissions: {
            ...approval.additionalPermissions,
            network: { enabled: true, unexpected: true },
          },
        } as never,
      ),
    ).toThrow();
    expect(() =>
      decodeCodexC2ServerRequest(
        "item/commandExecution/requestApproval",
        {
          ...approval,
          additionalPermissions: {
            ...approval.additionalPermissions,
            fileSystem: {
              ...approval.additionalPermissions.fileSystem,
              unexpected: true,
            },
          },
        } as never,
      ),
    ).toThrow();
    expect(() =>
      decodeCodexC2ServerRequest(
        "item/commandExecution/requestApproval",
        {
          ...approval,
          additionalPermissions: {
            ...approval.additionalPermissions,
            fileSystem: {
              ...approval.additionalPermissions.fileSystem,
              entries: [
                {
                  ...approval.additionalPermissions.fileSystem.entries[0]!,
                  path: {
                    ...approval.additionalPermissions.fileSystem.entries[0]!
                      .path,
                    value: {
                      ...approval.additionalPermissions.fileSystem.entries[0]!
                        .path.value!,
                      unexpected: true,
                    },
                  },
                },
              ],
            },
          },
        } as never,
      ),
    ).toThrow();
  });

  it("validates routed responses before they cross the RPC boundary", () => {
    expect(
      encodeCodexC2RoutedServerResponse("execCommandApproval", {
        decision: "approved_for_session",
      }),
    ).toEqual({ decision: "approved_for_session" });
    expect(
      encodeCodexC2RoutedServerResponse("applyPatchApproval", {
        decision: { denied: { rejection: "Denied by the user." } },
      }),
    ).toEqual({
      decision: { denied: { rejection: "Denied by the user." } },
    });
    expect(
      encodeCodexC2RoutedServerResponse(
        "item/commandExecution/requestApproval",
        { decision: "decline" },
      ),
    ).toEqual({ decision: "decline" });
    expect(
      encodeCodexC2RoutedServerResponse("item/permissions/requestApproval", {
        permissions: {},
        scope: "turn",
      }),
    ).toEqual({ permissions: {}, scope: "turn" });
    expect(() =>
      encodeCodexC2RoutedServerResponse("item/permissions/requestApproval", {
        permissions: {},
      }),
    ).toThrow();
    expect(() =>
      encodeCodexC2RoutedServerResponse("mcpServer/elicitation/request", {
        action: "accept",
        content: {},
        _meta: null,
        extra: true,
      }),
    ).toThrow();
    const prototypeQuestion = JSON.parse(
      '{"answers":{"__proto__":{"answers":["safe"]}}}',
    ) as unknown;
    const encoded = encodeCodexC2RoutedServerResponse(
      "item/tool/requestUserInput",
      prototypeQuestion,
    ) as { readonly answers: Record<string, unknown> };
    expect(Object.hasOwn(encoded.answers, "__proto__")).toBe(true);
    expect(({} as { readonly safe?: unknown }).safe).toBeUndefined();
  });

  it("closes every nested permission entry while accepting the supported profile", () => {
    const valid = {
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: null,
          write: null,
          entries: [
            { path: { type: "path", path: "/workspace" }, access: "read" },
            { path: { type: "glob_pattern", pattern: "**/*.ts" }, access: "write" },
            {
              path: {
                type: "special",
                value: { kind: "project_roots", subpath: "src" },
              },
              access: "deny",
            },
          ],
        },
      },
      scope: "turn",
    } as const;
    expect(encodeCodexC2RoutedServerResponse(
      "item/permissions/requestApproval",
      valid,
    )).toEqual(valid);

    const withEntryExtra = structuredClone(valid) as unknown as {
      permissions: { fileSystem: { entries: Array<Record<string, unknown>> } };
    };
    withEntryExtra.permissions.fileSystem.entries[0]!.extra = true;
    expect(() => encodeCodexC2RoutedServerResponse(
      "item/permissions/requestApproval",
      withEntryExtra,
    )).toThrow();

    const withPathExtra = structuredClone(valid) as unknown as {
      permissions: { fileSystem: { entries: Array<{ path: Record<string, unknown> }> } };
    };
    withPathExtra.permissions.fileSystem.entries[1]!.path.extra = true;
    expect(() => encodeCodexC2RoutedServerResponse(
      "item/permissions/requestApproval",
      withPathExtra,
    )).toThrow();

    const withSpecialExtra = structuredClone(valid) as unknown as {
      permissions: { fileSystem: { entries: Array<{ path: { value?: Record<string, unknown> } }> } };
    };
    withSpecialExtra.permissions.fileSystem.entries[2]!.path.value!.extra = true;
    expect(() => encodeCodexC2RoutedServerResponse(
      "item/permissions/requestApproval",
      withSpecialExtra,
    )).toThrow();
  });

  it("freezes the live interactive notification set used by C2", () => {
    const turn = {
      id: "turn-1",
      items: [],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    };
    const item = {
      type: "agentMessage",
      id: "item-1",
      text: "hello",
      phase: null,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    const usage = {
      totalTokens: 1,
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    };
    const fixtures: Record<string, unknown> = {
      warning: { threadId: "thread-1", message: "warning" },
      error: { error: { message: "failed", codexErrorInfo: null, additionalDetails: null }, willRetry: false, threadId: "thread-1", turnId: "turn-1" },
      "modelProvider/authRecoveryStarted": { threadId: "thread-1", turnId: "turn-1", provider: "openai", message: "Authentication recovery started." },
      "modelProvider/authRecoveryCompleted": { threadId: "thread-1", turnId: "turn-1", provider: "openai", message: "Authentication recovery completed." },
      "thread/status/changed": { threadId: "thread-1", status: { type: "idle" } },
      "thread/name/updated": { threadId: "thread-1", threadName: "name" },
      "thread/goal/updated": { threadId: "thread-1", turnId: null, goal: { threadId: "thread-1", objective: "ship", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } },
      "thread/goal/cleared": { threadId: "thread-1" },
      "thread/settings/updated": { threadId: "thread-1", threadSettings: { cwd: "/workspace", approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly", networkAccess: false }, activePermissionProfile: null, model: "gpt-5.6", modelProvider: "openai", serviceTier: null, effort: "low", summary: null, collaborationMode: { mode: "default", settings: { model: "gpt-5.6", reasoning_effort: "low", developer_instructions: null } }, multiAgentMode: "explicitRequestOnly", personality: null } },
      "thread/tokenUsage/updated": { threadId: "thread-1", turnId: "turn-1", tokenUsage: { total: usage, last: usage, modelContextWindow: 100 } },
      "thread/compacted": { threadId: "thread-1", turnId: "turn-1" },
      "turn/started": { threadId: "thread-1", turn },
      "turn/completed": { threadId: "thread-1", turn },
      "turn/diff/updated": { threadId: "thread-1", turnId: "turn-1", diff: "diff" },
      "turn/plan/updated": { threadId: "thread-1", turnId: "turn-1", explanation: null, plan: [{ step: "test", status: "pending" }] },
      "item/started": { threadId: "thread-1", turnId: "turn-1", item, startedAtMs: 1 },
      "item/completed": { threadId: "thread-1", turnId: "turn-1", item, completedAtMs: 2 },
      "item/agentMessage/delta": { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" },
      "item/plan/delta": { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" },
      "item/commandExecution/outputDelta": { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" },
      "item/fileChange/outputDelta": { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello" },
      "item/fileChange/patchUpdated": { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", changes: [{ path: "a.txt", kind: { type: "add" }, diff: "+a" }] },
      "item/mcpToolCall/progress": { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", message: "working" },
      "item/reasoning/summaryPartAdded": { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", summaryIndex: 0 },
      "item/reasoning/summaryTextDelta": { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "why", summaryIndex: 0 },
      "item/reasoning/textDelta": { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "why", contentIndex: 0 },
      "serverRequest/resolved": { threadId: "thread-1", requestId: "request-1" },
    };
    expect(Object.keys(codexC2NotificationSchemas)).toEqual(Object.keys(fixtures));
    for (const [method, params] of Object.entries(fixtures)) {
      expect(decodeCodexC2Notification(method as never, params)).toEqual(params);
    }
    expect(
      decodeCodexC2Notification("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "hello",
      }),
    ).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "hello",
    });
    expect(() =>
      decodeCodexC2Notification("serverRequest/resolved", {
        threadId: "thread-1",
        requestId: {},
      }),
    ).toThrow();
    expect(
      decodeCodexC2Notification("warning", {
        threadId: "thread-1",
        message: "Code mode is unavailable.",
      }),
    ).toEqual({
      threadId: "thread-1",
      message: "Code mode is unavailable.",
    });
  });

  it("closes and bounds model-provider authentication recovery notifications", () => {
    const notification = {
      threadId: "thread-1",
      turnId: "turn-1",
      provider: "openai",
      message: "Authentication recovery started.",
    };
    expect(
      decodeCodexC2Notification(
        "modelProvider/authRecoveryStarted",
        notification,
      ),
    ).toEqual(notification);
    expect(() =>
      decodeCodexC2Notification("modelProvider/authRecoveryStarted", {
        ...notification,
        accountId: "provider-account-must-stay-private",
      }),
    ).toThrow();
    expect(() =>
      decodeCodexC2Notification("modelProvider/authRecoveryCompleted", {
        ...notification,
        provider: "",
      }),
    ).toThrow();
    expect(() =>
      decodeCodexC2Notification("modelProvider/authRecoveryCompleted", {
        ...notification,
        message: "",
      }),
    ).toThrow();
    expect(() =>
      decodeCodexC2Notification("modelProvider/authRecoveryCompleted", {
        ...notification,
        message: "x".repeat(4_097),
      }),
    ).toThrow();
  });

  it("decodes null, missing, and closed structured Codex 0.151 misalignment", () => {
    const notification = {
      error: {
        message: "failed",
        codexErrorInfo: null,
        additionalDetails: null,
        misalignment: null,
      },
      willRetry: false,
      threadId: "thread-1",
      turnId: "turn-1",
    };
    expect(decodeCodexC2Notification("error", notification as never)).toEqual(
      notification,
    );
    const structured = {
      ...notification,
      error: {
        ...notification.error,
        codexErrorInfo: "misalignmentPolicyViolation",
        misalignment: {
          errorType: "open-ended-category",
          detailedExplanation: "A substantive explanation.",
          steer: { message: "A steering instruction." },
        },
      },
    };
    expect(decodeCodexC2Notification("error", structured as never)).toEqual(
      structured,
    );
    const missingMisalignment = {
      ...notification,
      error: {
        message: "stream retry budget exhausted",
        codexErrorInfo: "rateLimitExceeded",
        additionalDetails: null,
      },
    };
    expect(
      decodeCodexC2Notification("error", missingMisalignment as never),
    ).toEqual(missingMisalignment);
    expect(() =>
      decodeCodexC2Notification("error", {
        ...structured,
        error: {
          ...structured.error,
          misalignment: {
            ...structured.error.misalignment,
            unexpected: true,
          },
        },
      } as never),
    ).toThrow();
    expect(() =>
      decodeCodexC2Notification("error", {
        ...structured,
        error: {
          ...structured.error,
          misalignment: {
            ...structured.error.misalignment,
            steer: {
              ...structured.error.misalignment.steer,
              unexpected: true,
            },
          },
        },
      } as never),
    ).toThrow();
  });

  it("retains exact top-level and nested closure after official validation", () => {
    expect(() => codexTurnStartMethod.encodeParams({
      threadId: "thread-1",
      input: [{
        type: "text",
        text: "hello",
        text_elements: [{
          byteRange: { start: 0, end: 5, extra: true },
          placeholder: null,
        }],
      }],
    } as never)).toThrow();
    expect(() => decodeCodexC2ServerRequest("item/tool/requestUserInput", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: [{ id: "q", header: "h", question: "?", isOther: false, isSecret: false, options: [{ label: "yes", description: "yes", extra: true }] }],
      isBlocking: true,
    })).toThrow();
    expect(() => decodeCodexC2Notification("turn/plan/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      explanation: null,
      plan: [{ step: "test", status: "pending", extra: true }],
    })).toThrow();
    expect(() => encodeCodexC2RoutedServerResponse("applyPatchApproval", {
      decision: { denied: { rejection: "no", extra: true } },
    })).toThrow();
    const changed = decodeCodexServerNotificationParams("skills/changed", {
      extra: true,
    });
    expect(() => refineCodexSkillsChangedNotification(changed)).toThrow();
  });

  it("does not export handwritten per-route structural schemas", async () => {
    const protocol = await import(
      "../../src/server/backends/codex/codex-c2-protocol.js"
    );
    expect(Object.keys(protocol).filter((key) => /(?:Params|Response)Schema$/u.test(key))).toEqual([]);
  });

  it("preserves legacy UTF-16 code-unit bounds for ids, paths, and skill metadata", () => {
    const maxUnicodeId = "😀".repeat(256);
    expect(codexThreadSettingsUpdateMethod.encodeParams({
      threadId: maxUnicodeId,
    })).toEqual({ threadId: maxUnicodeId });
    expect(() => codexThreadSettingsUpdateMethod.encodeParams({
      threadId: `${maxUnicodeId}😀`,
    })).toThrow();

    const maxUnicodePath = "😀".repeat(2048);
    expect(codexSkillsListMethod.encodeParams({ cwds: [maxUnicodePath] })).toEqual({
      cwds: [maxUnicodePath],
    });
    expect(() => codexSkillsListMethod.encodeParams({
      cwds: [`${maxUnicodePath}😀`],
    })).toThrow();

    const maxUnicodeSkillName = "😀".repeat(120);
    const projectedSkill = codexSkillsListMethod.decodeResult({
      data: [{
        cwd: maxUnicodePath,
        skills: [{
          name: maxUnicodeSkillName,
          description: "skill",
          path: maxUnicodePath,
          scope: "repo",
          enabled: true,
          pluginId: "private-plugin",
        }],
        errors: [],
      }],
    }).data[0]?.skills[0];
    expect(projectedSkill?.name).toBe(maxUnicodeSkillName);
    expect(projectedSkill).not.toHaveProperty("pluginId");
    expect(JSON.stringify(projectedSkill)).not.toContain("private-plugin");

    for (const pluginId of ["", "x".repeat(513)]) {
      expect(() => codexSkillsListMethod.decodeResult({
        data: [{
          cwd: maxUnicodePath,
          skills: [{
            name: maxUnicodeSkillName,
            description: "skill",
            path: maxUnicodePath,
            scope: "repo",
            enabled: true,
            pluginId,
          }],
          errors: [],
        }],
      })).toThrow();
    }
  });

  it("allows unsafe finite numbers only in intentionally open JSON payloads", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(codexThreadStartMethod.encodeParams({
      config: { unsafe },
    })).toEqual({ config: { unsafe } });
    expect(decodeCodexC2ServerRequest("item/tool/call", {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: null,
      tool: "tool",
      arguments: { unsafe },
    }).params).toMatchObject({ arguments: { unsafe } });
    expect(() => codexModelListMethod.encodeParams({ limit: unsafe })).toThrow();
    expect(() => codexModelListMethod.encodeParams({ limit: -1 })).toThrow();
    expect(() => decodeCodexC2ServerRequest(
      "item/fileChange/requestApproval",
      {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: unsafe,
      },
    )).toThrow();
    expect(() => encodeCodexC2RoutedServerResponse(
      "item/permissions/requestApproval",
      {
        permissions: {
          fileSystem: {
            read: null,
            write: null,
            globScanMaxDepth: -1,
          },
        },
        scope: "turn",
      },
    )).toThrow();
    expect(() => decodeCodexC2Notification("item/reasoning/summaryPartAdded", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      summaryIndex: unsafe,
    })).toThrow();
  });

  it("closes boolean elicitation schemas and keeps their count fields safe", () => {
    const base = {
      threadId: "thread-1",
      turnId: null,
      serverName: "server",
      mode: "form",
      _meta: { unsafe: Number.MAX_SAFE_INTEGER + 1 },
      message: "question",
      requestedSchema: {
        type: "object",
        properties: { enabled: { type: "boolean", default: true } },
      },
    } as const;
    expect(decodeCodexC2ServerRequest("mcpServer/elicitation/request", base).params).toEqual(base);
    expect(() => decodeCodexC2ServerRequest("mcpServer/elicitation/request", {
      ...base,
      requestedSchema: {
        ...base.requestedSchema,
        properties: { enabled: { type: "boolean", default: true, minimum: 0 } },
      },
    })).toThrow();
    expect(() => decodeCodexC2ServerRequest("mcpServer/elicitation/request", {
      ...base,
      requestedSchema: {
        ...base.requestedSchema,
        properties: { values: { type: "array", minItems: -1, items: { type: "string", enum: [] } } },
      },
    })).toThrow();
    expect(() => decodeCodexC2ServerRequest("mcpServer/elicitation/request", {
      ...base,
      url: "https://example.test/elicitation",
      elicitationId: "elicitation-1",
    })).toThrow();
    expect(() => decodeCodexC2ServerRequest("mcpServer/elicitation/request", {
      threadId: "thread-1",
      turnId: null,
      serverName: "server",
      mode: "url",
      _meta: null,
      message: "question",
      url: "https://example.test/elicitation",
      elicitationId: "elicitation-1",
      requestedSchema: {},
    })).toThrow();
  });

  it("recognizes but fails closed on unadvertised openai elicitation forms", () => {
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "provider",
      mode: "openaiForm",
      _meta: null,
      message: "Configure the provider",
      requestedSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
        },
      },
    } as const;

    expect(
      decodeCodexServerRequestParams("mcpServer/elicitation/request", params),
    ).toEqual(params);
    expect(() =>
      decodeCodexC2ServerRequest("mcpServer/elicitation/request", params),
    ).toThrow("codex_mcp_openai_elicitation_unadvertised");
  });

  it("validates the experimental settings notification field enabled by the adopted mode", () => {
    const params = {
      threadId: "thread-1",
      threadSettings: {
        cwd: "/workspace",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        model: "gpt-5.6-luna",
        modelProvider: "openai",
        serviceTier: null,
        effort: "low",
        summary: null,
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.6-luna",
            reasoning_effort: "low",
            developer_instructions: null,
          },
        },
        multiAgentMode: "explicitRequestOnly",
        personality: null,
      },
    };
    expect(
      decodeCodexC2Notification("thread/settings/updated", params),
    ).toEqual(params);
    expect(() =>
      decodeCodexC2Notification("thread/settings/updated", {
        ...params,
        threadSettings: {
          ...params.threadSettings,
          multiAgentMode: "unknown-mode",
        },
      }),
    ).toThrow();
  });
});
