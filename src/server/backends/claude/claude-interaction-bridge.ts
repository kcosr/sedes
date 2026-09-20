import { createHash } from "node:crypto";
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  BackendConversationEvent,
  DriverInteraction,
} from "../../../shared/protocol/backend.js";
import { driverInteractionSchema } from "../../../shared/protocol/backend.js";
import { INTERACTION_LIMITS } from "../../../shared/protocol/interactions.js";
import {
  boundDisplayText,
  boundText,
  boundValue,
} from "../../conversations/payload-policy.js";
import type {
  BackendMutationReconciliation,
  InteractionResponseInput,
} from "../contracts.js";

const ALLOW_ONCE_ACTION_ID = "allow_once";
const ALLOW_FOR_SESSION_ACTION_ID = "allow_for_session";
const DENY_ACTION_ID = "deny";
const MAXIMUM_RESOLVED_PERMISSIONS = 1_024;
const MAXIMUM_SESSION_PERMISSION_UPDATES = 64;
const MAXIMUM_SESSION_PERMISSION_ENTRIES = 256;
const MAXIMUM_SESSION_PERMISSION_TEXT = 4_096;
const MAXIMUM_SESSION_PERMISSION_BYTES = 65_536;

type InteractionEvent = Extract<
  BackendConversationEvent,
  { readonly type: "interaction_opened" | "interaction_resolved" }
>;

type PermissionOptions = Parameters<CanUseTool>[2];

interface PendingPermission {
  readonly nativeKey: string;
  readonly backendInteractionId: string;
  readonly toolUseID: string;
  readonly interaction: DriverInteraction;
  readonly promise: Promise<PermissionResult>;
  readonly resolve: (result: PermissionResult) => void;
  readonly removeAbortListener: () => void;
  readonly askUserQuestion?: AskUserQuestionState;
  readonly sessionPermissionUpdates?: readonly PermissionUpdate[];
  settlement?: PendingPermissionSettlement;
}

interface PendingPermissionSettlement {
  readonly responseFingerprint: string;
  readonly providerResult: PermissionResult;
  readonly delivery: Promise<void>;
  readonly resolveDelivery: () => void;
  readonly rejectDelivery: (error: unknown) => void;
}

interface AskUserQuestionState {
  readonly originalInput: Record<string, unknown>;
  readonly questions: readonly AskUserQuestion[];
}

interface AskUserQuestion {
  readonly id: string;
  readonly fullQuestion: string;
  readonly inputKind: "single_choice" | "text";
  readonly options: ReadonlyMap<string, string>;
  readonly otherOptionId?: string;
}

interface AskUserQuestionPresentation {
  readonly interaction: Extract<DriverInteraction, { kind: "questionnaire" }>;
  readonly state: AskUserQuestionState;
}

interface ResolvedPermission {
  readonly responseFingerprint: string;
  readonly providerResult: PermissionResult;
}

export class ClaudeInteractionBridgeError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "ClaudeInteractionBridgeError";
    this.code = code;
  }
}

/**
 * Adapts the Agent SDK's provider-private permission callback to Sedes's
 * normalized interaction contract. Permission decisions remain one-shot
 * unless Claude supplies a complete, session-scoped additive grant set.
 */
export class ClaudeInteractionBridge {
  readonly #emit: (event: InteractionEvent) => void;
  readonly #now: () => number;
  readonly #pendingByNativeKey = new Map<string, PendingPermission>();
  readonly #pendingByInteractionId = new Map<string, PendingPermission>();
  readonly #resolved = new Map<string, ResolvedPermission>();
  #closed = false;

  constructor(input: {
    readonly emit: (event: InteractionEvent) => void;
    readonly now?: () => number;
  }) {
    this.#emit = input.emit;
    this.#now = input.now ?? Date.now;
  }

  readonly canUseTool: CanUseTool = (toolName, toolInput, options) =>
    this.#requestPermission(toolName, toolInput, options);

