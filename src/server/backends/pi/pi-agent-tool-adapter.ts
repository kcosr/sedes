import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
  BackendAgentToolRequestError,
  type BackendAgentToolFacade,
  type TrustedAgentToolSource,
} from "../../agent-tools/adapters/backend-facade.js";
import type {
  AgentToolCatalogSummary,
  AgentToolContractArtifact,
  AgentToolDescription,
  SedesToolInvocationResult,
  SedesToolProgress,
} from "../../agent-tools/contracts/agent-tool-contracts.js";
import { compileCanonicalAgentToolSchema } from "../../agent-tools/schema/canonical-json-schema.js";
import { deterministicJson } from "../../canonical-json.js";
import {
  createPiAgentToolInvocationMarker,
  isPiAgentToolInvocationMarkerType,
  piAgentToolInvocationMarkerType,
  readPiAgentToolInvocationMarker,
} from "./pi-agent-tool-invocation-marker.js";
import type {
  TrustedPiAgentToolDescriptor,
  TrustedPiAgentToolGatewayDescriptor,
  TrustedPiAgentToolRegistration,
} from "./pi-tool-identities.js";
import type { PiToolAccessController } from "./pi-tool-access.js";
import type {
  PiAgentToolApprovalResolver,
  PiAgentToolApprovalRecorder,
  PiResolvedAgentToolApproval,
} from "./pi-tool-approval-extension.js";
import {
  findPiToolCallAssistantEntryId,
  type PiToolIdentityAuthentication,
} from "./pi-tool-identity-marker.js";

export interface PiAgentToolSet {
  readonly tools: readonly ToolDefinition[];
  readonly descriptors: readonly TrustedPiAgentToolRegistration[];
  readonly resolveApproval: PiAgentToolApprovalResolver;
  readonly recordApproval: PiAgentToolApprovalRecorder;
  readonly refreshProgressiveSnapshot: (
    policy: ReturnType<BackendAgentToolFacade["readPolicy"]>,
    accessMode: PiToolAccessController["mode"],
  ) => void;
}

export interface CreatePiAgentToolSetInput {
  readonly facade: BackendAgentToolFacade;
  readonly source: TrustedAgentToolSource;
  readonly manager: SessionManager;
  readonly authentication: PiToolIdentityAuthentication;
  readonly providerTurnCorrelation: () => string | undefined;
  readonly toolAccess: PiToolAccessController;
}

const reservedToolNamePattern = /^sedes_[a-z][a-z0-9_]{0,119}$/;

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function exactPiPresentation(
  artifact: AgentToolContractArtifact,
): NonNullable<AgentToolContractArtifact["adapters"]["pi"]> {
  const presentation = artifact.adapters.pi;
  if (
    artifact.artifactVersion !== 2 ||
    !artifact.exposure.adapters.includes("pi_sdk") ||
    !presentation ||
    !reservedToolNamePattern.test(presentation.name)
  ) {
    throw new Error("pi_agent_tool_catalog_invalid");
  }
  return presentation;
}

function currentInvocationLocation(
  manager: SessionManager,
  toolCallId: string,
  toolName: string,
  providerTurnCorrelation: string | undefined,
): {
  readonly assistantEntryId: string;
  readonly providerTurnCorrelation: string;
} {
  const branch = manager.getBranch();
  const assistantEntryId = findPiToolCallAssistantEntryId(
    branch,
    toolCallId,
    toolName,
  );
  if (!assistantEntryId) {
    throw new Error("pi_agent_tool_call_correlation_missing");
  }
  const assistantIndex = branch.findIndex(
    (entry) => entry.id === assistantEntryId,
  );
  const providerTurnIndex = branch.findIndex(
    (entry) =>
      entry.id === providerTurnCorrelation &&
      entry.type === "message" &&
      entry.message.role === "user",
  );
  if (
    assistantIndex < 0 ||
    providerTurnIndex < 0 ||
    providerTurnIndex >= assistantIndex ||
    !providerTurnCorrelation
  ) {
    throw new Error("pi_agent_tool_provider_turn_correlation_missing");
  }
  return {
    assistantEntryId,
    providerTurnCorrelation,
  };
}

