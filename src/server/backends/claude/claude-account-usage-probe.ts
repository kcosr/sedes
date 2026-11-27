import { randomUUID } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackendAccountUsageReport } from "../../../shared/protocol/account-usage.js";
import { withAbort } from "../../runtime/with-abort.js";
import { projectClaudeAccountUsage } from "./claude-account-usage-projection.js";
import type { ClaudeChildEnvironment } from "./claude-child-environment.js";
import { claudeQuotaAccountKey, permitsClaudeSubscriptionQuota } from "./claude-quota-account.js";
import type { ClaudeSdkSession } from "./claude-sdk-session.js";
import { ClaudeInputQueue } from "./claude-input-queue.js";
import type { ClaudeSdkFacade } from "./claude-sdk-facade.js";
import { assertClaudeSubscriptionAuthStatus } from "./claude-sdk-probe.js";
import { CLAUDE_ACCOUNT_USAGE_REFRESH_INTERVAL_MS, CLAUDE_ACCOUNT_USAGE_TIMEOUT_MS, type ClaudeAccountUsageObservation } from "./worker/claude-runtime-v4.js";

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
  if (!await withAbort(permitsClaudeSubscriptionQuota(cwd, input.environment, ["user"]), signal)) return null;
  signal.throwIfAborted();
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
    if (!accountKey) return null;
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

type AccountSample = NonNullable<Awaited<ReturnType<typeof readClaudeAccountUsage>>>;
type AccountQuery = { sessionId: string; launch: "new" | "resume" | "fork";
  session: Pick<ClaudeSdkSession, "closed" | "startupProbeUuid" | "quotaAccountKey"> };

/** Holds one neutral sample and its private login evidence for a single worker generation. */
export class ClaudeAccountUsageCache {
  #entry?: { observationId: string; expiresAt: number; sample: AccountSample };

  clear(): void { this.#entry = undefined; }

  store(sample: AccountSample): string {
    const observationId = randomUUID();
    this.#entry = { observationId, expiresAt: performance.now() + CLAUDE_ACCOUNT_USAGE_REFRESH_INTERVAL_MS, sample };
    return observationId;
  }

  #current(observationId: string) {
    if (this.#entry && performance.now() >= this.#entry.expiresAt) this.clear();
    return this.#entry?.observationId === observationId ? this.#entry : undefined;
  }

  async observe(observationId: string, queries: Iterable<AccountQuery>): Promise<ClaudeAccountUsageObservation | null> {
    const entry = this.#current(observationId);
    if (!entry) return null;
    const candidates = await Promise.all(Array.from(queries, async ({ session, launch, sessionId }) => {
      const proof = session.quotaAccountKey;
      if (launch === "fork" || !proof || await proof !== entry.sample.accountKey) return null;
      // Another init or login can invalidate the proof while settings are resolving.
      if (session.closed || !session.startupProbeUuid || session.quotaAccountKey !== proof) return null;
      return { sessionId, startupProbeUuid: session.startupProbeUuid };
    }));
    if (this.#current(observationId) !== entry) return null;
    return { observationId, usage: entry.sample.usage, verifiedSessions: candidates.filter(candidate => candidate !== null) };
  }
}
