import type { ConfigurationDocument, ConfigurationEffect, ConfigurationRuntimeState } from "../../shared/protocol/configuration-admin.js";
import { providerLaunchDigest } from "../backends/provider-launch-digest.js";
import { configurationFingerprint } from "../config/configuration-fingerprint.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { compareIds, rootGrantId } from "./configuration-execution-policy.js";

type Kind = ConfigurationRuntimeState["resourceKind"];
type Input = Pick<ConfigurationEffect, "component" | "subjectId" | "state" | "subjectLabel" | "providerLaunch"> & { value: string };
const key = (effect: Pick<Input, "component" | "subjectId">) => `${effect.component}:${effect.subjectId}`;

/** Classify the field actually changed; presentation and future defaults never create a remote apply operation. */
function inputs(scope: RequestScope, document: ConfigurationDocument, kind: Kind, id: string): Map<string, Input> {
  const result = new Map<string, Input>();
  function add(component: Input["component"], subjectId: string, state: Input["state"], value: unknown, subjectLabel?: string) {
    result.set(key({ component, subjectId }), { component, subjectId, state, ...(subjectLabel ? { subjectLabel } : {}), value: configurationFingerprint(value) });
  }
  const backend = document.backends.find(item => item.id === id);
  const bindings = document.targets.filter(target => target.backendInstanceId === id);
  const environment = document.executionEnvironments.find(item => item.id === (kind === "environment" ? id : bindings[0]?.executionEnvironmentId));
  if (!environment) return result;
  const live = environment.kind === "local" ? "applied" : "awaiting_host";
  if (kind === "environment") {
    add("presentation", id, "applied", environment.label);
    add("defaults", "execution_variables", "future_defaults", environment.environmentVariables?.execution ?? {});
    if (Object.keys(environment.environmentVariables?.startup ?? {}).length) {
      add("defaults", "startup_variables", "next_launch", environment.environmentVariables?.startup);
    }
    for (const path of environment.workspaceRoots) {
      const root = rootGrantId(scope, id, path);
      add("host_policy", `root:${root}`, live, path, path);
    }
    if (environment.kind === "local") add("host_policy", "workspace_isolation", live, environment.workspaceIsolation);
    else {
      add("connection_compression", id, "next_attachment", environment.connectionCompression);
      if (environment.operations.kind === "sidecar") for (const capability of environment.operations.enabledCapabilities) {
        add("host_policy", `capability:${capability}`, live, true);
      }
    }
    for (const instance of document.backends.filter(candidate => candidate.enabled && document.targets.some(target =>
      target.backendInstanceId === candidate.id && target.executionEnvironmentId === id))) {
      add("host_policy", `backend:${instance.id}`, live, true);
    }
    return result;
  }
  if (!backend) return result;
  add("presentation", id, "applied", backend.label);
  add("defaults", "execution_variables", "future_defaults", backend.environmentVariables?.execution ?? {});
  if (backend.enabled) add("host_policy", `backend:${id}`, live, true);
  const module = "moduleConfiguration" in backend ? backend.moduleConfiguration : null;
  const policy = module && "policy" in module ? module.policy : module && "permissionPolicy" in module ? module.permissionPolicy : null;
  add("defaults", "admission_policy", "applied", { policy, modelPolicy: backend.modelPolicy });
  // Failure to install a launch edit must never grant a second process under the superseded identity.
  if (backend.enabled) {
    const digest = providerLaunchDigest(backend, environment.environmentVariables?.startup);
    const launch: Input = { component: "provider_launch", subjectId: id, state: "next_launch", value: digest,
      providerLaunch: {owner: environment.kind === "local" || backend.kind === "pi" ? "main" : "host", desiredDigest: digest, confirmedDigest: null} };
    result.set(key(launch), launch);
  }
  if (backend.enabled && backend.kind !== "pi" && environment.kind !== "local" && environment.operations.kind === "sidecar"
      && environment.operations.enabledCapabilities.includes("agent_tools_cli")) {
    const label = backend.kind === "pi_native" || backend.kind === "antigravity" ? "Tool access for new provider sessions" : "Provider tool access";
    add("host_policy", `route:${id}`, live, true, label);
  }
  if (backend.enabled && backend.kind === "codex_app_server") add("host_policy", `managed_tui:${id}`, environment.kind === "local" ? "next_launch" : live, backend.moduleConfiguration.tuiExecutablePath ?? null);
  for (const target of [...bindings].sort(compareIds)) {
    add("presentation", `target:${target.id}`, "applied", target.label);
    if (target.enabled) add("host_policy", `target:${target.id}`, live, true);
    if ("moduleConfiguration" in target) add("defaults", `target:${target.id}`, "future_defaults", target.moduleConfiguration);
    if (target.id === document.defaultTargetId) add("defaults", "default_target", "future_defaults", target.id);
  }
  return result;
}

