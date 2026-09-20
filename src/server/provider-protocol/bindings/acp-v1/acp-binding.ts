import {
  type AgentCapabilities,
  type CancelRequestNotification,
  type ClientCapabilities,
  type InitializeRequest,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import { sameEnvironmentChannelScope } from "../../../execution/environment-channel.js";
import { snapshotBoundedJson } from "../../json/bounded-json-snapshot.js";
import {
  FrameWriteError,
  isValidFramedTransportAssurance,
  type FrameDelivery,
  type FramedMessageTransport,
  type ProviderTransportScope,
} from "../../transport/assured-framed-transport.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../transport/framed-message-limits.js";
import {
  ACP_AGENT_REQUESTS,
  ACP_CLIENT_NOTIFICATIONS,
  ACP_CLIENT_REQUESTS,
  ACP_PROTOCOL_NOTIFICATIONS,
  ACP_RESERVED_V1_ROUTES,
  ACP_STABLE_V1_AGENT_DESCRIPTORS,
  ACP_STABLE_V1_REVERSE_DESCRIPTORS,
  ACP_UNSTABLE_V1_AGENT_DESCRIPTORS,
  SEDES_ACP_PROTOCOL_VERSION,
  isAcpDescriptor,
  type AcpDescriptor,
  type AcpNotificationDescriptor,
  type AcpRequestDescriptor,
} from "./descriptors.js";
import { AcpBindingError, AcpDeliveryError, AcpRemoteError } from "./errors.js";
import {
  DEFAULT_ACP_SEMANTIC_LIMITS,
  isPlainObject,
  validateAcpValue,
  type AcpSemanticLimits,
} from "./schema.js";

export interface AcpBindingLimits {
  readonly maximumFrameBytes: number;
  readonly maximumPendingRequests: number;
  readonly maximumReverseRequests: number;
  readonly maximumNotificationHandlers: number;
  readonly maximumNotificationsPerOrderingKey: number;
  readonly maximumOutboundRequestsPerGeneration: number;
  readonly maximumTombstones: number;
  readonly requestDeadlineMilliseconds: number;
  readonly reverseRequestDeadlineMilliseconds: number;
  readonly semantic: AcpSemanticLimits;
}

export const DEFAULT_ACP_BINDING_LIMITS: AcpBindingLimits = Object.freeze({
  maximumFrameBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
  maximumPendingRequests: 64,
  maximumReverseRequests: 16,
  maximumNotificationHandlers: 256,
  maximumNotificationsPerOrderingKey: 128,
  maximumOutboundRequestsPerGeneration: Number.MAX_SAFE_INTEGER,
  maximumTombstones: 256,
  requestDeadlineMilliseconds: 30_000,
  reverseRequestDeadlineMilliseconds: 30_000,
  semantic: DEFAULT_ACP_SEMANTIC_LIMITS,
});

export interface AcpReverseContext {
  readonly signal: AbortSignal;
  readonly requestId?: AcpRequestId;
  readonly scope: ProviderTransportScope;
  readonly connectionGeneration: number;
}

export interface AcpReverseRegistration {
  readonly descriptor: AcpDescriptor;
  readonly kind: "request" | "notification";
  readonly notificationDisposition?: (params: unknown) => "dispatch" | "ignore";
  readonly inlineNotification?: {
    authorize(params: unknown, context: AcpReverseContext): boolean;
    dispatch(params: unknown, context: AcpReverseContext): void;
  };
  authorize(params: unknown, context: AcpReverseContext): Promise<boolean>;
  dispatch(params: unknown, context: AcpReverseContext): Promise<unknown>;
}

const reverseRegistrationBrands = new WeakSet<object>();

/**
 * Creates a typed two-stage reverse handler. `authorize` must establish exact
 * session/turn/resource eligibility without performing the requested effect.
 */
export function defineAcpReverseRequestHandler<Request, Response>(input: {
  readonly descriptor: AcpRequestDescriptor<Request, Response>;
  readonly authorize: (
    request: Request,
    context: AcpReverseContext,
  ) => boolean | Promise<boolean>;
  readonly handle: (
    request: Request,
    context: AcpReverseContext,
  ) => Response | Promise<Response>;
}): AcpReverseRegistration {
  if (
    !isAcpDescriptor(input.descriptor) ||
    input.descriptor.kind !== "request" ||
    input.descriptor.direction !== "agent_to_client"
  ) {
    throw new Error("acp_reverse_request_registration_invalid");
  }
  const registration: AcpReverseRegistration = Object.freeze({
    descriptor: input.descriptor as AcpDescriptor,
    kind: "request",
    authorize: async (params: unknown, context: AcpReverseContext) =>
      await input.authorize(params as Request, context),
    dispatch: async (params: unknown, context: AcpReverseContext) =>
      await input.handle(params as Request, context),
  });
  reverseRegistrationBrands.add(registration);
  return registration;
}

export function defineAcpReverseNotificationHandler<Params>(input: {
  readonly descriptor: AcpNotificationDescriptor<Params>;
  /**
   * Classifies one bounded routing identity from parsed JSON parameters before
   * route-specific decoding or asynchronous queueing. Return `ignore` only
   * when it proves that the known route is outside this consumer's ownership.
   */
  readonly disposition?: (params: unknown) => "dispatch" | "ignore";
  readonly authorize: (
    params: Params,
    context: AcpReverseContext,
  ) => boolean | Promise<boolean>;
  readonly handle: (
    params: Params,
    context: AcpReverseContext,
  ) => void | Promise<void>;
}): AcpReverseRegistration {
  if (
    !isAcpDescriptor(input.descriptor) ||
    input.descriptor.kind !== "notification" ||
    input.descriptor.direction !== "agent_to_client"
  ) {
    throw new Error("acp_reverse_notification_registration_invalid");
  }
  const registration: AcpReverseRegistration = Object.freeze({
    descriptor: input.descriptor as AcpDescriptor,
    kind: "notification",
    ...(input.disposition
      ? {
          notificationDisposition: (params: unknown) =>
            input.disposition!(params),
        }
      : {}),
    authorize: async (params: unknown, context: AcpReverseContext) =>
      await input.authorize(params as Params, context),
    dispatch: async (params: unknown, context: AcpReverseContext) => {
      await input.handle(params as Params, context);
      return undefined;
    },
  });
  reverseRegistrationBrands.add(registration);
  return registration;
}

/**
 * Creates a synchronous notification handler for high-rate depended-on
 * deltas. Both stages must finish before returning and must never initiate or
 * await protocol work; this keeps response demultiplexing live without
 * allocating one queued continuation per delta.
 */
export function defineAcpInlineReverseNotificationHandler<Params>(input: {
  readonly descriptor: AcpNotificationDescriptor<Params>;
  readonly disposition?: (params: unknown) => "dispatch" | "ignore";
  readonly authorize: (params: Params, context: AcpReverseContext) => boolean;
  readonly handle: (params: Params, context: AcpReverseContext) => void;
}): AcpReverseRegistration {
  if (
    !isAcpDescriptor(input.descriptor) ||
    input.descriptor.kind !== "notification" ||
    input.descriptor.direction !== "agent_to_client"
  ) {
    throw new Error("acp_reverse_notification_registration_invalid");
  }
  const registration: AcpReverseRegistration = Object.freeze({
    descriptor: input.descriptor as AcpDescriptor,
    kind: "notification",
    ...(input.disposition
      ? { notificationDisposition: input.disposition }
      : {}),
    inlineNotification: Object.freeze({
      authorize: (params: unknown, context: AcpReverseContext) =>
        input.authorize(params as Params, context),
      dispatch: (params: unknown, context: AcpReverseContext) =>
        input.handle(params as Params, context),
    }),
    authorize: async (params: unknown, context: AcpReverseContext) =>
      input.authorize(params as Params, context),
    dispatch: async (params: unknown, context: AcpReverseContext) => {
      input.handle(params as Params, context);
      return undefined;
    },
  });
  reverseRegistrationBrands.add(registration);
  return registration;
}

export interface AcpBindingOptions {
  readonly transport: FramedMessageTransport;
  readonly expectedScope: ProviderTransportScope;
  readonly expectedConnectionGeneration: number;
  readonly profiles?: readonly string[];
  readonly extensions?: readonly AcpDescriptor[];
  readonly reverseHandlers?: readonly AcpReverseRegistration[];
  readonly outboundCapabilityCorrections?: readonly AcpOutboundCapabilityCorrection[];
  readonly preInitializeNotificationBuffer?: {
    readonly descriptors: readonly AcpNotificationDescriptor<unknown>[];
    readonly maximumCount: number;
    readonly maximumAggregateFrameBytes: number;
  };
  readonly limits?: Partial<Omit<AcpBindingLimits, "semantic">> & {
    readonly semantic?: Partial<AcpSemanticLimits>;
  };
}

export interface AcpOutboundCapabilityCorrection {
  readonly profile: string;
  readonly descriptor: AcpRequestDescriptor<unknown, unknown>;
  admits(request: unknown): boolean;
}

const outboundCapabilityCorrectionBrands = new WeakSet<object>();

/**
 * Registers one reviewed, profile-scoped correction for a source-visible ACP
 * capability that a provider under-advertises. Corrections never alter the
 * peer's advertised capability document and apply only to the exact standard
 * request descriptor named by the registration.
 */
export function defineAcpOutboundCapabilityCorrection<
  Request,
  Response,
>(input: {
  readonly profile: string;
  readonly descriptor: AcpRequestDescriptor<Request, Response>;
  readonly admits: (request: Request) => boolean;
}): AcpOutboundCapabilityCorrection {
  if (
    !isAcpDescriptor(input.descriptor) ||
    input.descriptor.kind !== "request" ||
    input.descriptor.direction !== "client_to_agent" ||
    input.profile.length === 0 ||
    input.profile === "acp-v1"
  ) {
    throw new Error("acp_outbound_capability_correction_invalid");
  }
  const correction: AcpOutboundCapabilityCorrection = Object.freeze({
    profile: input.profile,
    descriptor: input.descriptor as AcpRequestDescriptor<unknown, unknown>,
    admits: (request: unknown) => input.admits(request as Request),
  });
  outboundCapabilityCorrectionBrands.add(correction);
  return correction;
}

export interface AcpRequestOptions {
  readonly cancellationSignal?: AbortSignal;
  /**
   * Retire this request locally when cancellation wins instead of retaining
   * correlation until the peer responds or the connection closes.
   */
  readonly abandonOnCancellation?: true;
  /**
   * Observe the first late response envelope after an abandonable request has
   * crossed the carrier. The callback is synchronous, receives no response
   * payload, and exists only so an adapter with a side-channel stream can
   * recognize the exact zero-item end after local request retirement.
   */
  readonly onAbandonedSettlement?: () => void;
  /**
   * Total request/response deadline. `null` keeps the correlated response
   * pending until cancellation or transport closure while still bounding the
   * outbound frame write with the binding's configured request deadline.
   */
  readonly deadlineMilliseconds?: number | null;
}

export interface AcpSettlementRequestOptions extends AcpRequestOptions {
  readonly notificationCutover:
    | { readonly kind: "all" }
    | { readonly kind: "ordering_key"; readonly orderingKey: string };
}

interface AcpSettlementDrain {
  readonly inboundSequence: number;
  commitNotificationCutover<Result>(commit: () => Result): Promise<Result>;
}

export type AcpRequestSettlement<Response> =
  | (AcpSettlementDrain & {
      readonly kind: "success";
      readonly response: Response;
    })
  | (AcpSettlementDrain & {
      readonly kind: "remote_error";
      readonly error: AcpRemoteError;
    });

export interface AcpBindingDiagnostics {
  readonly initialized: boolean;
  readonly closed: boolean;
  readonly pendingRequests: number;
  readonly activeReverseRequests: number;
  readonly activeNotifications: number;
  readonly pendingNotifications: number;
  readonly notificationOrderingKeys: number;
  readonly preInitializeBufferedNotifications: number;
  readonly preInitializeBufferedNotificationBytes: number;
  readonly ignoredNotifications: number;
  readonly ignoredNotificationBytes: number;
  readonly deniedReverseRequests: number;
  readonly handlerFailures: number;
  readonly rejectedLateResponses: number;
  readonly protocolFailures: number;
  readonly closeReason?: string;
  readonly invalidEnvelopeRootType?:
    "array" | "boolean" | "null" | "number" | "object" | "string";
  readonly invalidEnvelopeShape?: string;
  readonly invalidEnvelopeUnknownKeys?: number;
  readonly invalidEnvelopeMethod?: string;
  readonly invalidEnvelopeBounds?: "invalid" | "valid";
}

export interface AcpBindingClosure {
  readonly reason: string;
  readonly delivery?: FrameDelivery;
  readonly transportCleanup?: "failed";
  readonly continuations?: "unsettled";
}

type AcpRequestId = string | number;

const EMPTY_CLIENT_CAPABILITIES = Object.freeze(
  Object.create(null),
) as Readonly<ClientCapabilities>;
const EMPTY_AGENT_CAPABILITIES = Object.freeze(
  Object.create(null),
) as Readonly<AgentCapabilities>;

const RESERVED_ACP_V1_ROUTES = new Set(
  ACP_RESERVED_V1_ROUTES.map((route) =>
    descriptorRoute(route.direction, route.kind, route.method),
  ),
);

interface PendingRequest {
  readonly descriptor: AcpRequestDescriptor<unknown, unknown>;
  readonly request: unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cancellationSignal?: AbortSignal;
  readonly cancellationListener?: () => void;
  readonly abandonOnCancellation: boolean;
  readonly onAbandonedSettlement?: () => void;
  readonly deadline?: NodeJS.Timeout;
  readonly deadlineAt?: number;
  readonly writeController: AbortController;
  readonly resultMode: "response" | "settlement";
  readonly notificationCutover?: AcpSettlementRequestOptions["notificationCutover"];
  cutoverTransferred: boolean;
  delivery: FrameDelivery;
  writeSettled: boolean;
  abandonRequested: boolean;
  abandonCompleting: boolean;
  cancelSent: boolean;
  abandonedSettlementObserved: boolean;
}

interface ParsedRequest {
  readonly kind: "request";
  readonly id: AcpRequestId;
  readonly method: string;
  readonly params: unknown;
}

interface ParsedNotification {
  readonly kind: "notification";
  readonly method: string;
  readonly params: unknown;
}

interface ActiveNotificationDependency {
  readonly descriptor: AcpNotificationDescriptor<unknown>;
  readonly registration: AcpReverseRegistration;
}

interface AdmittedNotification extends ActiveNotificationDependency {
  readonly envelope: ParsedNotification;
}

const IGNORED_ADMITTED_NOTIFICATION = Symbol(
  "acp_ignored_admitted_notification",
);

interface BufferedPreInitializeNotification extends AdmittedNotification {
  readonly frameBytes: number;
}

interface ParsedSuccessResponse {
  readonly kind: "success";
  readonly id: AcpRequestId;
  readonly result: unknown;
}

interface ParsedErrorResponse {
  readonly kind: "error";
  readonly id: AcpRequestId;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

type ParsedEnvelope =
  | ParsedRequest
  | ParsedNotification
  | ParsedSuccessResponse
  | ParsedErrorResponse;

export class AcpBinding {
  readonly #transport: FramedMessageTransport;
  readonly #limits: AcpBindingLimits;
  readonly #profiles: ReadonlySet<string>;
  readonly #descriptorsByRoute = new Map<string, AcpDescriptor>();
  readonly #reverseHandlers = new Map<string, AcpReverseRegistration>();
  readonly #outboundCapabilityCorrections = new Map<
    string,
    AcpOutboundCapabilityCorrection[]
  >();
  readonly #preInitializeNotificationRoutes = new Set<string>();
  readonly #preInitializeNotificationMaximumCount: number;
  readonly #preInitializeNotificationMaximumAggregateFrameBytes: number;
  readonly #preInitializeNotifications: BufferedPreInitializeNotification[] =
    [];
  readonly #authMethodIds = new Set<string>();
  readonly #pending = new Map<AcpRequestId, PendingRequest>();
  readonly #tombstones = new Set<AcpRequestId>();
  readonly #abandonedTombstones = new Set<AcpRequestId>();
  readonly #abandonedSettlementObservers = new Map<AcpRequestId, () => void>();
  readonly #tombstoneOrder: AcpRequestId[] = [];
  readonly #activeReverse = new Map<AcpRequestId, AbortController>();
  readonly #reverseTombstones = new Set<AcpRequestId>();
  readonly #reverseTombstoneOrder: AcpRequestId[] = [];
  readonly #activeNotificationControllers = new Set<AbortController>();
  readonly #notificationTails = new Map<string, Promise<void>>();
  readonly #notificationDepth = new Map<string, number>();
  readonly #notificationAdmissionWaiters = new Set<() => void>();
  readonly #globalNotificationCutoverBarriers = new Set<Promise<void>>();
  readonly #notificationCutoverReservations = new Set<string>();
  readonly #activeNotificationCutoverReleases = new Set<() => void>();
  readonly #continuations = new Set<Promise<void>>();
  readonly #closedPromise: Promise<AcpBindingClosure>;
  #resolveClosed!: (closure: AcpBindingClosure) => void;
  #nextRequestId = 1;
  #activeNotifications = 0;
  #pendingNotifications = 0;
  #preInitializeNotificationBytes = 0;
  #preInitializeNotificationObserved = false;
  #preInitializeDrain: Promise<void> | undefined;
  #ignoredNotifications = 0;
  #ignoredNotificationBytes = 0;
  #initialized = false;
  #initializing = false;
  #clientCapabilities: Readonly<ClientCapabilities> = EMPTY_CLIENT_CAPABILITIES;
  #agentCapabilities: Readonly<AgentCapabilities> = EMPTY_AGENT_CAPABILITIES;
  #closed = false;
  #closeReason: string | undefined;
  #invalidEnvelopeRootType:
    "array" | "boolean" | "null" | "number" | "object" | "string" | undefined;
  #invalidEnvelopeShape: string | undefined;
  #invalidEnvelopeUnknownKeys: number | undefined;
  #invalidEnvelopeMethod: string | undefined;
  #invalidEnvelopeBounds: "invalid" | "valid" | undefined;
  #finalization: Promise<void> | undefined;
  #deniedReverseRequests = 0;
  #handlerFailures = 0;
  #rejectedLateResponses = 0;
  #protocolFailures = 0;
  #closeDelivery: FrameDelivery | undefined;
  #inboundSequence = 0;

  constructor(options: AcpBindingOptions) {
    if (
      !isValidFramedTransportAssurance(options.transport.assurance) ||
      !sameEnvironmentChannelScope(
        options.expectedScope,
        options.transport.assurance.scope,
      ) ||
      options.expectedConnectionGeneration !==
        options.transport.assurance.connectionGeneration
    ) {
      throw new Error("acp_binding_transport_assurance_invalid");
    }
    this.#transport = options.transport;
    this.#limits = resolveLimits(options.limits);
    if (this.#limits.maximumFrameBytes > options.transport.maximumFrameBytes) {
      throw new Error("acp_binding_transport_frame_capacity_invalid");
    }
    this.#profiles = new Set(["acp-v1", ...(options.profiles ?? [])]);
    this.#closedPromise = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    for (const descriptor of ACP_STABLE_V1_REVERSE_DESCRIPTORS) {
      this.#addDescriptor(descriptor as AcpDescriptor);
    }
    for (const descriptor of ACP_STABLE_V1_AGENT_DESCRIPTORS) {
      this.#addDescriptor(descriptor as AcpDescriptor);
    }
    for (const descriptor of ACP_UNSTABLE_V1_AGENT_DESCRIPTORS) {
      this.#addDescriptor(descriptor as AcpDescriptor);
    }
    this.#addDescriptor(
      ACP_PROTOCOL_NOTIFICATIONS.cancelRequest as AcpDescriptor,
    );
    for (const descriptor of options.extensions ?? []) {
      if (
        !isAcpDescriptor(descriptor) ||
        descriptor.stability !== "extension"
      ) {
        throw new Error("acp_extension_descriptor_invalid");
      }
      if (
        RESERVED_ACP_V1_ROUTES.has(
          descriptorRoute(
            descriptor.direction,
            descriptor.kind,
            descriptor.method,
          ),
        )
      ) {
        throw new Error("acp_extension_standard_route_reserved");
      }
      this.#addDescriptor(descriptor);
    }
    for (const correction of options.outboundCapabilityCorrections ?? []) {
      if (!outboundCapabilityCorrectionBrands.has(correction)) {
        throw new Error("acp_outbound_capability_correction_invalid");
      }
      const route = descriptorRoute(
        "client_to_agent",
        "request",
        correction.descriptor.method,
      );
      if (
        !this.#profiles.has(correction.profile) ||
        this.#descriptorsByRoute.get(route) !== correction.descriptor
      ) {
        throw new Error("acp_outbound_capability_correction_invalid");
      }
      const registrations = this.#outboundCapabilityCorrections.get(route);
      if (registrations?.includes(correction)) {
        throw new Error("acp_outbound_capability_correction_invalid");
      }
      if (registrations) registrations.push(correction);
      else this.#outboundCapabilityCorrections.set(route, [correction]);
    }
    for (const registration of options.reverseHandlers ?? []) {
      this.#addReverseHandler(registration);
    }
    const preInitializeBuffer = options.preInitializeNotificationBuffer;
    this.#preInitializeNotificationMaximumCount =
      preInitializeBuffer?.maximumCount ?? 0;
    this.#preInitializeNotificationMaximumAggregateFrameBytes =
      preInitializeBuffer?.maximumAggregateFrameBytes ?? 0;
    if (preInitializeBuffer) {
      if (
        !positiveSafeInteger(preInitializeBuffer.maximumCount) ||
        !positiveSafeInteger(preInitializeBuffer.maximumAggregateFrameBytes) ||
        preInitializeBuffer.descriptors.length === 0
      ) {
        throw new Error("acp_preinitialize_notification_buffer_invalid");
      }
      for (const descriptor of preInitializeBuffer.descriptors) {
        const route = descriptorRoute(
          "agent_to_client",
          "notification",
          descriptor.method,
        );
        if (
          !isAcpDescriptor(descriptor) ||
          descriptor.kind !== "notification" ||
          descriptor.direction !== "agent_to_client" ||
          this.#descriptorsByRoute.get(route) !== descriptor ||
          !this.#profiles.has(descriptor.requiredProfile) ||
          !this.#reverseHandlers.has(route) ||
          this.#preInitializeNotificationRoutes.has(route)
        ) {
          throw new Error("acp_preinitialize_notification_buffer_invalid");
        }
        this.#preInitializeNotificationRoutes.add(route);
      }
    }
    this.#track(this.#consumeFrames());
    void this.#transport.closed.then(
      () => {
        void this.#startFinalization("transport_closed", false);
      },
      () => {
        void this.#startFinalization("transport_close_failed", false);
      },
    );
  }

  get closed(): Promise<AcpBindingClosure> {
    return this.#closedPromise;
  }

  diagnostics(): AcpBindingDiagnostics {
    return Object.freeze({
      initialized: this.#initialized,
      closed: this.#closed,
      pendingRequests: this.#pending.size,
      activeReverseRequests: this.#activeReverse.size,
      activeNotifications: this.#activeNotifications,
      pendingNotifications: this.#pendingNotifications,
      notificationOrderingKeys: this.#notificationTails.size,
      preInitializeBufferedNotifications:
        this.#preInitializeNotifications.length,
      preInitializeBufferedNotificationBytes:
        this.#preInitializeNotificationBytes,
      ignoredNotifications: this.#ignoredNotifications,
      ignoredNotificationBytes: this.#ignoredNotificationBytes,
      deniedReverseRequests: this.#deniedReverseRequests,
      handlerFailures: this.#handlerFailures,
      rejectedLateResponses: this.#rejectedLateResponses,
      protocolFailures: this.#protocolFailures,
      ...(this.#closeReason ? { closeReason: this.#closeReason } : {}),
      ...(this.#invalidEnvelopeRootType
        ? { invalidEnvelopeRootType: this.#invalidEnvelopeRootType }
        : {}),
      ...(this.#invalidEnvelopeShape
        ? { invalidEnvelopeShape: this.#invalidEnvelopeShape }
        : {}),
      ...(this.#invalidEnvelopeUnknownKeys !== undefined
        ? { invalidEnvelopeUnknownKeys: this.#invalidEnvelopeUnknownKeys }
        : {}),
      ...(this.#invalidEnvelopeMethod
        ? { invalidEnvelopeMethod: this.#invalidEnvelopeMethod }
        : {}),
      ...(this.#invalidEnvelopeBounds
        ? { invalidEnvelopeBounds: this.#invalidEnvelopeBounds }
        : {}),
    });
  }

  async initialize(
    request: InitializeRequest,
    options?: AcpRequestOptions,
  ): Promise<InitializeResponse> {
    if (this.#initialized || this.#initializing) {
      throw new AcpBindingError("acp_binding_protocol_violation");
    }
    const requestSnapshot = snapshotAcpValue(
      request,
      ACP_AGENT_REQUESTS.initialize.decodeRequest,
      ACP_AGENT_REQUESTS.initialize.validateRequest,
      this.#limits.semantic,
      this.#limits.maximumFrameBytes,
    );
    if (
      requestSnapshot === undefined ||
      requestSnapshot.protocolVersion !== SEDES_ACP_PROTOCOL_VERSION
    ) {
      throw new AcpBindingError("acp_binding_protocol_violation");
    }
    if (!this.#hasTruthfulClientCapabilityHandlers(requestSnapshot)) {
      throw new AcpBindingError("acp_binding_protocol_violation");
    }
    this.#initializing = true;
    try {
      const response = await this.#requestBeforeInitialization(
        ACP_AGENT_REQUESTS.initialize,
        requestSnapshot,
        options,
      );
      if (response.protocolVersion !== SEDES_ACP_PROTOCOL_VERSION) {
        await this.#failProtocol("acp_protocol_version_mismatch");
        throw new AcpBindingError("acp_binding_protocol_violation");
      }
      this.#clientCapabilities =
        requestSnapshot.clientCapabilities ?? EMPTY_CLIENT_CAPABILITIES;
      this.#agentCapabilities =
        response.agentCapabilities ?? EMPTY_AGENT_CAPABILITIES;
      for (const method of response.authMethods ?? []) {
        if (
          "type" in method &&
          method.type === "terminal" &&
          requestSnapshot.clientCapabilities?.auth?.terminal !== true
        ) {
          await this.#failProtocol("acp_auth_method_not_advertised");
          throw new AcpBindingError("acp_binding_protocol_violation");
        }
        if (this.#authMethodIds.has(method.id)) {
          await this.#failProtocol("acp_auth_method_duplicate");
          throw new AcpBindingError("acp_binding_protocol_violation");
        }
        this.#authMethodIds.add(method.id);
      }
      this.#initialized = true;
      this.#preInitializeDrain = this.#drainPreInitializeNotifications();
      try {
        await this.#preInitializeDrain;
      } finally {
        this.#preInitializeDrain = undefined;
      }
      if (this.#closed) {
        throw new AcpBindingError("acp_binding_closed");
      }
      return response;
    } catch (error) {
      if (
        !this.#initialized &&
        this.#preInitializeNotificationObserved &&
        !this.#closed
      ) {
        await this.#startFinalization(
          "acp_initialize_failed_with_buffered_notifications",
          true,
        );
      }
      throw error;
    } finally {
      this.#initializing = false;
      if (!this.#initialized) this.#clearPreInitializeNotifications();
    }
  }

  async request<Request, Response>(
    descriptor: AcpRequestDescriptor<Request, Response>,
    request: Request,
    options?: AcpRequestOptions,
  ): Promise<Response> {
    if (descriptor === ACP_AGENT_REQUESTS.initialize) {
      throw new AcpBindingError("acp_binding_protocol_violation");
    }
    this.#requireInitializedDescriptor(descriptor, "client_to_agent");
    return (await this.#sendRequest(
      descriptor,
      request,
      options,
      "response",
    )) as Response;
  }

  async requestWithSettlement<Request, Response>(
    descriptor: AcpRequestDescriptor<Request, Response>,
    request: Request,
    options?: AcpSettlementRequestOptions,
  ): Promise<AcpRequestSettlement<Response>> {
    if (descriptor === ACP_AGENT_REQUESTS.initialize) {
      throw new AcpBindingError("acp_binding_protocol_violation");
    }
    this.#requireInitializedDescriptor(descriptor, "client_to_agent");
    return (await this.#sendRequest(
      descriptor,
      request,
      options,
      "settlement",
    )) as AcpRequestSettlement<Response>;
  }

  async notify<Params>(
    descriptor: AcpNotificationDescriptor<Params>,
    params: Params,
  ): Promise<void> {
    this.#requireInitializedDescriptor(descriptor, "client_to_agent");
    this.#requireActiveAssurance();
    const paramsSnapshot = snapshotAcpValue(
      params,
      descriptor.decodeParams,
      descriptor.validateParams,
      this.#limits.semantic,
      this.#limits.maximumFrameBytes,
    );
    if (paramsSnapshot === undefined || !validParamsContainer(paramsSnapshot)) {
      throw new AcpBindingError("acp_binding_protocol_violation");
    }
    if (
      descriptor.outboundCapability &&
      !safePredicate(
        () =>
          descriptor.outboundCapability?.(
            this.#agentCapabilities,
            paramsSnapshot,
          ) ?? true,
      )
    ) {
      throw new AcpBindingError("acp_binding_capability_denied");
    }
    try {
      await this.#sendWireWithDeadline(
        {
          jsonrpc: "2.0",
          method: descriptor.method,
          params: paramsSnapshot,
        },
        this.#limits.requestDeadlineMilliseconds,
      );
    } catch (error) {
      const delivery = deliveryFrom(error);
      if (delivery === "sent_outcome_unknown") {
        await this.#failProtocol("acp_notification_delivery_unknown");
      }
      throw new AcpDeliveryError("acp_binding_closed", delivery, {
        cause: safeCause(error),
      });
    }
  }

  async close(reason = "caller_close"): Promise<void> {
    await this.#startFinalization(safeCloseReason(reason), true);
  }

  async #requestBeforeInitialization<Request, Response>(
    descriptor: AcpRequestDescriptor<Request, Response>,
    request: Request,
    options?: AcpRequestOptions,
  ): Promise<Response> {
    if (this.#closed) throw new AcpBindingError("acp_binding_closed");
    this.#requireActiveAssurance();
    return (await this.#sendRequest(
      descriptor,
      request,
      options,
      "response",
    )) as Response;
  }

  async #sendRequest<Request, Response>(
    descriptor: AcpRequestDescriptor<Request, Response>,
    request: Request,
    options?: AcpRequestOptions | AcpSettlementRequestOptions,
    resultMode: PendingRequest["resultMode"] = "response",
  ): Promise<Response | AcpRequestSettlement<Response>> {
    if (this.#closed) throw new AcpBindingError("acp_binding_closed");
    if (
      options?.onAbandonedSettlement !== undefined &&
      (options.abandonOnCancellation !== true ||
        typeof options.onAbandonedSettlement !== "function")
    ) {
      throw new AcpBindingError("acp_binding_protocol_violation");
    }
    if (
      resultMode === "settlement" &&
      (options === undefined ||
        !("notificationCutover" in options) ||
        options.notificationCutover == null)
    ) {
      throw new AcpBindingError("acp_binding_protocol_violation");
    }
    this.#requireActiveAssurance();
    if (options?.cancellationSignal?.aborted) {
      throw new AcpDeliveryError("acp_binding_request_cancelled", "not_sent");
    }
    if (this.#pending.size >= this.#limits.maximumPendingRequests) {
      throw new AcpBindingError("acp_binding_overloaded");
    }
    const deadlineMilliseconds =
      options?.deadlineMilliseconds === null
        ? null
        : validateDeadline(
            options?.deadlineMilliseconds ??
              this.#limits.requestDeadlineMilliseconds,
            this.#limits.requestDeadlineMilliseconds,
          );
    if (
      this.#nextRequestId > this.#limits.maximumOutboundRequestsPerGeneration
    ) {
      await this.#failProtocol("acp_request_id_exhausted");
      throw new AcpDeliveryError("acp_binding_closed", "not_sent");
    }
    const requestSnapshot = snapshotAcpValue(
      request,
      descriptor.decodeRequest,
      descriptor.validateRequest,
      this.#limits.semantic,
      this.#limits.maximumFrameBytes,
    );
    if (
      requestSnapshot === undefined ||
      !validParamsContainer(requestSnapshot)
    ) {
      throw new AcpBindingError("acp_binding_protocol_violation");
    }
    if (
      this.#initialized &&
      descriptor.outboundCapability &&
      !this.#outboundCapabilityAdmits(descriptor, requestSnapshot)
    ) {
      throw new AcpBindingError("acp_binding_capability_denied");
    }
    if (
      descriptor.outboundAuthMethodId &&
      !safePredicate(() =>
        this.#authMethodIds.has(
          descriptor.outboundAuthMethodId?.(requestSnapshot) ?? "",
        ),
      )
    ) {
      throw new AcpBindingError("acp_binding_capability_denied");
    }
    const settlementOptions =
      resultMode === "settlement" &&
      options !== undefined &&
      "notificationCutover" in options
        ? options
        : undefined;
    const notificationCutover = settlementOptions?.notificationCutover;
    if (notificationCutover) {
      this.#reserveNotificationCutover(notificationCutover);
    }
    const id = `sedes-acp-${this.#nextRequestId++}`;
    const deadlineAt =
      deadlineMilliseconds === null
        ? undefined
        : performance.now() + deadlineMilliseconds;
    const writeController = new AbortController();
    const promise = new Promise<Response>((resolve, reject) => {
      const deadline =
        deadlineMilliseconds === null
          ? undefined
          : setTimeout(() => {
              const pending = this.#pending.get(id);
              if (!pending) return;
              if (pending.abandonRequested) {
                this.#track(this.#completePendingAbandonment(id, pending));
                return;
              }
              pending.writeController.abort(
                new AcpBindingError("acp_binding_request_deadline"),
              );
              this.#pending.delete(id);
              this.#retirePending(id, pending);
              pending.reject(
                new AcpDeliveryError(
                  "acp_binding_request_deadline",
                  pending.delivery,
                ),
              );
              void this.#failProtocol("acp_request_deadline", pending.delivery);
            }, deadlineMilliseconds);
      deadline?.unref?.();
      const pending: PendingRequest = {
        descriptor: descriptor as AcpRequestDescriptor<unknown, unknown>,
        request: requestSnapshot,
        resolve: (value) => resolve(value as Response),
        reject,
        ...(deadline ? { deadline } : {}),
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        writeController,
        resultMode,
        ...(settlementOptions
          ? { notificationCutover: settlementOptions.notificationCutover }
          : {}),
        cutoverTransferred: false,
        delivery: "not_sent",
        writeSettled: false,
        abandonRequested: false,
        abandonCompleting: false,
        cancelSent: false,
        abandonedSettlementObserved: false,
        abandonOnCancellation: options?.abandonOnCancellation === true,
        ...(options?.onAbandonedSettlement
          ? { onAbandonedSettlement: options.onAbandonedSettlement }
          : {}),
        ...(options?.cancellationSignal
          ? { cancellationSignal: options.cancellationSignal }
          : {}),
      };
      if (options?.cancellationSignal) {
        const listener = () => {
          if (pending.abandonOnCancellation) {
            this.#requestPendingAbandonment(id, pending);
          } else {
            this.#track(this.#sendCancellation(id));
          }
        };
        (
          pending as { cancellationListener?: () => void }
        ).cancellationListener = listener;
        options.cancellationSignal.addEventListener("abort", listener, {
          once: true,
        });
      }
      this.#pending.set(id, pending);
    });

    const writeDeadline =
      deadlineMilliseconds === null
        ? setTimeout(() => {
            writeController.abort(
              new AcpBindingError("acp_binding_request_deadline"),
            );
          }, this.#limits.requestDeadlineMilliseconds)
        : undefined;
    writeDeadline?.unref?.();
    try {
      const sending = this.#pending.get(id);
      if (sending) {
        sending.delivery = "sent_outcome_unknown";
        await this.#sendWire(
          {
            jsonrpc: "2.0",
            id,
            method: descriptor.method,
            params: requestSnapshot,
          },
          writeController.signal,
        );
      }
      const pending = this.#pending.get(id);
      if (pending) {
        pending.writeSettled = true;
        if (pending.cancellationSignal?.aborted) {
          if (pending.abandonOnCancellation || pending.abandonRequested) {
            this.#track(this.#completePendingAbandonment(id, pending));
          } else {
            await this.#sendCancellation(id);
          }
        }
      }
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) {
        const delivery = deliveryFrom(error);
        if (
          pending.abandonRequested ||
          (pending.abandonOnCancellation &&
            pending.cancellationSignal?.aborted === true)
        ) {
          pending.delivery = delivery;
          this.#track(this.#completePendingAbandonment(id, pending));
          return await promise;
        }
        this.#pending.delete(id);
        this.#retirePending(id, pending);
        pending.reject(
          new AcpDeliveryError("acp_binding_closed", delivery, {
            cause: safeCause(error),
          }),
        );
        if (delivery === "sent_outcome_unknown") {
          void this.#failProtocol("acp_request_delivery_unknown");
        }
      }
    } finally {
      if (writeDeadline) clearTimeout(writeDeadline);
    }
    return await promise;
  }

  #outboundCapabilityAdmits<Request, Response>(
    descriptor: AcpRequestDescriptor<Request, Response>,
    request: Request,
  ): boolean {
    if (
      safePredicate(
        () =>
          descriptor.outboundCapability?.(
            this.#agentCapabilities,
            request,
            this.#clientCapabilities,
          ) ?? true,
      )
    ) {
      return true;
    }
    const route = descriptorRoute(
      "client_to_agent",
      "request",
      descriptor.method,
    );
    return (
      this.#outboundCapabilityCorrections
        .get(route)
        ?.some((correction) =>
          safePredicate(() => correction.admits(request)),
        ) === true
    );
  }

  #requestPendingAbandonment(id: AcpRequestId, pending: PendingRequest): void {
    if (this.#pending.get(id) !== pending || pending.abandonRequested) return;
    pending.abandonRequested = true;
    if (pending.delivery === "not_sent" || pending.writeSettled) {
      this.#track(this.#completePendingAbandonment(id, pending));
      return;
    }
    pending.writeController.abort(
      new AcpBindingError("acp_binding_request_cancelled"),
    );
  }

  async #completePendingAbandonment(
    id: AcpRequestId,
    pending: PendingRequest,
  ): Promise<void> {
    if (this.#pending.get(id) !== pending || pending.abandonCompleting) {
      return;
    }
    pending.abandonCompleting = true;
    const delivery = pending.delivery;
    if (
      delivery !== "not_sent" &&
      !(await this.#sendCancellationForPending(id, pending))
    ) {
      return;
    }
    if (this.#pending.get(id) !== pending) return;
    this.#pending.delete(id);
    pending.writeController.abort(
      new AcpBindingError("acp_binding_request_cancelled"),
    );
    this.#retirePending(id, pending, true);
    pending.reject(
      new AcpDeliveryError("acp_binding_request_cancelled", delivery),
    );
  }

  async #sendCancellation(id: AcpRequestId): Promise<void> {
    const pending = this.#pending.get(id);
    if (!pending) return;
    await this.#sendCancellationForPending(id, pending);
  }

  async #sendCancellationForPending(
    id: AcpRequestId,
    pending: PendingRequest,
  ): Promise<boolean> {
    if (pending.cancelSent || pending.delivery === "not_sent") return true;
    pending.cancelSent = true;
    const params: CancelRequestNotification = { requestId: id };
    try {
      await this.#sendWireWithDeadline(
        {
          jsonrpc: "2.0",
          method: ACP_PROTOCOL_NOTIFICATIONS.cancelRequest.method,
          params,
        },
        this.#limits.requestDeadlineMilliseconds,
      );
      return true;
    } catch (error) {
      await this.#failProtocol(
        "acp_cancel_delivery_failed",
        deliveryFrom(error),
      );
      return false;
    }
  }

  async #consumeFrames(): Promise<void> {
    try {
      for await (const frame of this.#transport.frames) {
        if (this.#closed) break;
        if (!isValidFramedTransportAssurance(this.#transport.assurance)) {
          await this.#failProtocol("acp_transport_assurance_stale");
          break;
        }
        if (frame.byteLength > this.#limits.maximumFrameBytes) {
          await this.#failProtocol("acp_frame_oversized");
          break;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(frame.text);
        } catch {
          await this.#failProtocol("acp_json_invalid");
          break;
        }
        const parsedEnvelope = parseEnvelope(raw, this.#limits.semantic);
        if (!parsedEnvelope) {
          this.#invalidEnvelopeRootType = jsonRootType(raw);
          const invalidShape = invalidEnvelopeShape(raw);
          this.#invalidEnvelopeShape = invalidShape.shape;
          this.#invalidEnvelopeUnknownKeys = invalidShape.unknownKeys;
          this.#invalidEnvelopeMethod =
            isPlainObject(raw) && validMethod(raw.method) ? raw.method : "none";
          this.#invalidEnvelopeBounds = validateAcpEnvelopeBounds(
            raw,
            this.#limits.semantic,
          )
            ? "valid"
            : "invalid";
          await this.#failProtocol("acp_envelope_invalid");
          break;
        }
        const envelope = deepFreeze(parsedEnvelope);
        this.#inboundSequence += 1;
        await this.#dispatchEnvelope(
          envelope,
          frame.byteLength,
          this.#inboundSequence,
        );
      }
      if (!this.#closed) {
        void this.#startFinalization("transport_frames_ended", true);
      }
    } catch {
      void this.#startFinalization("transport_frames_failed", true);
    }
  }

  async #dispatchEnvelope(
    envelope: ParsedEnvelope,
    frameBytes: number,
    inboundSequence: number,
  ): Promise<void> {
    switch (envelope.kind) {
      case "success":
      case "error":
        this.#handleResponse(envelope, inboundSequence);
        return;
      case "request":
        this.#track(this.#handleReverseRequest(envelope));
        return;
      case "notification":
        if (
          envelope.method === ACP_PROTOCOL_NOTIFICATIONS.cancelRequest.method
        ) {
          await this.#handleProtocolCancellation(envelope);
        } else {
          const dependency = this.#activeNotificationDependency(
            envelope.method,
          );
          if (!dependency) {
            this.#ignoreNotification(frameBytes);
            return;
          }
          if (this.#initializing && !this.#initialized) {
            if (
              this.#bufferPreInitializeNotification(
                envelope,
                frameBytes,
                dependency,
              )
            ) {
              return;
            }
          }
          if (!this.#initialized) {
            this.#deniedReverseRequests += 1;
            await this.#failProtocol("acp_notification_not_available");
            return;
          }
          if (this.#preInitializeDrain) {
            await this.#scheduleNotification(
              envelope,
              dependency,
              this.#preInitializeDrain,
            );
            return;
          }
          await this.#scheduleNotification(envelope, dependency);
        }
        return;
    }
  }

  #bufferPreInitializeNotification(
    envelope: ParsedNotification,
    frameBytes: number,
    dependency: ActiveNotificationDependency,
  ): boolean {
    const route = descriptorRoute(
      "agent_to_client",
      "notification",
      envelope.method,
    );
    if (!this.#preInitializeNotificationRoutes.has(route)) return false;
    const { descriptor, registration } = dependency;
    const projectedParams = snapshotAcpValue(
      envelope.params,
      descriptor.decodeParams,
      descriptor.validateParams,
      this.#limits.semantic,
      this.#limits.maximumFrameBytes,
    );
    if (
      !descriptor ||
      descriptor.kind !== "notification" ||
      descriptor.direction !== "agent_to_client" ||
      !this.#profiles.has(descriptor.requiredProfile) ||
      !registration ||
      projectedParams === undefined
    ) {
      void this.#failProtocol("acp_notification_invalid");
      return true;
    }
    if (
      this.#preInitializeNotifications.length >=
        this.#preInitializeNotificationMaximumCount ||
      frameBytes >
        this.#preInitializeNotificationMaximumAggregateFrameBytes -
          this.#preInitializeNotificationBytes
    ) {
      void this.#failProtocol(
        "acp_preinitialize_notification_buffer_overloaded",
      );
      return true;
    }
    this.#preInitializeNotifications.push({
      envelope: { ...envelope, params: projectedParams },
      descriptor,
      registration,
      frameBytes,
    });
    this.#preInitializeNotificationBytes += frameBytes;
    this.#preInitializeNotificationObserved = true;
    return true;
  }

  #activeNotificationDependency(
    method: string,
  ): ActiveNotificationDependency | undefined {
    const route = descriptorRoute("agent_to_client", "notification", method);
    const descriptor = this.#descriptorsByRoute.get(route);
    const registration = this.#reverseHandlers.get(route);
    if (
      !descriptor ||
      descriptor.kind !== "notification" ||
      descriptor.direction !== "agent_to_client" ||
      !this.#profiles.has(descriptor.requiredProfile) ||
      !registration
    ) {
      return undefined;
    }
    return { descriptor, registration };
  }

  #ignoreNotification(frameBytes: number): void {
    this.#ignoredNotifications = saturatingAdd(this.#ignoredNotifications, 1);
    this.#ignoredNotificationBytes = saturatingAdd(
      this.#ignoredNotificationBytes,
      frameBytes,
    );
  }

  async #drainPreInitializeNotifications(): Promise<void> {
    while (!this.#closed && this.#preInitializeNotifications.length > 0) {
      const buffered = this.#preInitializeNotifications.shift();
      if (!buffered) break;
      this.#preInitializeNotificationBytes -= buffered.frameBytes;
      if (
        buffered.descriptor.reverseCapability &&
        !safePredicate(
          () =>
            buffered.descriptor.reverseCapability?.(
              this.#clientCapabilities,
              buffered.envelope.params,
            ) ?? false,
        )
      ) {
        await this.#failProtocol("acp_notification_invalid");
        continue;
      }
      try {
        await this.#scheduleAdmittedNotification(buffered, undefined, true);
      } catch {
        if (!this.#closed) {
          await this.#failProtocol(
            "acp_preinitialize_notification_scheduling_failed",
          );
        }
        return;
      }
    }
    if (this.#closed) this.#clearPreInitializeNotifications();
  }

  #clearPreInitializeNotifications(): void {
    this.#preInitializeNotifications.length = 0;
    this.#preInitializeNotificationBytes = 0;
  }

  #handleResponse(
    envelope: ParsedSuccessResponse | ParsedErrorResponse,
    inboundSequence: number,
  ): void {
    const pending = this.#pending.get(envelope.id);
    if (!pending) {
      if (this.#tombstones.has(envelope.id)) {
        this.#rejectedLateResponses += 1;
        if (this.#abandonedTombstones.has(envelope.id)) {
          this.#observeAbandonedSettlement(envelope.id);
          return;
        }
        void this.#failProtocol("acp_response_duplicate");
        return;
      }
      void this.#failProtocol("acp_response_id_unknown");
      return;
    }
    if (pending.abandonRequested) {
      pending.delivery = "sent_outcome_unknown";
      this.#observeAbandonedSettlement(envelope.id, pending);
      this.#track(this.#completePendingAbandonment(envelope.id, pending));
      return;
    }
    if (
      pending.deadlineAt !== undefined &&
      performance.now() >= pending.deadlineAt
    ) {
      this.#pending.delete(envelope.id);
      this.#retirePending(envelope.id, pending);
      pending.reject(
        new AcpDeliveryError("acp_binding_request_deadline", pending.delivery),
      );
      void this.#failProtocol("acp_request_deadline", pending.delivery);
      return;
    }
    if (envelope.kind === "error") {
      this.#pending.delete(envelope.id);
      pending.cutoverTransferred = true;
      this.#retirePending(envelope.id, pending);
      const error = new AcpRemoteError(envelope.error.code);
      if (pending.resultMode === "settlement") {
        pending.resolve(
          this.#requestSettlementReceipt(
            inboundSequence,
            {
              kind: "remote_error",
              error,
            },
            pending.notificationCutover,
          ),
        );
      } else {
        pending.reject(error);
      }
      return;
    }
    let valid = false;
    let projectedResult: unknown;
    try {
      projectedResult = snapshotAcpValue(
        envelope.result,
        pending.descriptor.decodeResponse,
        pending.descriptor.validateResponse,
        this.#limits.semantic,
        this.#limits.maximumFrameBytes,
      );
      valid =
        projectedResult !== undefined &&
        (!pending.descriptor.validateResponseForRequest ||
          pending.descriptor.validateResponseForRequest(
            projectedResult,
            pending.request,
          )) &&
        (!pending.descriptor.validateResponseForCapabilities ||
          pending.descriptor.validateResponseForCapabilities(
            projectedResult,
            this.#clientCapabilities,
            this.#agentCapabilities,
          ));
    } catch {
      valid = false;
    }
    const deadlineExceeded =
      pending.deadlineAt !== undefined &&
      performance.now() >= pending.deadlineAt;
    this.#pending.delete(envelope.id);
    pending.cutoverTransferred = true;
    this.#retirePending(envelope.id, pending);
    if (deadlineExceeded) {
      pending.reject(
        new AcpDeliveryError("acp_binding_request_deadline", pending.delivery),
      );
      void this.#failProtocol("acp_request_deadline", pending.delivery);
      return;
    }
    if (!valid) {
      pending.reject(
        new AcpDeliveryError("acp_binding_closed", "sent_outcome_unknown"),
      );
      void this.#failProtocol("acp_response_invalid");
      return;
    }
    if (pending.resultMode === "response") {
      pending.resolve(projectedResult);
      return;
    }
    pending.resolve(
      this.#requestSettlementReceipt(
        inboundSequence,
        {
          kind: "success",
          response: projectedResult,
        },
        pending.notificationCutover,
      ),
    );
  }

  #requestSettlementReceipt<Response>(
    inboundSequence: number,
    outcome:
      | { readonly kind: "success"; readonly response: Response }
      | { readonly kind: "remote_error"; readonly error: AcpRemoteError },
    cutover: AcpSettlementRequestOptions["notificationCutover"] | undefined,
  ): AcpRequestSettlement<Response> {
    const notificationTails = new Map(this.#notificationTails);
    let releaseCutover: (() => void) | undefined;
    let cutoverBarrier: Promise<void> | undefined;
    if (cutover) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      releaseCutover = release;
      this.#activeNotificationCutoverReleases.add(release);
      if (cutover.kind === "all") {
        cutoverBarrier = released;
        this.#globalNotificationCutoverBarriers.add(released);
      } else {
        const prior = this.#notificationTails.get(cutover.orderingKey);
        cutoverBarrier = Promise.all([prior, released]).then(() => undefined);
        this.#notificationTails.set(cutover.orderingKey, cutoverBarrier);
      }
    }
    let committed = false;
    const cutoverDeadline = cutover
      ? setTimeout(() => {
          releaseCutover?.();
          this.#releaseNotificationCutover(cutover);
          void this.#failProtocol("acp_notification_cutover_deadline");
        }, this.#limits.reverseRequestDeadlineMilliseconds)
      : undefined;
    cutoverDeadline?.unref?.();
    const drain = async (tails: readonly (Promise<void> | undefined)[]) => {
      await Promise.all(tails);
      if (this.#closed) throw new AcpBindingError("acp_binding_closed");
    };
    return Object.freeze({
      ...outcome,
      inboundSequence,
      commitNotificationCutover: async <Result>(commit: () => Result) => {
        if (committed) {
          throw new AcpBindingError("acp_binding_protocol_violation");
        }
        committed = true;
        try {
          if (cutover?.kind === "ordering_key") {
            await drain([notificationTails.get(cutover.orderingKey)]);
          } else {
            await drain([...notificationTails.values()]);
          }
          const result = commit();
          if (
            typeof result === "object" &&
            result !== null &&
            "then" in result &&
            typeof result.then === "function"
          ) {
            throw new AcpBindingError("acp_binding_protocol_violation");
          }
          if (this.#closed) {
            throw new AcpBindingError("acp_binding_closed");
          }
          return result;
        } finally {
          if (cutoverDeadline) clearTimeout(cutoverDeadline);
          releaseCutover?.();
          if (releaseCutover) {
            this.#activeNotificationCutoverReleases.delete(releaseCutover);
          }
          if (cutover) this.#releaseNotificationCutover(cutover);
          if (cutover?.kind === "all" && cutoverBarrier) {
            this.#globalNotificationCutoverBarriers.delete(cutoverBarrier);
          } else if (
            cutover?.kind === "ordering_key" &&
            cutoverBarrier &&
            this.#notificationTails.get(cutover.orderingKey) === cutoverBarrier
          ) {
            this.#notificationTails.delete(cutover.orderingKey);
          }
        }
      },
    });
  }

  async #handleReverseRequest(envelope: ParsedRequest): Promise<void> {
    if (
      this.#activeReverse.has(envelope.id) ||
      this.#reverseTombstones.has(envelope.id)
    ) {
      await this.#failProtocol("acp_reverse_id_duplicate");
      return;
    }
    if (!isValidFramedTransportAssurance(this.#transport.assurance)) {
      await this.#failProtocol("acp_transport_assurance_stale");
      return;
    }
    if (this.#activeReverse.size >= this.#limits.maximumReverseRequests) {
      this.#addReverseTombstone(envelope.id);
      this.#deniedReverseRequests += 1;
      await this.#sendError(envelope.id, -32000, "Server overloaded");
      return;
    }
    const controller = new AbortController();
    this.#activeReverse.set(envelope.id, controller);
    const deadlineAt =
      performance.now() + this.#limits.reverseRequestDeadlineMilliseconds;
    let workSettled = true;
    let lifecycleFinished = false;
    let responseDelivery: FrameDelivery | undefined;
    const hardDeadline = setTimeout(() => {
      controller.abort(new AcpBindingError("acp_binding_request_deadline"));
      void this.#failProtocol("acp_reverse_request_deadline", responseDelivery);
    }, this.#limits.reverseRequestDeadlineMilliseconds);
    hardDeadline.unref?.();
    const sendTerminalError = async (
      code: number,
      message: string,
    ): Promise<void> => {
      responseDelivery = "sent_outcome_unknown";
      await this.#sendError(
        envelope.id,
        code,
        message,
        remainingDeadline(deadlineAt),
      );
    };
    let reverseWork:
      | Promise<
          | { readonly kind: "denied" }
          | { readonly kind: "response"; readonly value: unknown }
        >
      | undefined;
    try {
      const route = descriptorRoute(
        "agent_to_client",
        "request",
        envelope.method,
      );
      const descriptor = this.#descriptorsByRoute.get(route);
      const registration = this.#reverseHandlers.get(route);
      if (
        !this.#initialized ||
        !descriptor ||
        descriptor.kind !== "request" ||
        descriptor.direction !== "agent_to_client" ||
        !this.#profiles.has(descriptor.requiredProfile) ||
        !registration
      ) {
        this.#deniedReverseRequests += 1;
        await sendTerminalError(-32601, "Method not available");
        return;
      }
      const projectedRequest = snapshotAcpValue(
        envelope.params,
        descriptor.decodeRequest,
        descriptor.validateRequest,
        this.#limits.semantic,
        this.#limits.maximumFrameBytes,
      );
      if (projectedRequest === undefined) {
        await sendTerminalError(-32602, "Invalid params");
        return;
      }
      if (
        descriptor.reverseCapability &&
        !descriptor.reverseCapability(
          this.#clientCapabilities,
          projectedRequest,
        )
      ) {
        this.#deniedReverseRequests += 1;
        await sendTerminalError(-32601, "Method not available");
        return;
      }
      const context = this.#reverseContext(controller.signal, envelope.id);
      let responseSnapshot: unknown;
      workSettled = false;
      reverseWork = (async () => {
        const authorized = await registration.authorize(
          projectedRequest,
          context,
        );
        if (!authorized) return { kind: "denied" as const };
        return {
          kind: "response" as const,
          value: await registration.dispatch(projectedRequest, context),
        };
      })();
      void reverseWork.then(
        () => {
          workSettled = true;
          if (lifecycleFinished) {
            this.#activeReverse.delete(envelope.id);
            clearTimeout(hardDeadline);
          }
        },
        () => {
          workSettled = true;
          if (lifecycleFinished) {
            this.#activeReverse.delete(envelope.id);
            clearTimeout(hardDeadline);
          }
        },
      );
      this.#track(
        reverseWork.then(
          () => undefined,
          () => undefined,
        ),
      );
      const response = await boundedReverseWork(
        reverseWork,
        controller,
        remainingDeadline(deadlineAt),
      );
      if (performance.now() >= deadlineAt) {
        controller.abort(new AcpBindingError("acp_binding_request_deadline"));
        this.#handlerFailures += 1;
        await this.#failProtocol(
          "acp_reverse_request_deadline",
          responseDelivery,
        );
        return;
      }
      if (response.kind === "denied") {
        this.#deniedReverseRequests += 1;
        await sendTerminalError(-32601, "Method not available");
        return;
      }
      if (controller.signal.aborted) {
        await sendTerminalError(-32800, "Request cancelled");
        return;
      }
      responseSnapshot = snapshotAcpValue(
        response.value,
        descriptor.decodeResponse,
        descriptor.validateResponse,
        this.#limits.semantic,
        this.#limits.maximumFrameBytes,
      );
      if (
        responseSnapshot === undefined ||
        (descriptor.validateResponseForRequest &&
          !descriptor.validateResponseForRequest(
            responseSnapshot,
            projectedRequest,
          ))
      ) {
        this.#handlerFailures += 1;
        if (performance.now() >= deadlineAt) {
          controller.abort(new AcpBindingError("acp_binding_request_deadline"));
          await this.#failProtocol(
            "acp_reverse_request_deadline",
            responseDelivery,
          );
          return;
        }
        await sendTerminalError(-32603, "Request failed");
        return;
      }
      if (performance.now() >= deadlineAt) {
        controller.abort(new AcpBindingError("acp_binding_request_deadline"));
        this.#handlerFailures += 1;
        await this.#failProtocol(
          "acp_reverse_request_deadline",
          responseDelivery,
        );
        return;
      }
      try {
        responseDelivery = "sent_outcome_unknown";
        await this.#sendWireWithDeadline(
          {
            jsonrpc: "2.0",
            id: envelope.id,
            result: responseSnapshot,
          },
          remainingDeadline(deadlineAt),
        );
      } catch (error) {
        const delivery = deliveryFrom(error);
        await this.#failProtocol(
          performance.now() >= deadlineAt ||
            (controller.signal.reason instanceof AcpBindingError &&
              controller.signal.reason.code === "acp_binding_request_deadline")
            ? "acp_reverse_request_deadline"
            : delivery === "sent_outcome_unknown"
              ? "acp_reverse_response_delivery_unknown"
              : "acp_reverse_response_not_sent",
          delivery,
        );
      }
    } catch (error) {
      if (
        performance.now() >= deadlineAt ||
        (error instanceof AcpBindingError &&
          error.code === "acp_binding_request_deadline")
      ) {
        this.#handlerFailures += 1;
        await this.#failProtocol(
          "acp_reverse_request_deadline",
          responseDelivery,
        );
        return;
      }
      const cancelled =
        controller.signal.aborted &&
        error instanceof AcpBindingError &&
        error.code === "acp_binding_request_cancelled";
      if (!cancelled) this.#handlerFailures += 1;
      await sendTerminalError(
        cancelled ? -32800 : -32603,
        cancelled ? "Request cancelled" : "Request failed",
      );
    } finally {
      lifecycleFinished = true;
      this.#addReverseTombstone(envelope.id);
      if (workSettled || !reverseWork) {
        this.#activeReverse.delete(envelope.id);
        clearTimeout(hardDeadline);
      }
    }
  }

  async #handleProtocolCancellation(
    envelope: ParsedNotification,
  ): Promise<void> {
    const projectedCancel = snapshotAcpValue(
      envelope.params,
      ACP_PROTOCOL_NOTIFICATIONS.cancelRequest.decodeParams,
      ACP_PROTOCOL_NOTIFICATIONS.cancelRequest.validateParams,
      this.#limits.semantic,
      this.#limits.maximumFrameBytes,
    );
    if (projectedCancel === undefined) {
      await this.#failProtocol("acp_cancel_invalid");
      return;
    }
    const cancel = projectedCancel as CancelRequestNotification;
    if (!validRequestId(cancel.requestId)) {
      await this.#failProtocol("acp_cancel_id_invalid");
      return;
    }
    const controller = this.#activeReverse.get(cancel.requestId);
    controller?.abort(new AcpBindingError("acp_binding_request_cancelled"));
  }

  async #handleAdmittedNotification(
    admitted: AdmittedNotification,
  ): Promise<void> {
    const { envelope, registration } = admitted;
    if (
      this.#closed ||
      !isValidFramedTransportAssurance(this.#transport.assurance)
    ) {
      return;
    }
    if (this.#activeNotifications >= this.#limits.maximumNotificationHandlers) {
      await this.#failProtocol("acp_notification_invalid");
      return;
    }
    this.#activeNotifications += 1;
    const controller = new AbortController();
    const deadlineAt =
      performance.now() + this.#limits.reverseRequestDeadlineMilliseconds;
    this.#activeNotificationControllers.add(controller);
    const context = this.#reverseContext(controller.signal);
    try {
      const notificationWork = (async () => {
        if (!(await registration.authorize(envelope.params, context))) {
          return "denied" as const;
        }
        await registration.dispatch(envelope.params, context);
        return "handled" as const;
      })();
      this.#track(
        notificationWork.then(
          () => undefined,
          () => undefined,
        ),
      );
      const outcome = await boundedReverseWork(
        notificationWork,
        controller,
        remainingDeadline(deadlineAt),
      );
      if (performance.now() >= deadlineAt) {
        controller.abort(new AcpBindingError("acp_binding_request_deadline"));
        this.#handlerFailures += 1;
        await this.#failProtocol("acp_notification_deadline");
        return;
      }
      if (outcome === "denied") {
        this.#deniedReverseRequests += 1;
        await this.#failProtocol("acp_notification_authority_denied");
      }
    } catch (error) {
      if (this.#closed) return;
      this.#handlerFailures += 1;
      if (
        performance.now() >= deadlineAt ||
        (error instanceof AcpBindingError &&
          error.code === "acp_binding_request_deadline")
      ) {
        await this.#failProtocol("acp_notification_deadline");
      } else {
        await this.#failProtocol("acp_notification_handler_failed");
      }
    } finally {
      this.#activeNotificationControllers.delete(controller);
      this.#activeNotifications -= 1;
    }
  }

  #admitNotification(
    envelope: ParsedNotification,
    dependency: ActiveNotificationDependency,
  ): AdmittedNotification | typeof IGNORED_ADMITTED_NOTIFICATION | undefined {
    const { descriptor, registration } = dependency;
    if (registration.notificationDisposition) {
      let disposition: "dispatch" | "ignore";
      try {
        disposition = registration.notificationDisposition(envelope.params);
      } catch {
        void this.#failProtocol("acp_notification_invalid");
        return undefined;
      }
      if (disposition === "ignore") return IGNORED_ADMITTED_NOTIFICATION;
      if (disposition !== "dispatch") {
        void this.#failProtocol("acp_notification_invalid");
        return undefined;
      }
    }
    const projectedParams = snapshotAcpValue(
      envelope.params,
      descriptor.decodeParams,
      descriptor.validateParams,
      this.#limits.semantic,
      this.#limits.maximumFrameBytes,
    );
    if (
      projectedParams === undefined ||
      (descriptor.reverseCapability &&
        !safePredicate(
          () =>
            descriptor.reverseCapability?.(
              this.#clientCapabilities,
              projectedParams,
            ) ?? false,
        ))
    ) {
      void this.#failProtocol("acp_notification_invalid");
      return undefined;
    }
    return {
      envelope: { ...envelope, params: projectedParams },
      descriptor,
      registration,
    };
  }

  async #scheduleNotification(
    envelope: ParsedNotification,
    dependency: ActiveNotificationDependency,
    startupBarrier?: Promise<void>,
  ): Promise<void> {
    const admitted = this.#admitNotification(envelope, dependency);
    if (!admitted || admitted === IGNORED_ADMITTED_NOTIFICATION) {
      return;
    }
    if (
      startupBarrier === undefined &&
      admitted.registration.inlineNotification &&
      this.#globalNotificationCutoverBarriers.size === 0
    ) {
      let orderingKey: string | undefined;
      try {
        orderingKey = admitted.descriptor.notificationOrderingKey?.(
          admitted.envelope.params,
        );
      } catch {
        void this.#failProtocol("acp_notification_ordering_key_invalid");
        return;
      }
      if (
        orderingKey !== undefined &&
        (orderingKey.length === 0 ||
          Buffer.byteLength(orderingKey, "utf8") > 256)
      ) {
        void this.#failProtocol("acp_notification_ordering_key_invalid");
        return;
      }
      if (
        orderingKey === undefined ||
        !this.#notificationTails.has(orderingKey)
      ) {
        this.#handleInlineAdmittedNotification(admitted);
        return;
      }
    }
    await this.#scheduleAdmittedNotification(admitted, startupBarrier, false);
  }

  #handleInlineAdmittedNotification(admitted: AdmittedNotification): void {
    const inline = admitted.registration.inlineNotification;
    if (!inline || this.#closed) return;
    if (!isValidFramedTransportAssurance(this.#transport.assurance)) {
      void this.#failProtocol("acp_transport_assurance_stale");
      return;
    }
    const controller = new AbortController();
    this.#activeNotificationControllers.add(controller);
    this.#activeNotifications += 1;
    const deadlineAt =
      performance.now() + this.#limits.reverseRequestDeadlineMilliseconds;
    try {
      const context = this.#reverseContext(controller.signal);
      const authorized = inline.authorize(admitted.envelope.params, context);
      if (isPromiseLike(authorized)) {
        throw new AcpBindingError("acp_binding_protocol_violation");
      }
      if (!authorized) {
        this.#deniedReverseRequests += 1;
        void this.#failProtocol("acp_notification_authority_denied");
        return;
      }
      const result = inline.dispatch(admitted.envelope.params, context);
      if (isPromiseLike(result)) {
        throw new AcpBindingError("acp_binding_protocol_violation");
      }
      if (performance.now() >= deadlineAt) {
        this.#handlerFailures += 1;
        void this.#failProtocol("acp_notification_deadline");
      }
    } catch {
      if (!this.#closed) {
        this.#handlerFailures += 1;
        void this.#failProtocol("acp_notification_handler_failed");
      }
    } finally {
      this.#activeNotificationControllers.delete(controller);
      this.#activeNotifications -= 1;
    }
  }

  async #scheduleAdmittedNotification(
    admitted: AdmittedNotification,
    startupBarrier?: Promise<void>,
    awaitCompletion = false,
  ): Promise<void> {
    const { descriptor, envelope } = admitted;
    let orderingKey: string | undefined;
    try {
      orderingKey = descriptor.notificationOrderingKey?.(envelope.params);
    } catch {
      await this.#failProtocol("acp_notification_ordering_key_invalid");
      return;
    }
    if (orderingKey !== undefined) {
      if (
        orderingKey.length === 0 ||
        Buffer.byteLength(orderingKey, "utf8") > 256
      ) {
        await this.#failProtocol("acp_notification_ordering_key_invalid");
        return;
      }
    }
    if (!(await this.#waitForNotificationAdmission(orderingKey))) return;
    if (orderingKey !== undefined) {
      const depth = this.#notificationDepth.get(orderingKey) ?? 0;
      this.#notificationDepth.set(orderingKey, depth + 1);
    }
    this.#pendingNotifications += 1;
    const prior = orderingKey
      ? this.#notificationTails.get(orderingKey)
      : undefined;
    const task = Promise.all([
      prior ?? Promise.resolve(),
      startupBarrier ?? Promise.resolve(),
      ...this.#globalNotificationCutoverBarriers,
    ]).then(async () => {
      await this.#handleAdmittedNotification(admitted);
    });
    if (orderingKey !== undefined) {
      this.#notificationTails.set(orderingKey, task);
    }
    const tracked = task.finally(() => {
      this.#pendingNotifications -= 1;
      if (orderingKey !== undefined) {
        const remaining = (this.#notificationDepth.get(orderingKey) ?? 1) - 1;
        if (remaining <= 0) this.#notificationDepth.delete(orderingKey);
        else this.#notificationDepth.set(orderingKey, remaining);
        if (this.#notificationTails.get(orderingKey) === task) {
          this.#notificationTails.delete(orderingKey);
        }
      }
      this.#wakeNotificationAdmissionWaiters();
    });
    this.#track(tracked);
    if (awaitCompletion) await tracked;
  }

  async #waitForNotificationAdmission(
    orderingKey: string | undefined,
  ): Promise<boolean> {
    while (!this.#closed && !this.#notificationCapacityAvailable(orderingKey)) {
      await new Promise<void>((resolve) => {
        this.#notificationAdmissionWaiters.add(resolve);
      });
    }
    return !this.#closed;
  }

  #notificationCapacityAvailable(orderingKey: string | undefined): boolean {
    return (
      this.#pendingNotifications < this.#limits.maximumNotificationHandlers &&
      (orderingKey === undefined ||
        (this.#notificationDepth.get(orderingKey) ?? 0) <
          this.#limits.maximumNotificationsPerOrderingKey)
    );
  }

  #wakeNotificationAdmissionWaiters(): void {
    for (const resolve of this.#notificationAdmissionWaiters) resolve();
    this.#notificationAdmissionWaiters.clear();
  }

  #reverseContext(
    signal: AbortSignal,
    requestId?: AcpRequestId,
  ): AcpReverseContext {
    return Object.freeze({
      signal,
      ...(requestId !== undefined ? { requestId } : {}),
      scope: this.#transport.assurance.scope,
      connectionGeneration: this.#transport.assurance.connectionGeneration,
    });
  }

  async #sendError(
    id: AcpRequestId,
    code: number,
    message: string,
    deadlineMilliseconds = this.#limits.reverseRequestDeadlineMilliseconds,
  ): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#sendWireWithDeadline(
        { jsonrpc: "2.0", id, error: { code, message } },
        deadlineMilliseconds,
      );
    } catch (error) {
      await this.#failProtocol(
        "acp_error_response_delivery_failed",
        deliveryFrom(error),
      );
    }
  }

  async #sendWireWithDeadline(
    value: unknown,
    milliseconds: number,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new AcpBindingError("acp_binding_request_deadline"));
    }, milliseconds);
    timer.unref?.();
    try {
      await this.#sendWire(value, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async #sendWire(value: unknown, signal?: AbortSignal): Promise<void> {
    if (this.#closed) {
      throw new AcpDeliveryError("acp_binding_closed", "not_sent");
    }
    this.#requireActiveAssurance();
    let snapshot: unknown;
    try {
      snapshot = snapshotBoundedJson(value, {
        ...this.#limits.semantic,
        maximumEncodedBytes: this.#limits.maximumFrameBytes,
      });
    } catch {
      throw new AcpDeliveryError("acp_binding_closed", "not_sent");
    }
    const text = JSON.stringify(snapshot);
    if (signal?.aborted) {
      throw new AcpDeliveryError("acp_binding_closed", "not_sent");
    }
    const write = this.#transport.send(text, signal ? { signal } : undefined);
    if (!signal) {
      await write;
      return;
    }
    await raceFrameWrite(write, signal);
  }

  #requireInitializedDescriptor(
    descriptor: AcpDescriptor,
    direction: "client_to_agent",
  ): void {
    if (
      this.#closed ||
      !this.#initialized ||
      !isAcpDescriptor(descriptor) ||
      descriptor.direction !== direction ||
      this.#descriptorsByRoute.get(
        descriptorRoute(
          descriptor.direction,
          descriptor.kind,
          descriptor.method,
        ),
      ) !== descriptor ||
      !this.#profiles.has(descriptor.requiredProfile)
    ) {
      throw new AcpBindingError(
        this.#closed ? "acp_binding_closed" : "acp_binding_protocol_violation",
      );
    }
  }

  #requireActiveAssurance(): void {
    if (isValidFramedTransportAssurance(this.#transport.assurance)) return;
    void this.#failProtocol("acp_transport_assurance_stale");
    throw new AcpDeliveryError("acp_binding_closed", "not_sent");
  }

  #addDescriptor(descriptor: AcpDescriptor): void {
    const route = descriptorRoute(
      descriptor.direction,
      descriptor.kind,
      descriptor.method,
    );
    if (this.#descriptorsByRoute.has(route)) {
      throw new Error("acp_descriptor_collision");
    }
    this.#descriptorsByRoute.set(route, descriptor);
  }

  #addReverseHandler(registration: AcpReverseRegistration): void {
    if (!reverseRegistrationBrands.has(registration)) {
      throw new Error("acp_reverse_registration_invalid");
    }
    const route = descriptorRoute(
      registration.descriptor.direction,
      registration.descriptor.kind,
      registration.descriptor.method,
    );
    const known = this.#descriptorsByRoute.get(route);
    if (
      known !== registration.descriptor ||
      this.#reverseHandlers.has(route) ||
      registration.kind !== registration.descriptor.kind
    ) {
      throw new Error("acp_reverse_registration_collision");
    }
    this.#reverseHandlers.set(route, registration);
  }

  #hasTruthfulClientCapabilityHandlers(request: InitializeRequest): boolean {
    const capabilities = request.clientCapabilities;
    const hasHandler = (descriptor: AcpDescriptor): boolean =>
      this.#reverseHandlers.has(
        descriptorRoute(
          descriptor.direction,
          descriptor.kind,
          descriptor.method,
        ),
      );
    if (
      capabilities?.fs?.readTextFile === true &&
      !hasHandler(ACP_CLIENT_REQUESTS.readTextFile)
    ) {
      return false;
    }
    if (
      capabilities?.fs?.writeTextFile === true &&
      !hasHandler(ACP_CLIENT_REQUESTS.writeTextFile)
    ) {
      return false;
    }
    if (
      capabilities?.terminal === true &&
      ![
        ACP_CLIENT_REQUESTS.createTerminal,
        ACP_CLIENT_REQUESTS.terminalOutput,
        ACP_CLIENT_REQUESTS.releaseTerminal,
        ACP_CLIENT_REQUESTS.waitForTerminalExit,
        ACP_CLIENT_REQUESTS.killTerminal,
      ].every(hasHandler)
    ) {
      return false;
    }
    if (
      capabilities?.plan != null &&
      !hasHandler(ACP_CLIENT_NOTIFICATIONS.sessionUpdate)
    ) {
      return false;
    }
    return capabilities?.elicitation == null && capabilities?.nes == null;
  }

  #addReverseTombstone(id: AcpRequestId): void {
    this.#reverseTombstones.add(id);
    this.#reverseTombstoneOrder.push(id);
    while (
      this.#reverseTombstoneOrder.length > this.#limits.maximumTombstones
    ) {
      const expired = this.#reverseTombstoneOrder.shift();
      if (expired !== undefined) this.#reverseTombstones.delete(expired);
    }
  }

  #track(task: Promise<void>): void {
    this.#continuations.add(task);
    void task.then(
      () => this.#continuations.delete(task),
      () => {
        this.#continuations.delete(task);
        void this.#failProtocol("acp_continuation_failed");
      },
    );
  }

  #retirePending(
    id: AcpRequestId,
    pending: PendingRequest,
    abandoned = false,
  ): void {
    if (pending.deadline) clearTimeout(pending.deadline);
    pending.writeController.abort(new AcpBindingError("acp_binding_closed"));
    if (pending.cancellationSignal && pending.cancellationListener) {
      pending.cancellationSignal.removeEventListener(
        "abort",
        pending.cancellationListener,
      );
    }
    if (pending.notificationCutover && !pending.cutoverTransferred) {
      this.#releaseNotificationCutover(pending.notificationCutover);
    }
    this.#tombstones.add(id);
    if (abandoned) {
      this.#abandonedTombstones.add(id);
      if (
        pending.onAbandonedSettlement &&
        !pending.abandonedSettlementObserved
      ) {
        this.#abandonedSettlementObservers.set(
          id,
          pending.onAbandonedSettlement,
        );
      }
    } else {
      this.#abandonedTombstones.delete(id);
      this.#abandonedSettlementObservers.delete(id);
    }
    this.#tombstoneOrder.push(id);
    while (this.#tombstoneOrder.length > this.#limits.maximumTombstones) {
      const expired = this.#tombstoneOrder.shift();
      if (expired !== undefined) {
        this.#tombstones.delete(expired);
        this.#abandonedTombstones.delete(expired);
        this.#abandonedSettlementObservers.delete(expired);
      }
    }
  }

  #observeAbandonedSettlement(
    id: AcpRequestId,
    pending?: PendingRequest,
  ): void {
    if (pending?.abandonedSettlementObserved) return;
    const observer =
      pending?.onAbandonedSettlement ??
      this.#abandonedSettlementObservers.get(id);
    this.#abandonedSettlementObservers.delete(id);
    if (!observer) return;
    if (pending) pending.abandonedSettlementObserved = true;
    try {
      observer();
    } catch {
      void this.#failProtocol("acp_abandoned_settlement_observer_failed");
    }
  }

  #reserveNotificationCutover(
    cutover: AcpSettlementRequestOptions["notificationCutover"],
  ): void {
    if (
      typeof cutover !== "object" ||
      cutover === null ||
      (cutover.kind !== "all" && cutover.kind !== "ordering_key") ||
      (cutover.kind === "ordering_key" &&
        typeof cutover.orderingKey !== "string")
    ) {
      throw new AcpBindingError("acp_binding_protocol_violation");
    }
    const key = cutover.kind === "all" ? "*" : cutover.orderingKey;
    if (
      (cutover.kind === "all" &&
        this.#notificationCutoverReservations.size > 0) ||
      this.#notificationCutoverReservations.has("*") ||
      this.#notificationCutoverReservations.has(key) ||
      (cutover.kind === "ordering_key" &&
        (key.length === 0 || Buffer.byteLength(key, "utf8") > 256))
    ) {
      throw new AcpBindingError("acp_binding_overloaded");
    }
    this.#notificationCutoverReservations.add(key);
  }

  #releaseNotificationCutover(
    cutover: AcpSettlementRequestOptions["notificationCutover"],
  ): void {
    this.#notificationCutoverReservations.delete(
      cutover.kind === "all" ? "*" : cutover.orderingKey,
    );
  }

  async #failProtocol(reason: string, delivery?: FrameDelivery): Promise<void> {
    if (this.#closed) return;
    this.#closeDelivery = delivery;
    this.#protocolFailures += 1;
    void this.#startFinalization(safeCloseReason(reason), true);
  }

  #startFinalization(reason: string, closeTransport: boolean): Promise<void> {
    this.#finalization ??= (async () => {
      this.#quarantine(reason);
      let cleanupFailed = false;
      if (closeTransport) {
        try {
          await this.#transport.close(reason);
        } catch {
          cleanupFailed = true;
        }
      }
      const continuationsSettled = await settleContinuations(
        this.#continuations,
        this.#limits.reverseRequestDeadlineMilliseconds,
      );
      this.#closeReason = reason;
      this.#resolveClosed(
        Object.freeze({
          reason,
          ...(this.#closeDelivery ? { delivery: this.#closeDelivery } : {}),
          ...(cleanupFailed ? { transportCleanup: "failed" as const } : {}),
          ...(!continuationsSettled
            ? { continuations: "unsettled" as const }
            : {}),
        }),
      );
    })();
    return this.#finalization;
  }

  #quarantine(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    this.#wakeNotificationAdmissionWaiters();
    this.#clearPreInitializeNotifications();
    for (const controller of this.#activeReverse.values()) {
      controller.abort(new AcpBindingError("acp_binding_closed"));
    }
    for (const controller of this.#activeNotificationControllers) {
      controller.abort(new AcpBindingError("acp_binding_closed"));
    }
    for (const release of this.#activeNotificationCutoverReleases) release();
    this.#activeNotificationCutoverReleases.clear();
    this.#notificationCutoverReservations.clear();
    this.#abandonedSettlementObservers.clear();
    for (const [id, pending] of this.#pending) {
      pending.writeController.abort(new AcpBindingError("acp_binding_closed"));
      this.#retirePending(id, pending);
      pending.reject(
        new AcpDeliveryError("acp_binding_closed", pending.delivery),
      );
    }
    this.#pending.clear();
  }
}

