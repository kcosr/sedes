import type { EffortLevel, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SidecarOperationError } from "../../../internal/sidecar-protocol/operation-registry.js";
import type { ResolvedEnvironmentVariables } from "../../environment-variables/runtime-environment.js";
import type { VerifiedClaudeRuntimeVersion } from "./claude-release-guard.js";
import type {
  ClaudeRuntimeSession,
  ClaudeRuntimeSessionOptions,
} from "./claude-runtime-client.js";
import {
  CLAUDE_FORK_LAUNCH_PERMISSION_MODE,
  CLAUDE_QUERY_NOT_LAUNCHED_CODE_PREFIX,
  claudeLaunchRefusal,
  type ClaudeLaunchRefusal,
} from "./claude-sdk-session.js";

export interface ClaudeRuntimeForkOptions {
  readonly executionEnvironment?: ResolvedEnvironmentVariables;
  readonly executablePath: string;
  readonly initializationTimeoutMs: number;
  /** The application-reserved child session identity. */
  readonly sessionId: string;
  readonly sourceSessionId: string;
  /** Exact retained native chain leaf copied into the child. */
  readonly resumeSessionAt: string;
  readonly cwd: string;
  readonly title?: string;
  /** The child's frozen model, confirmed by the launch. */
  readonly model: string;
  /** The child's frozen effort, confirmed by the launch. */
  readonly effort?: EffortLevel;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly onVersionAssessment?: (
    assessment: VerifiedClaudeRuntimeVersion,
  ) => void;
  readonly onVersionAssessmentFailed?: () => void;
}

export interface ClaudeRuntimeForkResult {
  readonly cliRelease: string;
}

/**
 * Classified fork-launch failures. They cross the persistent host unchanged.
 *
 * - `refused*`: no Claude Code process started, so no child exists.
 * - `settings`/`effort`/`started_turn`/`failed`: a process started and its
 *   cleanup is proven, so the child transcript can be checked.
 * - `cleanup_unproven`: a process may still be writing the child.
 */
export const CLAUDE_FORK_LAUNCH_FAILURE_CODES = [
  "claude_fork_launch_refused",
  "claude_fork_launch_refused_version",
  "claude_fork_launch_refused_login",
  "claude_fork_launch_refused_capacity",
  "claude_fork_effective_settings_mismatch",
  "claude_fork_effort_unconfirmed",
  "claude_fork_launch_started_turn",
  "claude_fork_launch_failed",
  "claude_fork_launch_cleanup_unproven",
] as const;
export type ClaudeForkLaunchFailureCode =
  (typeof CLAUDE_FORK_LAUNCH_FAILURE_CODES)[number];
const failureCodes = new Set<string>(CLAUDE_FORK_LAUNCH_FAILURE_CODES);

export function claudeForkLaunchFailure(
  code: ClaudeForkLaunchFailureCode,
  cause?: unknown,
): SidecarOperationError {
  return new SidecarOperationError(
    code,
    false,
    cause === undefined ? undefined : { cause },
  );
}

export function claudeForkLaunchFailureCode(
  error: unknown,
): ClaudeForkLaunchFailureCode | undefined {
  return error instanceof SidecarOperationError && failureCodes.has(error.code)
    ? (error.code as ClaudeForkLaunchFailureCode)
    : undefined;
}

export function claudeForkLaunchRefused(
  code: ClaudeForkLaunchFailureCode,
): boolean {
  return code.startsWith("claude_fork_launch_refused");
}

/** Model output proves the launch began a turn, which a fork launch must never do. */
function startsModelTurn(message: SDKMessage): boolean {
  return message.type === "assistant" || message.type === "stream_event";
}

/**
 * Run one locked-down fork launch through `createSession` and prove its exit.
 * The launch sends only Sedes' `shouldQuery: false` startup message: Claude
 * Code writes the retained prefix, any unfinished background tasks as
 * transcript-only notifications, and the startup row, then Sedes closes it.
 * If Claude nevertheless starts a turn, the launch is closed at once and
 * fails; it has no tools, hooks, or MCP servers to act with meanwhile.
 */