export function changedConfigurationEffects(scope: RequestScope, previous: ConfigurationDocument, document: ConfigurationDocument,
  kind: Kind, id: string, revision: number, current: ConfigurationRuntimeState | undefined): ConfigurationEffect[] | undefined {
  const before = inputs(scope, previous, kind, id);
  const after = inputs(scope, document, kind, id);
  const saved = new Map((current?.effects ?? []).map(effect => [key(effect), effect]));
  // Retire obsolete evidence once its withdrawal is settled. An absent subject still awaiting host acknowledgment stays visible.
  const retained = new Map([...saved].filter(([k, e]) =>
    after.has(k) || (e.component === "host_policy" && e.state === "awaiting_host") || (e.component === "ownership" && !document.backends.some(backend => backend.id === id && backend.enabled))));
  let changed = false;
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(k);
    const next = after.get(k);
    if (old?.value === next?.value) continue;
    changed = true;
    const input = (next ?? old)!;
    // Initial installation establishes the launch specification; a newly added provider has no process to restart.
    if (input.component === "provider_launch" && (!old || !next)) continue;
    const previousEffect = saved.get(k);
    const launch = input.providerLaunch && { ...input.providerLaunch, confirmedDigest: previousEffect?.providerLaunch?.confirmedDigest ?? null };
    const restart = launch?.owner === "host" ? Boolean(launch.confirmedDigest && launch.confirmedDigest !== launch.desiredDigest) : current?.connectionState === "connected";
    const state = launch && restart ? "restart_backend" : input.state;
    const pending = state === "awaiting_host" || state === "next_launch" || state === "restart_backend";
    retained.set(k, { component: input.component, subjectId: input.subjectId, state, desiredRevision: revision,
      effectiveRevision: pending ? previousEffect?.effectiveRevision ?? null : revision,
      ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
      ...(launch ? {providerLaunch: launch} : {}),
      ...(!next ? { detail: "Removed from the saved configuration." } : {}),
      ...(previousEffect?.lastHostConfirmation ? { lastHostConfirmation: previousEffect.lastHostConfirmation } : {}) });
  }
  // One host can accumulate arbitrary churn while disconnected. Keep current subjects and one
  // combined evidence row for an older batch of withdrawals if their individual rows exceed the bound.
  if (retained.size > 512) {
    for (const [k, e] of retained) if (e.component === "host_policy" && !after.has(k)) retained.delete(k);
    const effect: ConfigurationEffect = { component: "host_policy", subjectId: "withdrawals", state: "awaiting_host",
      desiredRevision: revision, effectiveRevision: null, detail: "Previously saved removals are awaiting host confirmation." };
    retained.set(key(effect), effect);
  }
  return changed || !current ? [...retained.values()] : undefined;
}


export function observeProviderLaunch(runtime: ConfigurationRuntimeState, effects: ConfigurationEffect[], desiredDigest: string,
  reportedDigest: string | undefined, confirmation: NonNullable<ConfigurationEffect["lastHostConfirmation"]>): void {
  const index = effects.findIndex(effect => effect.component === "provider_launch");
  const before = effects[index];
  if (!before && !reportedDigest) return;
  // A normal reattachment to the same service keeps the admitted runtime. A different service cannot
  // inherit its process evidence. Missing inventory by itself neither proves launch nor retirement.
  const sameService = before?.lastHostConfirmation?.incarnation === confirmation.incarnation;
  const confirmedDigest = reportedDigest ?? (sameService ? before?.providerLaunch?.confirmedDigest : null) ?? null;
  const confirmedAt = reportedDigest ? confirmation : sameService ? before?.lastHostConfirmation : undefined;
  const desiredRevision = before?.desiredRevision ?? runtime.desiredRevision;
  const state = !confirmedDigest ? "next_launch" : confirmedDigest === desiredDigest ? "applied" : "restart_backend";
  const effect: ConfigurationEffect = { component: "provider_launch", subjectId: runtime.resourceId, state, desiredRevision,
    effectiveRevision: state === "applied" ? desiredRevision : sameService && before?.effectiveRevision !== desiredRevision ? before?.effectiveRevision ?? null : null,
    providerLaunch: {owner:"host", desiredDigest, confirmedDigest}, ...(confirmedAt ? {lastHostConfirmation: confirmedAt} : {}) };
  if (index === -1) effects.push(effect);
  else effects[index] = effect;
}