function writeInvocationMarker(
  input: CreatePiAgentToolSetInput,
  artifact: Pick<AgentToolContractArtifact, "id" | "schemaVersion">,
  toolName: string,
  toolCallId: string,
  invocationId: string,
  assistantEntryId: string,
): void {
  const matchingEntries = input.manager.getBranch().filter((entry) => {
    if (
      entry.type !== "custom" ||
      !isPiAgentToolInvocationMarkerType(entry.customType)
    ) {
      return false;
    }
    return (
      own(entry.data, "assistantEntryId") === assistantEntryId &&
      own(entry.data, "toolCallId") === toolCallId
    );
  });
  if (matchingEntries.length > 0) {
    if (matchingEntries.length === 1) {
      const result = readPiAgentToolInvocationMarker(
        matchingEntries[0]!,
        input.authentication,
      );
      if (
        result.status === "authenticated" &&
        result.marker.toolName === toolName &&
        result.marker.toolId === artifact.id &&
        result.marker.schemaVersion === artifact.schemaVersion &&
        result.marker.invocationId === invocationId
      ) {
        return;
      }
    }
    throw new Error("pi_agent_tool_invocation_marker_conflict");
  }
  input.manager.appendCustomEntry(
    piAgentToolInvocationMarkerType,
    createPiAgentToolInvocationMarker(
      {
        assistantEntryId,
        toolCallId,
        toolName,
        toolId: artifact.id,
        schemaVersion: artifact.schemaVersion,
        invocationId,
      },
      input.authentication,
    ),
  );
}

const gatewayEnvelopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["toolId", "schemaVersion", "input"],
  properties: {
    toolId: { type: "string", minLength: 1, maxLength: 128 },
    schemaVersion: { type: "integer", minimum: 1, maximum: 1_000_000 },
    input: { type: "object" },
  },
} as const;

const gatewayCatalogSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: { action: { const: "list" } },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "toolIds"],
      properties: {
        action: { const: "describe" },
        toolIds: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 128 },
        },
      },
    },
  ],
} as const;

interface GatewayEnvelope {
  readonly toolId: string;
  readonly schemaVersion: number;
  readonly input: Record<string, unknown>;
}

interface ResolvedGatewayEnvelope extends GatewayEnvelope {
  readonly description: AgentToolDescription;
  readonly fingerprint: string;
}

function safeUnavailable(): BackendAgentToolRequestError {
  return new BackendAgentToolRequestError({
    code: "not_found",
    message: "The requested Sedes tool is unavailable.",
    retryable: false,
  });
}

