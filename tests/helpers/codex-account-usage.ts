import type { OfficialCodexClientRequestResult } from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";

export function codexAccountUsageResult(): OfficialCodexClientRequestResult<"account/rateLimits/read"> {
  const ordinary = {
    limitId: "codex",
    limitName: "Codex",
    normalModelSlug: null,
    primary: null,
    secondary: { usedPercent: 72, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: "promax" as const,
    rateLimitReachedType: null,
  };
  return {
    ordinaryUsageAllowed: true,
    rateLimits: ordinary,
    rateLimitsByLimitId: { codex: ordinary },
    rateLimitResetCredits: null,
    accountId: "account-1",
    rateLimitUpsell: null,
  };
}
