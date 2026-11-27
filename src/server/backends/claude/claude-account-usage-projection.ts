import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  MAXIMUM_ACCOUNT_USAGE_MODEL_LABEL_LENGTH,
  MAXIMUM_ACCOUNT_USAGE_WINDOWS,
  type BackendAccountUsage,
} from "../../../shared/protocol/account-usage.js";

type UsageWindow = BackendAccountUsage["windows"][number];
type Limits = NonNullable<SDKControlGetUsageResponse["rate_limits"]>;
const WEEK = 7 * 24 * 60;
const resetTimestamp = z.iso.datetime({ offset: true });
const fableFamily = "claude:fable";

/** Catalog choices already use resolved IDs; an unresolved alias has no quota key. */
export function claudeAccountUsageModelKeys(model: string | null): string[] | undefined {
  if (!model || model.length > 160) return undefined;
  const version = /^claude-fable-(\d+(?:-\d+)*)(?:\[1m\])?$/.exec(model)?.[1];
  return version ? [`${fableFamily}-${version}`, fableFamily] : undefined;
}

function modelKey(label: string): string | null {
  if (/^fable$/i.test(label)) return fableFamily;
  const version = /^fable (\d+(?:\.\d+)*)$/i.exec(label)?.[1];
  return version ? `${fableFamily}-${version.replaceAll(".", "-")}` : null;
}

function projectWindow(
  row: Limits["seven_day"],
  durationMinutes: number,
  scope: UsageWindow["scope"],
): UsageWindow | null {
  if (!row || typeof row.utilization !== "number" || !Number.isFinite(row.utilization)) return null;
  let resetsAt: number | null = null;
  if (row.resets_at !== null) {
    if (!resetTimestamp.safeParse(row.resets_at).success) return null;
    resetsAt = Date.parse(row.resets_at);
    if (!Number.isSafeInteger(resetsAt) || resetsAt < 0) return null;
  }
  return {
    durationMinutes,
    remainingPercent: 100 - Math.max(0, Math.min(100, row.utilization)),
    resetsAt,
    scope,
  };
}

/** Only included subscription quota can leave the execution host. */
export function projectClaudeAccountUsage(
  result: SDKControlGetUsageResponse,
  capturedAt: number,
): BackendAccountUsage | null {
  if (result.behaviors !== null || result.rate_limits_available !== true || !result.rate_limits) return null;
  const limits = result.rate_limits;
  const account = { kind: "account" } as const;
  const windows = [
    projectWindow(limits.five_hour, 5 * 60, account),
    projectWindow(limits.seven_day, WEEK, account),
  ].filter(window => window !== null);

  // Retain space for the family and its versioned rows ahead of informational rows.
  let familyWindow: UsageWindow | undefined;
  const versions = new Map<string, UsageWindow>();
  const otherModels = new Map<string, UsageWindow>();
  function addModel(label: string, row: Limits["seven_day"]) {
    if (!label || label.length > MAXIMUM_ACCOUNT_USAGE_MODEL_LABEL_LENGTH) return;
    const key = modelKey(label);
    const window = projectWindow(row, WEEK, { kind: "model", label, key });
    if (!window) return;
    if (key === fableFamily) {
      familyWindow ??= window;
      return;
    }
    const bucket = key === null ? otherModels : versions;
    const id = key ?? label.toLowerCase();
    if (bucket.size < MAXIMUM_ACCOUNT_USAGE_WINDOWS && !bucket.has(id)) bucket.set(id, window);
  }
  if (Array.isArray(limits.model_scoped)) {
    for (const row of limits.model_scoped) {
      if (typeof row?.display_name === "string") addModel(row.display_name.trim(), row);
    }
  }
  addModel("Opus", limits.seven_day_opus);
  addModel("Sonnet", limits.seven_day_sonnet);
  if (familyWindow) windows.push(familyWindow);
  windows.push(...versions.values(), ...otherModels.values());
  if (!windows.length) return null;

  const plan = typeof result.subscription_type === "string" ? result.subscription_type.trim() : "";
  return {
    capturedAt,
    accountId: null,
    includedUsageAllowed: null,
    plan: plan && plan.length <= 80 ? plan[0]!.toUpperCase() + plan.slice(1) : null,
    windows: windows.slice(0, MAXIMUM_ACCOUNT_USAGE_WINDOWS),
  };
}
