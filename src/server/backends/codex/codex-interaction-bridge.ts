import { normalizeCodexElicitationForm } from "./codex-elicitation-form.js";
import { createHash } from "node:crypto";
import { boundValue } from "../../conversations/payload-policy.js";
import {
  driverInteractionSchema,
  type BackendConversationEvent,
  type DriverInteraction,
} from "../../../shared/protocol/backend.js";
import type {
  BackendMutationReconciliation,
  InteractionResponseInput,
} from "../contracts.js";
import {
  type CodexRoutedServerRequest,
  type CodexServerRequestOwnershipLease,
  type CodexServerRequestRoute,
  CodexServerRequestRouter,
  CodexServerRequestRoutingError,
} from "./codex-server-request-router.js";

const DEFAULT_RESPONSE_CONFIRMATION_TIMEOUT_MILLISECONDS = 30_000;
const MAXIMUM_RECONCILIATION_RECORDS = 1_024;
const MAXIMUM_PRESENTED_TEXT_CHARACTERS = 65_536;
const CODEX_OTHER_OPTION_LABEL = "None of the above";
const CODEX_USER_NOTE_PREFIX = "user_note: ";

type InteractionEvent = Extract<
  BackendConversationEvent,
  { readonly type: "interaction_opened" | "interaction_resolved" }
>;

type CommandApprovalRequest = Extract<
  CodexRoutedServerRequest,
  { readonly method: "item/commandExecution/requestApproval" }
>;
type CommandApprovalDecision = NonNullable<
  CommandApprovalRequest["params"]["availableDecisions"]
>[number];
type CommandDecisionChoice = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly role: "primary" | "alternative" | "reject";
  readonly decision: CommandApprovalDecision;
};

const DEFAULT_COMMAND_DECISIONS = Object.freeze([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
] as const satisfies ReadonlyArray<CommandApprovalDecision>);

type PendingInteraction = {
  readonly backendInteractionId: string;
  readonly nativeRequestKey: string;
  readonly generation: number;
  readonly request: CodexRoutedServerRequest;
  readonly interaction: DriverInteraction;
  readonly toProviderResponse: (input: InteractionResponseInput) => unknown;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly removeAbortListener: () => void;
  handlerSettled: boolean;
};

type ResponseObservation = {
  readonly fingerprint: string;
  readonly secret: boolean;
  readonly nativeRequestKey: string;
  readonly generation: number;
  readonly confirmation: Promise<void>;
  readonly resolveConfirmation: () => void;
  readonly rejectConfirmation: (error: unknown) => void;
  readonly lateReconciliation: Promise<BackendMutationReconciliation>;
  readonly resolveLateReconciliation: (
    outcome: BackendMutationReconciliation,
  ) => void;
  state: "unconfirmed" | "uncertain" | "accepted" | "unknown";
  timeout?: ReturnType<typeof setTimeout>;
};

export class CodexInteractionBridgeError extends Error {
  readonly code: string;
  readonly outcomeUnknown: boolean;
  readonly lateMutationReconciliation?: Promise<BackendMutationReconciliation>;

  constructor(
    code: string,
    outcomeUnknown = false,
    lateMutationReconciliation?: Promise<BackendMutationReconciliation>,
  ) {
    super(code);
    this.name = "CodexInteractionBridgeError";
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
    this.lateMutationReconciliation = lateMutationReconciliation;
  }
}

/**
 * Converts stable C2 interaction request kinds into the normalized broker
 * contract while retaining native response correlation only in the provider
 * boundary.
 */
export class CodexInteractionBridge {
  readonly #router: CodexServerRequestRouter;
  readonly #nativeThreadId: string;
  readonly #ownsRoute: (route: CodexServerRequestRoute) => boolean;
  readonly #emit: (event: InteractionEvent) => void;
  readonly #now: () => number;
  readonly #responseConfirmationTimeoutMilliseconds: number;
  readonly #pending = new Map<string, PendingInteraction>();
  readonly #pendingByNativeRequest = new Map<string, string>();
  readonly #responses = new Map<string, ResponseObservation>();
  #lease: CodexServerRequestOwnershipLease | undefined;
  #generation = 0;
  #closed = false;