function jsonRootType(
  value: unknown,
): "array" | "boolean" | "null" | "number" | "object" | "string" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    default:
      return "object";
  }
}

const JSON_RPC_ENVELOPE_KEYS = new Set([
  "jsonrpc",
  "id",
  "method",
  "params",
  "result",
  "error",
]);

function invalidEnvelopeShape(value: unknown): {
  readonly shape: string;
  readonly unknownKeys: number;
} {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return { shape: "non_object", unknownKeys: 0 };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const field = (name: string, expected?: unknown): string => {
    if (!Object.hasOwn(record, name)) return "a";
    if (expected !== undefined && record[name] === expected) return "v";
    const fieldValue = record[name];
    if (fieldValue === null) return "n";
    if (Array.isArray(fieldValue)) return "l";
    switch (typeof fieldValue) {
      case "boolean":
        return "b";
      case "number":
        return "d";
      case "object":
        return "o";
      case "string":
        return "s";
      default:
        return "x";
    }
  };
  return {
    shape: [
      `j${field("jsonrpc", "2.0")}`,
      `i${field("id")}`,
      `m${field("method")}`,
      `p${field("params")}`,
      `r${field("result")}`,
      `e${field("error")}`,
      `k${Math.min(keys.length, 99)}`,
    ].join("_"),
    unknownKeys: keys.filter((key) => !JSON_RPC_ENVELOPE_KEYS.has(key)).length,
  };
}

