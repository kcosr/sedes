export function encodeCodexModelSetting(
  modelId: string,
  defaultReasoningEffort: string,
  supportsFastMode: boolean,
  defaultServiceTier: "standard" | "fast",
): string {
  const value = `codex-model:${Buffer.from(
    JSON.stringify([
      modelId,
      defaultReasoningEffort,
      supportsFastMode,
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
  readonly supportsFastMode: boolean;
  readonly defaultServiceTier: "standard" | "fast";
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
    typeof decoded[2] !== "boolean" ||
    (decoded[3] !== "standard" && decoded[3] !== "fast") ||
    (!decoded[2] && decoded[3] !== "standard")
  ) {
    throw new Error("codex_model_setting_invalid");
  }
  return {
    modelId: decoded[0] as string,
    defaultReasoningEffort: decoded[1] as string,
    supportsFastMode: decoded[2] as boolean,
    defaultServiceTier: decoded[3] as "standard" | "fast",
  };
}
