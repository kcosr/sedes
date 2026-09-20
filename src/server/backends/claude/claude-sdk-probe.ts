import type {
  AccountInfo,
  ModelInfo,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { ClaudeInputQueue } from "./claude-input-queue.js";
import {
  type ClaudeCliAuthStatus,
  type ClaudeSdkFacade,
} from "./claude-sdk-facade.js";
import {
  emitClaudeRuntimeNewerVersionWarning,
  type ClaudeRuntimeVersionWarning,
  type VerifiedClaudeRuntimeVersion,
  verifyClaudeRuntimeVersion,
} from "./claude-release-guard.js";

const CLAUDE_RESET_PRODUCING_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);

export interface ClaudeSdkProbeResult {
  readonly cliRelease: string;
  readonly account: AccountInfo;
  readonly models: readonly ModelInfo[];
  readonly commands: readonly SlashCommand[];
  readonly skillNames: readonly string[];
  readonly terminalCommandNames: readonly string[];
}

/**
 * Fails closed unless Claude Code says its active credential is a claude.ai
 * subscription and no API-key source has precedence. Merely having a
 * subscription on the account is insufficient: Claude Code permits an API key
 * to override the externally authenticated subscription.
 */
export function assertClaudeSubscriptionAuthStatus(
  status: ClaudeCliAuthStatus,
): void {
  if (
    !status.loggedIn ||
    status.authMethod !== "claude.ai" ||
    status.apiProvider !== "firstParty" ||
    !status.subscriptionType ||
    status.apiKeySource !== undefined
  ) {
    throw new Error("claude_subscription_auth_unavailable");
  }
}

