import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolveSettings, type AccountInfo, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { assertClaudeSdkHelperEnvironment, type ClaudeChildEnvironment } from "./claude-child-environment.js";
import { withAbort } from "../../runtime/with-abort.js";
import type { ClaudeCliAuthStatus } from "./claude-sdk-facade.js";

const quotaAccountSchema = z.strictObject({
  email: z.email().max(320),
  organizationId: z.uuid(),
  organizationName: z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/u),
});
export type ClaudeQuotaAccount = z.infer<typeof quotaAccountSchema>;

export function parseClaudeQuotaAccount(status: Record<string, unknown>): ClaudeQuotaAccount | undefined {
  const result = quotaAccountSchema.safeParse({
    email: status.email, organizationId: status.orgId, organizationName: status.orgName,
  });
  return result.success ? result.data : undefined;
}

/** The SDK reports the organization name. Bind that login to its CLI organization UUID. */
export function claudeQuotaAccountKey(status: ClaudeCliAuthStatus, account: AccountInfo): string | null {
  const login = status.quotaAccount;
  if (!status.loggedIn || status.authMethod !== "claude.ai" || status.apiProvider !== "firstParty" ||
      status.apiKeySource !== undefined || !status.subscriptionType ||
      account.apiProvider !== "firstParty" || account.apiKeySource !== undefined || !account.subscriptionType ||
      (account.tokenSource !== undefined && account.tokenSource !== "oauth") ||
      !login || account.email !== login.email || account.organization !== login.organizationName) return null;
  return createHash("sha256").update(JSON.stringify([login.organizationId, login.email])).digest("hex");
}

const quotaCredentialOverrides = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_SESSIONS_OAUTH_TOKEN", "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR", "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
] as const;

function hasCredentialOverride(environment: ClaudeChildEnvironment | undefined): boolean {
  return quotaCredentialOverrides.some(name => Boolean(environment?.[name]));
}

/** The settings resolver uses the worker's home and native configuration directory. */
function usesWorkerLoginEnvironment(environment: ClaudeChildEnvironment): boolean {
  if (hasCredentialOverride(environment) || (environment.HOME !== undefined && environment.HOME !== homedir())) return false;
  assertClaudeSdkHelperEnvironment(environment);
  return true;
}

export async function permitsClaudeSubscriptionQuota(
  cwd: string, environment: ClaudeChildEnvironment, settingSources: SettingSource[],
): Promise<boolean> {
  try {
    if (!usesWorkerLoginEnvironment(environment)) return false;
    const { effective } = await withAbort(resolveSettings({ cwd, settingSources }), AbortSignal.timeout(1_000));
    // resolveSettings skips dynamic policy from both the generic and per-OS helper.
    if (effective.policyHelper || "policyHelpers" in effective || effective.apiKeyHelper) return false;
    return usesWorkerLoginEnvironment({ ...environment, ...effective.env });
  } catch {
    return false;
  }
}

export async function verifyClaudeQuotaSettings(
  accountKey: string, cwd: string, environment: ClaudeChildEnvironment, settingSources: SettingSource[],
): Promise<string | null> {
  return await permitsClaudeSubscriptionQuota(cwd, environment, settingSources) ? accountKey : null;
}
