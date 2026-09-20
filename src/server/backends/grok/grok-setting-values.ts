export function encodeGrokModelSetting(
  modelId: string,
  reasoningEffort: string,
): string {
  const value = `grok-model:${Buffer.from(
    JSON.stringify([modelId, reasoningEffort]),
    "utf8",
  ).toString("base64url")}`;
  if (value.length > 1_024) throw new Error("grok_model_setting_too_long");
  return value;
}

export function decodeGrokModelSetting(value: string): {
  readonly modelId: string;
  readonly reasoningEffort: string;
} {
  if (!value.startsWith("grok-model:") || value.length > 1_024) {
    throw new Error("grok_model_setting_invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(value.slice("grok-model:".length), "base64url").toString(
        "utf8",
      ),
    );
  } catch {
    throw new Error("grok_model_setting_invalid");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    typeof decoded[0] !== "string" ||
    decoded[0].length < 1 ||
    decoded[0].length > 240 ||
    typeof decoded[1] !== "string" ||
    decoded[1].length < 1 ||
    decoded[1].length > 120
  ) {
    throw new Error("grok_model_setting_invalid");
  }
  return { modelId: decoded[0], reasoningEffort: decoded[1] };
}
