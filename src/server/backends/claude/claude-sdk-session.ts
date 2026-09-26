import type {
  CanUseTool,
  EffortLevel,
  ModelInfo,
  PermissionMode,
  Query,
  SDKControlInitializeResponse,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { ClaudeInputQueue } from "./claude-input-queue.js";
import type { ClaudeSdkFacade } from "./claude-sdk-facade.js";
import { assertClaudeSubscriptionAuthStatus } from "./claude-sdk-probe.js";
import {
  emitClaudeRuntimeNewerVersionWarning,
  isClaudeRuntimeReleaseFailure,
  type ClaudeRuntimeVersionWarning,
  type VerifiedClaudeRuntimeVersion,
  verifyClaudeRuntimeVersion,
} from "./claude-release-guard.js";
import {
  resolveClaudeSafeSkills,
  type ClaudeSafeSkill,
} from "./claude-skills.js";
import type { ClaudeRuntimeAgentToolMcp } from "./worker/claude-runtime-v1.js";

const CLAUDE_SETTING_SOURCES = ["user", "project", "local"] as const;

/**
 * Claude Code emits `session_state_changed` only when this variable is set.
 * Sedes owns it for every launch: turns Claude starts itself (task
 * notifications, peer hand-backs) are otherwise invisible to run state.
 */
export const CLAUDE_SESSION_STATE_EVENTS_VARIABLE =
  "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS";

/**
 * When set, Claude Code re-runs a turn that a process restart interrupted,
 * tools included, with no Sedes input. Sedes withholds it from every launch:
 * such a turn is marked interrupted and the user decides whether to resend.
 */
export const CLAUDE_RESUME_INTERRUPTED_TURN_VARIABLE =
  "CLAUDE_CODE_RESUME_INTERRUPTED_TURN";

const SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE =
  "SEDES_AGENT_TOOL_SOURCE_CAPABILITY";

/**
 * Claude names these tools `mcp__sedes__<tool>`. The SDK passes MCP servers to
 * the CLI as a `--mcp-config` argument, which other local users can read, so
 * the reference stays in the query environment and the server entry names it
 * with a placeholder that Claude expands when it starts the server.
 */
function sedesMcpServers(mcp: ClaudeRuntimeAgentToolMcp) {
  return {
    sedes: {
      type: "stdio" as const,
      command: mcp.command,
      args: ["mcp", "--mode", mcp.mode],
      env: {
        SEDES_AGENT_TOOL_ENDPOINT: mcp.endpoint,
        [SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE]: `\${${SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE}}`,
      },
    },
  };
}

const CLAUDE_RESET_PRODUCING_TOOLS = ["EnterPlanMode", "ExitPlanMode"] as const;
const CLAUDE_RESET_PRODUCING_TOOL_SET = new Set<string>(
  CLAUDE_RESET_PRODUCING_TOOLS,
);

export interface ClaudeSdkSessionOptions {
  readonly sdk: ClaudeSdkFacade;
  readonly executablePath: string;
  readonly initializationTimeoutMs: number;
  readonly sessionId: string;
  readonly cwd: string;
  readonly launch: "new" | "resume" | "fork";
  /** Required only for a fork; the new child identity remains `sessionId`. */
  readonly sourceSessionId?: string;
  /** Exact retained native chain leaf copied into a fork child. */
  readonly resumeSessionAt?: string;
  readonly title?: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly permissionMode?: PermissionMode;
  /** Enables, but does not select, the SDK's bypass-permissions mode. */
  readonly allowDangerouslySkipPermissions?: true;
  readonly canUseTool?: CanUseTool;
  readonly onPermissionResponseDelivered?: (
    response: ClaudePermissionResponseIdentity,
  ) => void | Promise<void>;
  readonly onPermissionResponseDeliveryFailed?: (
    response: ClaudePermissionResponseIdentity & { readonly error: unknown },
  ) => void | Promise<void>;
  /** Full child environment. The Agent SDK replaces rather than merges it. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Native Sedes tools; exclusive with CLI variables in `environment`. */
  readonly agentToolMcp?: ClaudeRuntimeAgentToolMcp;
  readonly onNewerVersion?: (warning: ClaudeRuntimeVersionWarning) => void;
  readonly onVersionAssessment?: (
    assessment: VerifiedClaudeRuntimeVersion,
  ) => void;
  readonly onVersionAssessmentFailed?: () => void;
  readonly onMessage: (message: SDKMessage) => void | false | Promise<void | false>;
  readonly onFailure?: (error: unknown) => void;
}

export interface ClaudePermissionResponseIdentity {
  readonly requestId: string;
  readonly toolUseID: string;
}

export interface ClaudeSdkSessionInitialization {
  readonly models: readonly ModelInfo[];
  readonly commands: readonly SDKControlInitializeResponse["commands"][number][];
  readonly skillNames: readonly string[];
  readonly terminalCommandNames: readonly string[];
  readonly account: SDKControlInitializeResponse["account"];
  readonly actualModel?: string;
  readonly actualPermissionMode: PermissionMode;
  readonly cliRelease: string;
}

interface ClaudeStreamInitialization {
  readonly actualModel: string;
  readonly actualPermissionMode: PermissionMode;
  readonly cliRelease: string;
  readonly skillNames: readonly string[];
  readonly terminalCommandNames: readonly string[];
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/** Owns one official-SDK query and its Claude Code subprocess. */
export class ClaudeSdkSession {
  readonly #options: ClaudeSdkSessionOptions;
  readonly #input = new ClaudeInputQueue<SDKUserMessage>(16);
  readonly #abortController = new AbortController();
  #query: Query | undefined;
  #consumer: Promise<void> | undefined;
  #closed = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #initialization: ClaudeSdkSessionInitialization | undefined;
  #startupBarrier: Deferred<void> | undefined;
  #startupProbeUuid: SDKUserMessage["uuid"] | undefined;
  #commands: readonly SlashCommand[] = [];
  #safeSkills: readonly ClaudeSafeSkill[] = [];

  constructor(options: ClaudeSdkSessionOptions) {
    if (
      (options.launch === "fork" &&
        (!options.sourceSessionId || !options.resumeSessionAt)) ||
      (options.launch !== "fork" &&
        (options.sourceSessionId !== undefined ||
          options.resumeSessionAt !== undefined))
    ) {
      throw new Error("claude_sdk_fork_options_invalid");
    }
    this.#options = options;
  }

  get closed(): boolean {
    return this.#closed || this.#closing;
  }

  get initialization(): ClaudeSdkSessionInitialization | undefined {
    return this.#initialization;
  }

  get startupProbeUuid(): string | undefined {
    return this.#startupProbeUuid;
  }

  get safeSkills(): readonly ClaudeSafeSkill[] {
    return this.#safeSkills;
  }

  async start(): Promise<ClaudeSdkSessionInitialization> {
    try {
      return await this.#start();
    } catch (error) {
      this.#options.onVersionAssessmentFailed?.();
      throw error;
    }
  }

  async #start(): Promise<ClaudeSdkSessionInitialization> {
    if (this.closed) throw new Error("claude_sdk_session_closed");
    if (this.#initialization) return this.#initialization;
    if (this.#query) throw new Error("claude_sdk_session_starting");

    const cliRelease = await withTimeout(
      this.#options.sdk.readCliRelease(
        this.#options.executablePath,
        this.#options.initializationTimeoutMs,
        this.#options.environment,
        this.#options.cwd,
        this.#abortController.signal,
      ),
      this.#options.initializationTimeoutMs,
      "claude_cli_release_probe_timeout",
    );
    if (this.closed) throw new Error("claude_sdk_session_closed");
    const onNewerVersion =
      this.#options.onNewerVersion ?? emitClaudeRuntimeNewerVersionWarning;
    verifyClaudeRuntimeVersion(cliRelease, {
      onNewerVersion,
      ...(this.#options.onVersionAssessment
        ? { onVersionAssessment: this.#options.onVersionAssessment }
        : {}),
    });
    const authStatus = await withTimeout(
      this.#options.sdk.readCliAuthStatus(
        this.#options.executablePath,
        this.#options.initializationTimeoutMs,
        this.#options.environment,
        this.#options.cwd,
        this.#abortController.signal,
      ),
      this.#options.initializationTimeoutMs,
      "claude_cli_auth_status_timeout",
    );
    if (this.closed) throw new Error("claude_sdk_session_closed");
    assertClaudeSubscriptionAuthStatus(authStatus);
    if (this.closed) throw new Error("claude_sdk_session_closed");
    const query = this.#options.sdk.createQuery({
      prompt: this.#input,
      options: {
        abortController: this.#abortController,
        cwd: this.#options.cwd,
        pathToClaudeCodeExecutable: this.#options.executablePath,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: [...CLAUDE_SETTING_SOURCES],
        disallowedTools: [...CLAUDE_RESET_PRODUCING_TOOLS],
        persistSession: true,
        includePartialMessages: true,
        ...(this.#options.launch === "new"
          ? { sessionId: this.#options.sessionId }
          : this.#options.launch === "resume"
            ? { resume: this.#options.sessionId }
            : {
                resume: this.#options.sourceSessionId,
                forkSession: true,
                sessionId: this.#options.sessionId,
                resumeSessionAt: this.#options.resumeSessionAt,
              }),
        ...(this.#options.title ? { title: this.#options.title } : {}),
        ...(this.#options.model ? { model: this.#options.model } : {}),
        ...(this.#options.effort ? { effort: this.#options.effort } : {}),
        ...(this.#options.permissionMode
          ? { permissionMode: this.#options.permissionMode }
          : {}),
        ...(this.#options.allowDangerouslySkipPermissions
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(this.#options.canUseTool
          ? { canUseTool: this.#deliveryAwareCanUseTool() }
          : {}),
        // Added beside the user's own MCP servers, which setting sources load.
        ...(this.#options.agentToolMcp
          ? { mcpServers: sedesMcpServers(this.#options.agentToolMcp) }
          : {}),
        env: {
          ...withoutVariable(
            this.#options.environment,
            CLAUDE_RESUME_INTERRUPTED_TURN_VARIABLE,
          ),
          ...(this.#options.agentToolMcp
            ? {
                [SEDES_AGENT_TOOL_SOURCE_CAPABILITY_VARIABLE]:
                  this.#options.agentToolMcp.sourceCapability,
              }
            : {}),
          [CLAUDE_SESSION_STATE_EVENTS_VARIABLE]: "1",
        },
      },
    });
    this.#query = query;
    const streamInitialization = createDeferred<ClaudeStreamInitialization>();
    const startupBarrier = createDeferred<void>();
    this.#startupBarrier = startupBarrier;
    this.#startupProbeUuid = randomUUID() as SDKUserMessage["uuid"];
    this.#consumer = this.#consume(
      query,
      streamInitialization,
      startupBarrier,
      onNewerVersion,
    );
    // Claude Code does not emit its stream init until it receives stream
    // input. A synthetic empty append starts the transport without querying a
    // model; the matching replay is provider-private and filtered below.
    this.#input.push({
      type: "user",
      session_id: this.#options.sessionId,
      parent_tool_use_id: null,
      uuid: this.#startupProbeUuid,
      message: { role: "user", content: "" },
      isSynthetic: true,
      shouldQuery: false,
    });
    try {
      const [initialized, streamInitialized] = await withTimeout(
        Promise.all([
          query.initializationResult(),
          streamInitialization.promise,
        ]),
        this.#options.initializationTimeoutMs,
        "claude_sdk_initialization_timeout",
      );
      if (
        initialized.account.apiProvider !== "firstParty" ||
        !initialized.account.subscriptionType
      ) {
        throw new Error("claude_subscription_auth_unavailable");
      }
      const initialization: ClaudeSdkSessionInitialization = Object.freeze({
        models: Object.freeze([...initialized.models]),
        commands: Object.freeze([...initialized.commands]),
        skillNames: streamInitialized.skillNames,
        terminalCommandNames: streamInitialized.terminalCommandNames,
        account: Object.freeze({ ...initialized.account }),
        actualModel: streamInitialized.actualModel,
        actualPermissionMode: streamInitialized.actualPermissionMode,
        cliRelease: streamInitialized.cliRelease,
      });
      this.#commands = initialization.commands;
      this.#safeSkills = resolveClaudeSafeSkills({
        commands: this.#commands,
        skillNames: initialization.skillNames,
        terminalCommandNames: initialization.terminalCommandNames,
      });
      this.#initialization = initialization;
      startupBarrier.resolve();
      this.#startupBarrier = undefined;
      return initialization;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  #deliveryAwareCanUseTool(): CanUseTool {
    const canUseTool = this.#options.canUseTool;
    if (!canUseTool) throw new Error("claude_can_use_tool_unavailable");
    return async (toolName, input, options) => {
      const identity = {
        requestId: options.requestId,
        toolUseID: options.toolUseID,
      };
      try {
        const result = await canUseTool(toolName, input, options);
        await this.#options.onPermissionResponseDelivered?.(identity);
        return result;
      } catch (error) {
        await this.#options.onPermissionResponseDeliveryFailed?.({
          ...identity,
          error,
        });
        throw error;
      }
    };
  }

  send(input: {
    readonly operationId: string;
    readonly content: SDKUserMessage["message"]["content"];
    readonly shouldQuery?: boolean;
    readonly priority?: "next";
  }): void {
    if (!this.#query || !this.#initialization || this.closed) {
      throw new Error("claude_sdk_session_not_ready");
    }
    this.#input.push({
      type: "user",
      session_id: this.#options.sessionId,
      parent_tool_use_id: null,
      uuid: input.operationId as SDKUserMessage["uuid"],
      message: {
        role: "user",
        content: input.content,
      },
      ...(input.shouldQuery === false ? { shouldQuery: false } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      origin: { kind: "human" },
    });
  }

  async interrupt(): Promise<SDKControlInterruptResponse | undefined> {
    if (!this.#query || !this.#initialization || this.closed) {
      throw new Error("claude_sdk_session_not_ready");
    }
    return this.#query.interrupt();
  }

  async setModel(model?: string): Promise<void> {
    if (!this.#query || !this.#initialization || this.closed) {
      throw new Error("claude_sdk_session_not_ready");
    }
    await this.#query.setModel(model);
  }

  async setEffort(effort?: EffortLevel): Promise<void> {
    if (!this.#query || !this.#initialization || this.closed) {
      throw new Error("claude_sdk_session_not_ready");
    }
    // The SDK deliberately ignores `undefined`; `null` clears a prior
    // session-scoped flag when a model change removes the desired effort.
    await this.#query.applyFlagSettings({ effortLevel: effort ?? null });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.#query || !this.#initialization || this.closed) {
      throw new Error("claude_sdk_session_not_ready");
    }
    await this.#query.setPermissionMode(mode);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    if (this.#query && this.#initialization) {
      // Give the owned CLI its protocol interrupt before the SDK force-closes
      // it. A wedged permission/transport must not defeat process cleanup.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => this.#query!.interrupt()),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); }),
        ]);
      } catch { /* Bounded native shutdown below remains authoritative. */ }
      finally { if (timer) clearTimeout(timer); }
    }
    this.#terminate(new Error("claude_sdk_session_closed"));
    try {
      await this.#consumer;
    } catch {
      // Closure owns the process and intentionally absorbs its terminal read.
    }
  }

  async #consume(
    query: Query,
    streamInitialization: Deferred<ClaudeStreamInitialization>,
    startupBarrier: Deferred<void>,
    onNewerVersion: (warning: ClaudeRuntimeVersionWarning) => void,
  ): Promise<void> {
    try {
      for await (const message of query) {
        if (message.session_id !== this.#options.sessionId) {
          throw new Error("claude_session_identity_mismatch");
        }
        if (
          message.type === "user" &&
          message.uuid === this.#startupProbeUuid
        ) {
          continue;
        }
        if (message.type === "system" && message.subtype === "init") {
          verifyClaudeRuntimeVersion(message.claude_code_version, {
            onNewerVersion,
            ...(this.#options.onVersionAssessment
              ? { onVersionAssessment: this.#options.onVersionAssessment }
              : {}),
          });
          if (
            message.tools.some((tool) =>
              CLAUDE_RESET_PRODUCING_TOOL_SET.has(tool),
            )
          ) {
            throw new Error("claude_reset_producing_tools_enabled");
          }
          if (!streamInitialization.settled) {
            streamInitialization.resolve({
              actualModel: message.model,
              actualPermissionMode: message.permissionMode,
              cliRelease: message.claude_code_version,
              skillNames: Object.freeze([...message.skills]),
              terminalCommandNames: Object.freeze([
                ...(message.terminal_slash_commands ?? []),
              ]),
            });
            // Do not advance to an early end until start() has atomically
            // installed the control and stream initialization result.
            await startupBarrier.promise;
            if (this.#closed) return;
          }
          if (this.#initialization) {
            this.#safeSkills = resolveClaudeSafeSkills({
              commands: this.#commands,
              skillNames: message.skills,
              terminalCommandNames: message.terminal_slash_commands ?? [],
            });
          }
        }
        if (
          message.type === "system" &&
          message.subtype === "commands_changed" &&
          this.#initialization
        ) {
          // A commands_changed frame has no skill/terminal classification.
          // Even a retained name may have changed command kind, so the entire
          // safe set remains unavailable until a fresh init classifies it.
          this.#commands = message.commands;
          this.#safeSkills = [];
        }
        await this.#options.onMessage(message);
      }
      if (this.#closed) return;
      const error = new Error("claude_sdk_session_ended_unexpectedly");
      if (!streamInitialization.settled) {
        streamInitialization.reject(error);
      }
      if (this.#initialization && !this.#closed) {
        this.#terminate(error);
        this.#options.onFailure?.(error);
      }
    } catch (error) {
      if (!streamInitialization.settled) {
        streamInitialization.reject(error);
      }
      const initialized = this.#initialization !== undefined;
      if (initialized && isClaudeRuntimeReleaseFailure(error)) {
        this.#options.onVersionAssessmentFailed?.();
      }
      this.#terminate(error);
      if (initialized) {
        this.#options.onFailure?.(error);
      }
    }
  }

  #terminate(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#input.close();
    this.#abortController.abort(error);
    this.#startupBarrier?.resolve();
    this.#startupBarrier = undefined;
    this.#query?.close();
  }
}

function createDeferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withoutVariable(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): Record<string, string | undefined> {
  const copy = { ...environment };
  delete copy[name];
  return copy;
}
