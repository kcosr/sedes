import type {
  InitializeRequest,
  InitializeResponse,
} from "@agentclientprotocol/sdk";
import {
  AcpBinding,
  ACP_CLIENT_NOTIFICATIONS,
  defineAcpExtensionNotification,
  defineAcpExtensionRequest,
  defineAcpReverseNotificationHandler,
  defineAcpReverseRequestHandler,
  SEDES_ACP_PROTOCOL_VERSION,
  type AcpBindingDiagnostics,
  type AcpBindingLimits,
  type AcpDescriptor,
  type AcpNotificationDescriptor,
  type AcpRequestDescriptor,
  type AcpReverseRegistration,
} from "../../src/server/provider-protocol/bindings/acp-v1/index.js";
import type {
  FramedMessageTransport,
  ProviderTransportScope,
} from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import {
  GROK_REVIEWED_PROBE_CANDIDATES,
  type GrokExtensionCandidate,
} from "./grok-extension-candidates.js";
import o2bScenarioManifestJson from "./grok-o2b-scenarios.json";

export const GROK_SOURCE_PROBE_PROFILE = "grok-source-probe-v1" as const;

export type GrokProbeStage = "o2a_initialize_only" | "o2b_local_lifecycle";

export interface GrokProbeCapture {
  readonly sequence: number;
  readonly stage: GrokProbeStage;
  readonly method: string;
  readonly direction: "client_to_agent" | "agent_to_client";
  readonly kind: "request" | "notification";
  readonly outcome:
    | "attempted"
    | "response_admitted_by_probe_bounds"
    | "observed"
    | "authority_denied";
}

export interface GrokProbeCaptureSink {
  capture(event: GrokProbeCapture): void;
}

export interface GrokProbeProfileOptions {
  readonly transport: FramedMessageTransport;
  readonly expectedScope: ProviderTransportScope;
  readonly expectedConnectionGeneration: number;
  readonly limits?: Partial<Omit<AcpBindingLimits, "semantic">> & {
    readonly semantic?: Partial<AcpBindingLimits["semantic"]>;
  };
  readonly capture?: GrokProbeCaptureSink;
  readonly maximumCaptures?: number;
  readonly o2aReviewEvidence?: GrokO2aReviewEvidence;
}

export interface GrokO2aReviewEvidence {
  readonly status: "accepted";
  readonly evidenceId: string;
}

export interface GrokProbeDiagnostics {
  readonly binding: AcpBindingDiagnostics;
  readonly captured: number;
  readonly droppedCaptures: number;
  readonly captureFailures: number;
  readonly deniedExtensionReverseRequests: number;
}

export interface GrokProbeInitializeOptions {
  readonly signal?: AbortSignal;
}

export interface GrokInitializeOnlyProbe {
  readonly stage: "o2a_initialize_only";
  initialize(options?: GrokProbeInitializeOptions): Promise<InitializeResponse>;
  /**
   * Accepts only an open, settled binding with no authority or protocol
   * failures. Inactive notifications may have been generically ignored; their
   * routes and payloads are never captured and their saturating diagnostic
   * counters establish no support claim.
   */
  assertQuiescentClean(): void;
  diagnostics(): GrokProbeDiagnostics;
  close(reason?: string): Promise<void>;
}

export type GrokReviewedOfflineRequest =
  | { readonly scenarioId: "models_list" }
  | { readonly scenarioId: "session_info"; readonly sessionId?: string }
  | {
      readonly scenarioId: "session_list";
      readonly workspace_directory: string;
    }
  | { readonly scenarioId: "sessions_list" }
  | {
      readonly scenarioId: "session_updates";
      readonly sessionId: string;
      readonly cwd: string;
      readonly offset?: number;
      readonly limit?: number;
      readonly turnIndex?: number;
    }
  | {
      readonly scenarioId: "session_state";
      readonly sessionId: string;
      readonly cwd: string;
    }
  | { readonly scenarioId: "session_usage"; readonly sessionId: string };

export interface GrokOfflineLifecycleProbe {
  readonly stage: "o2b_local_lifecycle";
  initialize(options?: GrokProbeInitializeOptions): Promise<InitializeResponse>;
  request(input: GrokReviewedOfflineRequest): Promise<unknown>;
  diagnostics(): GrokProbeDiagnostics;
  close(reason?: string): Promise<void>;
}

const genericObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/**
 * Deliberately weak, probe-only response admission. AcpBinding applies frame,
 * tree, string, and node bounds before this predicate. This does not establish
 * an extension schema, semantic compatibility, or support claim and must never
 * be reused by a production Grok profile.
 */