  constructor(input: {
    readonly router: CodexServerRequestRouter;
    readonly nativeThreadId: string;
    readonly ownsRoute: (route: CodexServerRequestRoute) => boolean;
    readonly emit: (event: InteractionEvent) => void;
    readonly now?: () => number;
    readonly responseConfirmationTimeoutMilliseconds?: number;
  }) {
    this.#router = input.router;
    this.#nativeThreadId = input.nativeThreadId;
    this.#ownsRoute = input.ownsRoute;
    this.#emit = input.emit;
    this.#now = input.now ?? Date.now;
    this.#responseConfirmationTimeoutMilliseconds =
      input.responseConfirmationTimeoutMilliseconds ??
      DEFAULT_RESPONSE_CONFIRMATION_TIMEOUT_MILLISECONDS;
    if (
      !Number.isSafeInteger(this.#responseConfirmationTimeoutMilliseconds) ||
      this.#responseConfirmationTimeoutMilliseconds <= 0
    ) {
      throw new Error("codex_interaction_confirmation_timeout_invalid");
    }
  }

  activate(generation: number): void {
    if (this.#closed) throw new Error("codex_interaction_bridge_closed");
    if (this.#generation === generation && this.#lease) return;
    this.deactivate("codex_interaction_generation_replaced");
    this.#generation = generation;
    this.#lease = this.#router.claimThread({
      generation,
      nativeThreadId: this.#nativeThreadId,
      owner: {
        owns: (route) =>
          !this.#closed &&
          this.#generation === generation &&
          this.#ownsRoute(route),
        handle: (request) => this.#open(request),
      },
    });
  }

  deactivate(reason = "codex_interaction_generation_inactive"): void {
    const generation = this.#generation;
    this.#generation = 0;
    if (generation !== 0) {
      this.#markGenerationResponsesUnknown(
        generation,
        "codex_interaction_response_confirmation_lost",
      );
    }
    const lease = this.#lease;
    this.#lease = undefined;
    lease?.release(reason);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.deactivate("codex_interaction_owner_closed");
  }

  respond(input: InteractionResponseInput): Promise<void> {
    if (this.#closed) {
      throw new CodexInteractionBridgeError("codex_interaction_bridge_closed");
    }
    const observed = this.#responses.get(input.interactionId);
    if (observed) {
      const fingerprint = responseFingerprint(input, observed.secret);
      if (observed.fingerprint !== fingerprint) {
        throw new CodexInteractionBridgeError(
          "codex_interaction_response_replay_mismatch",
        );
      }
      if (observed.state === "accepted") return Promise.resolve();
      if (observed.state === "unconfirmed") return observed.confirmation;
      throw new CodexInteractionBridgeError(
        "codex_interaction_response_outcome_unknown",
        true,
        observed.state === "uncertain"
          ? observed.lateReconciliation
          : undefined,
      );
    }
    const pending = this.#pending.get(input.interactionId);
    if (!pending) {
      throw new CodexInteractionBridgeError("codex_interaction_not_pending");
    }
    if (
      pending.generation !== this.#generation ||
      pending.request.signal.aborted
    ) {
      throw new CodexInteractionBridgeError(
        "codex_interaction_generation_changed",
        true,
      );
    }
    const fingerprint = responseFingerprint(input, pending.interaction.secret);
    let result: unknown;
    try {
      result = pending.toProviderResponse(input);
    } catch (error) {
      throw error instanceof CodexInteractionBridgeError
        ? error
        : new CodexInteractionBridgeError("codex_interaction_response_invalid");
    }
    const observation = responseObservation({
      fingerprint,
      secret: pending.interaction.secret,
      nativeRequestKey: pending.nativeRequestKey,
      generation: pending.generation,
    });
    this.#rememberResponse(input.interactionId, observation);
    pending.handlerSettled = true;
    pending.resolve(result);
    observation.timeout = setTimeout(() => {
      this.#markResponseUnknown(
        input.interactionId,
        "codex_interaction_response_confirmation_timeout",
        pending,
      );
    }, this.#responseConfirmationTimeoutMilliseconds);
    observation.timeout.unref?.();
    return observation.confirmation;
  }

  reconcile(input: InteractionResponseInput): BackendMutationReconciliation {
    const observed = this.#responses.get(input.interactionId);
    if (observed) {
      const fingerprint = responseFingerprint(input, observed.secret);
      if (observed.fingerprint !== fingerprint) {
        throw new CodexInteractionBridgeError(
          "codex_interaction_response_replay_mismatch",
        );
      }
      return {
        outcome: observed.state === "accepted" ? "accepted" : "unknown",
      };
    }
    return this.#pending.has(input.interactionId)
      ? { outcome: "not_applied" }
      : { outcome: "unknown" };
  }

