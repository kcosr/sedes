import { describe, expect, it, vi } from "vitest";
import type {
  ConversationActorEvent,
  ConversationActorListener,
} from "../../src/server/conversations/conversation-actor.js";
import {
  InteractionBroker as ProductionInteractionBroker,
  type InteractionConversation,
  type InteractionBrokerPublisher,
} from "../../src/server/conversations/interaction-broker.js";
import {
  BackendError,
  type InteractionResponseInput,
} from "../../src/server/backends/contracts.js";
import { driverInteractionSchema } from "../../src/shared/protocol/backend.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };

/** Keeps each unit fixture's publisher explicit while the assertions focus on
 * broker correlation and settlement rather than runtime bridge composition. */
class InteractionBroker extends ProductionInteractionBroker {
  readonly #publisher: InteractionBrokerPublisher;

  constructor(input: {
    readonly publisher: InteractionBrokerPublisher;
    readonly onOpened?: NonNullable<
      ConstructorParameters<typeof ProductionInteractionBroker>[0]
    >["onOpened"];
  }) {
    super(input);
    this.#publisher = input.publisher;
  }

  override bind(
    bindingScope: typeof scope,
    applicationThreadId: string,
    conversation: InteractionConversation,
    publisher: InteractionBrokerPublisher = this.#publisher,
  ) {
    return super.bind(
      bindingScope,
      applicationThreadId,
      conversation,
      publisher,
    );
  }
}

class FakeConversation implements InteractionConversation {
  listener?: ConversationActorListener;
  readonly responses: InteractionResponseInput[] = [];
  readonly interactionFailureInterrupts: string[] = [];

