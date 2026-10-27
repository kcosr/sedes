import type { EnvironmentVariableOverrides } from "../../../../shared/protocol/environment-variables.js";
import type { EnvironmentChannelScope } from "../../../execution/environment-channel.js";
import type { PiManagedOperation } from "./rpc/pi-managed-protocol.js";

/** Provider-private execution-host configuration. Paths always name this host. */
export interface PiNativeRuntimeConfiguration extends EnvironmentChannelScope {
  readonly executablePath?: string;
  readonly agentDirectory?: string;
  readonly sessionDirectory?: string;
  readonly initializationTimeoutMs: number;
  readonly projectTrusted: boolean;
  readonly startupEnvironmentVariables?: EnvironmentVariableOverrides;
}

export interface PiNativeSessionIdentity {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
}
export interface PiNativeSessionSummary extends PiNativeSessionIdentity {
  readonly title?: string;
  readonly updatedAt: string;
}
/** Structural interpretation belongs to the pinned Pi codecs, not this port. */
export type PiNativeEntry = Readonly<Record<string, unknown>>;
export interface PiNativeHistory extends PiNativeSessionIdentity {
  readonly entries: readonly PiNativeEntry[];
  readonly leafId: string | null;
  readonly operations: readonly PiManagedOperation[];
  readonly toolCalls: readonly import("./tool-provenance.js").PiNativeToolCall[];
  readonly toolResults: readonly import("./tool-provenance.js").PiNativeToolResult[];
  readonly inheritedEntryIds: readonly string[];
  readonly inheritance: "none" | "verified" | "unknown";
  readonly parentSessionId?: string;
}
export interface PiNativeCreateInput {
  readonly cwd: string;
  readonly sessionId: string;
  readonly operationId: string;
  readonly title?: string;
}
export interface PiNativeForkInput {
  readonly cwd: string;
  readonly sourceSessionId: string;
  readonly sourceSessionFile: string;
  readonly sourceEntryId: string;
  readonly childSessionId: string;
  readonly operationId: string;
  readonly title?: string;
  readonly inheritedSettings: {
    readonly model?: { readonly provider: string; readonly id: string };
    readonly thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    readonly toolAccess: "read_only" | "ask" | "full";
  };
}
/** Each channel has its own closed, versioned decoder at the host boundary. */
export type PiNativeCommand = Readonly<{
  readonly channel: "rpc" | "companion";
  readonly command: Readonly<Record<string, unknown>>;
}>;
export type PiNativeFailure = Readonly<{
  readonly code: string;
  readonly delivery: "not_sent" | "sent_outcome_unknown" | "rejected";
}>;
export type PiNativeOutcome =
  | Readonly<{ readonly status: "pending" }>
  | Readonly<{ readonly status: "completed"; readonly result: unknown }>
  | Readonly<{ readonly status: "failed"; readonly failure: PiNativeFailure }>;