  observeProviderResolved(
    generation: number,
    requestId: string | number,
  ): void {
    const key = nativeRequestKey(requestId);
    for (const [interactionId, observed] of this.#responses) {
      if (
        observed.generation !== generation ||
        observed.nativeRequestKey !== key
      ) {
        continue;
      }
      if (observed.state === "unconfirmed" || observed.state === "uncertain") {
        observed.state = "accepted";
        if (observed.timeout) clearTimeout(observed.timeout);
        observed.timeout = undefined;
        observed.resolveConfirmation();
        observed.resolveLateReconciliation({ outcome: "accepted" });
      }
      const pending = this.#pending.get(interactionId);
      if (pending) this.#finishPending(pending);
    }
    const interactionId = this.#pendingByNativeRequest.get(
      generationRequestKey(generation, key),
    );
    const pending = interactionId
      ? this.#pending.get(interactionId)
      : undefined;
    if (pending) {
      this.#finishPending(
        pending,
        new CodexInteractionBridgeError(
          "codex_interaction_resolved_elsewhere",
          true,
        ),
      );
    }
  }

  pendingCount(): number {
    return this.#pending.size;
  }

  pendingInteractions(): readonly DriverInteraction[] {
    return [...this.#pending.values()].map(({ interaction }) =>
      structuredClone(interaction),
    );
  }

  #open(request: CodexRoutedServerRequest): Promise<unknown> {
    if (
      this.#closed ||
      request.generation !== this.#generation ||
      request.signal.aborted
    ) {
      throw new CodexServerRequestRoutingError(
        "codex_interaction_generation_changed",
      );
    }
    const backendInteractionId = interactionId(request);
    if (this.#pending.has(backendInteractionId)) {
      throw new CodexInteractionBridgeError(
        "codex_interaction_duplicate_request",
      );
    }
    const presented = presentRequest(request, backendInteractionId, this.#now);
    return new Promise((resolve, reject) => {
      const abort = () => {
        const current = this.#pending.get(backendInteractionId);
        if (current) {
          this.#markResponseUncertain(
            backendInteractionId,
            current,
            "codex_interaction_response_confirmation_lost",
          );
        }
      };
      request.signal.addEventListener("abort", abort, { once: true });
      const pending: PendingInteraction = {
        backendInteractionId,
        nativeRequestKey: nativeRequestKey(request.requestId),
        generation: request.generation,
        request,
        interaction: presented.interaction,
        toProviderResponse: presented.toProviderResponse,
        resolve,
        reject,
        removeAbortListener: () =>
          request.signal.removeEventListener("abort", abort),
        handlerSettled: false,
      };
      this.#pending.set(backendInteractionId, pending);
      this.#pendingByNativeRequest.set(
        generationRequestKey(pending.generation, pending.nativeRequestKey),
        backendInteractionId,
      );
      this.#emit({
        type: "interaction_opened",
        interaction: pending.interaction,
      });
    });
  }

  #finishPending(pending: PendingInteraction, handlerError?: unknown): void {
    if (this.#pending.get(pending.backendInteractionId) !== pending) return;
    this.#pending.delete(pending.backendInteractionId);
    if (
      this.#pendingByNativeRequest.get(
        generationRequestKey(pending.generation, pending.nativeRequestKey),
      ) === pending.backendInteractionId
    ) {
      this.#pendingByNativeRequest.delete(
        generationRequestKey(pending.generation, pending.nativeRequestKey),
      );
    }
    pending.removeAbortListener();
    this.#emit({
      type: "interaction_resolved",
      backendInteractionId: pending.backendInteractionId,
    });
    if (!pending.handlerSettled) {
      pending.handlerSettled = true;
      pending.reject(
        handlerError ??
          new CodexInteractionBridgeError(
            "codex_interaction_route_aborted",
            true,
          ),
      );
    }
  }

  #markResponseUnknown(
    interactionId: string,
    code: string,
    pending?: PendingInteraction,
  ): void {
    const observed = this.#responses.get(interactionId);
    if (observed?.state === "unconfirmed" || observed?.state === "uncertain") {
      const wasUnconfirmed = observed.state === "unconfirmed";
      observed.state = "unknown";
      if (observed.timeout) clearTimeout(observed.timeout);
      observed.timeout = undefined;
      if (wasUnconfirmed) {
        observed.rejectConfirmation(
          new CodexInteractionBridgeError(code, true),
        );
      }
      observed.resolveLateReconciliation({ outcome: "unknown" });
    }
    if (pending) {
      this.#finishPending(
        pending,
        pending.request.signal.reason instanceof Error
          ? pending.request.signal.reason
          : undefined,
      );
    }
  }

  #markResponseUncertain(
    interactionId: string,
    pending: PendingInteraction,
    code: string,
  ): void {
    const observed = this.#responses.get(interactionId);
    if (observed?.state === "unconfirmed") {
      observed.state = "uncertain";
      observed.rejectConfirmation(
        new CodexInteractionBridgeError(
          code,
          true,
          observed.lateReconciliation,
        ),
      );
    }
    this.#finishPending(
      pending,
      pending.request.signal.reason instanceof Error
        ? pending.request.signal.reason
        : undefined,
    );
  }

  #markGenerationResponsesUnknown(generation: number, code: string): void {
    for (const [interactionId, observed] of this.#responses) {
      if (observed.generation === generation) {
        this.#markResponseUnknown(interactionId, code);
      }
    }
  }

  #rememberResponse(
    interactionId: string,
    observation: ResponseObservation,
  ): void {
    if (
      !this.#responses.has(interactionId) &&
      this.#responses.size >= MAXIMUM_RECONCILIATION_RECORDS
    ) {
      const evictable = [...this.#responses].find(
        ([, response]) =>
          response.state === "accepted" || response.state === "unknown",
      )?.[0];
      if (!evictable) {
        throw new CodexInteractionBridgeError(
          "codex_interaction_response_capacity_exceeded",
        );
      }
      this.#responses.delete(evictable);
    }
    this.#responses.set(interactionId, observation);
  }
}

