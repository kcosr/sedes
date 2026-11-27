import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackendAccountUsage } from "../../../shared/protocol/account-usage.js";
import { withAbort } from "../../runtime/with-abort.js";
import { projectClaudeAccountUsage } from "./claude-account-usage-projection.js";
import type { ClaudeChildEnvironment } from "./claude-child-environment.js";
import { ClaudeInputQueue } from "./claude-input-queue.js";
import type { ClaudeSdkFacade } from "./claude-sdk-facade.js";
import { assertClaudeSubscriptionAuthStatus } from "./claude-sdk-probe.js";
import { CLAUDE_ACCOUNT_USAGE_TIMEOUT_MS } from "./worker/claude-runtime-v4.js";

/** A backend-account query. Its input stays open and never receives a message. */
export async function readClaudeAccountUsage(input: {
  readonly sdk: ClaudeSdkFacade;
  readonly executablePath: string;
  readonly environment: ClaudeChildEnvironment;
  readonly signal: AbortSignal;
}): Promise<BackendAccountUsage | null> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(CLAUDE_ACCOUNT_USAGE_TIMEOUT_MS)]);
  signal.throwIfAborted();
  const cwd = "/";
  const status = await input.sdk.readCliAuthStatus(
    input.executablePath, CLAUDE_ACCOUNT_USAGE_TIMEOUT_MS, input.environment, cwd, signal,
  );
  signal.throwIfAborted();
  assertClaudeSubscriptionAuthStatus(status);

  const prompt = new ClaudeInputQueue<SDKUserMessage>(1);
  const controller = new AbortController();
  const query = input.sdk.createQuery({
    prompt,
    options: {
      cwd, pathToClaudeCodeExecutable: input.executablePath, env: { ...input.environment },
      abortController: controller, persistSession: false, settingSources: ["user"],
      settings: { disableAllHooks: true }, tools: [], mcpServers: {}, strictMcpConfig: true,
    },
  });
  try {
    const { account } = await withAbort(query.initializationResult(), signal);
    if (account.apiProvider !== "firstParty" || !account.subscriptionType || account.apiKeySource !== undefined) return null;
    signal.throwIfAborted();
    const usage = await withAbort(query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      skipBehaviors: true,
    }), signal);
    return projectClaudeAccountUsage(usage, Date.now());
  } finally {
    prompt.close();
    controller.abort();
    query.close();
  }
}