  pendingCount(): number {
    return this.#pendingByInteractionId.size;
  }

  pendingInteractions(): readonly DriverInteraction[] {
    return [...this.#pendingByInteractionId.values()].map(({ interaction }) =>
      structuredClone(interaction),
    );
  }

  async respond(input: InteractionResponseInput): Promise<void> {
    const fingerprint = responseFingerprint(input);
    const resolved = this.#resolved.get(input.interactionId);
    if (resolved) {
      if (resolved.responseFingerprint !== fingerprint) {
        throw new ClaudeInteractionBridgeError(
          "claude_interaction_response_replay_mismatch",
        );
      }
      return;
    }
    if (this.#closed) {
      throw new ClaudeInteractionBridgeError(
        "claude_interaction_bridge_closed",
      );
    }
    const pending = this.#pendingByInteractionId.get(input.interactionId);
    if (!pending) {
      throw new ClaudeInteractionBridgeError("claude_interaction_not_pending");
    }

    const existingSettlement = pending.settlement;
    if (existingSettlement) {
      if (existingSettlement.responseFingerprint !== fingerprint) {
        throw new ClaudeInteractionBridgeError(
          "claude_interaction_response_replay_mismatch",
        );
      }
      await existingSettlement.delivery;
      return;
    }

    const result = providerResult(input, pending);
    let resolveDelivery!: () => void;
    let rejectDelivery!: (error: unknown) => void;
    const delivery = new Promise<void>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    pending.settlement = {
      responseFingerprint: fingerprint,
      providerResult: result,
      delivery,
      resolveDelivery,
      rejectDelivery,
    };
    // Release the provider callback so its response can cross the direct SDK
    // boundary or be encoded into the worker response frame. Acceptance is
    // committed only by the matching delivery notification below.
    pending.resolve(result);
    await delivery;
  }