export interface PiNativeEvent {
  readonly sequence: number;
  readonly kind: "rpc" | "companion" | "failure" | "stream";
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface PiNativeAttachment extends PiNativeSessionIdentity {
  readonly handleId: string;
  readonly generation: string;
  readonly throughSequence: number;
  readonly retainedAfterSequence: number;
  readonly retainedOperationIds: readonly string[];
}
export interface PiNativeDrainAttachment extends PiNativeAttachment {
  /** True only after native process cleanup has been proven. */
  readonly closed: boolean;
  /** Retained prefix is incomplete; apply stable disk history and report the gap before acknowledging it. */
  readonly observationGap: boolean;
}
export type PiNativeStreamSnapshot =
  | { readonly type: "message_snapshot"; readonly streamId: string; readonly contentIndex: number;
      readonly semanticKind: "assistant_message" | "reasoning"; readonly text: string }
  | { readonly type: "toolcall_snapshot"; readonly streamId: string; readonly contentIndex: number; readonly text: string }
  | { readonly type: "bash_snapshot"; readonly streamId: string; readonly text: string };
export interface PiNativeAttachInput extends PiNativeSessionIdentity {
  readonly executionEnvironment?: EnvironmentVariableOverrides;
  readonly agentToolEnvironment?: PiNativeAgentToolEnvironment;
}
/** Main-owned CLI authority, carried separately from user environment overrides. */
export interface PiNativeAgentToolEnvironment {
  readonly SEDES_AGENT_TOOL_ENDPOINT?: string | null;
  readonly SEDES_AGENT_TOOL_SOURCE_CAPABILITY?: string | null;
  readonly SEDES_AGENT_TOOL_CLIENT_TOKEN?: string | null;
  readonly SEDES_AGENT_TOOL_CLI_MODE?: string | null;
  readonly PATH?: string | null;
}
export interface PiNativeCatalog {
  readonly models: readonly Readonly<Record<string, unknown>>[];
  readonly commands: readonly Readonly<Record<string, unknown>>[];
  readonly defaultSelection?: { readonly provider: string; readonly modelId: string; readonly thinkingLevel: string };
}
export interface PiNativeObservation {
  readonly events: readonly PiNativeEvent[];
  readonly throughSequence: number;
  readonly retainedAfterSequence: number;
  readonly closed: boolean;
}
export interface PiNativeInspection {
  readonly runtimeId: string;
  readonly state: "idle" | "active" | "unknown";
  readonly revision: string;
  readonly blockers: readonly ("active_work" | "pending_interaction" | "unsettled_outcome" | "cleanup_unproven" | "unknown_state")[];
  readonly retainedSessions: readonly PiNativeAttachment[];
}
export type PiNativeRetirement = "retired" | "absent" | "busy" | "undelivered";

/** Shared by direct local use and the authenticated persistent-sidecar proxy.
 * Caller cancellation ends waits; admitted native mutations retain their owner. */
export interface PiNativePort {
  /** Canonical execution-host store identity; does not launch Pi or create a session. */
  resolveSessionDirectory(input: { readonly cwd: string }, signal?: AbortSignal): Promise<string>;
  catalog(input: { readonly cwd: string }, signal?: AbortSignal): Promise<PiNativeCatalog>;
  create(input: PiNativeCreateInput, signal?: AbortSignal): Promise<PiNativeSessionIdentity>;
  fork(input: PiNativeForkInput, signal?: AbortSignal): Promise<PiNativeSessionIdentity>;
  reconcileFork(input: PiNativeForkInput, signal?: AbortSignal): Promise<PiNativeSessionIdentity | null>;
  listSessions(input: { readonly cwd: string; readonly cursor?: string; readonly limit?: number }, signal?: AbortSignal): Promise<{ readonly sessions: readonly PiNativeSessionSummary[]; readonly cursor?: string }>;
  readHistory(input: PiNativeSessionIdentity, signal?: AbortSignal): Promise<PiNativeHistory>;
  attach(input: PiNativeAttachInput, signal?: AbortSignal): Promise<PiNativeAttachment>;
  /** Existing residency only; uses its applied environment and never starts a native process. */
  attachForDrain(input: PiNativeSessionIdentity, signal?: AbortSignal): Promise<PiNativeDrainAttachment | null>;
  /** Existing live observation gap only; permits explicit Stop and denial, never new work. */
  attachForControl(input: PiNativeSessionIdentity, signal?: AbortSignal): Promise<PiNativeAttachment | null>;
  request(input: { readonly handleId: string; readonly operationId: string; readonly command: PiNativeCommand; readonly retainOutcome: boolean }, signal?: AbortSignal): Promise<PiNativeOutcome>;
  outcome(input: { readonly handleId: string; readonly operationId: string }, signal?: AbortSignal): Promise<PiNativeOutcome>;
  acknowledgeOperation(input: { readonly handleId: string; readonly operationId: string }, signal?: AbortSignal): Promise<void>;
  /** Releases only non-retained reads; pending native work remains owned until it settles. */
  abandonObservation(input: { readonly handleId: string; readonly operationId: string }, signal?: AbortSignal): Promise<"pending" | "released">;
  observe(input: { readonly handleId: string; readonly afterSequence: number }, signal?: AbortSignal): Promise<PiNativeObservation>;
  acknowledge(input: { readonly handleId: string; readonly throughSequence: number }, signal?: AbortSignal): Promise<void>;
  /** Confirms explicit gap recovery after stable history and every retained event were applied. */
  acknowledgeObservationGap(input: { readonly handleId: string; readonly generation: string; readonly throughSequence: number }, signal?: AbortSignal): Promise<void>;
  release(input: { readonly handleId: string }, signal?: AbortSignal): Promise<void>;
  /** Proves the exact session process and writer lease retired without discarding work or output. */
  retireSession(input: PiNativeSessionIdentity, signal?: AbortSignal): Promise<PiNativeRetirement>;
  inspect(signal?: AbortSignal): Promise<PiNativeInspection>;
  stop(input: { readonly expectedRevision: string; readonly force: boolean }, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export class PiNativeError extends Error {
  constructor(readonly code: string, readonly delivery: PiNativeFailure["delivery"] = "not_sent", options?: ErrorOptions) {
    super(code, options);
    this.name = "PiNativeError";
  }
}