function resolveLimits(input: AcpBindingOptions["limits"]): AcpBindingLimits {
  const limits = {
    ...DEFAULT_ACP_BINDING_LIMITS,
    ...input,
    semantic: {
      ...DEFAULT_ACP_SEMANTIC_LIMITS,
      ...input?.semantic,
    },
  };
  for (const value of [
    limits.maximumFrameBytes,
    limits.maximumPendingRequests,
    limits.maximumReverseRequests,
    limits.maximumNotificationHandlers,
    limits.maximumNotificationsPerOrderingKey,
    limits.maximumOutboundRequestsPerGeneration,
    limits.maximumTombstones,
    limits.requestDeadlineMilliseconds,
    limits.reverseRequestDeadlineMilliseconds,
    ...Object.values(limits.semantic),
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("acp_binding_limits_invalid");
    }
  }
  return Object.freeze({
    ...limits,
    semantic: Object.freeze(limits.semantic),
  });
}

function saturatingAdd(current: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + increment);
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function parseEnvelope(
  raw: unknown,
  limits: AcpSemanticLimits,
): ParsedEnvelope | undefined {
  if (!isPlainObject(raw) || !validateAcpEnvelopeBounds(raw, limits)) return;
  if (raw.jsonrpc !== "2.0") return;
  const hasId = Object.hasOwn(raw, "id");
  const hasMethod = Object.hasOwn(raw, "method");
  const hasResult = Object.hasOwn(raw, "result");
  const hasError = Object.hasOwn(raw, "error");
  if (hasMethod) {
    if (hasResult || hasError) return;
    if (!validMethod(raw.method)) return;
    if (Object.hasOwn(raw, "params") && !validParamsContainer(raw.params)) {
      return;
    }
    if (hasId) {
      if (!validRequestId(raw.id)) return;
      return {
        kind: "request",
        id: raw.id,
        method: raw.method,
        params: Object.hasOwn(raw, "params") ? raw.params : {},
      };
    }
    return {
      kind: "notification",
      method: raw.method,
      params: Object.hasOwn(raw, "params") ? raw.params : {},
    };
  }
  if (!hasId || !validRequestId(raw.id) || hasResult === hasError) return;
  if (hasResult) {
    return { kind: "success", id: raw.id, result: raw.result };
  }
  if (!isPlainObject(raw.error)) {
    return;
  }
  if (
    !Number.isSafeInteger(raw.error.code) ||
    typeof raw.error.message !== "string" ||
    Buffer.byteLength(raw.error.message, "utf8") > 1_024
  ) {
    return;
  }
  return {
    kind: "error",
    id: raw.id,
    error: {
      code: raw.error.code as number,
      message: raw.error.message,
      ...(Object.hasOwn(raw.error, "data") ? { data: raw.error.data } : {}),
    },
  };
}