function presentRequest(
  request: CodexRoutedServerRequest,
  backendInteractionId: string,
  now: () => number,
): {
  readonly interaction: DriverInteraction;
  readonly toProviderResponse: (input: InteractionResponseInput) => unknown;
} {
  const base = {
    backendInteractionId,
    sourceLabel: display("Codex"),
    openedAt: openedAt(request, now),
    secret: false,
    destructive: false,
    cancellable: true,
  };
  switch (request.method) {
    case "execCommandApproval": {
      return {
        interaction: parseInteraction({
          ...base,
          kind: "decision",
          title: display("Command approval"),
          message: approvalDetail([
            request.params.reason,
            request.params.cwd
              ? `Working directory: ${request.params.cwd}`
              : undefined,
          ]),
          code:
            request.params.command.length > 0
              ? approvalCode(JSON.stringify(request.params.command))
              : undefined,
          destructive: true,
          actions: [
            action("accept", "Approve once", "primary"),
            action("acceptForSession", "Approve for session", "alternative"),
            action("decline", "Deny", "reject"),
          ],
        }),
        toProviderResponse: legacyApprovalResponse,
      };
    }
    case "applyPatchApproval":
      return {
        interaction: parseInteraction({
          ...base,
          kind: "decision",
          title: display("File-change approval"),
          message: approvalDetail([
            request.params.reason,
            `Files: ${JSON.stringify(Object.keys(request.params.fileChanges))}`,
            request.params.grantRoot
              ? `Requested root: ${request.params.grantRoot}`
              : undefined,
          ]),
          destructive: true,
          actions: [
            action("accept", "Approve once", "primary"),
            action("acceptForSession", "Approve for session", "alternative"),
            action("decline", "Deny", "reject"),
          ],
        }),
        toProviderResponse: legacyApprovalResponse,
      };
    case "item/commandExecution/requestApproval": {
      const writeStdin = request.params.kind === "writeStdin";
      if (
        writeStdin &&
        (request.params.availableDecisions?.length !== 2 ||
          request.params.availableDecisions[0] !== "accept" ||
          request.params.availableDecisions[1] !== "cancel")
      ) {
        throw new CodexInteractionBridgeError(
          "codex_write_stdin_approval_shape_invalid",
        );
      }
      const decisions =
        request.params.availableDecisions ?? defaultCommandDecisions(request);
      const choices = commandDecisionChoices(decisions);
      return {
        interaction: parseInteraction({
          ...base,
          kind: "decision",
          title: display(
            writeStdin ? "Terminal input approval" : "Command approval",
          ),
          message: approvalDetail([
            request.params.reason,
            request.params.cwd
              ? `Working directory: ${request.params.cwd}`
              : undefined,
            writeStdin && request.params.additionalPermissions
              ? `Requested permissions: ${JSON.stringify(request.params.additionalPermissions)}`
              : undefined,
          ]),
          code: approvalCode(
            request.params.command ??
              request.params.commandActions
                ?.map(({ command }) => command)
                .join("\n"),
          ),
          destructive: true,
          cancellable: false,
          actions: choices.map((choice) =>
            action(choice.id, choice.label, choice.role, choice.description),
          ),
        }),
        toProviderResponse: (input) => {
          const selected = selectedDecision(
            input,
            choices.map(({ id }) => id),
          );
          return {
            decision: choices.find(({ id }) => id === selected)!.decision,
          };
        },
      };
    }
    case "item/fileChange/requestApproval":
      return {
        interaction: parseInteraction({
          ...base,
          kind: "decision",
          title: display("File-change approval"),
          message: approvalDetail([
            request.params.reason,
            request.params.grantRoot
              ? `Requested root: ${request.params.grantRoot}`
              : undefined,
          ]),
          destructive: true,
          cancellable: false,
          actions: [
            action("accept", "Approve once", "primary"),
            action("acceptForSession", "Approve for session", "alternative"),
            action("decline", "Deny", "reject"),
            action("cancel", "Cancel turn", "reject"),
          ],
        }),
        toProviderResponse: (input) => ({
          decision: selectedDecision(input, [
            "accept",
            "acceptForSession",
            "decline",
            "cancel",
          ]),
        }),
      };
    case "item/permissions/requestApproval":
      return {
        interaction: parseInteraction({
          ...base,
          kind: "decision",
          title: display("Permission approval"),
          message: approvalDetail([
            request.params.reason,
            `Working directory: ${request.params.cwd}`,
            permissionDetail(request.params.permissions),
          ]),
          destructive: true,
          cancellable: false,
          actions: [
            action("turn", "Grant for this turn", "primary"),
            action("session", "Grant for this session", "alternative"),
            action("deny", "Deny", "reject"),
          ],
        }),
        toProviderResponse: (input) => {
          if (input.kind === "cancel") {
            return {
              permissions: {},
              scope: "turn",
            };
          }
          const scope = selectedDecision(input, ["turn", "session", "deny"]);
          if (scope === "deny") {
            return {
              permissions: {},
              scope: "turn",
            };
          }
          return {
            permissions: {
              ...(request.params.permissions.network
                ? { network: request.params.permissions.network }
                : {}),
              ...(request.params.permissions.fileSystem
                ? { fileSystem: request.params.permissions.fileSystem }
                : {}),
            },
            scope,
          };
        },
      };
    case "item/tool/requestUserInput":
      return presentUserInput(request, base);
    case "mcpServer/elicitation/request":
      return presentMcpElicitation(request, base);
  }
}

