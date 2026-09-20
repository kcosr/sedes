import { z } from "zod";

export const CODEX_NATIVE_FAST_SERVICE_TIER = "priority";
export const CODEX_NATIVE_STANDARD_SERVICE_TIER = "default";
export const CODEX_NATIVE_ULTRAFAST_SERVICE_TIER = "ultrafast";

export const codexServiceTierSelectionSchema = z.enum(["standard", "fast"]);
export type CodexServiceTierSelection = z.infer<
  typeof codexServiceTierSelectionSchema
>;

export function encodeCodexServiceTier(
  selection: CodexServiceTierSelection,
): string {
  return selection === "fast"
    ? CODEX_NATIVE_FAST_SERVICE_TIER
    : CODEX_NATIVE_STANDARD_SERVICE_TIER;
}

/**
 * Only explicit native sentinels are authoritative. `null` is inherited or
 * unset state and therefore cannot prove the closed Sedes selection.
 */
export function decodeCodexServiceTier(
  value: string | null,
): CodexServiceTierSelection | undefined {
  if (value === CODEX_NATIVE_STANDARD_SERVICE_TIER) {
    return "standard";
  }
  return value === CODEX_NATIVE_FAST_SERVICE_TIER ? "fast" : undefined;
}