  subscribe(listener: ConversationActorListener): () => void {
    this.listener = listener;
    listener({
      type: "projection_replaced",
      state: {
        timeline: {
          generation: "generation-1",
          orderedTurnIds: [],
          turnsById: {},
          itemsById: {},
          runState: "idle",
        },
        backendCapabilities: {
          revision: "cap-1",
          actions: [],
          deliveryModes: [],
          steerTarget: null,
          composerAttachments: { fileStaging: false, nativeImage: false },
          nonblockingQuestions: false,
          providerOutputArtifacts: { nativeImage: false },
          supportsHistory: false,
          branching: {
            availability: "unavailable",
            reason: { text: "Branching is unavailable in this fixture." },
          },
          interactionKinds: [],
          usageSections: [],
          effectiveSettings: {},
        },
        usage: {},
      },
    });
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  async respond(input: InteractionResponseInput): Promise<void> {
    this.responses.push(input);
  }

  async interruptForInteractionFailure(
    applicationOperationId: string,
  ): Promise<void> {
    this.interactionFailureInterrupts.push(applicationOperationId);
  }

  emit(event: ConversationActorEvent): void {
    this.listener?.(event);
  }
}

function opened(
  backendInteractionId = "backend-interaction-1",
  cancellable = true,
  title = "Choose",
  secret = false,
): ConversationActorEvent {
  return {
    type: "backend_event",
    generation: "generation-1",
    event: {
      type: "interaction_opened",
      interaction: {
        backendInteractionId,
        kind: "choice",
        sourceLabel: { text: "Extension" },
        title: { text: title },
        openedAt: "2026-07-30T15:00:00.000Z",
        secret,
        destructive: false,
        cancellable,
        multiple: false,
        options: [
          {
            backendOptionId: "backend-option-a",
            label: { text: "Alpha" },
          },
          {
            backendOptionId: "backend-option-b",
            label: { text: "Beta" },
          },
        ],
      },
    },
  };
}

function projectionReplaced(generation: string): ConversationActorEvent {
  return {
    type: "projection_replaced",
    state: {
      timeline: {
        generation,
        orderedTurnIds: [],
        turnsById: {},
        itemsById: {},
        runState: "idle",
      },
      backendCapabilities: {
        revision: "cap-1",
        actions: [],
        deliveryModes: [],
        steerTarget: null,
        composerAttachments: { fileStaging: false, nativeImage: false },
        nonblockingQuestions: false,
        providerOutputArtifacts: { nativeImage: false },
        supportsHistory: false,
        branching: {
          availability: "unavailable",
          reason: { text: "Branching is unavailable in this fixture." },
        },
        interactionKinds: [],
        usageSections: [],
        effectiveSettings: {},
      },
      usage: {},
    },
  };
}

function questionnaireOpened(
  backendInteractionId = "backend-questionnaire",
): ConversationActorEvent {
  return {
    type: "backend_event",
    generation: "generation-1",
    event: {
      type: "interaction_opened",
      interaction: {
        backendInteractionId,
        kind: "questionnaire",
        sourceLabel: { text: "Agent" },
        title: { text: "Questions" },
        openedAt: "2026-07-30T15:00:00.000Z",
        secret: true,
        destructive: false,
        cancellable: false,
        questions: [
          {
            backendQuestionId: "backend-environment",
            header: { text: "Environment" },
            prompt: { text: "Which environment?" },
            secret: false,
            input: {
              kind: "single_choice",
              options: [
                {
                  backendOptionId: "backend-staging",
                  label: { text: "Staging" },
                  description: { text: "Shared services" },
                },
              ],
              other: {
                backendOptionId: "backend-other",
                label: { text: "None of the above" },
              },
              allowNote: true,
            },
          },
          {
            backendQuestionId: "backend-token",
            header: { text: "Token" },
            prompt: { text: "Enter a token" },
            secret: true,
            input: { kind: "text", multiline: false },
          },
        ],
      },
    },
  };
}

function backendResolved(generation = "generation-1"): ConversationActorEvent {
  return {
    type: "backend_event",
    generation,
    event: {
      type: "interaction_resolved",
      backendInteractionId: "backend-interaction-1",
    },
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("InteractionBroker", () => {
  it("preserves readonly invocation details only within their thread and principal", async () => {
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    const conversation = new FakeConversation();
    const binding = broker.bind(scope, "thread-1", conversation);
    const event = opened();
    if (
      event.type !== "backend_event" ||
      event.event.type !== "interaction_opened"
    )
      throw new Error("fixture");
    event.event.interaction = {
      ...event.event.interaction,
      invocation: {
        arguments: {
          kind: "object",
          entries: [{ key: { text: "query" }, value: { text: "Llama" } }],
        },
      },
    };
    conversation.emit(event);
    const [interaction] = broker.listPending(scope, "thread-1");
    expect(interaction?.invocation).toEqual(event.event.interaction.invocation);
    expect(
      broker.listPending({ ...scope, principalId: "other" }, "thread-1"),
    ).toEqual([]);
    expect(broker.listPending(scope, "thread-2")).toEqual([]);
    binding.publishPending();
    expect(publisher.opened.mock.calls.at(-1)?.[3].invocation).toEqual(
      interaction?.invocation,
    );
    await broker.close();
  });

  it("observes only first acceptance across replay, resolution and scope boundaries", async () => {
    const onOpened = vi.fn();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher, onOpened });
    const conversation = new FakeConversation();
    const binding = broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());
    const [interaction] = broker.listPending(scope, "thread-1");
    expect(onOpened).toHaveBeenCalledExactlyOnceWith(scope, interaction);
    conversation.emit(opened());
    conversation.emit(projectionReplaced("generation-2"));
    binding.publishPending();
    conversation.emit({
      type: "backend_event",
      generation: "generation-2",
      event: {
        type: "interaction_resolved",
        backendInteractionId: "backend-interaction-1",
      },
    });
    expect(onOpened).toHaveBeenCalledTimes(1);
    const otherScope = { ...scope, principalId: "other" };
    const otherConversation = new FakeConversation();
    broker.bind(otherScope, "thread-1", otherConversation);
    otherConversation.emit(opened());
    expect(onOpened).toHaveBeenCalledTimes(2);
    expect(onOpened.mock.calls[1]![0]).toEqual(otherScope);
    expect(onOpened.mock.calls[1]![1].id).not.toBe(interaction!.id);
    await broker.close();
    expect(onOpened).toHaveBeenCalledTimes(2);
  });

  it("isolates observer failure and mutations from provider publication and settlement", async () => {
    const onOpened = vi.fn((_scope, interaction) => {
      interaction.title.text = "mutated";
      throw new Error("observer failed");
    });
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher, onOpened });
    const conversation = new FakeConversation();
    broker.bind(scope, "thread-1", conversation);
    expect(() => conversation.emit(opened())).not.toThrow();
    expect(publisher.opened.mock.calls[0]![3].title.text).toBe("Choose");
    expect(broker.listPending(scope, "thread-1")[0]!.title.text).toBe("Choose");
    await broker.close();
    expect(conversation.responses).toHaveLength(1);
  });

  it("publishes an indefinite application decision and settles it locally", async () => {
    vi.useFakeTimers();
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const onOpened = vi.fn(() => {
      throw new Error("passive failure");
    });
    const broker = new InteractionBroker({ publisher, onOpened });
    const binding = broker.bind(scope, "thread-1", conversation);
    const controller = new AbortController();
    try {
      const decision = broker.requestApplicationDecision({
        scope,
        applicationThreadId: "thread-1",
        generation: "generation-1",
        presentation: {
          sourceLabel: { text: "Sedes" },
          title: { text: "Allow access to another environment?" },
          message: { text: "Read thread messages in Server B." },
          destructive: false,
        },
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1_000);
      const [interaction] = broker.listPending(scope, "thread-1");
      if (!interaction || interaction.kind !== "decision") {
        throw new Error("application decision expected");
      }
      binding.publishPending();
      expect(onOpened).toHaveBeenCalledExactlyOnceWith(scope, interaction);
      expect(interaction.actions.map(({ label }) => label.text)).toEqual([
        "Allow once",
        "Deny",
      ]);
      const prepared = broker.prepareResponse(
        scope,
        "thread-1",
        "response-operation",
        interaction.id,
        {
          kind: "decision",
          selectedActionId: interaction.actions[0]!.id,
        },
      );
      expect(prepared).toMatchObject({
        owner: "application",
        persistence: "ephemeral",
        decision: "allow",
      });
      await broker.respondPrepared(scope, "thread-1", prepared);
      await expect(decision).resolves.toBe("allow");
      await expect(
        broker.respondPrepared(scope, "thread-1", prepared),
      ).rejects.toThrow("not found");
      expect(conversation.responses).toEqual([]);
      expect(broker.listPending(scope, "thread-1")).toEqual([]);
    } finally {
      controller.abort();
      await broker.close();
      vi.useRealTimers();
    }
  });

  it("cancels only the application waiter owned by an aborted invocation", async () => {
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    broker.bind(scope, "thread-1", conversation);
    const controller = new AbortController();
    const decision = broker.requestApplicationDecision({
      scope,
      applicationThreadId: "thread-1",
      generation: "generation-1",
      presentation: {
        sourceLabel: { text: "Sedes" },
        title: { text: "Approval" },
        destructive: false,
      },
      signal: controller.signal,
    });
    controller.abort();
    await expect(decision).rejects.toMatchObject({ name: "AbortError" });
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    expect(publisher.resolved).toHaveBeenCalledOnce();
    expect(conversation.responses).toEqual([]);
    await broker.close();
  });

  it("cancels an application waiter aborted during listener registration before publication", async () => {
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    broker.bind(scope, "thread-1", conversation);
    let abortedReads = 0;
    const signal = {
      get aborted() {
        abortedReads += 1;
        return abortedReads > 1;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(
      broker.requestApplicationDecision({
        scope,
        applicationThreadId: "thread-1",
        generation: "generation-1",
        presentation: {
          sourceLabel: { text: "Sedes" },
          title: { text: "Approval" },
          destructive: false,
        },
        signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(signal.addEventListener).toHaveBeenCalledOnce();
    expect(signal.removeEventListener).toHaveBeenCalledOnce();
    expect(publisher.opened).not.toHaveBeenCalled();
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    await broker.close();
  });

  it.each(["detach", "release", "close"] as const)(
    "cancels an application waiter on broker %s",
    async (cleanup) => {
      const conversation = new FakeConversation();
      const broker = new InteractionBroker({
        publisher: { opened: vi.fn(), resolved: vi.fn() },
      });
      const binding = broker.bind(scope, "thread-1", conversation);
      const decision = broker.requestApplicationDecision({
        scope,
        applicationThreadId: "thread-1",
        generation: "generation-1",
        presentation: {
          sourceLabel: { text: "Sedes" },
          title: { text: "Approval" },
          destructive: false,
        },
        signal: new AbortController().signal,
      });
      const observed = decision.catch((error: unknown) => error);

      if (cleanup === "detach") binding.detach();
      else if (cleanup === "release") await binding.release();
      else await broker.close();

      await expect(observed).resolves.toMatchObject({ name: "AbortError" });
      expect(conversation.responses).toEqual([]);
      if (cleanup !== "close") await broker.close();
    },
  );

  it("fails closed when an application decision cannot be published", async () => {
    const onOpened = vi.fn();
    const conversation = new FakeConversation();
    const broker = new InteractionBroker({
      publisher: {
        opened: vi.fn(() => {
          throw new Error("projection unavailable");
        }),
        resolved: vi.fn(),
      },
      onOpened,
    });
    broker.bind(scope, "thread-1", conversation);

    await expect(
      broker.requestApplicationDecision({
        scope,
        applicationThreadId: "thread-1",
        generation: "generation-1",
        presentation: {
          sourceLabel: { text: "Sedes" },
          title: { text: "Approval" },
          destructive: false,
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "runtime_unavailable", retryable: true });
    expect(onOpened).not.toHaveBeenCalled();
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    await broker.close();
  });

  it("rejects an application decision when 32 provider interactions are pending", async () => {
    const onOpened = vi.fn();
    const conversation = new FakeConversation();
    const broker = new InteractionBroker({
      onOpened,
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    broker.bind(scope, "thread-1", conversation);
    for (let index = 0; index < 32; index += 1) {
      conversation.emit(opened(`provider-${index}`));
    }
    await expect(
      broker.requestApplicationDecision({
        scope,
        applicationThreadId: "thread-1",
        generation: "generation-1",
        presentation: {
          sourceLabel: { text: "Sedes" },
          title: { text: "Approval" },
          destructive: false,
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "runtime_unavailable", retryable: true });
    expect(broker.listPending(scope, "thread-1")).toHaveLength(32);
    conversation.emit(opened("extra-provider"));
    expect(onOpened).toHaveBeenCalledTimes(32);
    await broker.close();
  });

  it("rejects a provider interaction after a mixed set consumes all 32 slots", async () => {
    const conversation = new FakeConversation();
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    broker.bind(scope, "thread-1", conversation);
    const controllers: AbortController[] = [];
    const decisions: Promise<unknown>[] = [];
    for (let index = 0; index < 16; index += 1) {
      conversation.emit(opened(`provider-${index}`));
      const controller = new AbortController();
      controllers.push(controller);
      decisions.push(
        broker
          .requestApplicationDecision({
            scope,
            applicationThreadId: "thread-1",
            generation: "generation-1",
            presentation: {
              sourceLabel: { text: "Sedes" },
              title: { text: `Approval ${index}` },
              destructive: false,
            },
            signal: controller.signal,
          })
          .catch((error: unknown) => error),
      );
    }
    conversation.emit(opened("provider-over-capacity"));
    await vi.waitFor(() => {
      expect(conversation.responses).toContainEqual(
        expect.objectContaining({
          interactionId: "provider-over-capacity",
          kind: "cancel",
        }),
      );
    });
    expect(broker.listPending(scope, "thread-1")).toHaveLength(32);
    for (const controller of controllers) controller.abort();
    await Promise.all(decisions);
    await broker.close();
  });

  it("tracks an over-capacity provider rejection without inserting it", async () => {
    const conversation = new FakeConversation();
    const capacityResponse = deferred();
    const ordinaryRespond = conversation.respond.bind(conversation);
    conversation.respond = vi.fn(async (input: InteractionResponseInput) => {
      if (input.interactionId === "provider-over-capacity") {
        await capacityResponse.promise;
        return;
      }
      await ordinaryRespond(input);
    });
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    broker.bind(scope, "thread-1", conversation);
    for (let index = 0; index < 32; index += 1) {
      conversation.emit(opened(`provider-${index}`));
    }
    conversation.emit(opened("provider-over-capacity"));
    await vi.waitFor(() => {
      expect(conversation.respond).toHaveBeenCalledWith(
        expect.objectContaining({
          interactionId: "provider-over-capacity",
          kind: "cancel",
        }),
      );
    });
    expect(broker.listPending(scope, "thread-1")).toHaveLength(32);

    let closed = false;
    const close = broker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    capacityResponse.resolve();
    await close;
    expect(closed).toBe(true);
  });

  it("interrupts the owning turn when an over-capacity provider rejection fails", async () => {
    const conversation = new FakeConversation();
    conversation.respond = vi.fn(async () => {
      throw new Error("provider response unavailable");
    });
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    broker.bind(scope, "thread-1", conversation);
    for (let index = 0; index < 32; index += 1) {
      conversation.emit(opened(`provider-${index}`));
    }

    conversation.emit(opened("provider-over-capacity"));

    await vi.waitFor(() => {
      expect(conversation.interactionFailureInterrupts).toHaveLength(1);
    });
    expect(conversation.interactionFailureInterrupts[0]).toMatch(/^capacity:/);
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    await broker.close();
  });

  it("abandons every owner waiter when capacity cancellation and interruption fail", async () => {
    const conversation = new FakeConversation();
    conversation.respond = vi.fn(async () => {
      throw new Error("provider response unavailable");
    });
    conversation.interruptForInteractionFailure = vi.fn(async () => {
      throw new Error("provider interruption unavailable");
    });
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    broker.bind(scope, "thread-1", conversation);
    const decision = broker
      .requestApplicationDecision({
        scope,
        applicationThreadId: "thread-1",
        generation: "generation-1",
        presentation: {
          sourceLabel: { text: "Sedes" },
          title: { text: "Approval" },
          destructive: false,
        },
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error);
    for (let index = 0; index < 31; index += 1) {
      conversation.emit(opened(`provider-${index}`));
    }

    conversation.emit(opened("provider-over-capacity"));

    const settled = await decision;
    expect(settled).toMatchObject({ name: "AbortError" });
    expect(conversation.interruptForInteractionFailure).toHaveBeenCalledOnce();
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    expect(publisher.resolved).toHaveBeenCalledTimes(32);

    conversation.emit(opened("provider-over-capacity"));
    conversation.emit(opened("provider-0"));
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    await broker.close();
  });

  it("maps decision action identities without exposing backend authority", async () => {
    const conversation = new FakeConversation();
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit({
      type: "backend_event",
      generation: "generation-1",
      event: {
        type: "interaction_opened",
        interaction: {
          backendInteractionId: "backend-decision",
          kind: "decision",
          sourceLabel: { text: "Terminal" },
          title: { text: "Command approval" },
          openedAt: "2026-07-30T15:00:00.000Z",
          secret: false,
          destructive: true,
          cancellable: false,
          actions: [
            {
              backendActionId: "backend-allow",
              label: { text: "Allow once" },
              role: "primary",
            },
            {
              backendActionId: "backend-deny",
              label: { text: "Deny" },
              role: "reject",
            },
          ],
        },
      },
    });
    const [interaction] = broker.listPending(scope, "thread-1");
    if (!interaction || interaction.kind !== "decision") {
      throw new Error("decision expected");
    }
    expect(interaction.actions[0]!.id).not.toBe("backend-allow");
    expect(() =>
      broker.prepareResponse(scope, "thread-1", "operation", interaction.id, {
        kind: "decision",
        selectedActionId: "backend-allow",
      }),
    ).toThrow("invalid");
    await broker.respond(scope, "thread-1", "operation", interaction.id, {
      kind: "decision",
      selectedActionId: interaction.actions[0]!.id,
    });
    expect(conversation.responses).toEqual([
      {
        applicationOperationId: "operation",
        interactionId: "backend-decision",
        kind: "decision",
        selectedActionId: "backend-allow",
      },
    ]);
  });

  it("maps complete questionnaire identities, Other, and secret persistence", () => {
    const conversation = new FakeConversation();
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(questionnaireOpened());
    const [interaction] = broker.listPending(scope, "thread-1");
    if (!interaction || interaction.kind !== "questionnaire") {
      throw new Error("questionnaire expected");
    }
    const [choice, secret] = interaction.questions;
    if (
      !choice ||
      choice.input.kind !== "single_choice" ||
      !choice.input.other ||
      !secret
    ) {
      throw new Error("question fixture invalid");
    }
    expect(choice.id).not.toBe("backend-environment");
    expect(choice.input.other.id).not.toBe("backend-other");
    const unansweredSecret = broker.prepareResponse(
      scope,
      "thread-1",
      "operation",
      interaction.id,
      {
        kind: "questionnaire",
        answers: [
          {
            questionId: choice.id,
            answer: {
              kind: "single_choice",
              selectedOptionId: choice.input.other.id,
              note: "Use development",
            },
          },
          { questionId: secret.id, answer: { kind: "unanswered" } },
        ],
      },
    );
    expect(unansweredSecret.persistence).toBe("durable");
    if (unansweredSecret.owner !== "provider") {
      throw new Error("provider response expected");
    }
    expect(unansweredSecret.backendResponse).toEqual({
      applicationOperationId: "operation",
      interactionId: "backend-questionnaire",
      kind: "questionnaire",
      answers: [
        {
          questionId: "backend-environment",
          answer: {
            kind: "single_choice",
            selectedOptionId: "backend-other",
            note: "Use development",
          },
        },
        {
          questionId: "backend-token",
          answer: { kind: "unanswered" },
        },
      ],
    });
    const answeredSecret = broker.prepareResponse(
      scope,
      "thread-1",
      "secret-operation",
      interaction.id,
      {
        kind: "questionnaire",
        answers: [
          { questionId: choice.id, answer: { kind: "unanswered" } },
          {
            questionId: secret.id,
            answer: { kind: "text", value: "secret value" },
          },
        ],
      },
    );
    expect(answeredSecret.persistence).toBe("ephemeral");
  });

  it("rejects incomplete and wrong-question questionnaire answers", () => {
    const conversation = new FakeConversation();
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(questionnaireOpened());
    const interaction = broker.listPending(scope, "thread-1")[0];
    if (!interaction || interaction.kind !== "questionnaire") {
      throw new Error("questionnaire expected");
    }
    const [choice, secret] = interaction.questions;
    if (!choice || choice.input.kind !== "single_choice" || !secret) {
      throw new Error("question fixture invalid");
    }
    const choiceOptionId = choice.input.options[0]!.id;
    expect(() =>
      broker.prepareResponse(scope, "thread-1", "operation", interaction.id, {
        kind: "questionnaire",
        answers: [{ questionId: choice.id, answer: { kind: "unanswered" } }],
      }),
    ).toThrow("every question");
    expect(() =>
      broker.prepareResponse(scope, "thread-1", "operation", interaction.id, {
        kind: "questionnaire",
        answers: [
          { questionId: choice.id, answer: { kind: "unanswered" } },
          {
            questionId: secret.id,
            answer: {
              kind: "single_choice",
              selectedOptionId: choiceOptionId,
            },
          },
        ],
      }),
    ).toThrow("does not match");
  });

  it("maps opaque backend and option identities and settles once", async () => {
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    const binding = broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());

    const [interaction] = broker.listPending(scope, "thread-1");
    expect(interaction).toMatchObject({
      kind: "choice",
      options: [{ label: { text: "Alpha" } }, { label: { text: "Beta" } }],
    });
    if (!interaction || interaction.kind !== "choice") {
      throw new Error("choice interaction expected");
    }
    await broker.respond(
      scope,
      "thread-1",
      "response-operation",
      interaction.id,
      {
        kind: "choice",
        selectedOptionIds: [interaction.options[1]!.id],
      },
    );

    expect(conversation.responses).toEqual([
      {
        applicationOperationId: "response-operation",
        interactionId: "backend-interaction-1",
        kind: "choice",
        selectedOptionIds: ["backend-option-b"],
      },
    ]);
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    expect(publisher.resolved).toHaveBeenCalledWith(
      scope,
      "thread-1",
      "generation-1",
      interaction.id,
    );
    await expect(
      broker.respond(scope, "thread-1", "response-operation", interaction.id, {
        kind: "cancel",
      }),
    ).rejects.toThrow("not found");
    await binding.release();
    await broker.close();
  });

  it("dispatches a recovered prepared response by durable backend correlation", async () => {
    const conversation = new FakeConversation();
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());
    const first = broker.listPending(scope, "thread-1")[0];
    if (!first || first.kind !== "choice") {
      throw new Error("choice interaction expected");
    }
    const prepared = broker.prepareResponse(
      scope,
      "thread-1",
      "response-operation",
      first.id,
      {
        kind: "choice",
        selectedOptionIds: [first.options[0]!.id],
      },
    );
    if (prepared.owner !== "provider") {
      throw new Error("provider response expected");
    }

    conversation.emit(backendResolved());
    conversation.emit(opened());
    const reattached = broker.listPending(scope, "thread-1")[0];
    expect(reattached?.id).not.toBe(first.id);

    await broker.respondPrepared(scope, "thread-1", prepared);
    expect(conversation.responses).toContainEqual(prepared.backendResponse);
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    await broker.close();
  });

  it("classifies secret responses as ephemeral and retires an unknown outcome", async () => {
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened("backend-interaction-1", true, "Secret", true));
    const [interaction] = broker.listPending(scope, "thread-1");
    if (!interaction || interaction.kind !== "choice") {
      throw new Error("choice interaction expected");
    }
    conversation.respond = vi.fn().mockRejectedValue(
      new BackendError({
        category: "submission_unknown",
        retryable: false,
        crossedSubmissionBoundary: true,
        safeMessage: "The secret response outcome is unknown.",
      }),
    );
    const prepared = broker.prepareResponse(
      scope,
      "thread-1",
      "response-operation",
      interaction.id,
      {
        kind: "choice",
        selectedOptionIds: [interaction.options[0]!.id],
      },
    );

    expect(prepared.persistence).toBe("ephemeral");
    await expect(
      broker.respondPrepared(scope, "thread-1", prepared),
    ).rejects.toThrow("outcome is unknown");
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    expect(publisher.resolved).toHaveBeenCalledOnce();
  });

  it("keeps requests pending when a response fails", async () => {
    const conversation = new FakeConversation();
    conversation.respond = vi.fn().mockRejectedValue(
      new BackendError({
        category: "overloaded",
        retryable: true,
        crossedSubmissionBoundary: false,
        safeMessage: "backend busy",
      }),
    );
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());
    const [interaction] = broker.listPending(scope, "thread-1");

    await expect(
      broker.respond(scope, "thread-1", "response-operation", interaction!.id, {
        kind: "cancel",
      }),
    ).rejects.toThrow("backend busy");
    expect(broker.listPending(scope, "thread-1")).toHaveLength(1);
  });

  it("quarantines an unclassified response failure conservatively", async () => {
    const conversation = new FakeConversation();
    conversation.respond = vi
      .fn()
      .mockRejectedValue(new Error("unclassified transport failure"));
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());
    const [interaction] = broker.listPending(scope, "thread-1");

    await expect(
      broker.respond(scope, "thread-1", "response-operation", interaction!.id, {
        kind: "cancel",
      }),
    ).rejects.toThrow("unclassified transport failure");
    expect(broker.listPending(scope, "thread-1")).toHaveLength(1);
    expect(publisher.resolved).not.toHaveBeenCalled();
  });

  it("keeps a backend request pending across elapsed time", async () => {
    vi.useFakeTimers();
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    try {
      const broker = new InteractionBroker({ publisher });
      broker.bind(scope, "thread-1", conversation);
      conversation.emit(opened());

      await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1_000);

      expect(broker.listPending(scope, "thread-1")).toHaveLength(1);
      expect(conversation.responses).toEqual([]);
      expect(publisher.resolved).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates owner scope and cancels pending requests on release", async () => {
    const conversation = new FakeConversation();
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    const binding = broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());
    expect(
      broker.listPending({ ...scope, principalId: "principal-2" }, "thread-1"),
    ).toEqual([]);

    await binding.release();
    expect(conversation.responses).toHaveLength(1);
    expect(conversation.responses[0]).toMatchObject({
      applicationOperationId: expect.stringMatching(/^cleanup:/),
      interactionId: "backend-interaction-1",
      kind: "cancel",
    });
  });

  it("replays pending interactions for the active owner binding", async () => {
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    publisher.opened.mockImplementationOnce(() => {
      throw new Error("thread_projection_snapshot_required");
    });
    const broker = new InteractionBroker({ publisher });
    const binding = broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());
    const initialPublication = publisher.opened.mock.calls[0];

    binding.publishPending();

    expect(publisher.opened).toHaveBeenCalledTimes(2);
    expect(publisher.opened.mock.calls[1]).toEqual(initialPublication);
    await binding.release();
    publisher.opened.mockClear();
    binding.publishPending();
    expect(publisher.opened).not.toHaveBeenCalled();
  });

  it("uses the current projection generation after replacement", async () => {
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());
    const [interaction] = broker.listPending(scope, "thread-1");

    conversation.emit(projectionReplaced("generation-2"));
    await broker.respond(
      scope,
      "thread-1",
      "response-operation",
      interaction!.id,
      {
        kind: "cancel",
      },
    );

    expect(publisher.resolved).toHaveBeenLastCalledWith(
      scope,
      "thread-1",
      "generation-2",
      interaction!.id,
    );
  });

  it("publishes one resolution when the backend resolves during response", async () => {
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());
    const [interaction] = broker.listPending(scope, "thread-1");
    conversation.respond = vi.fn(async () => {
      conversation.emit(backendResolved());
    });

    await broker.respond(
      scope,
      "thread-1",
      "response-operation",
      interaction!.id,
      {
        kind: "cancel",
      },
    );

    expect(publisher.resolved).toHaveBeenCalledOnce();
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
  });

  it("drains a response still running after backend resolution before close", async () => {
    const conversation = new FakeConversation();
    const wait = deferred();
    conversation.respond = vi.fn(() => wait.promise);
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());
    const [interaction] = broker.listPending(scope, "thread-1");
    const response = broker.respond(
      scope,
      "thread-1",
      "response-operation",
      interaction!.id,
      {
        kind: "cancel",
      },
    );
    await vi.waitFor(() => expect(conversation.respond).toHaveBeenCalledOnce());
    conversation.emit(backendResolved());

    const close = broker.close();
    let closed = false;
    void close.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    wait.resolve();
    await Promise.all([response, close]);
  });

  it("quarantines a response whose backend outcome is uncertain", async () => {
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());
    const [interaction] = broker.listPending(scope, "thread-1");
    conversation.respond = vi
      .fn()
      .mockRejectedValueOnce(
        new BackendError({
          category: "submission_unknown",
          retryable: false,
          crossedSubmissionBoundary: true,
          safeMessage: "The response outcome is unknown.",
        }),
      )
      .mockResolvedValueOnce(undefined);

    await expect(
      broker.respond(scope, "thread-1", "response-operation", interaction!.id, {
        kind: "cancel",
      }),
    ).rejects.toThrow("outcome is unknown");
    expect(broker.listPending(scope, "thread-1")).toHaveLength(1);
    expect(publisher.resolved).not.toHaveBeenCalled();
    await broker.respond(
      scope,
      "thread-1",
      "response-operation",
      interaction!.id,
      {
        kind: "cancel",
      },
    );
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    expect(publisher.resolved).toHaveBeenCalledOnce();
  });

  it("rejects user cancellation when the request is not cancellable", async () => {
    const conversation = new FakeConversation();
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened("backend-interaction-1", false));
    const [interaction] = broker.listPending(scope, "thread-1");

    await expect(
      broker.respond(scope, "thread-1", "response-operation", interaction!.id, {
        kind: "cancel",
      }),
    ).rejects.toThrow("cannot be cancelled");
    expect(conversation.responses).toEqual([]);
  });

  it("detaches locally even when backend cleanup cancellation fails", async () => {
    const conversation = new FakeConversation();
    conversation.respond = vi.fn().mockRejectedValue(new Error("offline"));
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    const binding = broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());

    await binding.release();

    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    expect(conversation.listener).toBeUndefined();
  });

  it("shares release and close cleanup promises and waits for settlement", async () => {
    const conversation = new FakeConversation();
    const wait = deferred();
    conversation.respond = vi.fn(() => wait.promise);
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    const binding = broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());

    const firstRelease = binding.release();
    const secondRelease = binding.release();
    expect(secondRelease).toBe(firstRelease);
    expect(conversation.listener).toBeUndefined();
    let released = false;
    void firstRelease.then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    wait.resolve();
    await firstRelease;

    const firstClose = broker.close();
    expect(broker.close()).toBe(firstClose);
    await firstClose;
  });

  it("detaches active and pending interactions without waiting or sending cleanup", async () => {
    const conversation = new FakeConversation();
    const blocked = deferred();
    conversation.respond = vi.fn(() => blocked.promise);
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    const binding = broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());
    const [interaction] = broker.listPending(scope, "thread-1");
    const response = broker.respond(
      scope,
      "thread-1",
      "active-response",
      interaction!.id,
      { kind: "cancel" },
    );
    await Promise.resolve();

    broker.detachForShutdown();
    binding.detach();
    expect(conversation.listener).toBeUndefined();
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    await expect(broker.close()).resolves.toBeUndefined();

    blocked.resolve();
    await response;
    expect(conversation.respond).toHaveBeenCalledOnce();
  });

  it("force-resets exact pending interactions locally and suppresses stale backend replay", () => {
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());
    const interaction = broker.listPending(scope, "thread-1")[0]!;

    broker.abandonPending(scope, "thread-1", [interaction.id]);

    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    expect(conversation.responses).toEqual([]);
    expect(publisher.resolved).toHaveBeenCalledWith(
      scope,
      "thread-1",
      "generation-1",
      interaction.id,
    );

    conversation.emit(opened());
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    expect(publisher.opened).toHaveBeenCalledTimes(1);

    conversation.emit(backendResolved());
    conversation.emit(opened());
    expect(broker.listPending(scope, "thread-1")).toHaveLength(1);
    expect(publisher.opened).toHaveBeenCalledTimes(2);
  });

  it("leaves pending interactions intact when force-reset evidence changed", () => {
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());

    expect(() =>
      broker.abandonPending(scope, "thread-1", ["missing-interaction"]),
    ).toThrow("evidence_changed");
    const [interaction] = broker.listPending(scope, "thread-1");
    expect(() =>
      broker.abandonPending(scope, "thread-1", [
        interaction!.id,
        interaction!.id,
      ]),
    ).toThrow("evidence_changed");
    expect(broker.listPending(scope, "thread-1")).toHaveLength(1);
    expect(publisher.resolved).not.toHaveBeenCalled();
    expect(conversation.responses).toEqual([]);
  });

  it("blocks replacement binding until release cleanup completes", async () => {
    const conversation = new FakeConversation();
    const wait = deferred();
    conversation.respond = vi.fn(() => wait.promise);
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    const binding = broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());

    const release = binding.release();
    expect(() =>
      broker.bind(scope, "thread-1", new FakeConversation()),
    ).toThrow("already_bound");
    wait.resolve();
    await release;
    expect(() =>
      broker.bind(scope, "thread-1", new FakeConversation()),
    ).not.toThrow();
  });

  it("finishes release and close cleanup when unsubscribe throws", async () => {
    const conversation = new FakeConversation();
    const originalSubscribe = conversation.subscribe.bind(conversation);
    conversation.subscribe = (listener) => {
      const unsubscribe = originalSubscribe(listener);
      return () => {
        unsubscribe();
        throw new Error("unsubscribe failed");
      };
    };
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    const binding = broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());

    await expect(binding.release()).rejects.toThrow("unsubscribe failed");
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    expect(() =>
      broker.bind(scope, "thread-1", new FakeConversation()),
    ).not.toThrow();

    const closeConversation = new FakeConversation();
    closeConversation.subscribe = (listener) => {
      FakeConversation.prototype.subscribe.call(closeConversation, listener);
      return () => {
        throw new Error("close unsubscribe failed");
      };
    };
    const closeBroker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    closeBroker.bind(scope, "thread-2", closeConversation);
    closeConversation.emit(opened());
    await expect(closeBroker.close()).rejects.toThrow(
      "subscriptions could not be released",
    );
    expect(closeBroker.listPending(scope, "thread-2")).toEqual([]);
  });

  it("copies nested driver values before retaining them", () => {
    const conversation = new FakeConversation();
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    broker.bind(scope, "thread-1", conversation);
    const event = opened();
    conversation.emit(event);
    if (
      event.type !== "backend_event" ||
      event.event.type !== "interaction_opened" ||
      event.event.interaction.kind !== "choice"
    ) {
      throw new Error("choice event expected");
    }
    event.event.interaction.title.text = "source mutation";
    event.event.interaction.options[0]!.label.text = "source mutation";

    const [pending] = broker.listPending(scope, "thread-1");
    expect(pending!.title.text).toBe("Choose");
    if (pending?.kind !== "choice") throw new Error("choice expected");
    expect(pending.options[0]!.label.text).toBe("Alpha");
  });

  it("does not poison an owner when subscription establishment throws", async () => {
    const failedConversation = new FakeConversation();
    failedConversation.subscribe = (listener) => {
      failedConversation.listener = listener;
      listener(opened());
      throw new Error("subscribe failed");
    };
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });

    expect(() => broker.bind(scope, "thread-1", failedConversation)).toThrow(
      "subscribe failed",
    );
    await vi.waitFor(() =>
      expect(broker.listPending(scope, "thread-1")).toEqual([]),
    );
    expect(() =>
      broker.bind(scope, "thread-1", new FakeConversation()),
    ).not.toThrow();
  });

  it("clones interaction values at publication and query boundaries", () => {
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened());

    const published = publisher.opened.mock.calls[0]![3];
    published.title.text = "mutated publication";
    const listed = broker.listPending(scope, "thread-1");
    listed[0]!.title.text = "mutated listing";

    expect(broker.listPending(scope, "thread-1")[0]!.title.text).toBe("Choose");
  });

  it("cancels a conflicting duplicate backend request instead of replacing it", async () => {
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    broker.bind(scope, "thread-1", conversation);
    conversation.emit(opened("backend-interaction-1", true, "First"));
    conversation.emit(opened("backend-interaction-1", true, "Conflicting"));
    await vi.waitFor(() => expect(conversation.responses).toHaveLength(1));

    expect(broker.listPending(scope, "thread-1")).toEqual([]);
    expect(publisher.resolved).toHaveBeenCalledOnce();
  });

  it("rejects duplicate backend option identities", () => {
    const event = opened();
    if (
      event.type !== "backend_event" ||
      event.event.type !== "interaction_opened" ||
      event.event.interaction.kind !== "choice"
    ) {
      throw new Error("choice event expected");
    }
    const interaction = structuredClone(event.event.interaction);
    interaction.options[1]!.backendOptionId =
      interaction.options[0]!.backendOptionId;

    expect(driverInteractionSchema.safeParse(interaction).success).toBe(false);
  });

  it("rejects an interaction whose aggregate browser payload is oversized", () => {
    const event = opened();
    if (
      event.type !== "backend_event" ||
      event.event.type !== "interaction_opened" ||
      event.event.interaction.kind !== "choice"
    ) {
      throw new Error("choice event expected");
    }
    const interaction = structuredClone(event.event.interaction);
    interaction.options = Array.from({ length: 64 }, (_, index) => ({
      backendOptionId: `backend-option-${index}`,
      label: { text: "😀".repeat(4_096) },
      description: { text: "😀".repeat(4_096) },
    }));

    expect(driverInteractionSchema.safeParse(interaction).success).toBe(false);
  });

  it("validates the final presentation after replacing backend identities", () => {
    const event = opened("i");
    if (
      event.type !== "backend_event" ||
      event.event.type !== "interaction_opened" ||
      event.event.interaction.kind !== "choice"
    ) {
      throw new Error("choice event expected");
    }
    event.event.interaction.options = Array.from(
      { length: 64 },
      (_, index) => ({
        backendOptionId: `o${index}`,
        label: { text: "x".repeat(4_048) },
        description: { text: "y".repeat(4_048) },
      }),
    );
    expect(
      driverInteractionSchema.safeParse(event.event.interaction).success,
    ).toBe(true);
    const conversation = new FakeConversation();
    const broker = new InteractionBroker({
      publisher: { opened: vi.fn(), resolved: vi.fn() },
    });
    broker.bind(scope, "thread-1", conversation);

    expect(() => conversation.emit(event)).toThrow(
      "Interaction payload exceeds",
    );
    expect(broker.listPending(scope, "thread-1")).toEqual([]);
  });
});