function defaultCommandDecisions(
  request: CommandApprovalRequest,
): CommandApprovalDecision[] {
  const decisions: CommandApprovalDecision[] = [...DEFAULT_COMMAND_DECISIONS];
  if (
    request.params.proposedExecpolicyAmendment &&
    request.params.proposedExecpolicyAmendment.length > 0
  ) {
    decisions.push({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: request.params.proposedExecpolicyAmendment,
      },
    });
  }
  for (const amendment of request.params.proposedNetworkPolicyAmendments ??
    []) {
    decisions.push({
      applyNetworkPolicyAmendment: {
        network_policy_amendment: amendment,
      },
    });
  }
  return decisions;
}

function legacyApprovalResponse(input: InteractionResponseInput): unknown {
  if (input.kind === "cancel") return { decision: "abort" };
  const selection = selectedDecision(input, [
    "accept",
    "acceptForSession",
    "decline",
  ]);
  switch (selection) {
    case "accept":
      return { decision: "approved" };
    case "acceptForSession":
      return { decision: "approved_for_session" };
    case "decline":
      return {
        decision: { denied: { rejection: "Denied by the user." } },
      };
  }
}

function commandDecisionChoices(
  decisions: ReadonlyArray<CommandApprovalDecision>,
): CommandDecisionChoice[] {
  const seen = new Set<string>();
  const choices: CommandDecisionChoice[] = [];
  decisions.forEach((decision, index) => {
    const fingerprint = JSON.stringify(decision);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    if (decision === "cancel") {
      choices.push({
        id: "cancel",
        label: "Cancel turn",
        role: "reject",
        decision,
      });
      return;
    }
    if (decision === "accept") {
      choices.push({
        id: "accept",
        label: "Approve once",
        role: "primary",
        decision,
      });
      return;
    }
    if (decision === "acceptForSession") {
      choices.push({
        id: "acceptForSession",
        label: "Approve for session",
        role: "alternative",
        decision,
      });
      return;
    }
    if (decision === "decline") {
      choices.push({ id: "decline", label: "Deny", role: "reject", decision });
      return;
    }
    if ("acceptWithExecpolicyAmendment" in decision) {
      choices.push({
        id: `acceptWithExecpolicyAmendment:${index}`,
        label: "Approve and remember similar commands",
        description: execPolicyAmendmentDescription(
          decision.acceptWithExecpolicyAmendment.execpolicy_amendment,
        ),
        role: "alternative",
        decision,
      });
      return;
    }
    const amendment =
      decision.applyNetworkPolicyAmendment.network_policy_amendment;
    const networkLabel =
      amendment.action === "allow"
        ? `Approve and always allow ${amendment.host}`
        : `Deny and always block ${amendment.host}`;
    const networkDescription = `${amendment.action === "allow" ? "Allow" : "Block"} network access to host: ${amendment.host}`;
    requireExactDisplay(networkLabel);
    requireExactDisplay(networkDescription);
    choices.push({
      id: `applyNetworkPolicyAmendment:${index}`,
      label: networkLabel,
      description: networkDescription,
      role: amendment.action === "allow" ? "alternative" : "reject",
      decision,
    });
  });
  return choices;
}