  permissionResponseDelivered(input: {
    readonly requestId: string;
    readonly toolUseID: string;
  }): void {
    const pending = this.#pendingByNativeKey.get(
      permissionKey(input.requestId, input.toolUseID),
    );
    if (!pending?.settlement) return;
    this.#commitDelivery(pending);
  }

  permissionResponseDeliveryFailed(input: {
    readonly requestId: string;
    readonly toolUseID: string;
    readonly error: unknown;
  }): void {
    const pending = this.#pendingByNativeKey.get(
      permissionKey(input.requestId, input.toolUseID),
    );
    if (!pending?.settlement) return;
    this.#failDelivery(
      pending,
      new ClaudeInteractionBridgeError(
        "claude_interaction_response_delivery_failed",
        { cause: input.error },
      ),
    );
  }

  reconcile(input: InteractionResponseInput): BackendMutationReconciliation {
    const resolved = this.#resolved.get(input.interactionId);
    if (resolved) {
      if (resolved.responseFingerprint !== responseFingerprint(input)) {
        throw new ClaudeInteractionBridgeError(
          "claude_interaction_response_replay_mismatch",
        );
      }
      return { outcome: "accepted" };
    }
    const pending = this.#pendingByInteractionId.get(input.interactionId);
    return !pending
      ? { outcome: "unknown" }
      : pending.settlement
        ? { outcome: "unknown" }
        : { outcome: "not_applied" };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of [...this.#pendingByInteractionId.values()]) {
      if (pending.settlement) {
        this.#failDelivery(
          pending,
          new ClaudeInteractionBridgeError("claude_interaction_bridge_closed"),
        );
      } else {
        this.#settle(
          pending,
          denied(pending.toolUseID, "Permission request closed."),
        );
      }
    }
  }

  #rememberResolved(interactionId: string, resolved: ResolvedPermission): void {
    if (
      !this.#resolved.has(interactionId) &&
      this.#resolved.size >= MAXIMUM_RESOLVED_PERMISSIONS
    ) {
      const oldest = this.#resolved.keys().next().value;
      if (oldest !== undefined) this.#resolved.delete(oldest);
    }
    this.#resolved.set(interactionId, resolved);
  }

  async #requestPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    options: PermissionOptions,
  ): Promise<PermissionResult> {
    if (this.#closed) {
      return denied(options.toolUseID, "Permission request closed.");
    }
    if (options.signal.aborted) {
      return denied(options.toolUseID, "Permission request cancelled.");
    }

    const nativeKey = permissionKey(options.requestId, options.toolUseID);
    const existing = this.#pendingByNativeKey.get(nativeKey);
    if (existing) return existing.promise;

    const backendInteractionId = `claude-permission:${nativeKey}`;
    const resolved = this.#resolved.get(backendInteractionId);
    if (resolved) return resolved.providerResult;
    const askUserQuestion =
      toolName === "AskUserQuestion"
        ? presentAskUserQuestion(
            backendInteractionId,
            toolInput,
            options,
            this.#now,
          )
        : undefined;
    if (toolName === "AskUserQuestion" && !askUserQuestion) {
      return denied(options.toolUseID, "Invalid question request.");
    }
    const interaction =
      askUserQuestion?.interaction ??
      presentPermission(
        backendInteractionId,
        toolName,
        toolInput,
        options,
        this.#now,
      );
    const sessionPermissionUpdates = allowedSessionPermissionUpdates(options);
    let resolve!: (result: PermissionResult) => void;
    const promise = new Promise<PermissionResult>((settle) => {
      resolve = settle;
    });
    const abort = () => {
      const current = this.#pendingByNativeKey.get(nativeKey);
      if (current) {
        if (current.settlement) {
          this.#failDelivery(
            current,
            new ClaudeInteractionBridgeError(
              "claude_interaction_response_delivery_failed",
              { cause: options.signal.reason },
            ),
          );
        } else {
          this.#settle(
            current,
            denied(current.toolUseID, "Permission request cancelled."),
          );
        }
      }
    };
    options.signal.addEventListener("abort", abort, { once: true });
    const pending: PendingPermission = {
      nativeKey,
      backendInteractionId,
      toolUseID: options.toolUseID,
      interaction,
      promise,
      resolve,
      removeAbortListener: () =>
        options.signal.removeEventListener("abort", abort),
      ...(askUserQuestion ? { askUserQuestion: askUserQuestion.state } : {}),
      ...(sessionPermissionUpdates ? { sessionPermissionUpdates } : {}),
    };
    this.#pendingByNativeKey.set(nativeKey, pending);
    this.#pendingByInteractionId.set(backendInteractionId, pending);
    try {
      this.#emit({ type: "interaction_opened", interaction });
    } catch {
      this.#settle(
        pending,
        denied(options.toolUseID, "Permission request unavailable."),
        false,
      );
    }
    return promise;
  }

  #settle(
    pending: PendingPermission,
    result: PermissionResult,
    emitResolved = true,
  ): void {
    if (this.#pendingByNativeKey.get(pending.nativeKey) !== pending) return;
    this.#pendingByNativeKey.delete(pending.nativeKey);
    this.#pendingByInteractionId.delete(pending.backendInteractionId);
    pending.removeAbortListener();
    if (emitResolved) {
      try {
        this.#emit({
          type: "interaction_resolved",
          backendInteractionId: pending.backendInteractionId,
        });
      } catch {
        // A lifecycle observer must not leave the provider permission parked.
      } finally {
        pending.resolve(result);
      }
      return;
    }
    pending.resolve(result);
  }

  #commitDelivery(pending: PendingPermission): void {
    const settlement = pending.settlement;
    if (
      !settlement ||
      this.#pendingByNativeKey.get(pending.nativeKey) !== pending
    ) {
      return;
    }
    this.#pendingByNativeKey.delete(pending.nativeKey);
    this.#pendingByInteractionId.delete(pending.backendInteractionId);
    pending.removeAbortListener();
    this.#rememberResolved(pending.backendInteractionId, {
      responseFingerprint: settlement.responseFingerprint,
      providerResult: settlement.providerResult,
    });
    try {
      this.#emit({
        type: "interaction_resolved",
        backendInteractionId: pending.backendInteractionId,
      });
    } catch {
      // Delivery and replay acceptance do not depend on an event observer.
    } finally {
      settlement.resolveDelivery();
    }
  }

  #failDelivery(pending: PendingPermission, error: unknown): void {
    const settlement = pending.settlement;
    if (
      !settlement ||
      this.#pendingByNativeKey.get(pending.nativeKey) !== pending
    ) {
      return;
    }
    this.#pendingByNativeKey.delete(pending.nativeKey);
    this.#pendingByInteractionId.delete(pending.backendInteractionId);
    pending.removeAbortListener();
    settlement.rejectDelivery(error);
  }
}

