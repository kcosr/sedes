import {
  CODEX_ACCELERATED_SERVICE_TIERS,
  type CodexAcceleratedServiceTier,
  type CodexServiceTierSelection,
} from "./codex-service-tier.js";

export function encodeCodexModelSetting(
  modelId: string,
  defaultReasoningEffort: string,
  offeredServiceTiers: readonly CodexAcceleratedServiceTier[],
  defaultServiceTier: CodexServiceTierSelection,
): string {
  const value = `codex-model:${Buffer.from(
    JSON.stringify([
      modelId,
      defaultReasoningEffort,
      offeredServiceTiers,
      defaultServiceTier,
    ]),
    "utf8",
  ).toString("base64url")}`;
  if (value.length > 1_024) throw new Error("codex_model_setting_too_long");
  return value;
}

export function decodeCodexModelSetting(value: string): {
  readonly modelId: string;
  readonly defaultReasoningEffort: string;
  readonly offeredServiceTiers: readonly CodexAcceleratedServiceTier[];
  readonly defaultServiceTier: CodexServiceTierSelection;
} {
  if (!value.startsWith("codex-model:")) {
    throw new Error("codex_model_setting_invalid");
  }
  if (value.length > 1_024) throw new Error("codex_model_setting_invalid");
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(value.slice("codex-model:".length), "base64url").toString(
        "utf8",
      ),
    );
  } catch {
    throw new Error("codex_model_setting_invalid");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 4 ||
    typeof decoded[0] !== "string" ||
    decoded[0].length === 0 ||
    decoded[0].length > 120 ||
    typeof decoded[1] !== "string" ||
    decoded[1].length === 0 ||
    decoded[1].length > 120 ||
    !isOfferedServiceTierList(decoded[2]) ||
    (decoded[3] !== "standard" && !decoded[2].includes(decoded[3]))
  ) {
    throw new Error("codex_model_setting_invalid");
  }
  return {
    modelId: decoded[0] as string,
    defaultReasoningEffort: decoded[1] as string,
    offeredServiceTiers: decoded[2],
    defaultServiceTier: decoded[3] as CodexServiceTierSelection,
  };
}

/** Unique accelerated tiers in Sedes order. */
function isOfferedServiceTierList(
  value: unknown,
): value is CodexAcceleratedServiceTier[] {
  return (
    Array.isArray(value) &&
    value.every((tier) =>
      (CODEX_ACCELERATED_SERVICE_TIERS as readonly unknown[]).includes(tier),
    ) &&
    value.every(
      (tier, index) =>
        index === 0 ||
        CODEX_ACCELERATED_SERVICE_TIERS.indexOf(value[index - 1]) <
          CODEX_ACCELERATED_SERVICE_TIERS.indexOf(tier),
    )
  );
}
