import {
  validateFormAnswers,
  type FormField,
} from "../../shared/protocol/interactions.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  DriverInteraction,
  BackendConversationEvent,
} from "../../shared/protocol/backend.js";
import {
  backendInteractionSchema,
  type BackendInteraction,
} from "../../shared/protocol/conversation.js";
import type { ThreadInteractionResponse } from "../../shared/protocol/api.js";
import {
  PAYLOAD_LIMITS,
  type BoundedDisplayText,
  type BoundedText,
} from "../../shared/protocol/payload.js";
import {
  BackendError,
  type InteractionResponseInput,
  type Unsubscribe,
} from "../backends/contracts.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  ConversationActorEvent,
  ConversationActorListener,
} from "./conversation-actor.js";

export interface InteractionConversation {
  subscribe(listener: ConversationActorListener): Unsubscribe;
  respond(input: InteractionResponseInput): Promise<void>;
  /** Fail closed rather than leaving a provider parked on an unseen prompt. */
  interruptForInteractionFailure(applicationOperationId: string): Promise<void>;
}

export interface InteractionBrokerPublisher {
  /**
   * The active runtime supplies this owner. It must serialize interaction
   * incrementals with projection replacement and recover asynchronous
   * publication failures authoritatively.
   */
  opened(
    scope: RequestScope,
    applicationThreadId: string,
    generation: string,
    interaction: BackendInteraction,
  ): void;
  resolved(
    scope: RequestScope,
    applicationThreadId: string,
    generation: string,
    interactionId: string,
  ): void;
}

export interface InteractionBrokerBinding {
  /** Replays current pending interactions after the initial thread snapshot. */
  publishPending(): void;
  /** Local-only shutdown detachment; never responds to the backend. */
  detach(): void;
  release(): Promise<void>;
}

export type PreparedInteractionResponse =
  | {
      readonly owner: "provider";
      readonly persistence: "durable";
      readonly backendResponse: InteractionResponseInput;
    }
  | {
      readonly owner: "provider";
      readonly persistence: "ephemeral";
      readonly backendResponse: InteractionResponseInput;
    }
  | {
      readonly owner: "application";
      readonly persistence: "ephemeral";
      readonly interactionId: string;
      readonly decision: ApplicationDecision;
    };

export type ApplicationDecision = "allow" | "deny";

export interface ApplicationDecisionPresentation {
  readonly sourceLabel: BoundedDisplayText;
  readonly title: BoundedDisplayText;
  readonly message?: BoundedText;
  readonly code?: BoundedText;
  readonly destructive: boolean;
}

export interface RequestApplicationDecisionInput {
  readonly scope: RequestScope;
  readonly applicationThreadId: string;
  readonly generation: string;
  readonly presentation: ApplicationDecisionPresentation;
  readonly signal: AbortSignal;
}

interface PendingInteractionBase {
  readonly scope: RequestScope;
  readonly applicationThreadId: string;
  generation: string;
  interaction: BackendInteraction;
  settling?: Promise<void>;
}

interface PendingProviderInteraction extends PendingInteractionBase {
  readonly owner: "provider";
  readonly backendInteractionId: string;
  readonly driverInteraction: DriverInteraction;
  readonly optionIds?: ReadonlyMap<string, string>;
  readonly actionIds?: ReadonlyMap<string, string>;
  readonly questionnaireIds?: QuestionnaireIdentityMaps;
  readonly formIds?: {
    fields: ReadonlyMap<string, string>;
    options: ReadonlyMap<string, string>;
  };
  readonly conversation: InteractionConversation;
}

interface PendingApplicationInteraction extends PendingInteractionBase {
  readonly owner: "application";
  readonly actionIds: ReadonlyMap<string, ApplicationDecision>;
  readonly resolve: (decision: ApplicationDecision) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal;
  readonly abortListener: () => void;
}

type PendingInteraction =
  PendingProviderInteraction | PendingApplicationInteraction;

const MAX_PENDING_INTERACTIONS_PER_THREAD = 32;

interface QuestionnaireOptionIdentity {
  readonly browserQuestionId: string;
  readonly backendQuestionId: string;
  readonly backendOptionId: string;
}

interface QuestionnaireIdentityMaps {
  readonly questions: ReadonlyMap<string, string>;
  readonly options: ReadonlyMap<string, QuestionnaireOptionIdentity>;
}

interface OwnerBinding {
  readonly token: object;
  readonly publisher: InteractionBrokerPublisher;
  unsubscribe: Unsubscribe;
  unsubscribed: boolean;
  state: "active" | "releasing";
}

function scopeKey(scope: RequestScope): string {
  return `${scope.tenantId}\0${scope.principalId}`;
}

function ownerKey(scope: RequestScope, applicationThreadId: string): string {
  return `${scopeKey(scope)}\0${applicationThreadId}`;
}

function backendKey(
  scope: RequestScope,
  applicationThreadId: string,
  backendInteractionId: string,
): string {
  return `${ownerKey(scope, applicationThreadId)}\0${backendInteractionId}`;
}

function sameScope(left: RequestScope, right: RequestScope): boolean {
  return (
    left.tenantId === right.tenantId && left.principalId === right.principalId
  );
}

