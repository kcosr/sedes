import { z } from "zod";
import type { BackendEffectiveSettings } from "../../../shared/protocol/backend.js";
import { DomainError } from "../../domain/errors.js";
import type { AgentConnectionProfile, BackendCatalog } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { OpenCodeConnectionDefaults } from "./opencode-backend-configuration.js";
import type { OpenCodeModelCatalogRead } from "./opencode-model-catalog.js";

const identifier = z.string().min(1).max(1_024).refine(value => Buffer.from(value, "utf8").toString("utf8") === value && !/\p{Cc}/u.test(value));
export const openCodeSelectionSchema = z.strictObject({ providerID: identifier, id: identifier,
  variant: identifier.optional() }).transform(({ variant, ...model }): OpenCodeSelection =>
  variant && variant !== "default" ? { ...model, variant } : model);
export type OpenCodeSelection = { readonly providerID: string; readonly id: string; readonly variant?: string };
export const openCodeObservationSchema = z.strictObject({
  nativeSelection: openCodeSelectionSchema.nullable(), resolvedSelection: openCodeSelectionSchema.nullable(),
  classification: z.enum(["recognized", "external_custom", "unavailable"]), catalogRevision: identifier,
}).refine(value => value.classification === "recognized"
  ? value.nativeSelection !== null && value.resolvedSelection !== null && sameOpenCodeSelection(value.nativeSelection, value.resolvedSelection)
  : value.resolvedSelection === null);
export type OpenCodeObservation = z.infer<typeof openCodeObservationSchema>;

/** Opaque normalized identity; native routing modelID is deliberately excluded. */
export function qualifiedOpenCodeModelId(ref: Pick<OpenCodeSelection, "providerID" | "id">): string {
  const value = encode("ocm_", [identifier.parse(ref.providerID), identifier.parse(ref.id)]);
  if (value.length > 240) throw unavailable("This OpenCode model identity is too long to select.");
  return value;
}
export function decodeOpenCodeModelId(value: string): Omit<OpenCodeSelection, "variant"> {
  const [providerID, id] = decode(value, "ocm_", 240);
  return { providerID, id };
}
export function encodeOpenCodeModelSetting(connectionId: string, modelId: string): string {
  decodeOpenCodeModelId(modelId);
  const value = encode("ocms_", [identifier.parse(connectionId), modelId]);
  if (value.length > 1_024) throw unavailable();
  return value;
}
export function decodeOpenCodeModelSetting(value: string): { readonly connectionId: string; readonly modelId: string } {
  const [connectionId, modelId] = decode(value, "ocms_", 1_024);
  decodeOpenCodeModelId(modelId);
  return { connectionId, modelId };
}
export function sameOpenCodeSelection(a: OpenCodeSelection | null, b: OpenCodeSelection | null): boolean {
  return a === null || b === null ? a === b : a.providerID === b.providerID && a.id === b.id &&
    (a.variant === "default" ? undefined : a.variant) === (b.variant === "default" ? undefined : b.variant);
}
export function assertOpenCodeCatalogPolicy(modelPolicy: CompiledBackendModelPolicy): void {
  if (modelPolicy.policy.type !== "catalog") throw unavailable("OpenCode supports only catalog model policy.");
}
export function resolveOpenCodeSelection(input: {
  readonly connection: AgentConnectionProfile; readonly catalog: BackendCatalog; readonly modelId: string;
  readonly variant?: string; readonly modelPolicy: CompiledBackendModelPolicy;
}): OpenCodeSelection {
  assertOpenCodeCatalogPolicy(input.modelPolicy);
  if (input.connection.kind !== "opencode_http") throw unavailable();
  return selectionInCatalog(input.modelId, input.variant, input.connection.id, input.catalog);
}
export function resolveOpenCodeDefaults(input: {
  readonly connection: AgentConnectionProfile; readonly catalog: BackendCatalog;
  readonly defaults: OpenCodeConnectionDefaults; readonly modelPolicy: CompiledBackendModelPolicy;
}): OpenCodeSelection {
  const modelId = input.defaults.model.type === "fixed" ? input.defaults.model.modelId
    : input.catalog.models.find(model => model.provider === input.connection.id && model.isDefault)?.id;
  if (!modelId) throw unavailable("Choose an available OpenCode model; no catalog default is available.");
  return resolveOpenCodeSelection({ ...input, modelId,
    variant: input.defaults.variant.type === "fixed" ? input.defaults.variant.variantId : "default" });
}
export function classifyObserved(input: {
  readonly selection: OpenCodeSelection | null; readonly catalog: OpenCodeModelCatalogRead;
}): OpenCodeObservation {
  // Native IDs have no length restriction. Unrepresentable external selections
  // remain readable/stoppable, but cannot gain normalized selection authority.
  const parsed = input.selection === null ? undefined : openCodeSelectionSchema.safeParse(input.selection);
  const selection = parsed?.success ? parsed.data : null;
  let classification: OpenCodeObservation["classification"] = "unavailable";
  if (selection) {
    let modelId: string | undefined;
    try { modelId = qualifiedOpenCodeModelId(selection); } catch { /* Not representable in normalized settings. */ }
    const native = modelId ? input.catalog.modelsById.get(modelId) : undefined;
    const descriptor = input.catalog.catalog.models.find(model => model.id === modelId);
    if (native && descriptor) classification = !selection.variant ||
      descriptor.supportedReasoningEfforts?.includes(selection.variant) ? "recognized" : "external_custom";
  }
  return { nativeSelection: selection, resolvedSelection: classification === "recognized" ? selection : null,
    classification, catalogRevision: input.catalog.revision };
}
/** Callers must supply the current qualified catalog; arbitrary variants never become effort. */
export function toEffective(selection: OpenCodeSelection, connectionId: string, catalog: BackendCatalog): BackendEffectiveSettings {
  const modelId = qualifiedOpenCodeModelId(selection);
  const checked = selectionInCatalog(modelId, selection.variant, connectionId, catalog);
  return { model: { provider: connectionId, id: modelId }, ...(checked.variant ? { thinkingLevel: checked.variant } : {}) };
}
function selectionInCatalog(modelId: string, variant: string | undefined, connectionId: string, catalog: BackendCatalog): OpenCodeSelection {
  const identity = decodeOpenCodeModelId(modelId);
  const descriptor = catalog.models.find(model => model.provider === connectionId && model.id === modelId);
  if (!descriptor || (variant && variant !== "default" && !descriptor.supportedReasoningEfforts?.includes(variant))) throw unavailable();
  return openCodeSelectionSchema.parse({ ...identity, ...(variant ? { variant } : {}) });
}
function encode(prefix: string, pair: readonly string[]): string { return prefix + Buffer.from(JSON.stringify(pair), "utf8").toString("base64url"); }
function decode(value: string, prefix: string, maximum: number): [string, string] {
  if (!value.startsWith(prefix) || value.length > maximum) throw unavailable();
  let pair: unknown;
  try { pair = JSON.parse(Buffer.from(value.slice(prefix.length), "base64url").toString("utf8")); } catch { throw unavailable(); }
  const parsed = z.tuple([identifier, identifier]).safeParse(pair);
  if (!parsed.success || encode(prefix, parsed.data) !== value) throw unavailable();
  return parsed.data;
}
function unavailable(message = "The selected OpenCode model or reasoning effort is unavailable."): DomainError {
  return new DomainError("invalid_transition", message);
}
