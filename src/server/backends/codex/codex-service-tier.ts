import { z } from "zod";
import type { BackendModelDescriptor } from "../contracts.js";

export const CODEX_NATIVE_FAST_SERVICE_TIER = "priority";
export const CODEX_NATIVE_STANDARD_SERVICE_TIER = "default";
export const CODEX_NATIVE_ULTRAFAST_SERVICE_TIER = "ultrafast";

export const codexServiceTierSelectionSchema = z.enum([
  "standard",
  "fast",
  "ultrafast",
]);
export type CodexServiceTierSelection = z.infer<
  typeof codexServiceTierSelectionSchema
>;

/** Selections that require a catalog-advertised native service tier. */
export const CODEX_ACCELERATED_SERVICE_TIERS = Object.freeze([
  "fast",
  "ultrafast",
] as const);
export type CodexAcceleratedServiceTier =
  (typeof CODEX_ACCELERATED_SERVICE_TIERS)[number];

export function isCodexAcceleratedServiceTier(
  selection: CodexServiceTierSelection,
): selection is CodexAcceleratedServiceTier {
  return selection !== "standard";
}

const NATIVE_BY_SELECTION: Readonly<Record<CodexServiceTierSelection, string>> =
  Object.freeze({
    standard: CODEX_NATIVE_STANDARD_SERVICE_TIER,
    fast: CODEX_NATIVE_FAST_SERVICE_TIER,
    ultrafast: CODEX_NATIVE_ULTRAFAST_SERVICE_TIER,
  });

export function encodeCodexServiceTier(
  selection: CodexServiceTierSelection,
): string {
  return NATIVE_BY_SELECTION[selection];
}

/**
 * Only explicit native sentinels are authoritative. `null` is inherited or
 * unset state and therefore cannot prove the closed Sedes selection.
 */
export function decodeCodexServiceTier(
  value: string | null,
): CodexServiceTierSelection | undefined {
  if (value === CODEX_NATIVE_STANDARD_SERVICE_TIER) return "standard";
  if (value === CODEX_NATIVE_FAST_SERVICE_TIER) return "fast";
  if (value === CODEX_NATIVE_ULTRAFAST_SERVICE_TIER) return "ultrafast";
  return undefined;
}

/** Maps a catalog service-tier id to its accelerated Sedes selection. */
export function decodeCodexCatalogServiceTier(
  id: string,
): CodexAcceleratedServiceTier | undefined {
  if (id === CODEX_NATIVE_FAST_SERVICE_TIER) return "fast";
  if (id === CODEX_NATIVE_ULTRAFAST_SERVICE_TIER) return "ultrafast";
  return undefined;
}

/** Standard is always offered; accelerated tiers need catalog metadata. */
export function codexModelOffersServiceTier(
  model: Pick<BackendModelDescriptor, "serviceTiers"> | undefined,
  selection: CodexServiceTierSelection,
): boolean {
  return (
    selection === "standard" ||
    model?.serviceTiers?.offered.some(
      (offered) => offered.selection === selection,
    ) === true
  );
}
