import { createHash } from "node:crypto";
import type { SettingDescriptor, ThreadSettingsSnapshot } from "../../../shared/protocol/conversation.js";
import type { ThreadBackendPresentationProvider } from "../../conversations/database-thread-application-readers.js";
import type { ThreadApplicationPresentation } from "../../conversations/thread-application-service.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import { assertOpenCodeCatalogPolicy, encodeOpenCodeModelSetting, qualifiedOpenCodeModelId, type OpenCodeSelection } from "./opencode-model-selection.js";
import type { OpenCodeThreadSettingsRepository } from "./opencode-thread-settings-repository.js";

export class OpenCodeThreadPresentationProvider implements ThreadBackendPresentationProvider {
  constructor(readonly input: { readonly scope: RequestScope; readonly backendInstanceId: string;
    readonly settings: OpenCodeThreadSettingsRepository; readonly modelPolicy: CompiledBackendModelPolicy }) {
    input.settings.assertScope(input.scope); assertOpenCodeCatalogPolicy(input.modelPolicy);
  }
  async read(input: Parameters<ThreadBackendPresentationProvider["read"]>[0]): Promise<ThreadApplicationPresentation> {
    this.input.settings.assertScope(input.scope);
    if (input.backend.id !== this.input.backendInstanceId || input.backend.kind !== "opencode" || input.backend.tenantId !== input.scope.tenantId ||
      input.connection.kind !== "opencode_http" || input.connection.backendInstanceId !== input.backend.id ||
      input.connection.tenantId !== input.scope.tenantId || input.connection.ownerPrincipalId !== input.scope.principalId ||
      (input.catalog !== undefined && input.workspace === undefined)) throw unavailable();
    const settings = this.input.settings.get(input.scope, input.applicationThreadId);
    if (settings.connectionProfileId !== input.connection.id || settings.executionEnvironmentId !== input.connection.executionEnvironmentId) throw unavailable();
    const thread = this.input.settings.database.prepare(`SELECT backing_state AS backingState FROM application_threads WHERE tenant_id=? AND owner_principal_id=? AND id=?`)
      .get(input.scope.tenantId, input.scope.principalId, input.applicationThreadId) as { backingState: string };
    const catalogKnown = input.catalog !== undefined;
    const models = (input.catalog?.models ?? []).filter(model => model.provider === input.connection.id).slice(0, 511);
    const desiredId = modelIdentity(settings.desired);
    const desiredModel = models.find(model => model.id === desiredId);
    const observed = settings.observationState === "confirmed" ? settings.observed : null;
    const effectiveSelection = observed?.classification === "recognized" ? observed.resolvedSelection : null;
    const effectiveId = modelIdentity(effectiveSelection);
    const modelOptions = models.map(model => ({ value: encodeOpenCodeModelSetting(input.connection.id, model.id), label: boundDisplayText(model.label), available: true }));
    const desiredValue = desiredId ? encodeOpenCodeModelSetting(input.connection.id, desiredId) : null;
    if (desiredValue && !modelOptions.some(option => option.value === desiredValue)) modelOptions.push({ value: desiredValue,
      label: boundDisplayText(`${settings.desired!.providerID}/${settings.desired!.id}${catalogKnown ? " (unavailable)" : ""}`), available: !catalogKnown });
    const efforts = desiredModel?.supportedReasoningEfforts ?? [];
    const effortOptions = efforts.map(value => ({ value, label: boundDisplayText(effortLabel(value)), available: true }));
    const desiredEffort = settings.desired ? settings.desired.variant ?? "default" : null;
    if (desiredEffort && !effortOptions.some(option => option.value === desiredEffort)) effortOptions.push({ value: desiredEffort,
      label: boundDisplayText(`${effortLabel(desiredEffort)}${catalogKnown ? " (unavailable)" : ""}`), available: !catalogKnown });
    const settingDescriptors: SettingDescriptor[] = [
      { id: "model", label: boundDisplayText("Model"), requiredForFirstSubmission: true, available: models.length > 0, options: modelOptions,
        ...(models.length === 0 ? { unavailableReason: boundDisplayText(catalogKnown ? "No OpenCode models are currently available." : "Refreshing the OpenCode model catalog.") } : {}) },
      { id: "thinking_level", label: boundDisplayText("Effort"), requiredForFirstSubmission: false, available: efforts.length > 0, options: effortOptions,
        ...(efforts.length === 0 ? { unavailableReason: boundDisplayText("Choose an available OpenCode model first.") } : {}) },
    ];
    const effectiveValue = effectiveId ? encodeOpenCodeModelSetting(input.connection.id, effectiveId) : null;
    const effectiveEffort = effectiveSelection ? effectiveSelection.variant ?? "default" : null;
    const unbound = thread.backingState === "unbound";
    const normalized: ThreadSettingsSnapshot = { revision: settings.revision, values: [
      { id: "model", desiredValue, effectiveValue, applicationState: state(unbound, desiredValue, effectiveValue, effectiveSelection !== null) },
      { id: "thinking_level", desiredValue: desiredEffort, effectiveValue: effectiveEffort,
        applicationState: state(unbound, desiredEffort, effectiveEffort, effectiveSelection !== null) },
    ] };
    const effectiveModel = models.find(model => model.id === effectiveId);
    const revision = createHash("sha256").update(JSON.stringify({ backendRevision: input.backend.configurationRevision,
      connectionRevision: input.connection.configurationRevision, settings, models, skills: input.catalog?.skills ?? [], catalogKnown })).digest("hex");
    return { revision: `opencode_${revision}`, backend: { label: boundDisplayText(input.backend.label), brand: "opencode",
      ...(effectiveModel || desiredModel ? { modelLabel: boundDisplayText((effectiveModel ?? desiredModel)!.label) } : {}) },
      interactionMode: "interactive", settings: normalized, settingDescriptors, nextTurnSettingIds: [],
      automationAllowed: !!desiredModel && !!desiredEffort && efforts.includes(desiredEffort) &&
        (observed === null || observed.classification === "recognized"),
      providerFeatureCapabilities: [], providerFeatureStates: [], composerCommands: [], skills: (input.catalog?.skills ?? []).map(skill => ({
        id: skill.id, name: boundDisplayText(skill.name), reference: skill.reference,
        ...(skill.displayName ? { displayName: boundDisplayText(skill.displayName) } : {}),
        ...(skill.description ? { description: boundDisplayText(skill.description) } : {}),
      })) };
  }
}
function modelIdentity(selection: OpenCodeSelection | null): string | null {
  if (!selection) return null;
  try { return qualifiedOpenCodeModelId(selection); } catch { return null; }
}
function state(unbound: boolean, desired: string | null, effective: string | null, confirmed: boolean): "draft" | "effective" | "pending_next_turn" {
  return unbound ? "draft" : confirmed && desired === effective ? "effective" : "pending_next_turn";
}
export function effortLabel(value: string): string { return value === "default" ? "Default" : value === "xhigh" ? "Extra high" : value[0]!.toUpperCase() + value.slice(1); }
function unavailable(): DomainError { return new DomainError("conflict", "The OpenCode thread target does not match its authority."); }