function presentUserInput(
  request: Extract<
    CodexRoutedServerRequest,
    { readonly method: "item/tool/requestUserInput" }
  >,
  base: Omit<DriverInteraction, "kind" | "title">,
): ReturnType<typeof presentRequest> {
  const questions = request.params.questions;
  const mappedQuestions = questions.map((question, questionIndex) => {
    const input =
      question.options && question.options.length > 0
        ? {
            kind: "single_choice" as const,
            options: question.options.map((item, optionIndex) => ({
              backendOptionId: questionnaireOptionId(
                questionIndex,
                optionIndex,
              ),
              label: exactDisplay(item.label),
              description: exactDisplay(item.description),
            })),
            ...(question.isOther
              ? {
                  other: {
                    backendOptionId: questionnaireOtherOptionId(questionIndex),
                    label: exactDisplay(CODEX_OTHER_OPTION_LABEL),
                    description: exactDisplay("Add details in a note."),
                  },
                }
              : {}),
            allowNote: true,
          }
        : {
            // No placeholder: Codex has no field distinct from the question
            // itself, and echoing the prompt into the input renders it twice.
            kind: "text" as const,
            multiline: true,
          };
    return {
      backendQuestionId: question.id,
      header: exactDisplay(question.header || "Question"),
      prompt: exactDisplay(question.question),
      secret: question.isSecret,
      input,
    };
  });
  return {
    interaction: parseInteraction({
      ...base,
      kind: "questionnaire",
      title: display("Questions"),
      secret: questions.some(({ isSecret }) => isSecret),
      cancellable: false,
      questions: mappedQuestions,
    }),
    toProviderResponse: (input) => ({
      answers: questionnaireResponse(input, questions),
    }),
  };
}

function presentMcpElicitation(
  request: Extract<
    CodexRoutedServerRequest,
    { readonly method: "mcpServer/elicitation/request" }
  >,
  base: Omit<DriverInteraction, "kind" | "title">,
): ReturnType<typeof presentRequest> {
  if (
    request.params.mode === "openaiForm" ||
    request.params.mode === "openai/form"
  ) {
    throw new CodexInteractionBridgeError(
      "codex_mcp_openai_elicitation_unadvertised",
    );
  }
  // Codex supplies these arguments on the approval itself. Do not infer an
  // association from a nearby tool item: parallel calls can share a server.
  const metadata = request.params._meta;
  if (
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    metadata.codex_approval_kind === "mcp_tool_call" &&
    Object.hasOwn(metadata, "tool_params")
  ) {
    base = {
      ...base,
      invocation: { arguments: boundValue(metadata.tool_params) },
    };
  }
  if (request.params.mode === "url") {
    return {
      interaction: parseInteraction({
        ...base,
        kind: "confirmation",
        title: display(`Continue with ${request.params.serverName}?`),
        message: text(`${request.params.message}\n\n${request.params.url}`),
        confirmLabel: display("Continue"),
        cancelLabel: display("Decline"),
      }),
      toProviderResponse: (input) => ({
        action:
          input.kind === "cancel"
            ? "cancel"
            : confirmationResponse(input)
              ? "accept"
              : "decline",
        content: null,
        _meta: null,
      }),
    };
  }
  const form = normalizeCodexElicitationForm(request.params.requestedSchema);
  if (form.fields.length === 0) {
    return {
      interaction: parseInteraction({
        ...base,
        kind: "confirmation",
        title: display(request.params.message),
        message: text(""),
        confirmLabel: display("Allow"),
        cancelLabel: display("Cancel"),
      }),
      toProviderResponse: (input) => ({
        action:
          input.kind === "cancel"
            ? "cancel"
            : confirmationResponse(input)
              ? "accept"
              : "decline",
        content:
          input.kind !== "cancel" && confirmationResponse(input) ? {} : null,
        _meta: null,
      }),
    };
  }
  return {
    interaction: parseInteraction({
      ...base,
      kind: "form",
      title: display(request.params.message),
      fields: form.fields,
    }),
    toProviderResponse: (input) => {
      if (input.kind === "cancel")
        return { action: "cancel", content: null, _meta: null };
      if (input.kind !== "form")
        throw new CodexInteractionBridgeError(
          "codex_mcp_elicitation_response_invalid",
        );
      return {
        action: "accept",
        content: form.content(input.answers),
        _meta: null,
      };
    },
  };
}

function selectedChoice(
  input: InteractionResponseInput,
  allowed: readonly string[],
): string {
  if (input.kind === "cancel") {
    if (allowed.includes("cancel")) return "cancel";
    throw new CodexInteractionBridgeError(
      "codex_interaction_cancellation_unsupported",
    );
  }
  if (
    input.kind !== "choice" ||
    input.selectedOptionIds.length !== 1 ||
    !allowed.includes(input.selectedOptionIds[0]!)
  ) {
    throw new CodexInteractionBridgeError("codex_interaction_choice_invalid");
  }
  return input.selectedOptionIds[0]!;
}

function selectedDecision(
  input: InteractionResponseInput,
  allowed: readonly string[],
): string {
  if (input.kind === "cancel") {
    if (allowed.includes("cancel")) return "cancel";
    throw new CodexInteractionBridgeError(
      "codex_interaction_cancellation_unsupported",
    );
  }
  if (input.kind !== "decision" || !allowed.includes(input.selectedActionId)) {
    throw new CodexInteractionBridgeError("codex_interaction_decision_invalid");
  }
  return input.selectedActionId;
}

