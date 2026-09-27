import type { SessionCompactOutput } from "@opencode/client";
import type { EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import type { OpenCodeNativeSession, OpenCodeNativeSessionPage, OpenCodeNativeSessionListOptions,
  OpenCodeNativeMessage, OpenCodeNativeHistoryPage, OpenCodeNativeHistoryReadOptions,
  OpenCodeNativeInboxItem, OpenCodeNativeInteractions, OpenCodeNativeActivity,
  OpenCodeNativeEvent } from "./opencode-native-codecs.js";
import type { OpenCodeNativeCreateInput, OpenCodeNativePromptInput, OpenCodeNativePromptAdmission,
  OpenCodeNativeCompactInput, OpenCodeNativeModel, OpenCodeNativeModelRef, OpenCodeNativeSkill,
  OpenCodeNativePermission, OpenCodeNativePermissionReplyInput, OpenCodeNativeFormDetail,
  OpenCodeNativeFormAnswer, OpenCodeNativeLogCut, OpenCodeNativeLogReadInput } from "./opencode-native-codecs.js";
import type { OpenCodeRuntimeError } from "./opencode-release.js";

type Session = { readonly sessionID: string };
type Workspace = { readonly directory: string };
export type OpenCodeNativeSuccess = { readonly ok: true };
type Method<Input, Output> = { readonly input: Input; readonly output: Output };

/** Native identity is independent of the current authenticated carrier. */
export interface OpenCodeNativeAuthority {
  readonly tenantId: string;
  readonly principalId: string;
  readonly executionEnvironmentId: string;
  readonly backendInstanceId: string;
  readonly runtimeId: string;
  readonly nativeGeneration: string;
  readonly directory: string;
  readonly session?: { readonly applicationThreadId: string; readonly nativeSessionID: string; readonly bindingFingerprint: string };
}

/** Closed provider-private catalog. Signals and JavaScript callbacks are never wire input. */
export interface OpenCodeReadMethods {
  getSession: Method<Session, OpenCodeNativeSession>;
  listSessions: Method<Omit<OpenCodeNativeSessionListOptions, "signal">, OpenCodeNativeSessionPage>;
  getMessage: Method<Session & { readonly messageID: string }, OpenCodeNativeMessage>;
  getHistoryPage: Method<Session & Omit<OpenCodeNativeHistoryReadOptions, "signal">, OpenCodeNativeHistoryPage>;
  getActive: Method<Record<string, never>, Record<string, { type: "running" }>>;
  getPending: Method<Session, OpenCodeNativeInboxItem[]>;
  getInteractions: Method<Session, OpenCodeNativeInteractions>;
  getActivity: Method<Session & Workspace, OpenCodeNativeActivity>;
  listSkills: Method<Workspace, readonly OpenCodeNativeSkill[]>;
  listModels: Method<Workspace, readonly OpenCodeNativeModel[]>;
  getDefaultModel: Method<Workspace, OpenCodeNativeModel | null>;
  getPermission: Method<Session & { readonly requestID: string }, OpenCodeNativePermission>;
  getForm: Method<Session & { readonly formID: string }, OpenCodeNativeFormDetail>;
  readLog: Method<Omit<OpenCodeNativeLogReadInput, "signal">, Omit<OpenCodeNativeLogCut, "watermark"> & { readonly watermark: number | null }>;
}

export interface OpenCodeMutationMethods {
  createSession: Method<OpenCodeNativeCreateInput, OpenCodeNativeSession>;
  prompt: Method<OpenCodeNativePromptInput, OpenCodeNativePromptAdmission>;
  compact: Method<OpenCodeNativeCompactInput, SessionCompactOutput>;
  cancelInput: Method<Session & { readonly inboxID: string }, OpenCodeNativeSuccess>;
  setModel: Method<Session & { readonly model: OpenCodeNativeModelRef }, OpenCodeNativeSuccess>;
  renameSession: Method<Session & { readonly title: string }, OpenCodeNativeSuccess>;
  setPermissions: Method<Session & { readonly permissions: Readonly<NonNullable<OpenCodeNativeSession["permissions"]>> }, OpenCodeNativeSuccess>;
  replyPermission: Method<OpenCodeNativePermissionReplyInput, OpenCodeNativeSuccess>;
  replyForm: Method<Session & { readonly formID: string; readonly answer: OpenCodeNativeFormAnswer }, OpenCodeNativeSuccess>;
  cancelForm: Method<Session & { readonly formID: string }, OpenCodeNativeSuccess>;
  interruptSession: Method<Session, { readonly interrupted: boolean }>;
  /** Host resolves frozen definitions against its immutable launched baseline. */
  installSessionEnvironment: Method<Session & { readonly definitions: EnvironmentVariableOverrides;
    readonly definitionFingerprint: string; readonly cliAdmissionId: string | null }, OpenCodeNativeSuccess>;
  /** Host constructs the fixed bundled bridge command and credentials. */
  ensureMcpRegistration: Method<Workspace & { readonly registrationAdmissionId: string }, OpenCodeNativeSuccess>;
}

/** A single Send can perform multiple distinct native writes. */
export type OpenCodeMutationIdentity = Readonly<{
  origin: "application";
  applicationOperationId: string;
  operationKind: "create" | "submit" | "steer" | "action" | "interaction" | "interrupt";
  step: string;
}> | Readonly<{ origin: "host"; operationId: string; step: string }>;
export type OpenCodeApplicationOperationIdentity = Pick<Extract<OpenCodeMutationIdentity, { origin: "application" }>,
  "applicationOperationId" | "operationKind">;
export interface OpenCodeMutationControl {
  readonly identity: OpenCodeMutationIdentity;
  /** Original application deadline, or null when the application has none. */
  readonly deadlineAt: number | null;
}

export type OpenCodeNativeFailure =
  | Readonly<{ kind: "mutation_refused"; delivery: "not_sent"; code: string }>
  | Readonly<{ kind: "mutation_unknown"; delivery: "sent_outcome_unknown"; code: string }>
  | Readonly<{ kind: "runtime"; code: string }>
  | Readonly<{ kind: "protocol"; code: string }>
  | Readonly<{ kind: "read_limit"; limit: "response_bytes" | "inventory_records" }>
  | Readonly<{ kind: "log"; reason: "input" | "bytes" | "records" | "time" | "cancelled" | "invalid" | "incomplete" }>;
export type OpenCodeMutationOutcome<Output> =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "completed"; result: Output }>
  | Readonly<{ status: "failed"; failure: OpenCodeNativeFailure }>;