function presentInteraction(
  threadId: string,
  source: DriverInteraction,
): {
  readonly interaction: BackendInteraction;
  readonly optionIds?: ReadonlyMap<string, string>;
  readonly actionIds?: ReadonlyMap<string, string>;
  readonly questionnaireIds?: QuestionnaireIdentityMaps;
  readonly formIds?: {
    fields: ReadonlyMap<string, string>;
    options: ReadonlyMap<string, string>;
  };
} {
  const interaction = structuredClone(source);
  const containsSecret =
    interaction.secret ||
    (interaction.kind === "questionnaire" &&
      interaction.questions.some((question) => question.secret));
  const base = {
    id: randomUUID(),
    threadId,
    sourceLabel: interaction.sourceLabel,
    title: interaction.title,
    openedAt: interaction.openedAt,
    secret: containsSecret,
    destructive: interaction.destructive,
    cancellable: interaction.cancellable,
    ...(interaction.invocation ? { invocation: interaction.invocation } : {}),
  };
  switch (interaction.kind) {
    case "form": {
      const fields = new Map<string, string>();
      const options = new Map<string, string>();
      const presentation = interaction.fields.map((field) => {
        const id = randomUUID();
        fields.set(id, field.id);
        const input = field.input;
        if (input.kind !== "single_choice" && input.kind !== "multiple_choice")
          return { ...field, id };
        const reverse = new Map<string, string>();
        const mappedOptions = input.options.map((option) => {
          const optionId = randomUUID();
          options.set(optionId, option.id);
          reverse.set(option.id, optionId);
          return { ...option, id: optionId };
        });
        return {
          ...field,
          id,
          input: {
            ...input,
            options: mappedOptions,
            ...(input.default !== undefined
              ? {
                  default: Array.isArray(input.default)
                    ? input.default.map((value) => reverse.get(value)!)
                    : reverse.get(input.default)!,
                }
              : {}),
          },
        } as FormField;
      });
      return {
        interaction: backendInteractionSchema.parse({
          ...base,
          kind: "form",
          fields: presentation,
        }),
        formIds: { fields, options },
      };
    }
    case "choice": {
      const optionIds = new Map<string, string>();
      const options = interaction.options.map((option) => {
        const id = randomUUID();
        optionIds.set(id, option.backendOptionId);
        return {
          id,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        };
      });
      return {
        interaction: backendInteractionSchema.parse({
          ...base,
          kind: "choice",
          ...(interaction.message ? { message: interaction.message } : {}),
          options,
          multiple: interaction.multiple,
        }),
        optionIds,
      };
    }
    case "confirmation":
      return {
        interaction: backendInteractionSchema.parse({
          ...base,
          kind: "confirmation",
          message: interaction.message,
          ...(interaction.confirmLabel
            ? { confirmLabel: interaction.confirmLabel }
            : {}),
          ...(interaction.cancelLabel
            ? { cancelLabel: interaction.cancelLabel }
            : {}),
        }),
      };
    case "text_input":
      return {
        interaction: backendInteractionSchema.parse({
          ...base,
          kind: "text_input",
          ...(interaction.placeholder
            ? { placeholder: interaction.placeholder }
            : {}),
          ...(interaction.initialValue
            ? { initialValue: interaction.initialValue }
            : {}),
          multiline: interaction.multiline,
        }),
      };
    case "editor":
      return {
        interaction: backendInteractionSchema.parse({
          ...base,
          kind: "editor",
          ...(interaction.initialValue
            ? { initialValue: interaction.initialValue }
            : {}),
          ...(interaction.language ? { language: interaction.language } : {}),
        }),
      };
    case "decision": {
      const actionIds = new Map<string, string>();
      const actions = interaction.actions.map((action) => {
        const id = randomUUID();
        actionIds.set(id, action.backendActionId);
        return {
          id,
          label: action.label,
          ...(action.description ? { description: action.description } : {}),
          role: action.role,
        };
      });
      return {
        interaction: backendInteractionSchema.parse({
          ...base,
          kind: "decision",
          ...(interaction.message ? { message: interaction.message } : {}),
          ...(interaction.code ? { code: interaction.code } : {}),
          actions,
        }),
        actionIds,
      };
    }
    case "questionnaire": {
      const questionIds = new Map<string, string>();
      const optionIds = new Map<string, QuestionnaireOptionIdentity>();
      const questions = interaction.questions.map((question) => {
        const id = randomUUID();
        questionIds.set(id, question.backendQuestionId);
        const questionBase = {
          id,
          header: question.header,
          prompt: question.prompt,
          secret: question.secret,
        };
        if (question.input.kind === "text") {
          return { ...questionBase, input: question.input };
        }
        const mapOption = (option: {
          readonly backendOptionId: string;
          readonly label: typeof question.header;
          readonly description?: typeof question.header;
        }) => {
          const optionId = randomUUID();
          optionIds.set(optionId, {
            browserQuestionId: id,
            backendQuestionId: question.backendQuestionId,
            backendOptionId: option.backendOptionId,
          });
          return {
            id: optionId,
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          };
        };
        return {
          ...questionBase,
          input: {
            kind: "single_choice" as const,
            options: question.input.options.map(mapOption),
            ...(question.input.other
              ? { other: mapOption(question.input.other) }
              : {}),
            allowNote: question.input.allowNote,
          },
        };
      });
      return {
        interaction: backendInteractionSchema.parse({
          ...base,
          kind: "questionnaire",
          ...(interaction.message ? { message: interaction.message } : {}),
          questions,
        }),
        questionnaireIds: { questions: questionIds, options: optionIds },
      };
    }
  }
}

/**
 * Correlates browser-safe interaction identities with backend request IDs.
 *
 * Pending interactions belong to one scoped actor binding. Reconnect reads the
 * same in-memory pending set, while actor release settles each backend request
 * at most once.
 */
export class InteractionBroker {
  readonly #pending = new Map<string, PendingInteraction>();
  readonly #byBackend = new Map<string, string>();
  readonly #cancellingBackend = new Set<string>();
  readonly #abandonedBackend = new Set<string>();
  readonly #bindings = new Map<string, OwnerBinding>();
  readonly #operationsByOwner = new Map<string, Set<Promise<void>>>();
  #closed = false;
  #closePromise?: Promise<void>;

  constructor(
    readonly observers: {
      readonly onOpened?: (
        scope: RequestScope,
        interaction: BackendInteraction,
      ) => void;
    } = {},
  ) {}