function textResponse(input: InteractionResponseInput): string {
  if (input.kind !== "text_input" && input.kind !== "editor") {
    throw new CodexInteractionBridgeError(
      "codex_interaction_text_response_invalid",
    );
  }
  return input.value;
}

function confirmationResponse(input: InteractionResponseInput): boolean {
  if (input.kind !== "confirmation") {
    throw new CodexInteractionBridgeError(
      "codex_interaction_confirmation_invalid",
    );
  }
  return input.confirmed;
}

function questionnaireResponse(
  input: InteractionResponseInput,
  questions: Extract<
    CodexRoutedServerRequest,
    { readonly method: "item/tool/requestUserInput" }
  >["params"]["questions"],
): Record<string, { readonly answers: readonly string[] }> {
  if (
    input.kind !== "questionnaire" ||
    input.answers.length !== questions.length
  ) {
    throw new CodexInteractionBridgeError(
      "codex_interaction_questionnaire_response_invalid",
    );
  }
  const answers: Array<
    readonly [string, { readonly answers: readonly string[] }]
  > = [];
  for (const [questionIndex, question] of questions.entries()) {
    const response = input.answers[questionIndex];
    if (!response || response.questionId !== question.id) {
      throw new CodexInteractionBridgeError(
        "codex_interaction_questionnaire_question_invalid",
      );
    }
    const answer = response.answer;
    if (answer.kind === "unanswered") {
      answers.push([question.id, { answers: [] }]);
      continue;
    }
    const options = question.options;
    if (answer.kind === "text") {
      if (options && options.length > 0) {
        throw new CodexInteractionBridgeError(
          "codex_interaction_questionnaire_answer_kind_invalid",
        );
      }
      const value = answer.value.trim();
      answers.push([
        question.id,
        { answers: value ? [`${CODEX_USER_NOTE_PREFIX}${value}`] : [] },
      ]);
      continue;
    }
    if (!options || options.length === 0) {
      throw new CodexInteractionBridgeError(
        "codex_interaction_questionnaire_answer_kind_invalid",
      );
    }
    const nativeAnswers: string[] = [];
    const otherId = questionnaireOtherOptionId(questionIndex);
    if (answer.selectedOptionId === otherId) {
      if (!question.isOther) {
        throw new CodexInteractionBridgeError(
          "codex_interaction_questionnaire_option_invalid",
        );
      }
      nativeAnswers.push(CODEX_OTHER_OPTION_LABEL);
    } else {
      const prefix = `question:${questionIndex}:option:`;
      if (!answer.selectedOptionId.startsWith(prefix)) {
        throw new CodexInteractionBridgeError(
          "codex_interaction_questionnaire_option_invalid",
        );
      }
      const optionIndexText = answer.selectedOptionId.slice(prefix.length);
      if (!/^\d+$/.test(optionIndexText)) {
        throw new CodexInteractionBridgeError(
          "codex_interaction_questionnaire_option_invalid",
        );
      }
      const option = options[Number(optionIndexText)];
      if (!option) {
        throw new CodexInteractionBridgeError(
          "codex_interaction_questionnaire_option_invalid",
        );
      }
      nativeAnswers.push(option.label);
    }
    const note = answer.note?.trim();
    if (note) nativeAnswers.push(`${CODEX_USER_NOTE_PREFIX}${note}`);
    answers.push([question.id, { answers: nativeAnswers }]);
  }
  // Object.fromEntries defines own data properties, so provider-controlled
  // question IDs such as "__proto__" cannot invoke Object.prototype setters.
  return Object.fromEntries(answers);
}

function questionnaireOptionId(
  questionIndex: number,
  optionIndex: number,
): string {
  return `question:${questionIndex}:option:${optionIndex}`;
}

function questionnaireOtherOptionId(questionIndex: number): string {
  return `question:${questionIndex}:other`;
}

function interactionId(request: CodexRoutedServerRequest): string {
  return `codex:${request.generation}:${createHash("sha256")
    .update(request.method)
    .update("\0")
    .update(nativeRequestKey(request.requestId))
    .digest("base64url")}`;
}

function nativeRequestKey(requestId: string | number): string {
  return `${typeof requestId === "string" ? "s" : "n"}:${String(requestId)}`;
}

function generationRequestKey(generation: number, requestKey: string): string {
  return `${generation}\0${requestKey}`;
}

function responseObservation(input: {
  readonly fingerprint: string;
  readonly secret: boolean;
  readonly nativeRequestKey: string;
  readonly generation: number;
}): ResponseObservation {
  let resolveConfirmation!: () => void;
  let rejectConfirmation!: (error: unknown) => void;
  let resolveLateReconciliation!: (
    outcome: BackendMutationReconciliation,
  ) => void;
  const confirmation = new Promise<void>((resolve, reject) => {
    resolveConfirmation = resolve;
    rejectConfirmation = reject;
  });
  // The bridge also observes this promise so generation loss cannot become an
  // unhandled rejection if a caller abandons its returned response promise.
  void confirmation.catch(() => undefined);
  const lateReconciliation = new Promise<BackendMutationReconciliation>(
    (resolve) => {
      resolveLateReconciliation = resolve;
    },
  );
  return {
    ...input,
    confirmation,
    resolveConfirmation,
    rejectConfirmation,
    lateReconciliation,
    resolveLateReconciliation,
    state: "unconfirmed",
  };
}