export type OpenCodeReadMethod = keyof OpenCodeReadMethods;
export type OpenCodeMutationMethod = keyof OpenCodeMutationMethods;
export type OpenCodeReadInput<K extends OpenCodeReadMethod> = OpenCodeReadMethods[K]["input"];
export type OpenCodeReadOutput<K extends OpenCodeReadMethod> = OpenCodeReadMethods[K]["output"];
export type OpenCodeMutationInput<K extends OpenCodeMutationMethod> = OpenCodeMutationMethods[K]["input"];
export type OpenCodeMutationOutput<K extends OpenCodeMutationMethod> = OpenCodeMutationMethods[K]["output"];

export interface OpenCodeObservationCursor { readonly journalId: string; readonly sequence: number; }
export interface OpenCodeNativeProof {
  readonly nativeSequence: number; readonly fingerprint: string; readonly type: string;
  readonly inputId: string | null; readonly boundaryId: string | null;
}
export interface OpenCodeNativeProofBaseline {
  readonly nativeFrontier: number | null; readonly coverageFloor: number | null;
  readonly currentInputId: string | null; readonly authorityEpoch: number;
  readonly proofs: readonly OpenCodeNativeProof[];
}
interface OpenCodeObservationPosition {
  readonly journalId: string;
  readonly sequence: number;
  readonly nativeContinuity: string;
  readonly decodedBytes: number;
}
export type OpenCodeObservationRecord = OpenCodeObservationPosition & (
  | { readonly kind: "native"; readonly event: OpenCodeNativeEvent }
  | { readonly kind: "native_break"; readonly reason: "disconnected" | "malformed" | "overflow" | "owner_lost" });
export interface OpenCodeObservationBoundary {
  readonly journalId: string; readonly throughSequence: number; readonly retainedAfterSequence: number;
  readonly nativeConnected: boolean; readonly nativeContinuity: string;
  readonly proof: OpenCodeNativeProofBaseline;
}
export interface OpenCodeObservationEnd {
  readonly reason: "closed" | "aborted" | "disconnected" | "malformed" | "overflow" | "failed" | "resnapshot_required" | "superseded";
  readonly error?: OpenCodeRuntimeError;
}
/** In-process interface; only strict DTOs are serialized by the sidecar client. */
export interface OpenCodePortObservation {
  readonly ready: Promise<OpenCodeObservationBoundary>;
  readonly ended: Promise<OpenCodeObservationEnd>;
  readonly failure: OpenCodeRuntimeError | undefined;
  drain(): OpenCodeObservationRecord[];
  wait(signal?: AbortSignal): Promise<void>;
  acknowledge(cursor: OpenCodeObservationCursor): Promise<void>;
  close(): Promise<void>;
}
export interface OpenCodeNativePort {
  readonly authority: OpenCodeNativeAuthority;
  /** Stable owner identity, independent of socket or facade object identity. */
  readonly ownerKey: string;
  /** Ends presentation authority, never permission to stop the retained owner. */
  readonly lifetime: AbortSignal;
  read<K extends OpenCodeReadMethod>(method: K, input: OpenCodeReadInput<K>,
    options?: { readonly signal?: AbortSignal; readonly deadlineAt?: number }): Promise<OpenCodeReadOutput<K>>;
  mutate<K extends OpenCodeMutationMethod>(method: K, input: OpenCodeMutationInput<K>, control: OpenCodeMutationControl,
    options?: { readonly signal?: AbortSignal }): Promise<OpenCodeMutationOutput<K>>;
  outcome<K extends OpenCodeMutationMethod>(method: K, identity: OpenCodeMutationIdentity): Promise<OpenCodeMutationOutcome<OpenCodeMutationOutput<K>>>;
  /** After a durable terminal application receipt. Pending native work remains
   * retained until settlement, then the host applies this release intent. */
  acknowledgeMutation(method: OpenCodeMutationMethod, identity: OpenCodeMutationIdentity): Promise<void>;
  /** Release all currently retained substeps after the exact main operation's
   * durable disposition. Includes dynamic Stop withdrawal identities. */
  acknowledgeOperation(identity: OpenCodeApplicationOperationIdentity): Promise<void>;
  observe(input: { readonly purpose: "evidence" | "presentation"; readonly after?: OpenCodeObservationCursor; readonly signal?: AbortSignal }): OpenCodePortObservation;
}

/** These effects must not queue behind history/body transfers. */
export const OPENCODE_CONTROL_MUTATIONS: ReadonlySet<OpenCodeMutationMethod> = new Set([
  "interruptSession", "cancelInput", "replyPermission", "replyForm", "cancelForm",
]);