const genericJson = (value: unknown): boolean =>
  value === null ||
  typeof value === "boolean" ||
  typeof value === "number" ||
  typeof value === "string" ||
  Array.isArray(value) ||
  genericObject(value);

const reviewedDescriptors = new Map<string, AcpDescriptor>();
for (const candidate of GROK_REVIEWED_PROBE_CANDIDATES) {
  if (
    candidate.literal === undefined ||
    candidate.direction === "unknown" ||
    candidate.kind === "unknown"
  ) {
    throw new Error("grok_probe_reviewed_candidate_incomplete");
  }
  const descriptor = defineCandidateDescriptor(candidate);
  reviewedDescriptors.set(candidateDescriptorKey(candidate), descriptor);
}

export const GROK_REVIEWED_PROBE_DESCRIPTOR_KEYS = Object.freeze(
  [...reviewedDescriptors.keys()].sort(),
);

export const GROK_O2B_REVIEWED_SCENARIOS = validateO2bScenarioManifest(
  o2bScenarioManifestJson,
);

export const GROK_O2B_EXTENSION_METHODS = Object.freeze(
  GROK_O2B_REVIEWED_SCENARIOS.map((scenario) => scenario.method).sort(),
);

const o2bScenariosById = new Map(
  GROK_O2B_REVIEWED_SCENARIOS.map((scenario) => [
    scenario.scenarioId,
    scenario,
  ]),
);

export function createGrokInitializeOnlyProbe(
  options: GrokProbeProfileOptions,
): GrokInitializeOnlyProbe {
  return createProbe("o2a_initialize_only", options);
}

export function createGrokOfflineLifecycleProbe(
  options: GrokProbeProfileOptions,
): GrokOfflineLifecycleProbe {
  assertO2aReviewAccepted(options.o2aReviewEvidence);
  return createProbe("o2b_local_lifecycle", options);
}

function createProbe(
  stage: "o2a_initialize_only",
  options: GrokProbeProfileOptions,
): GrokInitializeOnlyProbe;
function createProbe(
  stage: "o2b_local_lifecycle",
  options: GrokProbeProfileOptions,
): GrokOfflineLifecycleProbe;
function createProbe(
  stage: "o2a_initialize_only" | "o2b_local_lifecycle",
  options: GrokProbeProfileOptions,
): GrokInitializeOnlyProbe | GrokOfflineLifecycleProbe {
  const captures = new BoundedCapture(stage, options);
  const initializeOnly = stage === "o2a_initialize_only";
  const reverseHandlers = initializeOnly ? [] : createReverseHandlers(captures);
  const bindingLimits = {
    maximumFrameBytes:
      options.limits?.maximumFrameBytes ?? options.transport.maximumFrameBytes,
    ...options.limits,
  };
  const binding = new AcpBinding({
    transport: options.transport,
    expectedScope: options.expectedScope,
    expectedConnectionGeneration: options.expectedConnectionGeneration,
    profiles: [GROK_SOURCE_PROBE_PROFILE],
    extensions: initializeOnly ? [] : [...reviewedDescriptors.values()],
    reverseHandlers,
    limits: bindingLimits,
  });
  const initialize = createInitializeOperation(binding, captures);

  const common = {
    stage,
    initialize,
    diagnostics: (): GrokProbeDiagnostics => ({
      binding: binding.diagnostics(),
      ...captures.diagnostics(),
    }),
    close: async (reason = "grok_probe_complete") => {
      await binding.close(reason);
    },
  };

  if (stage === "o2a_initialize_only") {
    return {
      ...common,
      stage,
      assertQuiescentClean: () =>
        assertInitializeOnlyClean(
          binding.diagnostics(),
          captures.diagnostics(),
        ),
    };
  }
  return {
    ...common,
    stage,
    request: async (input: GrokReviewedOfflineRequest): Promise<unknown> => {
      const { scenarioId, ...params } = input;
      const scenario = o2bScenariosById.get(scenarioId);
      if (!scenario)
        throw new Error("grok_probe_scenario_not_reviewed_for_o2b");
      const { method } = scenario;
      const descriptor = reviewedDescriptors.get(
        descriptorKey("client_to_agent", "request", method),
      );
      if (!descriptor || descriptor.kind !== "request") {
        throw new Error("grok_probe_descriptor_missing");
      }
      captures.record(method, "client_to_agent", "request", "attempted");
      const response = await binding.request(
        descriptor as AcpRequestDescriptor<Record<string, unknown>, unknown>,
        params,
      );
      captures.record(
        method,
        "client_to_agent",
        "request",
        "response_admitted_by_probe_bounds",
      );
      return response;
    },
  };
}