function responseFingerprint(
  input: InteractionResponseInput,
  secret: boolean,
): string {
  const fingerprintInput = secret
    ? {
        applicationOperationId: input.applicationOperationId,
        interactionId: input.interactionId,
        kind: input.kind,
      }
    : input;
  return createHash("sha256")
    .update(JSON.stringify(fingerprintInput))
    .digest("base64url");
}

function openedAt(
  request: CodexRoutedServerRequest,
  now: () => number,
): string {
  const candidate =
    "startedAtMs" in request.params ? request.params.startedAtMs : now();
  const date = new Date(candidate);
  return Number.isFinite(date.valueOf())
    ? date.toISOString()
    : new Date(now()).toISOString();
}

function parseInteraction(value: unknown): DriverInteraction {
  return driverInteractionSchema.parse(value);
}

function option(backendOptionId: string, label: string, description?: string) {
  return {
    backendOptionId,
    label: display(label),
    ...(description ? { description: display(description) } : {}),
  };
}

function action(
  backendActionId: string,
  label: string,
  role: "primary" | "alternative" | "reject",
  description?: string,
) {
  return {
    backendActionId,
    label: display(label),
    role,
    ...(description ? { description: display(description) } : {}),
  };
}

function approvalDetail(
  parts: ReadonlyArray<string | null | undefined>,
): ReturnType<typeof text> | undefined {
  const value = parts
    .filter((part): part is string => Boolean(part))
    .join("\n");
  if (value.length > MAXIMUM_PRESENTED_TEXT_CHARACTERS) {
    throw new CodexInteractionBridgeError(
      "codex_interaction_approval_detail_too_large",
    );
  }
  return value ? text(value) : undefined;
}

function approvalCode(
  value: string | null | undefined,
): ReturnType<typeof text> | undefined {
  if (!value) return undefined;
  if (value.length > MAXIMUM_PRESENTED_TEXT_CHARACTERS) {
    throw new CodexInteractionBridgeError(
      "codex_interaction_approval_detail_too_large",
    );
  }
  return text(value);
}

function execPolicyAmendmentDescription(tokens: readonly string[]): string {
  const description = `Remember commands matching: ${tokens
    .map((token) => JSON.stringify(token))
    .join(" ")}`;
  requireExactDisplay(description);
  return description;
}

function requireExactDisplay(value: string): void {
  if (value.length > 4_096) {
    throw new CodexInteractionBridgeError(
      "codex_interaction_policy_scope_too_large",
    );
  }
}

function exactDisplay(value: string): ReturnType<typeof display> {
  requireExactDisplay(value);
  return { text: value };
}

function permissionDetail(
  permissions: Extract<
    CodexRoutedServerRequest,
    { readonly method: "item/permissions/requestApproval" }
  >["params"]["permissions"],
): string {
  const parts: string[] = [];
  if (permissions.network) {
    parts.push(
      permissions.network.enabled === true
        ? "Network access: enabled"
        : permissions.network.enabled === false
          ? "Network access: disabled"
          : "Network access: provider default",
    );
  }
  const fileSystem = permissions.fileSystem;
  if (fileSystem) {
    if (fileSystem.read?.length) {
      parts.push(`Read access: ${fileSystem.read.join(", ")}`);
    }
    if (fileSystem.write?.length) {
      parts.push(`Write access: ${fileSystem.write.join(", ")}`);
    }
    for (const entry of fileSystem.entries ?? []) {
      const path =
        entry.path.type === "path"
          ? entry.path.path
          : entry.path.type === "glob_pattern"
            ? entry.path.pattern
            : entry.path.value.kind === "unknown"
              ? [entry.path.value.path, entry.path.value.subpath]
                  .filter(Boolean)
                  .join("/")
              : entry.path.value.kind === "project_roots"
                ? ["project roots", entry.path.value.subpath]
                    .filter(Boolean)
                    .join("/")
                : entry.path.value.kind.replaceAll("_", " ");
      parts.push(
        `${entry.access[0]!.toUpperCase()}${entry.access.slice(1)} access: ${path}`,
      );
    }
  }
  return parts.length > 0
    ? parts.join("\n")
    : "No additional permissions requested";
}

function display(value: string) {
  return { text: value.slice(0, 4_096) };
}

function text(value: string) {
  return { text: value.slice(0, MAXIMUM_PRESENTED_TEXT_CHARACTERS) };
}