/** Initializes the external CLI without sending a user message or model call. */
export async function probeClaudeSdkDirect(input: {
  readonly sdk: ClaudeSdkFacade;
  readonly executablePath: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly onNewerVersion?: (warning: ClaudeRuntimeVersionWarning) => void;
  readonly onVersionAssessment?: (
    assessment: VerifiedClaudeRuntimeVersion,
  ) => void;
}): Promise<ClaudeSdkProbeResult> {
  input.signal?.throwIfAborted();
  const prompt = new ClaudeInputQueue<SDKUserMessage>(1);
  const abortController = new AbortController();
  const probeSessionId = randomUUID() as SDKUserMessage["session_id"];
  const cliRelease = await withTimeout(
    input.sdk.readCliRelease(
      input.executablePath,
      input.timeoutMs,
      input.environment,
      input.cwd,
      input.signal,
    ),
    input.timeoutMs,
    input.signal,
  );
  input.signal?.throwIfAborted();
  const onNewerVersion =
    input.onNewerVersion ?? emitClaudeRuntimeNewerVersionWarning;
  verifyClaudeRuntimeVersion(cliRelease, {
    onNewerVersion,
    ...(input.onVersionAssessment
      ? { onVersionAssessment: input.onVersionAssessment }
      : {}),
  });
  const authStatus = await withTimeout(
    input.sdk.readCliAuthStatus(
      input.executablePath,
      input.timeoutMs,
      input.environment,
      input.cwd,
      input.signal,
    ),
    input.timeoutMs,
    input.signal,
  );
  input.signal?.throwIfAborted();
  assertClaudeSubscriptionAuthStatus(authStatus);
  const query = input.sdk.createQuery({
    prompt,
    options: {
      abortController,
      cwd: input.cwd,
      pathToClaudeCodeExecutable: input.executablePath,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      persistSession: false,
      sessionId: probeSessionId,
      tools: [],
      strictMcpConfig: true,
      mcpServers: {},
      env: { ...input.environment },
    },
  });
  let streamFailure: unknown;
  let ownerClosing = false;
  let streamCatalog:
    | {
        readonly skillNames: readonly string[];
        readonly terminalCommandNames: readonly string[];
      }
    | undefined;
  let resolveStreamInitialization!: () => void;
  let rejectStreamInitialization!: (error: unknown) => void;
  const streamInitialization = new Promise<void>((resolve, reject) => {
    resolveStreamInitialization = resolve;
    rejectStreamInitialization = reject;
  });
  let streamInitializationSettled = false;
  const consume = (async () => {
    try {
      for await (const message of query) {
        assertStreamRelease(message);
      }
      if (!ownerClosing) {
        const error = new Error(
          streamInitializationSettled
            ? "claude_sdk_stream_ended_unexpectedly"
            : "claude_sdk_stream_initialization_missing",
        );
        streamFailure = error;
        if (!streamInitializationSettled) {
          streamInitializationSettled = true;
          rejectStreamInitialization(error);
        }
      }
    } catch (error) {
      if (!ownerClosing) {
        streamFailure = error;
        if (!streamInitializationSettled) {
          streamInitializationSettled = true;
          rejectStreamInitialization(error);
        }
      }
    }
  })();

  let queryClosed = false;
  const closeQuery = () => {
    if (queryClosed) return;
    queryClosed = true;
    try {
      query.close();
    } catch {
      // The finalizer still drains the consumer.
    }
  };
  const abortProbe = () => {
    ownerClosing = true;
    prompt.close();
    abortController.abort(input.signal?.reason);
    closeQuery();
  };
  input.signal?.addEventListener("abort", abortProbe, { once: true });
  if (input.signal?.aborted) abortProbe();

  function assertStreamRelease(message: SDKMessage): void {
    if (message.session_id !== probeSessionId) {
      throw new Error("claude_session_identity_mismatch");
    }
    if (message.type === "system" && message.subtype === "init") {
      verifyClaudeRuntimeVersion(message.claude_code_version, {
        onNewerVersion,
        ...(input.onVersionAssessment
          ? { onVersionAssessment: input.onVersionAssessment }
          : {}),
      });
      if (
        message.tools.some((tool) => CLAUDE_RESET_PRODUCING_TOOLS.has(tool))
      ) {
        throw new Error("claude_reset_producing_tools_enabled");
      }
      if (!streamCatalog) {
        streamCatalog = {
          skillNames: Object.freeze([...message.skills]),
          terminalCommandNames: Object.freeze([
            ...(message.terminal_slash_commands ?? []),
          ]),
        };
        streamInitializationSettled = true;
        resolveStreamInitialization();
      }
    }
  }

  prompt.push({
    type: "user",
    session_id: probeSessionId,
    parent_tool_use_id: null,
    uuid: randomUUID() as SDKUserMessage["uuid"],
    message: { role: "user", content: "" },
    isSynthetic: true,
    shouldQuery: false,
  });

  try {
    const [initialized] = await withTimeout(
      Promise.all([query.initializationResult(), streamInitialization]),
      input.timeoutMs,
      input.signal,
    );
    if (
      initialized.account.apiProvider !== "firstParty" ||
      !initialized.account.subscriptionType
    ) {
      throw new Error("claude_subscription_auth_unavailable");
    }
    return Object.freeze({
      cliRelease,
      account: Object.freeze({ ...initialized.account }),
      models: Object.freeze([...initialized.models]),
      commands: Object.freeze([...initialized.commands]),
      skillNames: streamCatalog!.skillNames,
      terminalCommandNames: streamCatalog!.terminalCommandNames,
    });
  } finally {
    input.signal?.removeEventListener("abort", abortProbe);
    ownerClosing = true;
    prompt.close();
    abortController.abort(new Error("claude_sdk_probe_complete"));
    closeQuery();
    await consume;
    if (streamFailure) throw streamFailure;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("claude_sdk_initialization_timeout")),
          timeoutMs,
        );
        timer.unref?.();
      }),
      ...(signal
        ? [
            new Promise<never>((_resolve, reject) => {
              onAbort = () =>
                reject(signal.reason ?? new Error("operation_aborted"));
              signal.addEventListener("abort", onAbort, { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
