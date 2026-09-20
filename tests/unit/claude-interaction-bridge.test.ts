import { describe, expect, it } from "vitest";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { BackendConversationEvent } from "../../src/shared/protocol/backend.js";
import { ClaudeInteractionBridge } from "../../src/server/backends/claude/claude-interaction-bridge.js";

type InteractionEvent = Extract<
  BackendConversationEvent,
  { readonly type: "interaction_opened" | "interaction_resolved" }
>;
type PermissionOptions = Parameters<CanUseTool>[2];

function fixture() {
  const events: InteractionEvent[] = [];
  const bridge = new ClaudeInteractionBridge({
    emit: (event) => events.push(event),
    now: () => Date.parse("2026-08-08T12:00:00.000Z"),
  });
  const options = (
    overrides: Partial<PermissionOptions> = {},
  ): PermissionOptions => ({
    signal: new AbortController().signal,
    requestId: "request-1",
    toolUseID: "tool-use-1",
    ...overrides,
  });
  const opened = () => {
    const event = events.find(
      (candidate) => candidate.type === "interaction_opened",
    );
    if (event?.type !== "interaction_opened") {
      throw new Error("interaction was not opened");
    }
    return event.interaction;
  };
  const respond = async (input: Parameters<typeof bridge.respond>[0]) => {
    const response = bridge.respond(input);
    bridge.permissionResponseDelivered({
      requestId: "request-1",
      toolUseID: "tool-use-1",
    });
    await response;
  };
  return { bridge, events, options, opened, respond };
}