function createInitializeOperation(
  binding: AcpBinding,
  captures: BoundedCapture,
): (options?: GrokProbeInitializeOptions) => Promise<InitializeResponse> {
  let initializeStarted = false;
  return async (
    initializeOptions?: GrokProbeInitializeOptions,
  ): Promise<InitializeResponse> => {
    if (initializeStarted) throw new Error("grok_probe_initialize_repeated");
    initializeStarted = true;
    const request: InitializeRequest = {
      protocolVersion: SEDES_ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: "sedes-grok-offline-probe",
        version: "1",
      },
    };
    captures.record("initialize", "client_to_agent", "request", "attempted");
    const response = await binding.initialize(request, {
      ...(initializeOptions?.signal
        ? { cancellationSignal: initializeOptions.signal }
        : {}),
    });
    captures.record(
      "initialize",
      "client_to_agent",
      "request",
      "response_admitted_by_probe_bounds",
    );
    return response;
  };
}

function createReverseHandlers(
  captures: BoundedCapture,
): readonly AcpReverseRegistration[] {
  const handlers: AcpReverseRegistration[] = [
    defineAcpReverseNotificationHandler({
      descriptor: ACP_CLIENT_NOTIFICATIONS.sessionUpdate,
      authorize: () => true,
      handle: () => {
        captures.record(
          ACP_CLIENT_NOTIFICATIONS.sessionUpdate.method,
          "agent_to_client",
          "notification",
          "observed",
        );
      },
    }),
  ];
  for (const candidate of GROK_REVIEWED_PROBE_CANDIDATES) {
    if (candidate.direction !== "agent_to_client") continue;
    const descriptor = reviewedDescriptors.get(
      candidateDescriptorKey(candidate),
    );
    if (!descriptor) throw new Error("grok_probe_descriptor_missing");
    if (candidate.probeDisposition === "deny_reverse_authority") {
      if (descriptor.kind !== "request") {
        throw new Error("grok_probe_reverse_descriptor_invalid");
      }
      handlers.push(
        defineAcpReverseRequestHandler({
          descriptor: descriptor as AcpRequestDescriptor<
            Record<string, unknown>,
            Record<string, never>
          >,
          authorize: () => {
            captures.denyReverse(candidate.literal ?? candidate.key);
            return false;
          },
          handle: () => {
            throw new Error("grok_probe_denied_reverse_dispatched");
          },
        }),
      );
      continue;
    }
    if (descriptor.kind !== "notification") {
      throw new Error("grok_probe_notification_descriptor_invalid");
    }
    handlers.push(
      defineAcpReverseNotificationHandler({
        descriptor: descriptor as AcpNotificationDescriptor<
          Record<string, unknown>
        >,
        authorize: () => true,
        handle: () => {
          captures.record(
            candidate.literal ?? candidate.key,
            "agent_to_client",
            "notification",
            "observed",
          );
        },
      }),
    );
  }
  return handlers;
}

function defineCandidateDescriptor(
  candidate: GrokExtensionCandidate,
): AcpDescriptor {
  const method = candidate.literal;
  if (
    !method ||
    candidate.direction === "unknown" ||
    candidate.kind === "unknown"
  ) {
    throw new Error("grok_probe_candidate_not_descriptor_eligible");
  }
  const wireMethod = grokExtensionWireMethod(method);
  if (candidate.kind === "notification") {
    return defineAcpExtensionNotification({
      method: wireMethod,
      direction: candidate.direction,
      operation: "control",
      requiredProfile: GROK_SOURCE_PROBE_PROFILE,
      decodeParams: decodeProbeNotification,
      validateParams: genericObject,
      notificationOrderingKey: (params: Record<string, unknown>) =>
        typeof params.sessionId === "string" ? params.sessionId : undefined,
    });
  }
  return defineAcpExtensionRequest({
    method: wireMethod,
    direction: candidate.direction,
    operation:
      candidate.probeDisposition === "o2b_read_only" ? "read" : "control",
    requiredProfile: GROK_SOURCE_PROBE_PROFILE,
    decodeRequest:
      candidate.direction === "client_to_agent" &&
      candidate.probeDisposition === "o2b_read_only"
        ? decodeProbeRequest(method)
        : decodeEmptyProbeObject,
    decodeResponse: decodeProbeJson,
    validateRequest:
      candidate.direction === "client_to_agent" &&
      candidate.probeDisposition === "o2b_read_only"
        ? requestValidator(method)
        : genericObject,
    validateResponse: genericJson,
  });
}