function isReadOnlyDescription(description: AgentToolDescription): boolean {
  return (
    description.effects.application === "read" &&
    description.effects.modelUsage === "none" &&
    description.effects.external === "none"
  );
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function parseGatewayEnvelope(value: unknown): GatewayEnvelope {
  if (!exactObject(value, ["toolId", "schemaVersion", "input"])) {
    throw safeUnavailable();
  }
  const { toolId, schemaVersion, input } = value;
  if (
    typeof toolId !== "string" ||
    !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(toolId) ||
    toolId.length > 128 ||
    !Number.isSafeInteger(schemaVersion) ||
    (schemaVersion as number) < 1 ||
    (schemaVersion as number) > 1_000_000 ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    throw safeUnavailable();
  }
  return {
    toolId,
    schemaVersion: schemaVersion as number,
    input: input as Record<string, unknown>,
  };
}

export function resolvePiProgressiveAgentToolEnvelope(
  setup: Pick<CreatePiAgentToolSetInput, "facade" | "source" | "toolAccess">,
  lane: "sedes_read" | "sedes_act",
  parameters: unknown,
): ResolvedGatewayEnvelope {
  const envelope = parseGatewayEnvelope(parameters);
  const policy = setup.facade.readPolicy(setup.source);
  if (
    !policy.enabled ||
    policy.presentation.surface !== "native" ||
    policy.presentation.mode !== "progressive" ||
    !policy.enabledToolIds.includes(envelope.toolId) ||
    (lane === "sedes_act" && setup.toolAccess.mode === "read_only")
  ) {
    throw safeUnavailable();
  }
  let description: AgentToolDescription | undefined;
  try {
    description = setup.facade.describeMany(setup.source, "pi_sdk", [
      envelope.toolId,
    ])[0];
  } catch {
    throw safeUnavailable();
  }
  if (
    !description ||
    description.id !== envelope.toolId ||
    description.schemaVersion !== envelope.schemaVersion ||
    (lane === "sedes_read") !== isReadOnlyDescription(description)
  ) {
    throw safeUnavailable();
  }
  const validator = compileCanonicalAgentToolSchema(description.inputSchema);
  if (!validator.check(envelope.input)) {
    throw new BackendAgentToolRequestError({
      code: "invalid_input",
      message: "The Sedes tool input is invalid.",
      retryable: false,
    });
  }
  const serializedInput = deterministicJson(envelope.input);
  if (
    Buffer.byteLength(serializedInput, "utf8") >
    description.execution.maximumInputBytes
  ) {
    throw new BackendAgentToolRequestError({
      code: "invalid_input",
      message: "The Sedes tool input is too large.",
      retryable: false,
    });
  }
  return Object.freeze({
    ...envelope,
    description,
    fingerprint: deterministicJson({
      lane,
      toolId: envelope.toolId,
      schemaVersion: envelope.schemaVersion,
      input: envelope.input,
      effects: description.effects,
    }),
  });
}

function progressResult(
  progress: SedesToolProgress,
): AgentToolResult<{ readonly progress: SedesToolProgress }> {
  return {
    content: [
      {
        type: "text",
        text: progress.message ?? `Sedes tool progress: ${progress.phase}`,
      },
    ],
    details: { progress },
  };
}

function completedResult(
  result: Extract<SedesToolInvocationResult<unknown>, { state: "completed" }>,
): AgentToolResult<{
  readonly invocation: SedesToolInvocationResult<unknown>;
}> {
  return {
    content: [{ type: "text", text: deterministicJson(result.output) }],
    details: { invocation: result },
  };
}

function operationResult(
  result: Extract<
    SedesToolInvocationResult<unknown>,
    { state: "accepted" | "running" | "waiting_for_input" | "cancel_requested" }
  >,
): AgentToolResult<{
  readonly invocation: SedesToolInvocationResult<unknown>;
}> {
  return {
    content: [
      {
        type: "text",
        text: deterministicJson({
          state: result.state,
          operationId: result.operationId,
          ...(result.retryAfterMilliseconds === undefined
            ? {}
            : { retryAfterMilliseconds: result.retryAfterMilliseconds }),
        }),
      },
    ],
    details: { invocation: result },
  };
}

function failure(
  result: Extract<
    SedesToolInvocationResult<unknown>,
    { state: "failed" | "uncertain" | "cancelled" }
  >,
): Error {
  const error = new Error(result.error.message);
  error.name = `SedesAgentToolError:${result.error.code}`;
  return error;
}

function safeInvocationRejection(cause: unknown): Error {
  if (cause instanceof BackendAgentToolRequestError) {
    const error = new Error(cause.toolError.message);
    error.name = `SedesAgentToolError:${cause.toolError.code}`;
    return error;
  }
  const error = new Error("The Sedes tool invocation could not be started.");
  error.name = "SedesAgentToolError:internal_error";
  return error;
}

function toolDefinition(
  input: CreatePiAgentToolSetInput,
  artifact: AgentToolContractArtifact,
): ToolDefinition {
  const presentation = exactPiPresentation(artifact);
  const validator = compileCanonicalAgentToolSchema(artifact.inputSchema);
  const validate = (value: unknown): Record<string, unknown> => {
    if (!validator.check(value)) {
      throw new Error("pi_agent_tool_input_invalid");
    }
    return value as Record<string, unknown>;
  };
  return {
    name: presentation.name,
    label: presentation.label,
    description: artifact.description,
    ...(presentation.promptSnippet
      ? { promptSnippet: presentation.promptSnippet }
      : {}),
    ...(presentation.promptGuidelines
      ? { promptGuidelines: [...presentation.promptGuidelines] }
      : {}),
    parameters: validator.schema as unknown as TSchema,
    prepareArguments: validate,
    executionMode: "sequential",
    async execute(
      toolCallId: string,
      parameters: unknown,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    ): Promise<AgentToolResult<unknown>> {
      if (!toolCallId || toolCallId.length > 256) {
        throw new Error("pi_agent_tool_call_id_invalid");
      }
      try {
        const policy = input.facade.readPolicy(input.source);
        const readOnly =
          artifact.effects.application === "read" &&
          artifact.effects.modelUsage === "none" &&
          artifact.effects.external === "none";
        if (
          !policy.enabled ||
          policy.presentation.surface !== "native" ||
          policy.presentation.mode !== "individual" ||
          !policy.enabledToolIds.includes(artifact.id) ||
          (!readOnly && input.toolAccess.mode === "read_only")
        ) {
          throw safeUnavailable();
        }
      } catch (cause) {
        throw safeInvocationRejection(cause);
      }
      const invocationLocation = currentInvocationLocation(
        input.manager,
        toolCallId,
        presentation.name,
        input.providerTurnCorrelation(),
      );
      const validatedParameters = validate(parameters);
      const abortSignal = signal ?? new AbortController().signal;
      let result: SedesToolInvocationResult<unknown>;
      try {
        result = await input.facade.invoke({
          source: input.source,
          adapter: "pi_sdk",
          request: {
            toolId: artifact.id,
            schemaVersion: artifact.schemaVersion,
            requestId: toolCallId,
            input: validatedParameters,
          },
          signal: abortSignal,
          onInvocationStarted: (invocationId) => {
            writeInvocationMarker(
              input,
              artifact,
              presentation.name,
              toolCallId,
              invocationId,
              invocationLocation.assistantEntryId,
            );
          },
          onProgress: (progress) => {
            writeInvocationMarker(
              input,
              artifact,
              presentation.name,
              toolCallId,
              progress.invocationId,
              invocationLocation.assistantEntryId,
            );
            onUpdate?.(progressResult(progress));
          },
        });
      } catch (cause) {
        throw safeInvocationRejection(cause);
      }
      writeInvocationMarker(
        input,
        artifact,
        presentation.name,
        toolCallId,
        result.invocationId,
        invocationLocation.assistantEntryId,
      );
      switch (result.state) {
        case "completed":
          return completedResult(result);
        case "accepted":
        case "running":
        case "waiting_for_input":
        case "cancel_requested":
          return operationResult(result);
        case "failed":
        case "uncertain":
        case "cancelled":
          throw failure(result);
      }
    },
  };
}

function gatewayCatalogInput(
  value: unknown,
):
  | { readonly action: "list" }
  | { readonly action: "describe"; readonly toolIds: readonly string[] } {
  if (exactObject(value, ["action"]) && value.action === "list") {
    return { action: "list" };
  }
  if (
    exactObject(value, ["action", "toolIds"]) &&
    value.action === "describe" &&
    Array.isArray(value.toolIds) &&
    value.toolIds.length >= 1 &&
    value.toolIds.length <= 16 &&
    new Set(value.toolIds).size === value.toolIds.length &&
    value.toolIds.every(
      (toolId) =>
        typeof toolId === "string" &&
        toolId.length <= 128 &&
        /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(toolId),
    )
  ) {
    return { action: "describe", toolIds: value.toolIds as string[] };
  }
  throw new BackendAgentToolRequestError({
    code: "invalid_input",
    message: "The Sedes catalog request is invalid.",
    retryable: false,
  });
}

function catalogGatewayDefinition(
  input: CreatePiAgentToolSetInput,
  readSnapshot: () => readonly AgentToolCatalogSummary[] | undefined,
): ToolDefinition {
  return {
    name: "sedes_catalog",
    label: "Sedes tool catalog",
    description:
      "Discover the current policy-filtered Sedes operation catalog: list it first, then describe up to 16 selected operation IDs before invoking them.",
    promptGuidelines: [
      "Use action=list to read the current catalog, then action=describe for the selected operation IDs. Treat each described tool ID, schema version, effects, and input schema as authoritative.",
      "Invoke exactly one described side-effect-free read through sedes_read, or exactly one described write, destructive, model-usage, or external-side-effect operation through sedes_act.",
      "Omit a scope field only when its described schema says what source context supplies by default. Inventory is principal-global within this Sedes installation, workspaces may map to different configured execution environments, and there is no cross-server discovery bus.",
    ],
    parameters: gatewayCatalogSchema as unknown as TSchema,
    prepareArguments: gatewayCatalogInput,
    executionMode: "sequential",
    async execute(_toolCallId, parameters): Promise<AgentToolResult<unknown>> {
      try {
        const request = gatewayCatalogInput(parameters);
        const summaries = readSnapshot();
        if (!summaries) throw safeUnavailable();
        const tools =
          request.action === "list"
            ? summaries
            : (() => {
                const availableIds = new Set(summaries.map(({ id }) => id));
                if (
                  request.toolIds.some((toolId) => !availableIds.has(toolId))
                ) {
                  throw safeUnavailable();
                }
                return input.facade.describeMany(
                  input.source,
                  "pi_sdk",
                  request.toolIds,
                );
              })();
        return {
          content: [{ type: "text", text: deterministicJson({ tools }) }],
          details: { discovery: { action: request.action, tools } },
        };
      } catch (cause) {
        throw safeInvocationRejection(cause);
      }
    },
  };
}

function executionGatewayDefinition(
  input: CreatePiAgentToolSetInput,
  lane: "sedes_read" | "sedes_act",
  takeApproval: (toolCallId: string) => string | undefined,
): ToolDefinition {
  return {
    name: lane,
    label: lane === "sedes_read" ? "Run Sedes read" : "Run Sedes action",
    description:
      lane === "sedes_read"
        ? "Invoke exactly one side-effect-free Sedes read from the current catalog using its exact described tool ID, schema version, and input schema."
        : "Invoke exactly one Sedes write, destructive, model-usage, or external-side-effect operation from the current catalog using its exact described tool ID, schema version, and input schema.",
    promptGuidelines: [
      "First use sedes_catalog to list the current catalog and describe the selected operation. Do not guess a tool ID, schema version, input field, or remembered contract.",
      lane === "sedes_read"
        ? "Use this lane only when the described effects are application=read, modelUsage=none, and external=none."
        : "Use this lane when any described effect can change application state, use a model, or produce an external side effect.",
    ],
    parameters: gatewayEnvelopeSchema as unknown as TSchema,
    prepareArguments: parseGatewayEnvelope,
    executionMode: "sequential",
    async execute(
      toolCallId: string,
      parameters: unknown,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    ): Promise<AgentToolResult<unknown>> {
      if (!toolCallId || toolCallId.length > 256) {
        throw new Error("pi_agent_tool_call_id_invalid");
      }
      const approvedFingerprint =
        lane === "sedes_act" ? takeApproval(toolCallId) : undefined;
      const invocationLocation = currentInvocationLocation(
        input.manager,
        toolCallId,
        lane,
        input.providerTurnCorrelation(),
      );
      let resolved: ResolvedGatewayEnvelope;
      let result: SedesToolInvocationResult<unknown>;
      try {
        resolved = resolvePiProgressiveAgentToolEnvelope(
          input,
          lane,
          parameters,
        );
        if (
          lane === "sedes_act" &&
          input.toolAccess.mode === "ask" &&
          approvedFingerprint !== resolved.fingerprint
        ) {
          throw safeUnavailable();
        }
        result = await input.facade.invoke({
          source: input.source,
          adapter: "pi_sdk",
          request: {
            toolId: resolved.toolId,
            schemaVersion: resolved.schemaVersion,
            requestId: toolCallId,
            input: resolved.input,
          },
          signal: signal ?? new AbortController().signal,
          onInvocationStarted: (invocationId) => {
            writeInvocationMarker(
              input,
              resolved.description,
              lane,
              toolCallId,
              invocationId,
              invocationLocation.assistantEntryId,
            );
          },
          onProgress: (progress) => {
            writeInvocationMarker(
              input,
              resolved.description,
              lane,
              toolCallId,
              progress.invocationId,
              invocationLocation.assistantEntryId,
            );
            onUpdate?.(progressResult(progress));
          },
        });
      } catch (cause) {
        throw safeInvocationRejection(cause);
      }
      writeInvocationMarker(
        input,
        resolved.description,
        lane,
        toolCallId,
        result.invocationId,
        invocationLocation.assistantEntryId,
      );
      switch (result.state) {
        case "completed":
          return completedResult(result);
        case "accepted":
        case "running":
        case "waiting_for_input":
        case "cancel_requested":
          return operationResult(result);
        case "failed":
        case "uncertain":
        case "cancelled":
          throw failure(result);
      }
    },
  };
}

export function createPiAgentToolSet(
  input: CreatePiAgentToolSetInput,
): PiAgentToolSet {
  const artifacts = input.facade.eligibleCatalog("pi_sdk");
  const names = new Set<string>();
  const contracts = new Set<string>();
  const tools: ToolDefinition[] = [];
  const descriptors: TrustedPiAgentToolRegistration[] = [];
  let progressiveSnapshot: readonly AgentToolCatalogSummary[] | undefined;
  const approvedActions = new Map<string, string>();
  const takeApproval = (toolCallId: string): string | undefined => {
    const approved = approvedActions.get(toolCallId);
    approvedActions.delete(toolCallId);
    return approved;
  };
  for (const artifact of artifacts) {
    const presentation = exactPiPresentation(artifact);
    const contract = `${artifact.id}@${artifact.schemaVersion}`;
    if (
      names.has(presentation.name) ||
      presentation.name === "sedes_catalog" ||
      presentation.name === "sedes_read" ||
      presentation.name === "sedes_act" ||
      contracts.has(contract)
    ) {
      throw new Error("pi_agent_tool_catalog_ambiguous");
    }
    names.add(presentation.name);
    contracts.add(contract);
    tools.push(toolDefinition(input, artifact));
    descriptors.push({
      toolName: presentation.name,
      toolId: artifact.id,
      schemaVersion: artifact.schemaVersion,
      displayName: presentation.label,
      readOnly:
        artifact.effects.application === "read" &&
        artifact.effects.modelUsage === "none" &&
        artifact.effects.external === "none",
    });
  }
  const gatewayDescriptors: readonly TrustedPiAgentToolGatewayDescriptor[] = [
    {
      gateway: true,
      toolName: "sedes_catalog",
      displayName: "Sedes tool catalog",
      readOnly: true,
    },
    {
      gateway: true,
      toolName: "sedes_read",
      displayName: "Sedes read",
      readOnly: true,
    },
    {
      gateway: true,
      toolName: "sedes_act",
      displayName: "Sedes action",
      readOnly: false,
    },
  ];
  tools.push(
    catalogGatewayDefinition(input, () => progressiveSnapshot),
    executionGatewayDefinition(input, "sedes_read", takeApproval),
    executionGatewayDefinition(input, "sedes_act", takeApproval),
  );
  descriptors.push(...gatewayDescriptors);
  const resolveApproval: PiAgentToolApprovalResolver = ({
    toolName,
    parameters,
  }): PiResolvedAgentToolApproval | undefined => {
    if (toolName !== "sedes_act") return undefined;
    const resolved = resolvePiProgressiveAgentToolEnvelope(
      input,
      "sedes_act",
      parameters,
    );
    const effects = resolved.description.effects;
    const serializedInput = deterministicJson(resolved.input);
    return {
      fingerprint: resolved.fingerprint,
      title: `Approve ${resolved.description.label}`,
      detail: [
        `${resolved.description.id}@${resolved.description.schemaVersion}`,
        `effects: application=${effects.application}, external=${effects.external}, model=${effects.modelUsage}`,
        `input: ${serializedInput.slice(0, 1_200)}${serializedInput.length > 1_200 ? "…" : ""}`,
      ].join("\n"),
    };
  };
  const recordApproval: PiAgentToolApprovalRecorder = ({
    toolCallId,
    toolName,
    fingerprint,
  }) => {
    if (
      toolName !== "sedes_act" ||
      approvedActions.has(toolCallId) ||
      approvedActions.size >= 128
    ) {
      throw new Error("pi_agent_tool_approval_record_invalid");
    }
    approvedActions.set(toolCallId, fingerprint);
  };
  const refreshProgressiveSnapshot: PiAgentToolSet["refreshProgressiveSnapshot"] =
    (policy, accessMode) => {
      approvedActions.clear();
      if (
        !policy.enabled ||
        policy.presentation.surface !== "native" ||
        policy.presentation.mode !== "progressive"
      ) {
        progressiveSnapshot = undefined;
        return;
      }
      const summaries = input.facade.catalogSummaries(input.source, "pi_sdk");
      progressiveSnapshot = Object.freeze(
        accessMode === "read_only"
          ? summaries.filter(
              ({ effects }) =>
                effects.application === "read" &&
                effects.modelUsage === "none" &&
                effects.external === "none",
            )
          : [...summaries],
      );
    };
  return {
    tools: Object.freeze(tools),
    descriptors: Object.freeze(descriptors),
    resolveApproval,
    recordApproval,
    refreshProgressiveSnapshot,
  };
}

export function assertNoPiAgentToolExtensionCollisions(
  entries: readonly {
    readonly tools: ReadonlyMap<string, unknown>;
  }[],
): void {
  for (const extension of entries) {
    for (const name of extension.tools.keys()) {
      if (name.startsWith("sedes_")) {
        throw new Error("pi_agent_tool_reserved_name_collision");
      }
    }
  }
}
