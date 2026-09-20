import type { BackendItem } from "../../shared/protocol/backend.js";
import type {
  DeliveryInputOrigin,
  MessageContentPart,
} from "../../shared/protocol/conversation.js";
import {
  materializedTaskContextsSchema,
  type MaterializedTaskContext,
} from "../../shared/protocol/tasks.js";
import type { SteerTurnInput, SubmitTurnInput } from "../backends/contracts.js";
import type { DeliveryInputSnapshot } from "../db/repositories/delivery-input-snapshot-repository.js";

const TASK_CONTEXT_HEADER = "Sedes Tasks selected for this message:";
const TASK_CONTEXT_GUIDANCE =
  "The user selected the following Sedes Tasks as work and context for this message. Use each task id as its stable identity when calling Sedes Task tools.";

export type DeliveryInputSnapshotResolver = (
  deliveryOperationId: string,
) => DeliveryInputSnapshot | undefined;

/** Application-only metadata is persisted before provider submission. */
export type ApplicationSubmitTurnInput = SubmitTurnInput & {
  readonly inputOrigin?: DeliveryInputOrigin;
};
export type ApplicationSteerTurnInput = SteerTurnInput & {
  readonly inputOrigin?: DeliveryInputOrigin;
};

/**
 * Produces the one common model-facing representation used when a provider has
 * no native Sedes Task content part. The provider receives ordinary text;
 * Sedes retains the structured snapshot separately for browser projection.
 */
export function renderTaskContextsForModel(
  taskContexts: readonly MaterializedTaskContext[],
  text: string,
): string {
  const canonical = materializedTaskContextsSchema.parse(taskContexts);
  if (canonical.length === 0) return text;
  const block = [
    TASK_CONTEXT_HEADER,
    TASK_CONTEXT_GUIDANCE,
    JSON.stringify({ taskContexts: canonical }),
  ].join("\n");
  return text.length > 0 ? `${block}\n\n${text}` : block;
}

export function backendDeliveryInput(
  input: ApplicationSubmitTurnInput,
): SubmitTurnInput;
export function backendDeliveryInput(
  input: ApplicationSteerTurnInput,
): SteerTurnInput;
export function backendDeliveryInput(
  input: ApplicationSubmitTurnInput | ApplicationSteerTurnInput,
): SubmitTurnInput | SteerTurnInput {
  const { inputOrigin, ...providerInput } =
    input as ApplicationSubmitTurnInput;
  const provenanceText =
    inputOrigin?.kind === "agent_message"
      ? `Agent message from ${inputOrigin.sourceThreadLabel.text}:\n\n${providerInput.text}`
      : providerInput.text;
  if (providerInput.taskContexts.length === 0) {
    return provenanceText === providerInput.text
      ? providerInput
      : { ...providerInput, text: provenanceText };
  }
  return {
    ...providerInput,
    text: renderTaskContextsForModel(
      providerInput.taskContexts,
      provenanceText,
    ),
    taskContexts: [],
  };
}

/**
 * Replaces a provider echo with the application-owned delivery snapshot.
 * Provider-private carriers and staged paths are consequently unable to enter
 * normalized browser history.
 */
export function canonicalUserMessageContent(input: {
  readonly snapshot: DeliveryInputSnapshot;
  readonly providerContent: Extract<
    BackendItem,
    { semanticKind: "user_message" }
  >["content"];
}): readonly MessageContentPart[] {
  const providerSkill = input.providerContent.find(
    ({ kind }) => kind === "skill",
  );
  const directSkillArguments =
    providerSkill?.kind === "skill" && !input.snapshot.selectedSkillId
      ? directSkillInvocationArguments(
          input.snapshot.text.trimStart(),
          providerSkill.name.text,
        )
      : undefined;
  const skill =
    providerSkill?.kind === "skill" &&
    (input.snapshot.selectedSkillId || directSkillArguments !== undefined)
      ? providerSkill
      : undefined;
  const canonicalText =
    skill && !input.snapshot.selectedSkillId
      ? directSkillArguments!
      : input.snapshot.text;
  return [
    ...(skill ? [skill] : []),
    ...input.snapshot.attachments.map(({ descriptor: attachment }) => ({
      kind: "attachment" as const,
      attachment,
    })),
    ...input.snapshot.taskContexts.map((task) => ({
      kind: "task_context" as const,
      task,
    })),
    ...input.snapshot.contextExcerpts.map((excerpt) => ({
      kind: "context_excerpt" as const,
      excerpt,
    })),
    ...(canonicalText.trim().length > 0
      ? [{ kind: "text" as const, text: { text: canonicalText } }]
      : []),
  ];
}

function directSkillInvocationArguments(
  text: string,
  skillName: string,
): string | undefined {
  const invocation = `/${skillName}`;
  if (text === invocation) return "";
  if (
    !text.startsWith(invocation) ||
    !/^\s/u.test(text.slice(invocation.length))
  ) {
    return undefined;
  }
  return text.slice(invocation.length).trimStart();
}