function grokExtensionWireMethod(method: string): string {
  if (method.startsWith("x.ai/")) return `_${method}`;
  throw new Error("grok_probe_candidate_wire_method_invalid");
}

function candidateDescriptorKey(candidate: GrokExtensionCandidate): string {
  if (!candidate.literal)
    throw new Error("grok_probe_candidate_literal_missing");
  return descriptorKey(candidate.direction, candidate.kind, candidate.literal);
}

function descriptorKey(
  direction: string,
  kind: string,
  method: string,
): string {
  return `${direction}\u0000${kind}\u0000${method}`;
}

interface GrokO2bReviewedScenario {
  readonly scenarioId:
    | "models_list"
    | "session_info"
    | "session_list"
    | "sessions_list"
    | "session_updates"
    | "session_state"
    | "session_usage";
  readonly method: string;
  readonly status: "source_characterization_only";
  readonly initializeFirst: true;
  readonly schemaId:
    | "empty_object"
    | "optional_session_id"
    | "workspace_directory"
    | "bounded_session_updates"
    | "session_id_and_cwd"
    | "session_id";
}

function validateO2bScenarioManifest(
  value: unknown,
): readonly GrokO2bReviewedScenario[] {
  if (
    !genericObject(value) ||
    value.schemaVersion !== 1 ||
    value.profile !== GROK_SOURCE_PROBE_PROFILE ||
    value.o2aGate !== "review_required" ||
    !Array.isArray(value.scenarios) ||
    !closedObject(value, ["schemaVersion", "profile", "o2aGate", "scenarios"])
  ) {
    throw new Error("grok_o2b_scenario_manifest_invalid");
  }
  const expectedSchemaByScenario = new Map<string, string>([
    ["models_list", "empty_object"],
    ["session_info", "optional_session_id"],
    ["session_list", "workspace_directory"],
    ["sessions_list", "empty_object"],
    ["session_updates", "bounded_session_updates"],
    ["session_state", "session_id_and_cwd"],
    ["session_usage", "session_id"],
  ]);
  const scenarios: GrokO2bReviewedScenario[] = [];
  const methods = new Set<string>();
  for (const item of value.scenarios) {
    if (
      !closedObject(item, [
        "scenarioId",
        "method",
        "status",
        "initializeFirst",
        "schemaId",
      ]) ||
      typeof item.scenarioId !== "string" ||
      typeof item.method !== "string" ||
      item.status !== "source_characterization_only" ||
      item.initializeFirst !== true ||
      item.schemaId !== expectedSchemaByScenario.get(item.scenarioId) ||
      methods.has(item.method)
    ) {
      throw new Error("grok_o2b_scenario_manifest_invalid");
    }
    expectedSchemaByScenario.delete(item.scenarioId);
    methods.add(item.method);
    scenarios.push(Object.freeze(item) as unknown as GrokO2bReviewedScenario);
  }
  const candidateMethods = GROK_REVIEWED_PROBE_CANDIDATES.filter(
    (candidate) => candidate.probeDisposition === "o2b_read_only",
  )
    .map((candidate) => candidate.literal)
    .filter((method): method is string => method !== undefined)
    .sort();
  if (
    expectedSchemaByScenario.size !== 0 ||
    scenarios.length !== candidateMethods.length ||
    [...methods]
      .sort()
      .some((method, index) => method !== candidateMethods[index])
  ) {
    throw new Error("grok_o2b_scenario_manifest_drift");
  }
  return Object.freeze(scenarios);
}

function assertO2aReviewAccepted(
  evidence: GrokO2aReviewEvidence | undefined,
): asserts evidence is GrokO2aReviewEvidence {
  if (
    evidence?.status !== "accepted" ||
    !nonEmptyString(evidence.evidenceId) ||
    Buffer.byteLength(evidence.evidenceId, "utf8") > 256
  ) {
    throw new Error("grok_o2b_pending_o2a_review");
  }
}

function assertInitializeOnlyClean(
  binding: AcpBindingDiagnostics,
  captures: Omit<GrokProbeDiagnostics, "binding">,
): void {
  if (
    !binding.initialized ||
    binding.closed ||
    binding.pendingRequests !== 0 ||
    binding.activeReverseRequests !== 0 ||
    binding.activeNotifications !== 0 ||
    binding.pendingNotifications !== 0 ||
    binding.notificationOrderingKeys !== 0 ||
    binding.preInitializeBufferedNotifications !== 0 ||
    binding.preInitializeBufferedNotificationBytes !== 0 ||
    binding.deniedReverseRequests !== 0 ||
    binding.handlerFailures !== 0 ||
    binding.rejectedLateResponses !== 0 ||
    binding.protocolFailures !== 0 ||
    captures.droppedCaptures !== 0 ||
    captures.captureFailures !== 0 ||
    captures.deniedExtensionReverseRequests !== 0
  ) {
    throw new Error("grok_o2a_initialize_not_quiescent_clean");
  }
}