function permissionKey(requestId: string, toolUseID: string): string {
  return createHash("sha256")
    .update(requestId)
    .update("\0")
    .update(toolUseID)
    .digest("hex")
    .slice(0, 40);
}

function presentPermission(
  backendInteractionId: string,
  toolName: string,
  input: Record<string, unknown>,
  options: PermissionOptions,
  now: () => number,
): DriverInteraction {
  const destructive = isPotentiallyDestructive(toolName);
  const title = boundDisplayText(
    options.title ?? `${options.displayName ?? toolName} permission`,
  );
  const message = boundText(
    options.description ??
      options.decisionReason ??
      `Claude wants to use ${toolName}.`,
  );
  const boundedInput = boundValue(input);
  const code = boundText(JSON.stringify(boundedInput, undefined, 2));
  const hasToolInput = Reflect.ownKeys(input).length > 0;
  const base = {
    backendInteractionId,
    sourceLabel: boundDisplayText("Claude"),
    title,
    openedAt: new Date(now()).toISOString(),
    secret: false,
    destructive,
    cancellable: true,
  } as const;

  const offersSessionGrant =
    allowedSessionPermissionUpdates(options) !== undefined;
  if (
    !options.defaultToNo &&
    !destructive &&
    !hasToolInput &&
    !offersSessionGrant
  ) {
    return {
      ...base,
      kind: "confirmation",
      message,
      confirmLabel: boundDisplayText("Allow once"),
      cancelLabel: boundDisplayText("Deny"),
    };
  }
  const approvals = [
    {
      backendActionId: ALLOW_ONCE_ACTION_ID,
      label: boundDisplayText("Allow once"),
      description: boundDisplayText("Allow only this tool use."),
      role: options.defaultToNo
        ? ("alternative" as const)
        : ("primary" as const),
    },
    ...(offersSessionGrant
      ? [
          {
            backendActionId: ALLOW_FOR_SESSION_ACTION_ID,
            label: boundDisplayText("Allow for Claude session"),
            description: boundDisplayText(
              "Apply Claude's suggested permission for this live session.",
            ),
            role: "alternative" as const,
          },
        ]
      : []),
  ];
  const rejection = {
    backendActionId: DENY_ACTION_ID,
    label: boundDisplayText("Deny"),
    role: "reject" as const,
  };
  return {
    ...base,
    kind: "decision",
    message,
    code,
    actions: options.defaultToNo
      ? [rejection, ...approvals]
      : [...approvals, rejection],
  };
}

function allowedSessionPermissionUpdates(
  options: PermissionOptions,
): readonly PermissionUpdate[] | undefined {
  return options.suppressAlwaysAllowRule
    ? undefined
    : safeSessionPermissionUpdates(options.suggestions);
}

