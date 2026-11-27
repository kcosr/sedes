import type { InitializeResponse, LoadSessionResponse, PromptRequest, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import type { EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import type { EnvironmentChannelScope } from "../../execution/environment-channel.js";
import type { AntigravityNativeHistory } from "./native-schema.js";

/** Provider-private values; all paths refer to the execution host. */
export interface AntigravityRuntimeConfiguration extends EnvironmentChannelScope {
  readonly executablePath?: string;
  readonly geminiDirectory?: string;
  readonly initializationTimeoutMs: number;
  readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
}
export interface AntigravityIdentity { readonly sessionId: string; readonly cwd: string; }
export interface AntigravitySessionSummary extends AntigravityIdentity { readonly title?: string; readonly updatedAt?: string; }
export interface AntigravityAgentTools {
  readonly surface: "native" | "cli";
  readonly mode: "progressive" | "individual";
  readonly endpoint: string;
  readonly sourceCapability: string;
  readonly executableDirectory: string;
  readonly inheritedPath: string;
}
export interface AntigravitySetup {
  readonly initialize: InitializeResponse;
  readonly session: LoadSessionResponse;
  readonly modelOptions?: readonly { readonly modelId: string; readonly thinkingLevels: readonly string[]; readonly defaultThinkingLevel?: string }[];
}
export interface AntigravityHistory extends AntigravityIdentity {
  readonly setup?: AntigravitySetup;
  readonly native: AntigravityNativeHistory;
}
export type AntigravityCommand =
  | { readonly type: "prompt"; readonly prompt: PromptRequest["prompt"] }
  | { readonly type: "steer"; readonly prompt: PromptRequest["prompt"] }
  | { readonly type: "cancel" }
  | { readonly type: "set_config"; readonly configId: string; readonly value: string }
  | { readonly type: "set_mode"; readonly modeId: string }
  | { readonly type: "permission"; readonly requestId: string; readonly response: RequestPermissionResponse };
export type AntigravityFailure = { readonly code: string; readonly delivery: "not_sent" | "sent_outcome_unknown" | "rejected" };
export type AntigravityOutcome =
  | { readonly status: "pending" }
  | { readonly status: "completed"; readonly result: unknown; readonly cancelledAtNativeRevision?: string }
  | { readonly status: "failed"; readonly failure: AntigravityFailure };
export type AntigravityEvent = { readonly sequence: number } & (
  | { readonly kind: "update"; readonly notification: SessionNotification }
  | { readonly kind: "session_loaded"; readonly session: LoadSessionResponse }
  | { readonly kind: "permission"; readonly requestId: string; readonly openedAt: string; readonly request: RequestPermissionRequest }
  | { readonly kind: "permission_resolved"; readonly requestId: string }
  | { readonly kind: "operation"; readonly operationId: string; readonly outcome: AntigravityOutcome }
  | { readonly kind: "failure"; readonly failure: AntigravityFailure });
export interface AntigravityAttachment extends AntigravityIdentity {
  /** Exact bound session awaiting its load response after an early permission. */
  readonly loading?: true;
  readonly toolPeerStamp?: string;
  readonly createdByOperationId?: string;
  readonly handleId: string;
  readonly generation: string;
  readonly setup: AntigravitySetup;
  readonly throughSequence: number;
  readonly retainedAfterSequence: number;
  readonly retainedOperationIds: readonly string[];
  readonly activePromptIds: readonly string[];
  readonly pendingPermissions: readonly { readonly requestId: string; readonly openedAt: string; readonly request: RequestPermissionRequest }[];
}
export interface AntigravityObservation {
  /** Pending ACP prompts at the time this event page was read. */
  readonly activePromptIds: readonly string[];
  readonly events: readonly AntigravityEvent[];
  readonly throughSequence: number;
  readonly retainedAfterSequence: number;
  readonly closed: boolean;
}
export interface AntigravityInspection {
  readonly runtimeId: string;
  readonly state: "idle" | "active" | "unknown";
  readonly revision: string;
  readonly blockers: readonly ("active_work" | "pending_interaction" | "unsettled_outcome" | "cleanup_unproven" | "unknown_state")[];
  readonly retainedSessions: readonly (AntigravityIdentity & { readonly handleId: string; readonly generation: string; readonly closed: boolean })[];
}
/** Closing a remote proxy releases its attachment, never its persistent host. */
export interface AntigravityPort {
  /** A successor execution-host service proves the bound runtime retired with its predecessor. */
  readonly serviceReplaced?: boolean;
  connect(signal?: AbortSignal): Promise<{ readonly runtimeId: string; readonly version: string }>;
  catalog(input: { readonly cwd: string }, signal?: AbortSignal): Promise<AntigravitySetup>;
  create(input: { readonly cwd: string; readonly operationId: string; readonly title?: string; readonly executionEnvironment?: EnvironmentVariableOverrides; readonly agentTools?: AntigravityAgentTools }, signal?: AbortSignal): Promise<AntigravityIdentity>;
  acknowledgeCreation(input: AntigravityIdentity & { readonly operationId: string }, signal?: AbortSignal): Promise<void>;
  listSessions(input: { readonly cwd: string; readonly cursor?: string }, signal?: AbortSignal): Promise<{ readonly sessions: readonly AntigravitySessionSummary[]; readonly cursor?: string }>;
  /** Null proves the exact requested native revision is still current. */
  readHistory(input: AntigravityIdentity & { readonly knownRevision?: string }, signal?: AbortSignal): Promise<AntigravityHistory | null>;
  attach(input: AntigravityIdentity & { readonly executionEnvironment?: EnvironmentVariableOverrides; readonly agentTools?: AntigravityAgentTools }, signal?: AbortSignal): Promise<AntigravityAttachment>;
  attachExisting(input: AntigravityIdentity, signal?: AbortSignal): Promise<AntigravityAttachment | null>;
  request(input: { readonly handleId: string; readonly operationId: string; readonly command: AntigravityCommand }, signal?: AbortSignal): Promise<AntigravityOutcome>;
  outcome(input: { readonly handleId: string; readonly operationId: string }, signal?: AbortSignal): Promise<AntigravityOutcome>;
  acknowledgeOperation(input: { readonly handleId: string; readonly operationId: string }, signal?: AbortSignal): Promise<void>;
  observe(input: { readonly handleId: string; readonly afterSequence: number }, signal?: AbortSignal): Promise<AntigravityObservation>;
  acknowledge(input: { readonly handleId: string; readonly throughSequence: number }, signal?: AbortSignal): Promise<void>;
  release(input: { readonly handleId: string }, signal?: AbortSignal): Promise<void>;
  retireSession(input: AntigravityIdentity, signal?: AbortSignal): Promise<"retired" | "absent" | "busy" | "undelivered">;
  inspect(signal?: AbortSignal): Promise<AntigravityInspection>;
  stop(input: { readonly expectedRevision: string; readonly force: boolean }, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export class AntigravityError extends Error {
  constructor(readonly code: string, readonly delivery: AntigravityFailure["delivery"] = "not_sent", options?: ErrorOptions) {
    super(code, options); this.name = "AntigravityError";
  }
}
