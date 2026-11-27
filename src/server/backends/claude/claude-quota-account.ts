import { createHash } from "node:crypto";
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
  "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
] as const;

function hasCredentialOverride(environment: ClaudeChildEnvironment | undefined): boolean {
  return quotaCredentialOverrides.some(name => Boolean(environment?.[name]));
}

/** Inspect the raw SDK settings cascade locally; project auth must never select another account's quota. */
export async function verifyClaudeQuotaSettings(
  accountKey: string, cwd: string, environment: ClaudeChildEnvironment, settingSources: SettingSource[],
): Promise<string | null> {
  try {
    if (hasCredentialOverride(environment)) return null;
    // resolveSettings reads user configuration through the worker process environment.
    assertClaudeSdkHelperEnvironment(environment);
    const { effective } = await withAbort(resolveSettings({ cwd, settingSources }), AbortSignal.timeout(1_000));
    // The SDK intentionally skips policyHelper. Its effective launch credentials are unknown.
    return effective.policyHelper || effective.apiKeyHelper || hasCredentialOverride(effective.env) ? null : accountKey;
  } catch {
    return null;
  }
}
