import type { ResolvedEnvironmentVariables } from "../../environment-variables/runtime-environment.js";
import type { BackgroundActivity } from "../../../shared/protocol/background-activity.js";
import { ClaudeHistoryPager, readClaudeSessionHistory, type ClaudeHistoryPage, type ClaudeHistoryPageOptions } from "./claude-session-history.js";
import type {
  EffortLevel,
  PermissionMode,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
  SDKSessionInfo,
  ListSessionsOptions,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudePermissionResponseIdentity,
  ClaudeSdkSessionInitialization,
} from "./claude-sdk-session.js";
import type {
  ClaudeCliAuthStatus,
  ClaudeSdkFacade,
} from "./claude-sdk-facade.js";
import { ClaudeSdkSession } from "./claude-sdk-session.js";
import type { ClaudeSafeSkill } from "./claude-skills.js";
import type {
  ClaudeRuntimeVersionWarning,
  VerifiedClaudeRuntimeVersion,
} from "./claude-release-guard.js";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeRuntimeAgentToolMcp } from "./worker/claude-runtime-v1.js";

export interface ClaudeRuntimeProbeInput {
  readonly executablePath: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly onNewerVersion?: (warning: ClaudeRuntimeVersionWarning) => void;
  readonly onVersionAssessment?: (
    assessment: VerifiedClaudeRuntimeVersion,
  ) => void;
}

export interface ClaudeRuntimeProbeResult {
  readonly cliRelease: string;
  readonly account: ClaudeSdkSessionInitialization["account"];
  readonly models: ClaudeSdkSessionInitialization["models"];
  readonly commands: ClaudeSdkSessionInitialization["commands"];
  readonly skillNames: readonly string[];
  readonly terminalCommandNames: readonly string[];
}

export interface ClaudeRuntimeSessionOptions {
  readonly executionEnvironment?: ResolvedEnvironmentVariables;
  readonly executablePath: string;
  readonly initializationTimeoutMs: number;
  readonly sessionId: string;
  readonly cwd: string;
  readonly launch: "new" | "resume" | "fork";
  readonly sourceSessionId?: string;
  readonly resumeSessionAt?: string;
  readonly title?: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly permissionMode?: PermissionMode;
  readonly allowDangerouslySkipPermissions?: true;
  readonly canUseTool?: CanUseTool;
  readonly onPermissionResponseDelivered?: (
    response: ClaudePermissionResponseIdentity,
  ) => void | Promise<void>;
  readonly onPermissionResponseDeliveryFailed?: (
    response: ClaudePermissionResponseIdentity & { readonly error: unknown },
  ) => void | Promise<void>;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Native Sedes tools; exclusive with CLI variables in `environment`. */
  readonly agentToolMcp?: ClaudeRuntimeAgentToolMcp;
  readonly onNewerVersion?: (warning: ClaudeRuntimeVersionWarning) => void;
  readonly onVersionAssessment?: (
    assessment: VerifiedClaudeRuntimeVersion,
  ) => void;
  readonly onVersionAssessmentFailed?: () => void;
  readonly onMessage: (message: SDKMessage, evidence?: { readonly consumedTurnRootUuid: string }) => void | false | Promise<void | false>;
  readonly onFailure?: (error: unknown) => void;
}

/** Provider-private live query contract implemented identically over local and SSH workers. */
export interface ClaudeRuntimeSession {
  readonly closed: boolean;
  /** A service-owned query and CLI ingress survive individual SSH carriers. */
  readonly lifetime?: "persistent_service";
  /** True when start attached to a service-owned query already running. */
  readonly reattached?: boolean;
  /** Current inventory observed by the persistent owner, including known empty startup. */
  readonly backgroundActivity?: BackgroundActivity;
  /** Runtime-private task identities awaiting their terminal notification. */
  readonly pendingBackgroundTaskIds?: readonly string[];
  /** Last effort successfully applied by the owning runtime, when known. */
  readonly confirmedEffort?: EffortLevel | null;
  /** Wait for replay delivered before the initial application snapshot. */
  flushMessages?(): Promise<void>;
  readonly initialization: ClaudeSdkSessionInitialization | undefined;
  readonly startupProbeUuid: string | undefined;
  readonly safeSkills: readonly ClaudeSafeSkill[];
  start(): Promise<ClaudeSdkSessionInitialization>;
  /** Await transport admission when asynchronous; native acceptance still requires correlated output. */
  send(input: {
    readonly operationId: string;
    readonly content: SDKUserMessage["message"]["content"];
    readonly shouldQuery?: boolean;
    readonly priority?: "next";
  }): void | Promise<void>;
  interrupt(): Promise<SDKControlInterruptResponse | undefined>;
  setModel(model?: string): Promise<void>;
  setEffort(effort?: EffortLevel): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  close(options?: { readonly reason: "evicted" }): Promise<void>;
}