export async function runClaudeForkLaunch(
  createSession: (options: ClaudeRuntimeSessionOptions) => ClaudeRuntimeSession,
  options: ClaudeRuntimeForkOptions,
): Promise<ClaudeRuntimeForkResult> {
  let startedTurn = false;
  let session: ClaudeRuntimeSession | undefined;
  try {
    session = createSession({
      ...(options.executionEnvironment
        ? { executionEnvironment: options.executionEnvironment }
        : {}),
      executablePath: options.executablePath,
      initializationTimeoutMs: options.initializationTimeoutMs,
      sessionId: options.sessionId,
      sourceSessionId: options.sourceSessionId,
      resumeSessionAt: options.resumeSessionAt,
      cwd: options.cwd,
      launch: "fork",
      ...(options.title ? { title: options.title } : {}),
      model: options.model,
      ...(options.effort ? { effort: options.effort } : {}),
      environment: options.environment,
      ...(options.onVersionAssessment
        ? { onVersionAssessment: options.onVersionAssessment }
        : {}),
      ...(options.onVersionAssessmentFailed
        ? { onVersionAssessmentFailed: options.onVersionAssessmentFailed }
        : {}),
      onMessage: (message) => {
        if (startedTurn || !startsModelTurn(message)) return;
        startedTurn = true;
        void session?.close().catch(() => undefined);
      },
    });
  } catch (error) {
    throw claudeForkLaunchFailure("claude_fork_launch_refused", error);
  }
  let initialization: Awaited<ReturnType<ClaudeRuntimeSession["start"]>>;
  try {
    initialization = await session.start();
  } catch (error) {
    await closeLaunch(session);
    const refusal = launchRefusal(error, session);
    if (refusal) {
      throw claudeForkLaunchFailure(
        refusal === "version"
          ? "claude_fork_launch_refused_version"
          : refusal === "login"
            ? "claude_fork_launch_refused_login"
            : "claude_fork_launch_refused",
        error,
      );
    }
    throw claudeForkLaunchFailure(
      startedTurn ? "claude_fork_launch_started_turn" : "claude_fork_launch_failed",
      error,
    );
  }
  let failure: SidecarOperationError | undefined;
  if (
    initialization.actualModel !== options.model ||
    initialization.actualPermissionMode !== CLAUDE_FORK_LAUNCH_PERMISSION_MODE
  ) {
    failure = claudeForkLaunchFailure("claude_fork_effective_settings_mismatch");
  } else {
    try {
      await session.setEffort(options.effort);
    } catch (error) {
      failure = claudeForkLaunchFailure("claude_fork_effort_unconfirmed", error);
    }
  }
  await closeLaunch(session);
  if (startedTurn) throw claudeForkLaunchFailure("claude_fork_launch_started_turn");
  if (failure) throw failure;
  return { cliRelease: initialization.cliRelease };
}

async function closeLaunch(session: ClaudeRuntimeSession): Promise<void> {
  try {
    await session.close();
  } catch (error) {
    throw claudeForkLaunchFailure("claude_fork_launch_cleanup_unproven", error);
  }
}

function launchRefusal(
  error: unknown,
  session: ClaudeRuntimeSession,
): ClaudeLaunchRefusal | undefined {
  if (
    error instanceof SidecarOperationError &&
    error.code.startsWith(`${CLAUDE_QUERY_NOT_LAUNCHED_CODE_PREFIX}_`)
  ) {
    const reason = error.code.slice(CLAUDE_QUERY_NOT_LAUNCHED_CODE_PREFIX.length + 1);
    return reason === "version" || reason === "login" ? reason : "unavailable";
  }
  return session.launched === false ? claudeLaunchRefusal(error) : undefined;
}