function validateAcpEnvelopeBounds(
  value: unknown,
  limits: AcpSemanticLimits,
): boolean {
  const permissive: (value: unknown) => boolean = () => true;
  return validateAcpValue(value, permissive, limits);
}

function descriptorRoute(
  direction: AcpDescriptor["direction"],
  kind: AcpDescriptor["kind"],
  method: string,
): string {
  return `${direction}\u0000${kind}\u0000${method}`;
}

function validRequestId(value: unknown): value is AcpRequestId {
  return (
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    (typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= 128)
  );
}

function validMethod(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 128 &&
    /^[A-Za-z0-9_$.-]+(?:\/[A-Za-z0-9_$.-]+)*$/u.test(value)
  );
}

function validParamsContainer(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

function validateDeadline(requested: number, maximum: number): number {
  if (
    !Number.isSafeInteger(requested) ||
    requested <= 0 ||
    requested > maximum
  ) {
    throw new AcpBindingError("acp_binding_protocol_violation");
  }
  return requested;
}

function remainingDeadline(deadlineAt: number): number {
  return Math.max(1, Math.ceil(deadlineAt - performance.now()));
}

function deliveryFrom(error: unknown): FrameDelivery {
  if (error instanceof FrameWriteError || error instanceof AcpDeliveryError) {
    return error.delivery;
  }
  return "sent_outcome_unknown";
}

async function raceFrameWrite(
  write: Promise<{ readonly disposition: "sent" }>,
  signal: AbortSignal,
): Promise<void> {
  let abortListener: (() => void) | undefined;
  try {
    await Promise.race([
      write,
      new Promise<never>((_resolve, reject) => {
        abortListener = () =>
          reject(
            new AcpDeliveryError("acp_binding_closed", "sent_outcome_unknown"),
          );
        if (signal.aborted) abortListener();
        else signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

function safeCause(error: unknown): Error | undefined {
  if (error instanceof FrameWriteError) {
    return new Error("acp_transport_write_failed");
  }
  return undefined;
}

function safeCloseReason(reason: string): string {
  return /^[a-z0-9_:-]{1,128}$/u.test(reason) ? reason : "acp_binding_close";
}

async function boundedReverseWork<T>(
  work: Promise<T>,
  controller: AbortController,
  milliseconds: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        abortListener = () =>
          reject(
            controller.signal.reason instanceof AcpBindingError
              ? controller.signal.reason
              : new AcpBindingError("acp_binding_request_cancelled"),
          );
        if (controller.signal.aborted) {
          abortListener();
        } else {
          controller.signal.addEventListener("abort", abortListener, {
            once: true,
          });
        }
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(new AcpBindingError("acp_binding_request_deadline"));
          reject(new AcpBindingError("acp_binding_request_deadline"));
        }, milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) {
      controller.signal.removeEventListener("abort", abortListener);
    }
  }
}

async function settleContinuations(
  continuations: ReadonlySet<Promise<void>>,
  milliseconds: number,
): Promise<boolean> {
  if (continuations.size === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.allSettled([...continuations]).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Canonicalizes raw input, decodes its declared projection, then canonicalizes
 * the decoder output again before semantic validation. The returned value is
 * the exact bounded, prototype-free, deeply frozen JSON used by consumers or
 * embedded in a wire envelope.
 */
function snapshotAcpValue<T>(
  value: T,
  decoder: (value: unknown) => T | undefined,
  validator: (value: unknown) => boolean,
  limits: AcpSemanticLimits,
  maximumEncodedBytes: number,
): T | undefined {
  let snapshot: unknown;
  try {
    snapshot = snapshotBoundedJson(value, {
      ...limits,
      maximumEncodedBytes,
    });
  } catch {
    return undefined;
  }
  try {
    const projected = decoder(snapshot);
    if (projected === undefined) return undefined;
    snapshot = snapshotBoundedJson(projected, {
      ...limits,
      maximumEncodedBytes,
    });
    if (!validateAcpValue(snapshot, validator, limits)) return undefined;
  } catch {
    return undefined;
  }
  return snapshot as T;
}

function safePredicate(predicate: () => boolean): boolean {
  try {
    return predicate();
  } catch {
    return false;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