/**
 * Semantic Claude runtime boundary. Implementations may cross a process or SSH
 * carrier, but SDK Query objects, callbacks, streams, and filesystem helpers do
 * not cross this interface.
 */
export interface ClaudeRuntimeClient {
  startupEnvironmentState?(): Promise<"not_started" | "started" | "unknown">;
  submissionDisposition?(input: {
    readonly sessionId: string;
    readonly operationId: string;
    readonly cwd: string;
  }): Promise<"submitted" | "session_ended" | "not_sent" | "unknown">;
  probe(input: ClaudeRuntimeProbeInput): Promise<ClaudeRuntimeProbeResult>;
  createSession(options: ClaudeRuntimeSessionOptions): ClaudeRuntimeSession;
  listSessions(
    options: ListSessionsOptions,
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<SDKSessionInfo[]>;
  getSessionInfo(
    sessionId: string,
    options: GetSessionInfoOptions,
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(
    sessionId: string,
    options: GetSessionMessagesOptions,
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<SessionMessage[]>;
  getSessionMessagesPage(
    sessionId: string,
    options: ClaudeHistoryPageOptions,
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<ClaudeHistoryPage>;
  /**
   * Native existence, independent of session metadata: the SDK reports no
   * info for a transcript holding only Sedes' startup message.
   */
  hasSessionTranscript(
    sessionId: string,
    options: { readonly dir: string },
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<boolean>;
  renameSession(
    sessionId: string,
    title: string,
    options: { readonly dir: string },
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<void>;
}

/**
 * Direct-SDK adapter for worker-host code and provider fakes. Production Sedes
 * composition uses the managed worker client, never this adapter.
 */
export class ClaudeSdkRuntimeAdapter implements ClaudeRuntimeClient {
  readonly #sdk: ClaudeSdkFacade;
  readonly #history = new ClaudeHistoryPager();

  constructor(sdk: ClaudeSdkFacade) {
    this.#sdk = sdk;
  }

  async probe(
    input: ClaudeRuntimeProbeInput,
  ): Promise<ClaudeRuntimeProbeResult> {
    const { probeClaudeSdkDirect } = await import("./claude-sdk-probe.js");
    return await probeClaudeSdkDirect({ sdk: this.#sdk, ...input });
  }

  createSession(options: ClaudeRuntimeSessionOptions): ClaudeRuntimeSession {
    return new ClaudeSdkSession({ sdk: this.#sdk, ...options });
  }

  listSessions(
    options: ListSessionsOptions,
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<SDKSessionInfo[]> {
    return this.#sdk.listSessions(options, environment);
  }

  getSessionInfo(
    sessionId: string,
    options: GetSessionInfoOptions,
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<SDKSessionInfo | undefined> {
    return this.#sdk.getSessionInfo(sessionId, options, environment);
  }

  getSessionMessages(
    sessionId: string,
    options: GetSessionMessagesOptions,
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<SessionMessage[]> {
    return readClaudeSessionHistory(page => this.getSessionMessagesPage(sessionId, page, environment), options);
  }

  async getSessionMessagesPage(
    sessionId: string, options: ClaudeHistoryPageOptions,
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<ClaudeHistoryPage> {
    const { offset: _offset, limit: _limit, cursor: _cursor, maintenance: _maintenance, ...nativeOptions } = options;
    const scope = JSON.stringify([sessionId, Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))]);
    return this.#history.getPage(scope, options, async () => structuredClone(
      await this.#sdk.getSessionMessages(sessionId, nativeOptions, environment),
    ));
  }

  hasSessionTranscript(
    sessionId: string,
    options: { readonly dir: string },
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<boolean> {
    return this.#sdk.hasSessionTranscript(sessionId, options, environment);
  }

  renameSession(
    sessionId: string,
    title: string,
    options: { readonly dir: string },
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<void> {
    return this.#sdk.renameSession(sessionId, title, options, environment);
  }
}

export type { ClaudeCliAuthStatus };
