import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackendAccountUsageReport } from "../../../shared/protocol/account-usage.js";
import { withAbort } from "../../runtime/with-abort.js";
import { projectClaudeAccountUsage } from "./claude-account-usage-projection.js";
import type { ClaudeChildEnvironment } from "./claude-child-environment.js";
import { claudeQuotaAccountKey, verifyClaudeQuotaSettings } from "./claude-quota-account.js";
import type { ClaudeSdkSession } from "./claude-sdk-session.js";
import { ClaudeInputQueue } from "./claude-input-queue.js";
import type { ClaudeSdkFacade } from "./claude-sdk-facade.js";
import { assertClaudeSubscriptionAuthStatus } from "./claude-sdk-probe.js";
import { CLAUDE_ACCOUNT_USAGE_TIMEOUT_MS, type ClaudeAccountUsageObservation } from "./worker/claude-runtime-v4.js";

/** A backend-account query. Its input stays open and never receives a message. */
export async function readClaudeAccountUsage(input: {
  readonly sdk: ClaudeSdkFacade;
  readonly executablePath: string;
  readonly environment: ClaudeChildEnvironment;
  readonly signal: AbortSignal;
}): Promise<{ usage: BackendAccountUsageReport; accountKey: string } | null> {
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
    const accountKey = claudeQuotaAccountKey(status, account);
    if (!accountKey || !await withAbort(verifyClaudeQuotaSettings(accountKey, cwd, input.environment, ["user"]), signal)) return null;
    signal.throwIfAborted();
    const report = await withAbort(query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      skipBehaviors: true,
    }), signal);
    const usage = projectClaudeAccountUsage(report, Date.now());
    return usage ? { usage, accountKey } : null;
  } finally {
    prompt.close();
    controller.abort();
    query.close();
  }
}

/** Only matching, live incarnations may receive this backend's quota. No login identity leaves the worker. */
export async function selectClaudeAccountUsageObservation(
  sample: Awaited<ReturnType<typeof readClaudeAccountUsage>>,
  queries: Iterable<{ sessionId: string; launch: "new" | "resume" | "fork";
    session: Pick<ClaudeSdkSession, "closed" | "startupProbeUuid" | "quotaAccountKey"> }>,
): Promise<ClaudeAccountUsageObservation | null> {
  if (!sample) return null;
  const candidates = await Promise.all(Array.from(queries, async ({ session, launch, sessionId }) => {
    const proof = session.quotaAccountKey;
    if (launch === "fork" || !proof || await proof !== sample.accountKey) return null;
    // Another init or login can invalidate the proof while settings are resolving.
    if (session.closed || !session.startupProbeUuid || session.quotaAccountKey !== proof) return null;
    return { sessionId, startupProbeUuid: session.startupProbeUuid };
  }));
  const verifiedSessions = candidates.filter(candidate => candidate !== null);
  return verifiedSessions.length ? { usage: sample.usage, verifiedSessions } : null;
}
