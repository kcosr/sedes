import { describe, expect, it } from "vitest";
import { threadInteractionResponseSchema } from "../../src/shared/protocol/api.js";
import {
  backendCapabilityDocumentSchema,
  driverInteractionSchema,
  interactionResponseInputSchema,
} from "../../src/shared/protocol/backend.js";
import { backendInteractionSchema } from "../../src/shared/protocol/conversation.js";

const base = {
  backendInteractionId: "backend-interaction",
  sourceLabel: { text: "Agent" },
  title: { text: "Input required" },
  openedAt: "2026-08-07T12:00:00.000Z",
  secret: false,
  destructive: false,
  cancellable: false,
} as const;

describe("blocking interaction protocol", () => {
  it("accepts bounded invocation context and rejects raw provider arguments", () => {
    const interaction = {
      ...base,
      kind: "editor",
      initialValue: { text: "{}" },
      invocation: {
        arguments: {
          kind: "object",
          entries: [
            {
              key: { text: "token" },
              value: { kind: "redacted", reason: "sensitive_key" },
            },
          ],
        },
      },
    };
    expect(driverInteractionSchema.safeParse(interaction).success).toBe(true);
    const { backendInteractionId: _id, ...presentation } = interaction;
    expect(
      backendInteractionSchema.safeParse({
        ...presentation,
        id: "request",
        threadId: "thread",
      }).success,
    ).toBe(true);
    expect(
      driverInteractionSchema.safeParse({
        ...interaction,
        invocation: { arguments: { token: "unbounded raw secret" } },
      }).success,
    ).toBe(false);
    expect(
      driverInteractionSchema.safeParse({
        ...interaction,
        invocation: {
          ...interaction.invocation,
          nativeItemId: "provider-private",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts flexible decision roles but rejects duplicate IDs and primaries", () => {
    const decision = {
      ...base,
      kind: "decision" as const,
      message: { text: "This action needs approval." },
      code: { text: "npm test" },
      actions: [
        {
          backendActionId: "allow",
          label: { text: "Allow once" },
          role: "primary" as const,
        },
        {
          backendActionId: "deny",
          label: { text: "Deny" },
          role: "reject" as const,
        },
      ],
    };
    expect(driverInteractionSchema.safeParse(decision).success).toBe(true);
    expect(
      driverInteractionSchema.safeParse({
        ...decision,
        actions: [decision.actions[1]],
      }).success,
    ).toBe(true);
    expect(
      driverInteractionSchema.safeParse({
        ...decision,
        actions: [decision.actions[0]],
      }).success,
    ).toBe(true);
    expect(
      driverInteractionSchema.safeParse({
        ...decision,
        actions: [decision.actions[0], decision.actions[0]],
      }).success,
    ).toBe(false);
    expect(
      driverInteractionSchema.safeParse({
        ...decision,
        actions: [
          decision.actions[0],
          { ...decision.actions[0], backendActionId: "always" },
        ],
      }).success,
    ).toBe(false);
  });

  it("enforces questionnaire counts, identities, sensitivity, and input shapes", () => {
    const questionnaire = {
      ...base,
      secret: true,
      kind: "questionnaire" as const,
      questions: [
        {
          backendQuestionId: "environment",
          header: { text: "Environment" },
          prompt: { text: "Which environment?" },
          secret: false,
          input: {
            kind: "single_choice" as const,
            options: [
              {
                backendOptionId: "staging",
                label: { text: "Staging" },
                description: { text: "Shared services" },
              },
            ],
            other: {
              backendOptionId: "other",
              label: { text: "None of the above" },
            },
            allowNote: true,
          },
        },
        {
          backendQuestionId: "token",
          header: { text: "Token" },
          prompt: { text: "Enter the token" },
          secret: true,
          input: { kind: "text" as const, multiline: false },
        },
      ],
    };
    expect(driverInteractionSchema.safeParse(questionnaire).success).toBe(true);
    expect(
      driverInteractionSchema.safeParse({ ...questionnaire, secret: false })
        .success,
    ).toBe(false);
    expect(
      driverInteractionSchema.safeParse({
        ...questionnaire,
        questions: [
          questionnaire.questions[0],
          {
            ...questionnaire.questions[1],
            backendQuestionId: "environment",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      driverInteractionSchema.safeParse({
        ...questionnaire,
        questions: Array.from({ length: 4 }, (_, index) => ({
          ...questionnaire.questions[1],
          backendQuestionId: `question-${index}`,
        })),
      }).success,
    ).toBe(false);
    expect(
      driverInteractionSchema.safeParse({
        ...questionnaire,
        expiresAt: "2026-08-07T12:01:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("strictly validates browser decision and complete-answer response members", () => {
    expect(
      threadInteractionResponseSchema.safeParse({
        kind: "decision",
        selectedActionId: "action",
      }).success,
    ).toBe(true);
    expect(
      threadInteractionResponseSchema.safeParse({
        kind: "decision",
        selectedActionId: "action",
        nativeDecision: "approved",
      }).success,
    ).toBe(false);
    expect(
      threadInteractionResponseSchema.safeParse({
        kind: "questionnaire",
        answers: [
          { questionId: "one", answer: { kind: "unanswered" } },
          {
            questionId: "two",
            answer: {
              kind: "single_choice",
              selectedOptionId: "option",
              note: "details",
            },
          },
          {
            questionId: "three",
            answer: { kind: "text", value: "value" },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      threadInteractionResponseSchema.safeParse({
        kind: "questionnaire",
        answers: [
          { questionId: "one", answer: { kind: "unanswered" } },
          { questionId: "one", answer: { kind: "unanswered" } },
        ],
      }).success,
    ).toBe(false);
    expect(
      threadInteractionResponseSchema.safeParse({
        kind: "questionnaire",
        answers: [],
      }).success,
    ).toBe(false);
  });

  it("keeps decision and questionnaire capabilities explicitly independent", () => {
    const capabilities = {
      revision: "revision",
      actions: [],
      deliveryModes: [],
      steerTarget: null,
      composerAttachments: { fileStaging: false, nativeImage: false },
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      supportsHistory: false,
      branching: {
        availability: "unavailable" as const,
        reason: { text: "Unavailable" },
      },
      interactionKinds: ["decision" as const],
      usageSections: [],
      effectiveSettings: {},
    };
    expect(
      backendCapabilityDocumentSchema.safeParse(capabilities).success,
    ).toBe(true);
    expect(
      backendCapabilityDocumentSchema.safeParse({
        ...capabilities,
        interactionKinds: ["questionnaire"],
      }).success,
    ).toBe(true);
    expect(
      backendCapabilityDocumentSchema.safeParse({
        ...capabilities,
        interactionKinds: ["decision", "decision"],
      }).success,
    ).toBe(false);
  });

  it("uses a distinct strict parser for server-private backend responses", () => {
    const response = {
      applicationOperationId: "operation",
      interactionId: "i".repeat(512),
      kind: "questionnaire" as const,
      answers: [
        {
          questionId: "q".repeat(512),
          answer: { kind: "unanswered" as const },
        },
      ],
    };
    expect(interactionResponseInputSchema.safeParse(response).success).toBe(
      true,
    );
    expect(threadInteractionResponseSchema.safeParse(response).success).toBe(
      false,
    );
    expect(
      interactionResponseInputSchema.safeParse({
        ...response,
        answers: [...response.answers, response.answers[0]],
      }).success,
    ).toBe(false);
    expect(
      interactionResponseInputSchema.safeParse({
        ...response,
        resolution: "auto",
      }).success,
    ).toBe(false);
  });

  it("rejects browser questionnaire identities that collide across questions", () => {
    expect(
      backendInteractionSchema.safeParse({
        id: "interaction",
        threadId: "thread",
        sourceLabel: { text: "Agent" },
        title: { text: "Questions" },
        openedAt: "2026-08-07T12:00:00.000Z",
        secret: false,
        destructive: false,
        cancellable: false,
        kind: "questionnaire",
        questions: [
          {
            id: "one",
            header: { text: "One" },
            prompt: { text: "Choose" },
            secret: false,
            input: {
              kind: "single_choice",
              options: [
                {
                  id: "same-option",
                  label: { text: "A" },
                  description: { text: "A" },
                },
              ],
              allowNote: false,
            },
          },
          {
            id: "two",
            header: { text: "Two" },
            prompt: { text: "Choose" },
            secret: false,
            input: {
              kind: "single_choice",
              options: [
                {
                  id: "same-option",
                  label: { text: "B" },
                  description: { text: "B" },
                },
              ],
              allowNote: false,
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