describe("ClaudeInteractionBridge", () => {
  it.each([{}, { command: "pwd" }])(
    "defaults a guarded approval to deny without a primary approval action",
    async (input) => {
      const current = fixture();
      const response = current.bridge.canUseTool(
        "Read",
        input,
        current.options({ defaultToNo: true }),
      );
      expect(current.opened()).toMatchObject({
        kind: "decision",
        actions: [
          { backendActionId: "deny", role: "reject" },
          { backendActionId: "allow_once", role: "alternative" },
        ],
      });
      await current.respond({
        applicationOperationId: "deny-guarded",
        interactionId: current.opened().backendInteractionId,
        kind: "decision",
        selectedActionId: "deny",
      });
      await expect(response).resolves.toMatchObject({ behavior: "deny" });
    },
  );

  it("suppresses a session grant and rejects a forged grant response while retaining allow-once", async () => {
    const current = fixture();
    const response = current.bridge.canUseTool(
      "Bash",
      { command: "pwd" },
      current.options({
        suppressAlwaysAllowRule: true,
        suggestions: [
          {
            type: "addRules",
            behavior: "allow",
            destination: "session",
            rules: [{ toolName: "Bash" }],
          },
        ],
      }),
    );
    const interaction = current.opened();
    expect(interaction).toMatchObject({
      kind: "decision",
      actions: [
        { backendActionId: "allow_once", role: "primary" },
        { backendActionId: "deny", role: "reject" },
      ],
    });
    await expect(
      current.bridge.respond({
        applicationOperationId: "forged-grant",
        interactionId: interaction.backendInteractionId,
        kind: "decision",
        selectedActionId: "allow_for_session",
      }),
    ).rejects.toThrow();
    expect(current.bridge.pendingCount()).toBe(1);
    await current.respond({
      applicationOperationId: "allow-once",
      interactionId: interaction.backendInteractionId,
      kind: "decision",
      selectedActionId: "allow_once",
    });
    await expect(response).resolves.toMatchObject({ behavior: "allow" });
    expect(await response).not.toHaveProperty("updatedPermissions");
  });

  it("holds a destructive tool request and resolves an allow-once decision", async () => {
    const current = fixture();
    let settled = false;
    const providerResponse = current.bridge.canUseTool(
      "Bash",
      { command: "npm test" },
      current.options({
        title: "Run command?",
        description: "Claude wants to run a command.",
        suggestions: [
          {
            type: "addRules",
            behavior: "allow",
            destination: "session",
            rules: [{ toolName: "Bash" }],
          },
        ],
      }),
    );
    void providerResponse.then(() => {
      settled = true;
    });

    expect(settled).toBe(false);
    expect(current.opened()).toMatchObject({
      kind: "decision",
      sourceLabel: { text: "Claude" },
      title: { text: "Run command?" },
      message: { text: "Claude wants to run a command." },
      code: { text: expect.stringContaining("npm test") },
      openedAt: "2026-08-08T12:00:00.000Z",
      destructive: true,
      actions: [
        { backendActionId: "allow_once", role: "primary" },
        { backendActionId: "allow_for_session", role: "alternative" },
        { backendActionId: "deny", role: "reject" },
      ],
    });

    await current.respond({
      applicationOperationId: "operation-1",
      interactionId: current.opened().backendInteractionId,
      kind: "decision",
      selectedActionId: "allow_once",
    });

    await expect(providerResponse).resolves.toEqual({
      behavior: "allow",
      toolUseID: "tool-use-1",
      decisionClassification: "user_temporary",
    });
    expect(current.events.at(-1)).toEqual({
      type: "interaction_resolved",
      backendInteractionId: current.opened().backendInteractionId,
    });
  });

  it("returns Claude's complete safe additive session suggestions unchanged", async () => {
    const current = fixture();
    const suggestions = [
      {
        type: "addRules" as const,
        behavior: "allow" as const,
        destination: "session" as const,
        rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
      },
      {
        type: "addDirectories" as const,
        destination: "session" as const,
        directories: ["/workspace/generated"],
      },
    ];
    const providerResponse = current.bridge.canUseTool(
      "Bash",
      { command: "npm test" },
      current.options({ suggestions }),
    );

    await current.respond({
      applicationOperationId: "operation-session",
      interactionId: current.opened().backendInteractionId,
      kind: "decision",
      selectedActionId: "allow_for_session",
    });

    await expect(providerResponse).resolves.toEqual({
      behavior: "allow",
      updatedPermissions: suggestions,
      toolUseID: "tool-use-1",
      decisionClassification: "user_permanent",
    });
  });

  it.each([
    [
      "non-session destination",
      [
        {
          type: "addRules" as const,
          behavior: "allow" as const,
          destination: "userSettings" as const,
          rules: [{ toolName: "Bash" }],
        },
      ],
    ],
    [
      "deny rule",
      [
        {
          type: "addRules" as const,
          behavior: "deny" as const,
          destination: "session" as const,
          rules: [{ toolName: "Bash" }],
        },
      ],
    ],
    [
      "mode change",
      [
        {
          type: "setMode" as const,
          mode: "bypassPermissions" as const,
          destination: "session" as const,
        },
      ],
    ],
    [
      "rule replacement",
      [
        {
          type: "replaceRules" as const,
          behavior: "allow" as const,
          destination: "session" as const,
          rules: [{ toolName: "Bash" }],
        },
      ],
    ],
    [
      "rule removal",
      [
        {
          type: "removeRules" as const,
          behavior: "allow" as const,
          destination: "session" as const,
          rules: [{ toolName: "Bash" }],
        },
      ],
    ],
    [
      "oversized rule content",
      [
        {
          type: "addRules" as const,
          behavior: "allow" as const,
          destination: "session" as const,
          rules: [{ toolName: "Bash", ruleContent: "x".repeat(4_097) }],
        },
      ],
    ],
    [
      "an unknown rule field",
      [
        {
          type: "addRules" as const,
          behavior: "allow" as const,
          destination: "session" as const,
          rules: [{ toolName: "Bash", unexpected: true }],
        },
      ],
    ],
    [
      "control characters in a directory",
      [
        {
          type: "addDirectories" as const,
          destination: "session" as const,
          directories: ["/workspace/generated\nother"],
        },
      ],
    ],
    [
      "mixed safe and unsafe updates",
      [
        {
          type: "addDirectories" as const,
          destination: "session" as const,
          directories: ["/workspace/generated"],
        },
        {
          type: "removeDirectories" as const,
          destination: "session" as const,
          directories: ["/workspace"],
        },
      ],
    ],
  ])("does not offer a session grant for %s", (_label, suggestions) => {
    const current = fixture();
    void current.bridge.canUseTool(
      "Bash",
      { command: "npm test" },
      current.options({ suggestions }),
    );
    const interaction = current.opened();
    expect(interaction.kind).toBe("decision");
    if (interaction.kind !== "decision") throw new Error("expected decision");
    expect(
      interaction.actions.map(({ backendActionId }) => backendActionId),
    ).toEqual(["allow_once", "deny"]);
  });

  it("bounds and redacts tool input before emitting it", () => {
    const current = fixture();
    void current.bridge.canUseTool(
      "Write",
      {
        apiKey: "sk-should-not-leak",
        content: "x".repeat(100_000),
      },
      current.options(),
    );

    const interaction = current.opened();
    expect(interaction.kind).toBe("decision");
    if (interaction.kind !== "decision") throw new Error("expected decision");
    expect(interaction.code?.text).not.toContain("sk-should-not-leak");
    expect(interaction.code?.text).toContain("redacted");
    expect(
      Buffer.byteLength(interaction.code?.text ?? "", "utf8"),
    ).toBeLessThanOrEqual(16_384);
  });

  it("uses a compact confirmation for a non-mutating request without input", async () => {
    const current = fixture();
    const providerResponse = current.bridge.canUseTool(
      "Read",
      {},
      current.options({ displayName: "Read file" }),
    );
    expect(current.opened()).toMatchObject({
      kind: "confirmation",
      title: { text: "Read file permission" },
      confirmLabel: { text: "Allow once" },
      cancelLabel: { text: "Deny" },
      destructive: false,
    });

    await current.respond({
      applicationOperationId: "operation-1",
      interactionId: current.opened().backendInteractionId,
      kind: "confirmation",
      confirmed: false,
    });
    await expect(providerResponse).resolves.toMatchObject({
      behavior: "deny",
      message: "User denied permission.",
      toolUseID: "tool-use-1",
    });
  });

  it("maps AskUserQuestion choices and Other text to Claude's answer map", async () => {
    const current = fixture();
    const questions = [
      {
        question: "Which environment should I use?",
        header: "Environment",
        options: [
          { label: "Staging", description: "Shared test environment" },
          { label: "Production", description: "Customer environment" },
        ],
        multiSelect: false,
      },
    ];
    const providerResponse = current.bridge.canUseTool(
      "AskUserQuestion",
      { questions, metadata: "preserved" },
      current.options(),
    );
    const interaction = current.opened();
    expect(interaction).toMatchObject({
      kind: "questionnaire",
      title: { text: "Questions" },
      destructive: false,
      questions: [
        {
          backendQuestionId: "Which environment should I use?",
          header: { text: "Environment" },
          prompt: { text: "Which environment should I use?" },
          input: {
            kind: "single_choice",
            allowNote: true,
            options: [
              {
                label: { text: "Staging" },
                description: { text: "Shared test environment" },
              },
              {
                label: { text: "Production" },
                description: { text: "Customer environment" },
              },
            ],
            other: { label: { text: "Other" } },
          },
        },
      ],
    });
    if (interaction.kind !== "questionnaire") {
      throw new Error("expected questionnaire");
    }
    const question = interaction.questions[0]!;
    if (question.input.kind !== "single_choice" || !question.input.other) {
      throw new Error("expected single choice with Other");
    }

    await current.respond({
      applicationOperationId: "operation-question",
      interactionId: interaction.backendInteractionId,
      kind: "questionnaire",
      answers: [
        {
          questionId: question.backendQuestionId,
          answer: {
            kind: "single_choice",
            selectedOptionId: question.input.other.backendOptionId,
            note: "Use the isolated preview environment",
          },
        },
      ],
    });
    await expect(providerResponse).resolves.toEqual({
      behavior: "allow",
      updatedInput: {
        questions,
        metadata: "preserved",
        answers: {
          "Which environment should I use?":
            "Use the isolated preview environment",
        },
      },
      toolUseID: "tool-use-1",
      decisionClassification: "user_temporary",
    });
  });

  it("returns a selected AskUserQuestion label under the full question text", async () => {
    const current = fixture();
    const fullQuestion = "q".repeat(700);
    const providerResponse = current.bridge.canUseTool(
      "AskUserQuestion",
      {
        questions: [
          {
            question: fullQuestion,
            header: "Long question",
            options: [
              { label: "First", description: "The first option" },
              { label: "Second", description: "The second option" },
            ],
            multiSelect: false,
          },
        ],
      },
      current.options(),
    );
    const interaction = current.opened();
    if (interaction.kind !== "questionnaire") {
      throw new Error("expected questionnaire");
    }
    const question = interaction.questions[0]!;
    expect(question.backendQuestionId).toMatch(
      /^claude-question:[a-f0-9]{64}$/,
    );
    if (question.input.kind !== "single_choice") {
      throw new Error("expected single choice");
    }

    await current.respond({
      applicationOperationId: "operation-question",
      interactionId: interaction.backendInteractionId,
      kind: "questionnaire",
      answers: [
        {
          questionId: question.backendQuestionId,
          answer: {
            kind: "single_choice",
            selectedOptionId: question.input.options[1]!.backendOptionId,
          },
        },
      ],
    });
    await expect(providerResponse).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { [fullQuestion]: "Second" } },
    });
  });

  it("presents multi-select AskUserQuestion input as bounded freeform text", async () => {
    const current = fixture();
    const providerResponse = current.bridge.canUseTool(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Which checks should run?",
            header: "Checks",
            options: [
              { label: "Unit", description: "Unit tests" },
              { label: "E2E", description: "Browser tests" },
            ],
            multiSelect: true,
          },
        ],
      },
      current.options(),
    );
    const interaction = current.opened();
    expect(interaction).toMatchObject({
      kind: "questionnaire",
      questions: [
        {
          backendQuestionId: "Which checks should run?",
          input: {
            kind: "text",
            multiline: true,
            placeholder: { text: "Enter one or more choices" },
          },
        },
      ],
    });
    if (interaction.kind !== "questionnaire") {
      throw new Error("expected questionnaire");
    }

    await current.respond({
      applicationOperationId: "operation-question",
      interactionId: interaction.backendInteractionId,
      kind: "questionnaire",
      answers: [
        {
          questionId: interaction.questions[0]!.backendQuestionId,
          answer: { kind: "text", value: "Unit, E2E" },
        },
      ],
    });
    await expect(providerResponse).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: {
        answers: { "Which checks should run?": "Unit, E2E" },
      },
    });
  });

  it("fails closed for malformed, cancelled, and invalid question requests", async () => {
    const malformed = fixture();
    await expect(
      malformed.bridge.canUseTool(
        "AskUserQuestion",
        { questions: [] },
        malformed.options(),
      ),
    ).resolves.toMatchObject({
      behavior: "deny",
      message: "Invalid question request.",
    });
    expect(malformed.events).toHaveLength(0);

    const cancelled = fixture();
    const cancelledResponse = cancelled.bridge.canUseTool(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Continue?",
            header: "Continue",
            options: [{ label: "Yes", description: "Continue" }],
            multiSelect: false,
          },
        ],
      },
      cancelled.options(),
    );
    await cancelled.respond({
      applicationOperationId: "operation-cancel",
      interactionId: cancelled.opened().backendInteractionId,
      kind: "cancel",
    });
    await expect(cancelledResponse).resolves.toMatchObject({
      behavior: "deny",
      message: "Question request cancelled.",
    });

    const invalid = fixture();
    const invalidResponse = invalid.bridge.canUseTool(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Continue?",
            header: "Continue",
            options: [{ label: "Yes", description: "Continue" }],
            multiSelect: false,
          },
        ],
      },
      invalid.options(),
    );
    await invalid.respond({
      applicationOperationId: "operation-invalid",
      interactionId: invalid.opened().backendInteractionId,
      kind: "questionnaire",
      answers: [
        {
          questionId: "not-the-question",
          answer: { kind: "unanswered" },
        },
      ],
    });
    await expect(invalidResponse).resolves.toMatchObject({
      behavior: "deny",
      message: "Invalid question response.",
    });
  });

  it("deduplicates callbacks by request and tool-use identifiers", async () => {
    const current = fixture();
    const options = current.options();
    const first = current.bridge.canUseTool(
      "Bash",
      { command: "pwd" },
      options,
    );
    const duplicate = current.bridge.canUseTool(
      "Bash",
      { command: "different provider replay" },
      options,
    );

    expect(
      current.events.filter(({ type }) => type === "interaction_opened"),
    ).toHaveLength(1);
    expect(current.bridge.pendingCount()).toBe(1);
    await current.respond({
      applicationOperationId: "operation-1",
      interactionId: current.opened().backendInteractionId,
      kind: "decision",
      selectedActionId: "deny",
    });
    await expect(first).resolves.toMatchObject({ behavior: "deny" });
    await expect(duplicate).resolves.toMatchObject({ behavior: "deny" });
  });

  it("accepts an exact response replay and rejects a conflicting replay", async () => {
    const current = fixture();
    const providerResponse = current.bridge.canUseTool(
      "Bash",
      { command: "pwd" },
      current.options(),
    );
    const response = {
      applicationOperationId: "operation-1",
      interactionId: current.opened().backendInteractionId,
      kind: "decision" as const,
      selectedActionId: "allow_once",
    };
    await current.respond(response);
    await current.respond(response);
    await expect(providerResponse).resolves.toMatchObject({
      behavior: "allow",
    });
    expect(current.bridge.reconcile(response)).toEqual({ outcome: "accepted" });

    await expect(
      current.bridge.canUseTool(
        "Bash",
        { command: "provider replay" },
        current.options(),
      ),
    ).resolves.toMatchObject({ behavior: "allow" });
    expect(
      current.events.filter(({ type }) => type === "interaction_opened"),
    ).toHaveLength(1);

    await expect(
      current.respond({ ...response, selectedActionId: "deny" }),
    ).rejects.toMatchObject({
      code: "claude_interaction_response_replay_mismatch",
    });
  });

  it("leaves a request pending after an invalid response", async () => {
    const current = fixture();
    void current.bridge.canUseTool(
      "Bash",
      { command: "pwd" },
      current.options(),
    );
    const interactionId = current.opened().backendInteractionId;
    await expect(
      current.respond({
        applicationOperationId: "operation-1",
        interactionId,
        kind: "confirmation",
        confirmed: true,
      }),
    ).rejects.toMatchObject({
      code: "claude_interaction_response_invalid",
    });
    expect(current.bridge.pendingCount()).toBe(1);
    expect(
      current.bridge.reconcile({
        applicationOperationId: "operation-1",
        interactionId,
        kind: "decision",
        selectedActionId: "deny",
      }),
    ).toEqual({ outcome: "not_applied" });
  });

  it("keeps a released response unknown when provider delivery fails", async () => {
    const current = fixture();
    const providerResponse = current.bridge.canUseTool(
      "Bash",
      { command: "pwd" },
      current.options(),
    );
    const response = {
      applicationOperationId: "operation-1",
      interactionId: current.opened().backendInteractionId,
      kind: "decision" as const,
      selectedActionId: "allow_once",
    };
    const responding = current.bridge.respond(response);

    await expect(providerResponse).resolves.toMatchObject({
      behavior: "allow",
    });
    expect(current.bridge.reconcile(response)).toEqual({ outcome: "unknown" });
    expect(
      current.events.filter(({ type }) => type === "interaction_resolved"),
    ).toHaveLength(0);

    current.bridge.permissionResponseDeliveryFailed({
      requestId: "request-1",
      toolUseID: "tool-use-1",
      error: new Error("response frame failed"),
    });
    await expect(responding).rejects.toMatchObject({
      code: "claude_interaction_response_delivery_failed",
    });
    expect(current.bridge.pendingCount()).toBe(0);
    expect(current.bridge.reconcile(response)).toEqual({ outcome: "unknown" });
    expect(
      current.events.filter(({ type }) => type === "interaction_resolved"),
    ).toHaveLength(0);
  });

  it("denies and resolves a pending request when its signal aborts", async () => {
    const current = fixture();
    const controller = new AbortController();
    const providerResponse = current.bridge.canUseTool(
      "Bash",
      { command: "pwd" },
      current.options({ signal: controller.signal }),
    );
    const interactionId = current.opened().backendInteractionId;
    controller.abort();

    await expect(providerResponse).resolves.toMatchObject({
      behavior: "deny",
      message: "Permission request cancelled.",
      interrupt: false,
    });
    expect(current.bridge.pendingCount()).toBe(0);
    expect(current.events.at(-1)).toEqual({
      type: "interaction_resolved",
      backendInteractionId: interactionId,
    });
  });

  it("fails closed on close and on callbacks received after close", async () => {
    const current = fixture();
    const pending = current.bridge.canUseTool(
      "Bash",
      { command: "pwd" },
      current.options(),
    );
    current.bridge.close();
    current.bridge.close();

    await expect(pending).resolves.toMatchObject({
      behavior: "deny",
      message: "Permission request closed.",
    });
    await expect(
      current.bridge.canUseTool(
        "Read",
        {},
        current.options({ requestId: "request-after-close" }),
      ),
    ).resolves.toMatchObject({ behavior: "deny" });
    expect(current.bridge.pendingCount()).toBe(0);
    expect(
      current.events.filter(({ type }) => type === "interaction_opened"),
    ).toHaveLength(1);
    await expect(
      current.bridge.respond({
        applicationOperationId: "operation-2",
        interactionId: "missing",
        kind: "cancel",
      }),
    ).rejects.toMatchObject({
      code: "claude_interaction_bridge_closed",
    });
  });

  it("unblocks every provider request when a resolved-event observer throws", async () => {
    const bridge = new ClaudeInteractionBridge({
      emit: (event) => {
        if (event.type === "interaction_resolved") {
          throw new Error("observer failed");
        }
      },
    });
    const first = bridge.canUseTool(
      "Bash",
      { command: "one" },
      {
        signal: new AbortController().signal,
        requestId: "request-1",
        toolUseID: "tool-1",
      },
    );
    const second = bridge.canUseTool(
      "Bash",
      { command: "two" },
      {
        signal: new AbortController().signal,
        requestId: "request-2",
        toolUseID: "tool-2",
      },
    );

    bridge.close();
    await expect(first).resolves.toMatchObject({ behavior: "deny" });
    await expect(second).resolves.toMatchObject({ behavior: "deny" });
    expect(bridge.pendingCount()).toBe(0);
  });
});