function presentAskUserQuestion(
  backendInteractionId: string,
  input: Record<string, unknown>,
  options: PermissionOptions,
  now: () => number,
): AskUserQuestionPresentation | undefined {
  const rawQuestions = input.questions;
  if (
    !Array.isArray(rawQuestions) ||
    rawQuestions.length === 0 ||
    rawQuestions.length > INTERACTION_LIMITS.questionnaireQuestions
  ) {
    return undefined;
  }

  const seenQuestionTexts = new Set<string>();
  const seenQuestionIds = new Set<string>();
  const questions: Extract<
    DriverInteraction,
    { kind: "questionnaire" }
  >["questions"] = [];
  const stateQuestions: AskUserQuestion[] = [];
  for (const [questionIndex, rawQuestion] of rawQuestions.entries()) {
    if (!isRecord(rawQuestion)) return undefined;
    const fullQuestion = rawQuestion.question;
    if (
      typeof fullQuestion !== "string" ||
      fullQuestion.length === 0 ||
      seenQuestionTexts.has(fullQuestion)
    ) {
      return undefined;
    }
    seenQuestionTexts.add(fullQuestion);
    const questionId = stableQuestionId(fullQuestion);
    if (seenQuestionIds.has(questionId)) return undefined;
    seenQuestionIds.add(questionId);
    if (
      rawQuestion.header !== undefined &&
      typeof rawQuestion.header !== "string"
    ) {
      return undefined;
    }
    if (
      rawQuestion.multiSelect !== undefined &&
      typeof rawQuestion.multiSelect !== "boolean"
    ) {
      return undefined;
    }
    if (!Array.isArray(rawQuestion.options)) return undefined;
    if (
      rawQuestion.options.length >
      INTERACTION_LIMITS.questionnaireOptionsPerQuestion
    ) {
      return undefined;
    }

    const optionLabels = new Map<string, string>();
    const normalizedOptions: Array<{
      backendOptionId: string;
      label: ReturnType<typeof boundDisplayText>;
      description: ReturnType<typeof boundDisplayText>;
    }> = [];
    for (const [optionIndex, rawOption] of rawQuestion.options.entries()) {
      if (
        !isRecord(rawOption) ||
        typeof rawOption.label !== "string" ||
        rawOption.label.length === 0 ||
        (rawOption.description !== undefined &&
          typeof rawOption.description !== "string")
      ) {
        return undefined;
      }
      const optionId = stableOptionId(
        fullQuestion,
        optionIndex,
        rawOption.label,
      );
      optionLabels.set(optionId, rawOption.label);
      normalizedOptions.push({
        backendOptionId: optionId,
        label: boundDisplayText(rawOption.label),
        description: boundDisplayText(rawOption.description ?? ""),
      });
    }

    const multiSelect = rawQuestion.multiSelect === true;
    const header = boundDisplayText(
      rawQuestion.header ?? `Question ${questionIndex + 1}`,
    );
    if (multiSelect || normalizedOptions.length === 0) {
      const prompt = multiSelect
        ? `${fullQuestion}\nChoose one or more: ${normalizedOptions
            .map(({ label }) => label.text)
            .join(", ")}`
        : fullQuestion;
      questions.push({
        backendQuestionId: questionId,
        header,
        prompt: boundDisplayText(prompt),
        secret: false,
        input: {
          kind: "text",
          multiline: multiSelect,
          ...(multiSelect
            ? { placeholder: boundDisplayText("Enter one or more choices") }
            : {}),
        },
      });
      stateQuestions.push({
        id: questionId,
        fullQuestion,
        inputKind: "text",
        options: optionLabels,
      });
      continue;
    }

    const otherOptionId = stableOptionId(
      fullQuestion,
      normalizedOptions.length,
      "Other",
    );
    questions.push({
      backendQuestionId: questionId,
      header,
      prompt: boundDisplayText(fullQuestion),
      secret: false,
      input: {
        kind: "single_choice",
        allowNote: true,
        options: normalizedOptions,
        other: {
          backendOptionId: otherOptionId,
          label: boundDisplayText("Other"),
          description: boundDisplayText("Enter a different answer."),
        },
      },
    });
    stateQuestions.push({
      id: questionId,
      fullQuestion,
      inputKind: "single_choice",
      options: optionLabels,
      otherOptionId,
    });
  }

  const candidate = {
    backendInteractionId,
    sourceLabel: boundDisplayText("Claude"),
    title: boundDisplayText("Questions"),
    ...(options.description ? { message: boundText(options.description) } : {}),
    openedAt: new Date(now()).toISOString(),
    secret: false,
    destructive: false,
    cancellable: true,
    kind: "questionnaire" as const,
    questions,
  };
  const parsed = driverInteractionSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.kind !== "questionnaire") {
    return undefined;
  }
  return {
    interaction: parsed.data,
    state: { originalInput: input, questions: stateQuestions },
  };
}