function requestValidator(
  method: string,
): (value: unknown) => value is Record<string, unknown> {
  switch (method) {
    case "x.ai/models/list":
    case "x.ai/sessions/list":
      return emptyObject;
    case "x.ai/session/info":
      return (value): value is Record<string, unknown> =>
        closedObject(value, ["sessionId"]) && optionalString(value.sessionId);
    case "x.ai/session/list":
      return (value): value is Record<string, unknown> =>
        closedObject(value, ["workspace_directory"]) &&
        nonEmptyString(value.workspace_directory);
    case "x.ai/session/updates":
      return (value): value is Record<string, unknown> =>
        closedObject(value, [
          "sessionId",
          "cwd",
          "offset",
          "limit",
          "turnIndex",
        ]) &&
        nonEmptyString(value.sessionId) &&
        nonEmptyString(value.cwd) &&
        optionalSafeInteger(value.offset, -10_000, 10_000) &&
        optionalSafeInteger(value.limit, 1, 1_000) &&
        optionalSafeInteger(value.turnIndex, 1, 1_000);
    case "x.ai/session/state":
      return (value): value is Record<string, unknown> =>
        closedObject(value, ["sessionId", "cwd"]) &&
        nonEmptyString(value.sessionId) &&
        nonEmptyString(value.cwd);
    case "x.ai/session/usage":
      return (value): value is Record<string, unknown> =>
        closedObject(value, ["sessionId"]) && nonEmptyString(value.sessionId);
    default:
      throw new Error("grok_probe_request_schema_not_reviewed");
  }
}

function decodeProbeRequest(
  method: string,
): (value: unknown) => Record<string, unknown> | undefined {
  const validate = requestValidator(method);
  return (value) => (validate(value) ? value : undefined);
}

function decodeEmptyProbeObject(
  value: unknown,
): Record<string, unknown> | undefined {
  return genericObject(value)
    ? (Object.create(null) as Record<string, unknown>)
    : undefined;
}

function decodeProbeNotification(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!genericObject(value)) return undefined;
  const projected = Object.create(null) as Record<string, unknown>;
  if (typeof value.sessionId === "string") {
    Object.defineProperty(projected, "sessionId", {
      enumerable: true,
      value: value.sessionId,
    });
  }
  return projected;
}

function decodeProbeJson(value: unknown): unknown | undefined {
  return genericJson(value) ? value : undefined;
}

function emptyObject(value: unknown): value is Record<string, never> {
  return genericObject(value) && Object.keys(value).length === 0;
}

function closedObject(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  return (
    genericObject(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || nonEmptyString(value);
}

function optionalSafeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) &&
      (value as number) >= minimum &&
      (value as number) <= maximum)
  );
}

class BoundedCapture {
  readonly #stage: GrokProbeStage;
  readonly #sink: GrokProbeCaptureSink | undefined;
  readonly #maximum: number;
  #sequence = 0;
  #captured = 0;
  #dropped = 0;
  #failures = 0;
  #deniedReverse = 0;

  constructor(stage: GrokProbeStage, options: GrokProbeProfileOptions) {
    this.#stage = stage;
    this.#sink = options.capture;
    const maximum = options.maximumCaptures ?? 256;
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 4_096) {
      throw new Error("grok_probe_capture_limit_invalid");
    }
    this.#maximum = maximum;
  }

  denyReverse(method: string): void {
    this.#deniedReverse += 1;
    this.record(method, "agent_to_client", "request", "authority_denied");
  }

  record(
    method: string,
    direction: "client_to_agent" | "agent_to_client",
    kind: "request" | "notification",
    outcome: GrokProbeCapture["outcome"],
  ): void {
    if (!this.#sink) return;
    if (this.#captured >= this.#maximum) {
      this.#dropped += 1;
      return;
    }
    const event = Object.freeze({
      sequence: ++this.#sequence,
      stage: this.#stage,
      method,
      direction,
      kind,
      outcome,
    });
    try {
      this.#sink.capture(event);
      this.#captured += 1;
    } catch {
      this.#failures += 1;
    }
  }

  diagnostics(): Omit<GrokProbeDiagnostics, "binding"> {
    return Object.freeze({
      captured: this.#captured,
      droppedCaptures: this.#dropped,
      captureFailures: this.#failures,
      deniedExtensionReverseRequests: this.#deniedReverse,
    });
  }
}