describe("normalized form broker", () => {
  it("keeps form identities opaque and stable on replay, rejects wrong scope and cross-field choices, and validates before dispatch", async () => {
    const conversation = new FakeConversation();
    const publisher = { opened: vi.fn(), resolved: vi.fn() };
    const broker = new InteractionBroker({ publisher });
    const binding = broker.bind(scope, "thread-1", conversation);
    conversation.emit({
      type: "backend_event",
      generation: "generation-1",
      event: {
        type: "interaction_opened",
        interaction: driverInteractionSchema.parse({
          backendInteractionId: "native-form",
          sourceLabel: { text: "MCP" },
          title: { text: "Settings" },
          openedAt: "2026-07-30T15:00:00.000Z",
          secret: false,
          destructive: false,
          cancellable: true,
          kind: "form",
          fields: [
            {
              id: "native-number",
              label: { text: "Count" },
              required: true,
              input: { kind: "number", integer: true, minimum: 0 },
            },
            {
              id: "native-first",
              label: { text: "First" },
              required: true,
              input: {
                kind: "single_choice",
                options: [{ id: "native-a", label: { text: "A" } }],
                default: "native-a",
              },
            },
            {
              id: "native-second",
              label: { text: "Second" },
              required: false,
              input: {
                kind: "multiple_choice",
                options: [{ id: "native-b", label: { text: "B" } }],
                default: ["native-b"],
              },
            },
            {
              id: "native-bool",
              label: { text: "Enabled" },
              required: true,
              input: { kind: "boolean" },
            },
          ],
        }),
      },
    });
    const interaction = broker.listPending(scope, "thread-1")[0]!;
    if (interaction.kind !== "form") throw new Error("form expected");
    const [count, first, second, bool] = interaction.fields;
    if (
      first!.input.kind !== "single_choice" ||
      second!.input.kind !== "multiple_choice"
    )
      throw new Error("choices expected");
    const choiceId = first!.input.options[0]!.id;
    const otherId = second!.input.options[0]!.id;
    expect(JSON.stringify(interaction)).not.toContain("native-");
    expect(first!.input.default).toBe(choiceId);
    expect(second!.input.default).toEqual([otherId]);
    binding.publishPending();
    expect(publisher.opened.mock.calls.at(-1)![3]).toEqual(interaction);
    const answers = [
      { fieldId: count!.id, value: 0 },
      { fieldId: first!.id, value: choiceId },
      { fieldId: bool!.id, value: false },
    ];
    expect(() =>
      broker.prepareResponse(
        { ...scope, principalId: "other" },
        "thread-1",
        "wrong-scope",
        interaction.id,
        { kind: "form", answers },
      ),
    ).toThrow();
    expect(() =>
      broker.prepareResponse(
        scope,
        "other-thread",
        "wrong-thread",
        interaction.id,
        { kind: "form", answers },
      ),
    ).toThrow();
    expect(() =>
      broker.prepareResponse(scope, "thread-1", "wrong-field", interaction.id, {
        kind: "form",
        answers: [
          ...answers.filter((answer) => answer.fieldId !== first!.id),
          { fieldId: first!.id, value: otherId },
        ],
      }),
    ).toThrow();
    expect(() =>
      broker.prepareResponse(
        scope,
        "thread-1",
        "invalid-number",
        interaction.id,
        {
          kind: "form",
          answers: [
            ...answers.filter((answer) => answer.fieldId !== count!.id),
            { fieldId: count!.id, value: 1.5 },
          ],
        },
      ),
    ).toThrow();
    expect(conversation.responses).toHaveLength(0);
    await broker.respond(scope, "thread-1", "valid", interaction.id, {
      kind: "form",
      answers,
    });
    expect(conversation.responses).toEqual([
      {
        applicationOperationId: "valid",
        interactionId: "native-form",
        kind: "form",
        answers: [
          { fieldId: "native-number", value: 0 },
          { fieldId: "native-first", value: "native-a" },
          { fieldId: "native-bool", value: false },
        ],
      },
    ]);
    await broker.close();
  });
});