function stableQuestionId(question: string): string {
  if (question.length <= 512) return question;
  return `claude-question:${createHash("sha256")
    .update(question)
    .digest("hex")}`;
}

function stableOptionId(
  question: string,
  index: number,
  label: string,
): string {
  return `claude-option:${createHash("sha256")
    .update(question)
    .update("\0")
    .update(String(index))
    .update("\0")
    .update(label)
    .digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPotentiallyDestructive(toolName: string): boolean {
  return /(?:bash|shell|write|edit|delete|remove|move|kill|stop|execute|run)/iu.test(
    toolName,
  );
}

function providerResult(
  input: InteractionResponseInput,
  pending: PendingPermission,
): PermissionResult {
  if (pending.askUserQuestion) {
    return askUserQuestionResult(input, pending);
  }
  if (input.kind === "cancel") {
    return denied(pending.toolUseID, "User denied permission.");
  }
  if (pending.interaction.kind === "confirmation") {
    if (input.kind !== "confirmation") {
      throw new ClaudeInteractionBridgeError(
        "claude_interaction_response_invalid",
      );
    }
    return input.confirmed
      ? allowed(pending.toolUseID)
      : denied(pending.toolUseID, "User denied permission.");
  }
  if (pending.interaction.kind === "decision") {
    if (input.kind !== "decision") {
      throw new ClaudeInteractionBridgeError(
        "claude_interaction_response_invalid",
      );
    }
    if (input.selectedActionId === ALLOW_ONCE_ACTION_ID) {
      return allowed(pending.toolUseID);
    }
    if (
      input.selectedActionId === ALLOW_FOR_SESSION_ACTION_ID &&
      pending.sessionPermissionUpdates
    ) {
      return {
        behavior: "allow",
        updatedPermissions: pending.sessionPermissionUpdates.map((update) =>
          structuredClone(update),
        ),
        toolUseID: pending.toolUseID,
        decisionClassification: "user_permanent",
      };
    }
    if (input.selectedActionId === DENY_ACTION_ID) {
      return denied(pending.toolUseID, "User denied permission.");
    }
  }
  throw new ClaudeInteractionBridgeError("claude_interaction_response_invalid");
}

function safeSessionPermissionUpdates(
  suggestions: readonly PermissionUpdate[] | undefined,
): readonly PermissionUpdate[] | undefined {
  if (
    !Array.isArray(suggestions) ||
    suggestions.length === 0 ||
    suggestions.length > MAXIMUM_SESSION_PERMISSION_UPDATES
  ) {
    return undefined;
  }
  let entries = 0;
  for (const update of suggestions) {
    if (!isRecord(update) || update.destination !== "session") {
      return undefined;
    }
    if (update.type === "addRules") {
      if (!Array.isArray(update.rules)) return undefined;
      entries += update.rules.length;
      if (
        update.behavior !== "allow" ||
        update.rules.length === 0 ||
        !hasExactKeys(update, ["type", "rules", "behavior", "destination"]) ||
        update.rules.some((rule) => !isSafePermissionRule(rule))
      ) {
        return undefined;
      }
      continue;
    }
    if (update.type === "addDirectories") {
      if (!Array.isArray(update.directories)) return undefined;
      entries += update.directories.length;
      if (
        update.directories.length === 0 ||
        !hasExactKeys(update, ["type", "directories", "destination"]) ||
        update.directories.some(
          (directory) => !isBoundedPermissionText(directory),
        )
      ) {
        return undefined;
      }
      continue;
    }
    return undefined;
  }
  if (entries > MAXIMUM_SESSION_PERMISSION_ENTRIES) return undefined;
  let encoded: string;
  try {
    encoded = JSON.stringify(suggestions);
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(encoded, "utf8") > MAXIMUM_SESSION_PERMISSION_BYTES) {
    return undefined;
  }
  return Object.freeze(suggestions.map((update) => structuredClone(update)));
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isSafePermissionRule(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const ruleContent = value.ruleContent;
  return (
    hasExactKeys(
      value,
      ruleContent === undefined ? ["toolName"] : ["toolName", "ruleContent"],
    ) &&
    isBoundedPermissionText(value.toolName) &&
    (ruleContent === undefined || isBoundedPermissionText(ruleContent))
  );
}

function isBoundedPermissionText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAXIMUM_SESSION_PERMISSION_TEXT &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function askUserQuestionResult(
  input: InteractionResponseInput,
  pending: PendingPermission,
): PermissionResult {
  const state = pending.askUserQuestion!;
  if (input.kind === "cancel" || input.kind !== "questionnaire") {
    return denied(pending.toolUseID, "Question request cancelled.");
  }
  const submitted = new Map(
    input.answers.map((answer) => [answer.questionId, answer] as const),
  );
  if (
    submitted.size !== state.questions.length ||
    input.answers.length !== state.questions.length
  ) {
    return denied(pending.toolUseID, "Invalid question response.");
  }

  const answers: Record<string, string> = {};
  for (const question of state.questions) {
    const submittedAnswer = submitted.get(question.id)?.answer;
    if (!submittedAnswer || submittedAnswer.kind === "unanswered") {
      return denied(pending.toolUseID, "Invalid question response.");
    }
    if (question.inputKind === "text") {
      if (
        submittedAnswer.kind !== "text" ||
        submittedAnswer.value.length === 0
      ) {
        return denied(pending.toolUseID, "Invalid question response.");
      }
      answers[question.fullQuestion] = submittedAnswer.value;
      continue;
    }
    if (submittedAnswer.kind !== "single_choice") {
      return denied(pending.toolUseID, "Invalid question response.");
    }
    if (submittedAnswer.selectedOptionId === question.otherOptionId) {
      if (!submittedAnswer.note || submittedAnswer.note.trim().length === 0) {
        return denied(pending.toolUseID, "Invalid question response.");
      }
      answers[question.fullQuestion] = submittedAnswer.note;
      continue;
    }
    const label = question.options.get(submittedAnswer.selectedOptionId);
    if (!label) {
      return denied(pending.toolUseID, "Invalid question response.");
    }
    answers[question.fullQuestion] = submittedAnswer.note
      ? `${label}: ${submittedAnswer.note}`
      : label;
  }
  return {
    behavior: "allow",
    updatedInput: { ...state.originalInput, answers },
    toolUseID: pending.toolUseID,
    decisionClassification: "user_temporary",
  };
}

function allowed(toolUseID: string): PermissionResult {
  return {
    behavior: "allow",
    toolUseID,
    decisionClassification: "user_temporary",
  };
}

function denied(toolUseID: string, message: string): PermissionResult {
  return {
    behavior: "deny",
    message,
    interrupt: false,
    toolUseID,
    decisionClassification: "user_reject",
  };
}

function responseFingerprint(input: InteractionResponseInput): string {
  return JSON.stringify(input);
}