  bind(
    scope: RequestScope,
    applicationThreadId: string,
    conversation: InteractionConversation,
    publisher: InteractionBrokerPublisher,
  ): InteractionBrokerBinding {
    this.#assertOpen();
    const key = ownerKey(scope, applicationThreadId);
    if (this.#bindings.has(key)) {
      throw new Error("interaction_broker_owner_already_bound");
    }
    const token = {};
    const binding: OwnerBinding = {
      token,
      publisher,
      unsubscribe: () => undefined,
      unsubscribed: false,
      state: "active",
    };
    this.#bindings.set(key, binding);
    try {
      binding.unsubscribe = conversation.subscribe((event) => {
        const current = this.#bindings.get(key);
        if (current?.token !== token || current.state !== "active") return;
        this.#acceptActorEvent(scope, applicationThreadId, conversation, event);
      });
    } catch (error) {
      if (this.#bindings.get(key) === binding) this.#bindings.delete(key);
      void this.#cancelOwner(scope, applicationThreadId);
      throw error;
    }
    let releasePromise: Promise<void> | undefined;
    return {
      publishPending: () => {
        const current = this.#bindings.get(key);
        if (current?.token !== token || current.state !== "active") return;
        for (const pending of this.#pending.values()) {
          if (
            sameScope(pending.scope, scope) &&
            pending.applicationThreadId === applicationThreadId
          ) {
            this.#safePublishOpened(pending);
          }
        }
      },
      detach: () => this.#detachOwner(scope, applicationThreadId, binding),
      release: () => {
        releasePromise ??= (async () => {
          binding.state = "releasing";
          const unsubscribeError = this.#unsubscribeBinding(binding);
          try {
            await this.#cancelOwner(scope, applicationThreadId);
            await this.#drainOwner(scope, applicationThreadId);
          } finally {
            if (this.#bindings.get(key) === binding) {
              this.#bindings.delete(key);
            }
            this.#clearAbandonedOwner(scope, applicationThreadId);
          }
          if (unsubscribeError !== undefined) throw unsubscribeError;
        })();
        return releasePromise;
      },
    };
  }

  listPending(
    scope: RequestScope,
    applicationThreadId: string,
  ): BackendInteraction[] {
    return [...this.#pending.values()]
      .filter(
        (pending) =>
          sameScope(pending.scope, scope) &&
          pending.applicationThreadId === applicationThreadId,
      )
      .sort(
        (left, right) =>
          Date.parse(left.interaction.openedAt) -
          Date.parse(right.interaction.openedAt),
      )
      .map(({ interaction }) => structuredClone(interaction));
  }

  requestApplicationDecision(
    input: RequestApplicationDecisionInput,
  ): Promise<ApplicationDecision> {
    this.#assertOpen();
    if (input.signal.aborted) {
      return Promise.reject(abortError());
    }
    const binding = this.#bindings.get(
      ownerKey(input.scope, input.applicationThreadId),
    );
    if (!binding || binding.state !== "active") {
      return Promise.reject(interactionBrokerUnavailable());
    }
    if (
      this.#ownerPendingCount(input.scope, input.applicationThreadId) >=
      MAX_PENDING_INTERACTIONS_PER_THREAD
    ) {
      return Promise.reject(interactionBrokerUnavailable());
    }

    const interactionId = randomUUID();
    const allowActionId = randomUUID();
    const denyActionId = randomUUID();
    const interaction = backendInteractionSchema.parse({
      id: interactionId,
      threadId: input.applicationThreadId,
      sourceLabel: input.presentation.sourceLabel,
      title: input.presentation.title,
      openedAt: new Date().toISOString(),
      secret: false,
      destructive: input.presentation.destructive,
      cancellable: true,
      kind: "decision",
      ...(input.presentation.message
        ? { message: input.presentation.message }
        : {}),
      ...(input.presentation.code ? { code: input.presentation.code } : {}),
      actions: [
        {
          id: allowActionId,
          label: { text: "Allow once" },
          role: "primary",
        },
        { id: denyActionId, label: { text: "Deny" }, role: "reject" },
      ],
    });

    let resolve!: (decision: ApplicationDecision) => void;
    let reject!: (error: Error) => void;
    const decision = new Promise<ApplicationDecision>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const pending = {
      owner: "application" as const,
      scope: input.scope,
      applicationThreadId: input.applicationThreadId,
      generation: input.generation,
      interaction,
      actionIds: new Map([
        [allowActionId, "allow" as const],
        [denyActionId, "deny" as const],
      ]),
      resolve,
      reject,
      signal: input.signal,
      abortListener: () => this.#abortApplication(interactionId, true),
    } satisfies PendingApplicationInteraction;
    this.#pending.set(interactionId, pending);
    input.signal.addEventListener("abort", pending.abortListener, {
      once: true,
    });
    if (input.signal.aborted) {
      this.#abortApplication(interactionId, false);
      return decision;
    }
    try {
      binding.publisher.opened(
        input.scope,
        input.applicationThreadId,
        input.generation,
        structuredClone(interaction),
      );
      this.#observeOpened(pending);
    } catch {
      this.#remove(pending);
      pending.reject(interactionBrokerUnavailable());
    }
    return decision;
  }

  /**
   * Locally abandons exact browser interactions after a durable force reset.
   * This deliberately publishes no response or cancellation to the backend.
   */
  /**
   * Force reset: abandon exact pending interactions in Sedes, and deny any
   * provider request still waiting on one, so a runtime that is replaced or
   * reattached later does not keep the provider waiting on a prompt that
   * nobody can answer. Validation is synchronous; the returned promise
   * settles when the denials are delivered or have failed.
   */
  abandonPending(
    scope: RequestScope,
    applicationThreadId: string,
    interactionIds: readonly string[],
  ): Promise<void> {
    this.#assertOpen();
    if (new Set(interactionIds).size !== interactionIds.length) {
      throw new Error("interaction_broker_force_reset_evidence_changed");
    }
    const pending = interactionIds.map((interactionId) => {
      const current = this.#pending.get(interactionId);
      if (
        !current ||
        !sameScope(current.scope, scope) ||
        current.applicationThreadId !== applicationThreadId
      ) {
        throw new Error("interaction_broker_force_reset_evidence_changed");
      }
      return current;
    });
    const denials: Promise<void>[] = [];
    for (const current of pending) {
      if (current.owner === "provider") {
        this.#abandonedBackend.add(
          backendKey(
            current.scope,
            current.applicationThreadId,
            current.backendInteractionId,
          ),
        );
        denials.push(
          current.conversation
            .respond({
              applicationOperationId: `force-reset:${current.interaction.id}`,
              interactionId: current.backendInteractionId,
              kind: "cancel",
            })
            .catch(() => {
              // The abandoned marker still drops any replay of this request.
            }),
        );
      }
      this.#remove(current);
      if (current.owner === "application") current.reject(abortError());
      this.#safePublishResolved(
        current.scope,
        current.applicationThreadId,
        current.generation,
        current.interaction.id,
      );
    }
    return Promise.all(denials).then(() => undefined);
  }

  hasPending(
    scope: RequestScope,
    applicationThreadId: string,
    interactionId: string,
  ): boolean {
    const pending = this.#pending.get(interactionId);
    return (
      pending !== undefined &&
      sameScope(pending.scope, scope) &&
      pending.applicationThreadId === applicationThreadId
    );
  }

  prepareResponse(
    scope: RequestScope,
    applicationThreadId: string,
    applicationOperationId: string,
    interactionId: string,
    response: ThreadInteractionResponse,
  ): PreparedInteractionResponse {
    return this.#prepareResponse(
      scope,
      applicationThreadId,
      applicationOperationId,
      interactionId,
      response,
    );
  }

  #prepareResponse(
    scope: RequestScope,
    applicationThreadId: string,
    applicationOperationId: string,
    interactionId: string,
    response: ThreadInteractionResponse,
  ): PreparedInteractionResponse {
    this.#assertOpen();
    const pending = this.#pending.get(interactionId);
    if (
      !pending ||
      !sameScope(pending.scope, scope) ||
      pending.applicationThreadId !== applicationThreadId
    ) {
      throw new DomainError(
        "not_found",
        "The interaction request was not found.",
      );
    }
    if (
      response.kind !== "cancel" &&
      response.kind !== pending.interaction.kind
    ) {
      throw new DomainError(
        "invalid_transition",
        "The response does not match the interaction kind.",
      );
    }
    if (response.kind === "cancel" && !pending.interaction.cancellable) {
      throw new DomainError(
        "invalid_transition",
        "The interaction request cannot be cancelled.",
      );
    }
    if (pending.owner === "application") {
      if (response.kind === "cancel") {
        return {
          owner: "application",
          persistence: "ephemeral",
          interactionId: pending.interaction.id,
          decision: "deny",
        };
      }
      if (response.kind !== "decision") {
        throw new DomainError(
          "invalid_transition",
          "The response does not match the interaction kind.",
        );
      }
      const decision = pending.actionIds.get(response.selectedActionId);
      if (!decision) {
        throw new DomainError(
          "invalid_transition",
          "The selected decision action is invalid.",
        );
      }
      return {
        owner: "application",
        persistence: "ephemeral",
        interactionId: pending.interaction.id,
        decision,
      };
    }

    let backendResponse: InteractionResponseInput;
    if (response.kind === "choice") {
      if (pending.interaction.kind !== "choice") {
        throw new DomainError(
          "invalid_transition",
          "The response does not match the interaction kind.",
        );
      }
      const selected = response.selectedOptionIds.map((id) =>
        pending.optionIds?.get(id),
      );
      if (
        response.selectedOptionIds.length > 64 ||
        selected.some((id) => id === undefined) ||
        (!pending.interaction.multiple && selected.length !== 1) ||
        new Set(selected).size !== selected.length
      ) {
        throw new DomainError(
          "invalid_transition",
          "The selected interaction options are invalid.",
        );
      }
      backendResponse = {
        applicationOperationId,
        interactionId: pending.backendInteractionId,
        kind: "choice",
        selectedOptionIds: selected as string[],
      };
    } else if (response.kind === "decision") {
      if (pending.interaction.kind !== "decision") {
        throw new DomainError(
          "invalid_transition",
          "The response does not match the interaction kind.",
        );
      }
      const selectedActionId = pending.actionIds?.get(
        response.selectedActionId,
      );
      if (!selectedActionId) {
        throw new DomainError(
          "invalid_transition",
          "The selected decision action is invalid.",
        );
      }
      backendResponse = {
        applicationOperationId,
        interactionId: pending.backendInteractionId,
        kind: "decision",
        selectedActionId,
      };
    } else if (response.kind === "form") {
      if (pending.interaction.kind !== "form" || !pending.formIds)
        throw new DomainError(
          "invalid_transition",
          "The response does not match the interaction kind.",
        );
      const error = validateFormAnswers(
        pending.interaction.fields,
        response.answers,
      );
      if (error) throw new DomainError("invalid_transition", error);
      backendResponse = {
        applicationOperationId,
        interactionId: pending.backendInteractionId,
        kind: "form",
        answers: response.answers.map((answer) => {
          const field =
            pending.interaction.kind === "form"
              ? pending.interaction.fields.find(
                  (field) => field.id === answer.fieldId,
                )!
              : undefined;
          const value =
            field?.input.kind === "single_choice"
              ? pending.formIds!.options.get(answer.value as string)!
              : field?.input.kind === "multiple_choice"
                ? (answer.value as string[]).map((id) =>
                    pending.formIds!.options.get(id)!,
                  )
                : answer.value;
          return {
            fieldId: pending.formIds!.fields.get(answer.fieldId)!,
            value,
          };
        }),
      };
    } else if (response.kind === "questionnaire") {
      if (pending.interaction.kind !== "questionnaire") {
        throw new DomainError(
          "invalid_transition",
          "The response does not match the interaction kind.",
        );
      }
      backendResponse = {
        applicationOperationId,
        interactionId: pending.backendInteractionId,
        kind: "questionnaire",
        answers: this.#mapQuestionnaireAnswers(pending, response.answers),
      };
    } else if (
      (response.kind === "text_input" || response.kind === "editor") &&
      response.value.length > PAYLOAD_LIMITS.textCharacters
    ) {
      throw new DomainError(
        "invalid_transition",
        "The interaction response is too large.",
      );
    } else {
      backendResponse = {
        applicationOperationId,
        interactionId: pending.backendInteractionId,
        ...response,
      };
    }
    return {
      owner: "provider",
      persistence: this.#responsePersistence(pending, backendResponse),
      backendResponse,
    };
  }

  #responsePersistence(
    pending: PendingProviderInteraction,
    response: InteractionResponseInput,
  ): PreparedInteractionResponse["persistence"] {
    if (
      pending.interaction.kind !== "questionnaire" ||
      response.kind !== "questionnaire"
    ) {
      return pending.interaction.secret ? "ephemeral" : "durable";
    }
    const secretQuestionIds = new Set(
      pending.driverInteraction.kind === "questionnaire"
        ? pending.driverInteraction.questions
            .filter((question) => question.secret)
            .map((question) => question.backendQuestionId)
        : [],
    );
    return response.answers.some(
      ({ questionId, answer }) =>
        answer.kind !== "unanswered" && secretQuestionIds.has(questionId),
    )
      ? "ephemeral"
      : "durable";
  }

  #mapQuestionnaireAnswers(
    pending: PendingProviderInteraction,
    answers: Extract<
      ThreadInteractionResponse,
      { readonly kind: "questionnaire" }
    >["answers"],
  ): Extract<
    InteractionResponseInput,
    { readonly kind: "questionnaire" }
  >["answers"] {
    if (
      pending.interaction.kind !== "questionnaire" ||
      !pending.questionnaireIds
    ) {
      throw new DomainError(
        "invalid_transition",
        "The response does not match the interaction kind.",
      );
    }
    const byQuestion = new Map(
      answers.map((answer) => [answer.questionId, answer]),
    );
    if (
      answers.length !== pending.interaction.questions.length ||
      byQuestion.size !== answers.length ||
      [...byQuestion.keys()].some(
        (questionId) => !pending.questionnaireIds?.questions.has(questionId),
      )
    ) {
      throw new DomainError(
        "invalid_transition",
        "Questionnaire responses must answer every question exactly once.",
      );
    }
    return pending.interaction.questions.map((question) => {
      const submitted = byQuestion.get(question.id);
      const backendQuestionId = pending.questionnaireIds?.questions.get(
        question.id,
      );
      if (!submitted || !backendQuestionId) {
        throw new DomainError(
          "invalid_transition",
          "Questionnaire responses must answer every question exactly once.",
        );
      }
      if (submitted.answer.kind === "unanswered") {
        return {
          questionId: backendQuestionId,
          answer: { kind: "unanswered" as const },
        };
      }
      if (submitted.answer.kind === "text") {
        if (question.input.kind !== "text") {
          throw new DomainError(
            "invalid_transition",
            "The questionnaire answer does not match its question input.",
          );
        }
        return {
          questionId: backendQuestionId,
          answer: submitted.answer,
        };
      }
      if (question.input.kind !== "single_choice") {
        throw new DomainError(
          "invalid_transition",
          "The questionnaire answer does not match its question input.",
        );
      }
      if (submitted.answer.note !== undefined && !question.input.allowNote) {
        throw new DomainError(
          "invalid_transition",
          "This questionnaire question does not accept a note.",
        );
      }
      const selected = pending.questionnaireIds?.options.get(
        submitted.answer.selectedOptionId,
      );
      if (
        !selected ||
        selected.browserQuestionId !== question.id ||
        selected.backendQuestionId !== backendQuestionId
      ) {
        throw new DomainError(
          "invalid_transition",
          "The selected questionnaire option is invalid for its question.",
        );
      }
      return {
        questionId: backendQuestionId,
        answer: {
          kind: "single_choice" as const,
          selectedOptionId: selected.backendOptionId,
          ...(submitted.answer.note === undefined
            ? {}
            : { note: submitted.answer.note }),
        },
      };
    });
  }

  async respondPrepared(
    scope: RequestScope,
    applicationThreadId: string,
    prepared: PreparedInteractionResponse,
  ): Promise<void> {
    this.#assertOpen();
    if (prepared.owner === "application") {
      const pending = this.#pending.get(prepared.interactionId);
      if (
        !pending ||
        pending.owner !== "application" ||
        !sameScope(pending.scope, scope) ||
        pending.applicationThreadId !== applicationThreadId
      ) {
        throw new DomainError(
          "not_found",
          "The interaction request was not found.",
        );
      }
      if (prepared.persistence !== "ephemeral") {
        throw new Error("interaction_response_persistence_mismatch");
      }
      await this.#settleApplication(pending, prepared.decision, true);
      return;
    }
    const response = prepared.backendResponse;
    const browserInteractionId = this.#byBackend.get(
      backendKey(scope, applicationThreadId, response.interactionId),
    );
    const pending =
      browserInteractionId === undefined
        ? undefined
        : this.#pending.get(browserInteractionId);
    if (
      !pending ||
      pending.owner !== "provider" ||
      !sameScope(pending.scope, scope) ||
      pending.applicationThreadId !== applicationThreadId ||
      pending.backendInteractionId !== response.interactionId
    ) {
      throw new DomainError(
        "not_found",
        "The interaction request was not found.",
      );
    }
    if (
      prepared.persistence !==
      this.#responsePersistence(pending, prepared.backendResponse)
    ) {
      throw new Error("interaction_response_persistence_mismatch");
    }
    await this.#settle(pending, response, true);
  }

  async respond(
    scope: RequestScope,
    applicationThreadId: string,
    applicationOperationId: string,
    interactionId: string,
    response: ThreadInteractionResponse,
  ): Promise<void> {
    const prepared = this.prepareResponse(
      scope,
      applicationThreadId,
      applicationOperationId,
      interactionId,
      response,
    );
    await this.respondPrepared(scope, applicationThreadId, prepared);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  /**
   * Stops all subscriptions and forgets browser correlation immediately.
   * In-flight backend responses retain their own delivery semantics and are
   * deliberately not awaited or replayed during process shutdown.
   */
  detachForShutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [key, binding] of this.#bindings) {
      binding.state = "releasing";
      this.#unsubscribeBinding(binding);
      this.#bindings.delete(key);
    }
    for (const pending of [...this.#pending.values()]) {
      this.#remove(pending);
      if (pending.owner === "application") pending.reject(abortError());
    }
    this.#byBackend.clear();
    this.#abandonedBackend.clear();
    this.#operationsByOwner.clear();
  }

  async #performClose(): Promise<void> {
    this.#closed = true;
    const failures: unknown[] = [];
    for (const binding of this.#bindings.values()) {
      binding.state = "releasing";
      const failure = this.#unsubscribeBinding(binding);
      if (failure !== undefined) failures.push(failure);
    }
    const pending = [...this.#pending.values()];
    await Promise.allSettled(
      pending.map((request) => this.#cancelForCleanup(request, false)),
    );
    while (this.#operationsByOwner.size > 0) {
      await Promise.allSettled(
        [...this.#operationsByOwner.values()].flatMap((operations) => [
          ...operations,
        ]),
      );
    }
    this.#bindings.clear();
    this.#abandonedBackend.clear();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more interaction subscriptions could not be released.",
      );
    }
  }

  #detachOwner(
    scope: RequestScope,
    applicationThreadId: string,
    binding: OwnerBinding,
  ): void {
    const key = ownerKey(scope, applicationThreadId);
    if (this.#bindings.get(key) !== binding) return;
    binding.state = "releasing";
    this.#unsubscribeBinding(binding);
    for (const pending of [...this.#pending.values()]) {
      if (
        sameScope(pending.scope, scope) &&
        pending.applicationThreadId === applicationThreadId
      ) {
        this.#remove(pending);
        if (pending.owner === "application") pending.reject(abortError());
      }
    }
    this.#bindings.delete(key);
    this.#operationsByOwner.delete(key);
    this.#clearAbandonedOwner(scope, applicationThreadId);
  }

  #acceptActorEvent(
    scope: RequestScope,
    applicationThreadId: string,
    conversation: InteractionConversation,
    actorEvent: ConversationActorEvent,
  ): void {
    if (actorEvent.type === "projection_replaced") {
      for (const pending of this.#pending.values()) {
        if (
          sameScope(pending.scope, scope) &&
          pending.applicationThreadId === applicationThreadId
        ) {
          pending.generation = actorEvent.state.timeline.generation;
        }
      }
      return;
    }
    if (actorEvent.type !== "backend_event") return;
    const event: BackendConversationEvent = actorEvent.event;
    if (event.type === "interaction_opened") {
      this.#open(
        scope,
        applicationThreadId,
        conversation,
        actorEvent.generation,
        event.interaction,
      );
    } else if (event.type === "interaction_resolved") {
      this.#resolveBackend(
        scope,
        applicationThreadId,
        actorEvent.generation,
        event.backendInteractionId,
      );
    }
  }

  #open(
    scope: RequestScope,
    applicationThreadId: string,
    conversation: InteractionConversation,
    generation: string,
    driverInteraction: DriverInteraction,
  ): void {
    const correlation = backendKey(
      scope,
      applicationThreadId,
      driverInteraction.backendInteractionId,
    );
    if (
      this.#cancellingBackend.has(correlation) ||
      this.#abandonedBackend.has(correlation)
    ) {
      return;
    }
    const existingId = this.#byBackend.get(correlation);
    if (existingId) {
      const existing = this.#pending.get(existingId);
      if (existing?.owner === "provider") {
        existing.generation = generation;
        if (!isDeepStrictEqual(existing.driverInteraction, driverInteraction)) {
          void this.#cancelForCleanup(existing, true);
          return;
        }
        this.#safePublishOpened(existing);
        return;
      }
      this.#byBackend.delete(correlation);
    }
    if (
      this.#ownerPendingCount(scope, applicationThreadId) >=
      MAX_PENDING_INTERACTIONS_PER_THREAD
    ) {
      this.#rejectProviderAtCapacity(
        scope,
        applicationThreadId,
        conversation,
        driverInteraction.backendInteractionId,
      );
      return;
    }
    const presented = presentInteraction(
      applicationThreadId,
      driverInteraction,
    );
    const pending: PendingProviderInteraction = {
      owner: "provider",
      scope,
      applicationThreadId,
      generation,
      backendInteractionId: driverInteraction.backendInteractionId,
      driverInteraction: structuredClone(driverInteraction),
      interaction: presented.interaction,
      ...(presented.optionIds ? { optionIds: presented.optionIds } : {}),
      ...(presented.formIds ? { formIds: presented.formIds } : {}),
      ...(presented.actionIds ? { actionIds: presented.actionIds } : {}),
      ...(presented.questionnaireIds
        ? { questionnaireIds: presented.questionnaireIds }
        : {}),
      conversation,
    };
    this.#pending.set(pending.interaction.id, pending);
    this.#byBackend.set(correlation, pending.interaction.id);
    this.#observeOpened(pending);
    this.#safePublishOpened(pending);
  }

  /** First acceptance only; snapshot/reconnect publication is not a new request. */
  #observeOpened(pending: PendingInteraction): void {
    try {
      this.observers.onOpened?.(
        { ...pending.scope },
        structuredClone(pending.interaction),
      );
    } catch {
      // Passive observers must not change request publication or settlement.
    }
  }

  #resolveBackend(
    scope: RequestScope,
    applicationThreadId: string,
    generation: string,
    backendInteractionId: string,
  ): void {
    const correlation = backendKey(
      scope,
      applicationThreadId,
      backendInteractionId,
    );
    this.#abandonedBackend.delete(correlation);
    const id = this.#byBackend.get(correlation);
    if (!id) return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    pending.generation = generation;
    this.#remove(pending);
    this.#safePublishResolved(
      scope,
      applicationThreadId,
      generation,
      pending.interaction.id,
    );
  }

  async #cancelOwner(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<void> {
    const owned = [...this.#pending.values()].filter(
      (pending) =>
        sameScope(pending.scope, scope) &&
        pending.applicationThreadId === applicationThreadId,
    );
    await Promise.allSettled(
      owned.map((pending) => this.#cancelForCleanup(pending, false)),
    );
  }

  async #cancelForCleanup(
    pending: PendingInteraction,
    publish: boolean,
  ): Promise<void> {
    return this.#trackOwnerOperation(pending, () =>
      this.#performCleanup(pending, publish),
    );
  }

  async #performCleanup(
    pending: PendingInteraction,
    publish: boolean,
  ): Promise<void> {
    if (this.#pending.get(pending.interaction.id) !== pending) return;
    if (pending.settling) {
      await pending.settling.catch(() => undefined);
      if (this.#pending.get(pending.interaction.id) !== pending) return;
    }
    if (pending.owner === "application") {
      this.#remove(pending);
      pending.reject(abortError());
      if (publish) {
        this.#safePublishResolved(
          pending.scope,
          pending.applicationThreadId,
          pending.generation,
          pending.interaction.id,
        );
      }
      return;
    }
    const correlation = backendKey(
      pending.scope,
      pending.applicationThreadId,
      pending.backendInteractionId,
    );
    this.#cancellingBackend.add(correlation);
    this.#remove(pending);
    if (publish) {
      this.#safePublishResolved(
        pending.scope,
        pending.applicationThreadId,
        pending.generation,
        pending.interaction.id,
      );
    }
    try {
      await pending.conversation.respond({
        applicationOperationId: `cleanup:${pending.interaction.id}`,
        interactionId: pending.backendInteractionId,
        kind: "cancel",
      });
    } catch {
      // Local detachment is authoritative even when backend cleanup fails.
    } finally {
      this.#cancellingBackend.delete(correlation);
    }
  }

  async #settle(
    pending: PendingProviderInteraction,
    response: InteractionResponseInput,
    publish: boolean,
  ): Promise<void> {
    if (
      pending.settling ||
      this.#pending.get(pending.interaction.id) !== pending
    ) {
      throw new DomainError(
        "invalid_transition",
        "The interaction request is already resolved.",
      );
    }
    const settlement = this.#trackOwnerOperation(pending, () =>
      this.#performSettlement(pending, response, publish),
    );
    pending.settling = settlement;
    try {
      await settlement;
    } finally {
      if (pending.settling === settlement) pending.settling = undefined;
    }
  }

  async #performSettlement(
    pending: PendingProviderInteraction,
    response: InteractionResponseInput,
    publish: boolean,
  ): Promise<void> {
    try {
      await pending.conversation.respond(response);
    } catch (error) {
      if (
        this.#responsePersistence(pending, response) === "ephemeral" &&
        !(error instanceof DomainError) &&
        !(error instanceof BackendError && !error.crossedSubmissionBoundary) &&
        this.#pending.get(pending.interaction.id) === pending
      ) {
        this.#remove(pending);
        if (publish) {
          this.#safePublishResolved(
            pending.scope,
            pending.applicationThreadId,
            pending.generation,
            pending.interaction.id,
          );
        }
      }
      throw error;
    }
    if (this.#pending.get(pending.interaction.id) !== pending) return;
    this.#remove(pending);
    if (publish) {
      this.#safePublishResolved(
        pending.scope,
        pending.applicationThreadId,
        pending.generation,
        pending.interaction.id,
      );
    }
  }

  async #settleApplication(
    pending: PendingApplicationInteraction,
    decision: ApplicationDecision,
    publish: boolean,
  ): Promise<void> {
    if (
      pending.settling ||
      this.#pending.get(pending.interaction.id) !== pending
    ) {
      throw new DomainError(
        "invalid_transition",
        "The interaction request is already resolved.",
      );
    }
    const settlement = Promise.resolve().then(() => {
      if (this.#pending.get(pending.interaction.id) !== pending) {
        throw new DomainError(
          "invalid_transition",
          "The interaction request is already resolved.",
        );
      }
      this.#remove(pending);
      if (publish) {
        this.#safePublishResolved(
          pending.scope,
          pending.applicationThreadId,
          pending.generation,
          pending.interaction.id,
        );
      }
      pending.resolve(decision);
    });
    pending.settling = settlement;
    try {
      await settlement;
    } finally {
      if (pending.settling === settlement) pending.settling = undefined;
    }
  }

  #abortApplication(interactionId: string, publish: boolean): void {
    const pending = this.#pending.get(interactionId);
    if (!pending || pending.owner !== "application" || pending.settling) return;
    this.#remove(pending);
    if (publish) {
      this.#safePublishResolved(
        pending.scope,
        pending.applicationThreadId,
        pending.generation,
        pending.interaction.id,
      );
    }
    pending.reject(abortError());
  }

  #ownerPendingCount(scope: RequestScope, applicationThreadId: string): number {
    let count = 0;
    for (const pending of this.#pending.values()) {
      if (
        sameScope(pending.scope, scope) &&
        pending.applicationThreadId === applicationThreadId
      ) {
        count += 1;
      }
    }
    return count;
  }

  #rejectProviderAtCapacity(
    scope: RequestScope,
    applicationThreadId: string,
    conversation: InteractionConversation,
    backendInteractionId: string,
  ): void {
    const correlation = backendKey(
      scope,
      applicationThreadId,
      backendInteractionId,
    );
    this.#cancellingBackend.add(correlation);
    const key = ownerKey(scope, applicationThreadId);
    const applicationOperationId = `capacity:${randomUUID()}`;
    const operation = Promise.resolve()
      .then(async () => {
        try {
          await conversation.respond({
            applicationOperationId,
            interactionId: backendInteractionId,
            kind: "cancel",
          });
        } catch {
          try {
            await conversation.interruptForInteractionFailure(
              applicationOperationId,
            );
          } finally {
            // Whether or not the backend accepts the interrupt, its owner can
            // no longer safely present or settle any of these interactions.
            this.#abandonedBackend.add(correlation);
            this.#abandonOwnerAfterInteractionFailure(
              scope,
              applicationThreadId,
            );
          }
        }
      })
      .catch(() => undefined)
      .finally(() => this.#cancellingBackend.delete(correlation));
    this.#trackOperation(key, operation);
  }

  #remove(pending: PendingInteraction): void {
    this.#pending.delete(pending.interaction.id);
    if (pending.owner === "provider") {
      this.#byBackend.delete(
        backendKey(
          pending.scope,
          pending.applicationThreadId,
          pending.backendInteractionId,
        ),
      );
    } else {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }

  #abandonOwnerAfterInteractionFailure(
    scope: RequestScope,
    applicationThreadId: string,
  ): void {
    for (const pending of [...this.#pending.values()]) {
      if (
        !sameScope(pending.scope, scope) ||
        pending.applicationThreadId !== applicationThreadId
      ) {
        continue;
      }
      if (pending.owner === "provider") {
        this.#abandonedBackend.add(
          backendKey(
            pending.scope,
            pending.applicationThreadId,
            pending.backendInteractionId,
          ),
        );
      }
      this.#remove(pending);
      if (pending.owner === "application") pending.reject(abortError());
      this.#safePublishResolved(
        pending.scope,
        pending.applicationThreadId,
        pending.generation,
        pending.interaction.id,
      );
    }
  }

  #clearAbandonedOwner(scope: RequestScope, applicationThreadId: string): void {
    const prefix = `${ownerKey(scope, applicationThreadId)}\0`;
    for (const correlation of this.#abandonedBackend) {
      if (correlation.startsWith(prefix)) {
        this.#abandonedBackend.delete(correlation);
      }
    }
  }

  #safePublishOpened(pending: PendingInteraction): void {
    const publisher = this.#bindings.get(
      ownerKey(pending.scope, pending.applicationThreadId),
    )?.publisher;
    if (!publisher) return;
    try {
      publisher.opened(
        pending.scope,
        pending.applicationThreadId,
        pending.generation,
        structuredClone(pending.interaction),
      );
    } catch {
      // A synchronous projection observer cannot interrupt provider state.
    }
  }

  #safePublishResolved(
    scope: RequestScope,
    applicationThreadId: string,
    generation: string,
    interactionId: string,
  ): void {
    const publisher = this.#bindings.get(
      ownerKey(scope, applicationThreadId),
    )?.publisher;
    if (!publisher) return;
    try {
      publisher.resolved(scope, applicationThreadId, generation, interactionId);
    } catch {
      // A synchronous projection observer cannot interrupt provider state.
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("interaction_broker_closed");
  }

  #unsubscribeBinding(binding: OwnerBinding): unknown | undefined {
    if (binding.unsubscribed) return undefined;
    binding.unsubscribed = true;
    try {
      binding.unsubscribe();
      return undefined;
    } catch (error) {
      return error;
    }
  }

  #trackOwnerOperation(
    pending: PendingInteraction,
    operation: () => Promise<void>,
  ): Promise<void> {
    const key = ownerKey(pending.scope, pending.applicationThreadId);
    const result = Promise.resolve().then(operation);
    this.#trackOperation(key, result);
    return result;
  }

  #trackOperation(key: string, result: Promise<void>): void {
    const operations = this.#operationsByOwner.get(key) ?? new Set();
    operations.add(result);
    this.#operationsByOwner.set(key, operations);
    void result.then(
      () => this.#releaseOwnerOperation(key, operations, result),
      () => this.#releaseOwnerOperation(key, operations, result),
    );
  }

  #releaseOwnerOperation(
    key: string,
    operations: Set<Promise<void>>,
    operation: Promise<void>,
  ): void {
    operations.delete(operation);
    if (
      operations.size === 0 &&
      this.#operationsByOwner.get(key) === operations
    ) {
      this.#operationsByOwner.delete(key);
    }
  }

  async #drainOwner(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<void> {
    const key = ownerKey(scope, applicationThreadId);
    while (this.#operationsByOwner.has(key)) {
      await Promise.allSettled([...(this.#operationsByOwner.get(key) ?? [])]);
    }
  }
}

function abortError(): Error {
  return new DOMException(
    "The interaction request was cancelled.",
    "AbortError",
  );
}

function interactionBrokerUnavailable(): DomainError {
  return new DomainError(
    "runtime_unavailable",
    "The thread cannot accept another interaction request right now.",
    true,
  );
}
