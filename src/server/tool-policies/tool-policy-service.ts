import {
  toolPolicyDefinitionSchema,
  toolPolicySelectionSchema,
  resolvedToolPolicySchema,
  toolPolicyOptionsSchema,
  toolPolicyPreviewSchema,
  type ToolPolicyDefinition,
  type ToolPolicySelection,
  type ToolPolicySet,
  type ToolPolicySelectionTarget,
  type ToolPolicySelectionSetting,
  type ResolvedToolPolicy,
  type ToolPolicyInspection,
  type ToolPolicyPreview,
} from "../../shared/protocol/tool-policies.js";
import type { ConfigurationRepository } from "../configuration-admin/configuration-repository.js";
import { ToolPolicyRepository } from "../db/repositories/tool-policy-repository.js";
import { DomainError } from "../domain/errors.js";
import { ToolPolicyResolutionError } from "./tool-policy-errors.js";
import { createThreadAgentToolPolicyDependencies, presentationOptionsForBackend } from "../conversations/thread-agent-tool-policy-dependencies.js";
import type { ThreadAgentToolCatalogReader } from "../conversations/database-thread-application-readers.js";
import { boundDisplayText } from "../conversations/payload-policy.js";
import type { BackendKind } from "../backends/contracts.js";
import type { RequestScope } from "../identity/identity-provider.js";

export type PolicyResolutionInput = {
  readonly target: { readonly backendId: string; readonly executionEnvironmentId: string };
  readonly agentSelection?: ToolPolicySelection;
  readonly threadSelection?: ToolPolicySelection;
};

/** Resolves principal-owned defaults without changing execution configuration or runtimes. */
export class ToolPolicyService {
  constructor(
    readonly repository: ToolPolicyRepository,
    readonly configuration?: ConfigurationRepository,
    readonly catalog: ThreadAgentToolCatalogReader = createThreadAgentToolPolicyDependencies().catalog,
    readonly savedAgentBackendType?: (backendId: string) => string | undefined,
  ) {}

  options(_scope: RequestScope) {
    return toolPolicyOptionsSchema.parse({
      groups: this.catalog.list().groups.map(group => ({
        ...group,
        label: boundDisplayText(group.label),
        description: boundDisplayText(group.description),
        tools: group.tools.map(tool => ({
          id: tool.id,
          order: tool.order,
          effects: tool.effects,
          available: tool.available,
          label: boundDisplayText(tool.label),
          enabled: false,
          ...(tool.description ? { description: boundDisplayText(tool.description) } : {}),
          ...(tool.unavailableReason ? { unavailableReason: boundDisplayText(tool.unavailableReason) } : {}),
        })),
      })),
    });
  }

  list(scope: RequestScope, input: {cursor?: string;pageSize?: number} = {}) {
    return this.repository.listPage(scope,input);
  }

  get(scope: RequestScope, id: string): ToolPolicySet {
    return this.repository.get(scope, id);
  }

  create(scope: RequestScope, input: ToolPolicyDefinition): ToolPolicySet {
    return this.repository.create(scope, this.validateDefinition(input));
  }

  update(
    scope: RequestScope,
    id: string,
    input: ToolPolicyDefinition & { expectedRevision: number },
  ): ToolPolicySet {
    const definition = this.validateDefinition({
      name: input.name,
      enabledToolIds: input.enabledToolIds,
      resourceScope: input.resourceScope,
    });
    return this.repository.update(scope, id, definition, input.expectedRevision);
  }

  delete(scope: RequestScope, id: string, expectedRevision: number): { deleted: true } {
    this.repository.delete(scope, id, expectedRevision);
    return { deleted: true };
  }

  assertSelection(scope: RequestScope, selection: ToolPolicySelection): void {
    this.repository.assertSelection(scope, toolPolicySelectionSchema.parse(selection));
  }

  listSelections(scope: RequestScope): { items: ToolPolicySelectionSetting[] } {
    return { items: this.repository.listSelections(scope) };
  }

  updateSelection(scope: RequestScope, input: {
    target: ToolPolicySelectionTarget;
    selection: ToolPolicySelection;
    expectedRevision: number;
  }): ToolPolicySelectionSetting {
    this.assertTarget(scope, input.target);
    return this.repository.updateSelection(scope, input.target, input.selection, input.expectedRevision);
  }

  resolvePolicy(scope: RequestScope, input: PolicyResolutionInput): ResolvedToolPolicy {
    this.assertTarget(scope, { kind: "environment", executionEnvironmentId: input.target.executionEnvironmentId });
    this.assertTarget(scope, { kind: "backend", backendId: input.target.backendId });
    const levels: readonly [ResolvedToolPolicy["source"], ToolPolicySelection][] = [
      ["account", this.repository.getSelection(scope, { kind: "account" }).selection],
      ["environment", this.repository.getSelection(scope, { kind: "environment", executionEnvironmentId: input.target.executionEnvironmentId }).selection],
      ["backend", this.repository.getSelection(scope, { kind: "backend", backendId: input.target.backendId }).selection],
      ["agent", input.agentSelection ?? { kind: "inherit" }],
      ["thread", input.threadSelection ?? { kind: "inherit" }],
    ];
    // Only the nearest explicit selection contributes. An overridden missing
    // reference must not block a valid, more specific selection.
    const selected = [...levels].reverse().find(([, selection]) =>
      toolPolicySelectionSchema.parse(selection).kind !== "inherit",
    );
    const disabled = {
      enabled: false,
      enabledToolIds: [],
      resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false },
    };
    if (!selected) return { ...disabled, source: "default" };
    const [source, selection] = selected;
    if (selection.kind === "disabled") return { ...disabled, source };
    if (selection.kind !== "policy_set") throw new Error("tool_policy_selection_invalid");
    let policy: ToolPolicySet;
    try {
      policy = this.repository.get(scope, selection.policySetId);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "not_found") throw error;
      if (source === "default") throw new Error("default_policy_selection_invalid");
      throw new ToolPolicyResolutionError({kind:"missing_policy_set",source,policySetId:selection.policySetId});
    }
    return resolvedToolPolicySchema.parse({
      enabled: true,
      enabledToolIds: [...policy.enabledToolIds],
      resourceScope: { ...policy.resourceScope },
      source,
      policySet: { id: policy.id, name: policy.name, revision: policy.revision },
    });
  }

  inspectPolicy(scope: RequestScope, input: PolicyResolutionInput): ToolPolicyInspection {
    try {
      return {kind:"resolved",policy:this.resolvePolicy(scope,input)};
    } catch (error) {
      if (!(error instanceof ToolPolicyResolutionError)) throw error;
      return error.issue;
    }
  }

  preview(scope: RequestScope, input: {
    targetId: string;
    agentId?: string;
    agentSelection?: ToolPolicySelection;
    threadSelection?: ToolPolicySelection;
  }): ToolPolicyPreview {
    const profile = this.repository.database.prepare(`
      SELECT profile.backend_instance_id AS backendId,
        profile.execution_environment_id AS executionEnvironmentId,
        backend.kind AS backendKind, environment.kind AS environmentKind
      FROM agent_connection_profiles AS profile
      JOIN agent_backend_instances AS backend
        ON backend.tenant_id=profile.tenant_id
        AND backend.owner_principal_id=profile.owner_principal_id
        AND backend.id=profile.backend_instance_id
      JOIN execution_environments AS environment
        ON environment.tenant_id=profile.tenant_id
        AND environment.owner_principal_id=profile.owner_principal_id
        AND environment.id=profile.execution_environment_id
      WHERE profile.tenant_id=? AND profile.owner_principal_id=? AND profile.id=? AND profile.enabled=1
    `).get(scope.tenantId, scope.principalId, input.targetId) as (PolicyResolutionInput["target"] & {
      backendKind: BackendKind;
      environmentKind: "local" | "ssh" | "outbound";
    }) | undefined;
    if (!profile) throw new DomainError("not_found", "The execution target was not found.");
    let agentSelection = input.agentSelection;
    if (input.agentId) {
      const agent = this.repository.database.prepare(`
        SELECT tool_policy_selection_json AS selection, backend_type_id AS backendTypeId FROM saved_agents
        WHERE tenant_id=? AND owner_principal_id=? AND id=?
      `).get(scope.tenantId, scope.principalId, input.agentId) as { selection: string; backendTypeId: string } | undefined;
      if (!agent) throw new DomainError("not_found", "The Saved Agent was not found.");
      const targetType = this.savedAgentBackendType?.(profile.backendId);
      if (!targetType) throw new DomainError("runtime_unavailable", "The target's Saved Agent support is unavailable.");
      if (agent.backendTypeId !== targetType) throw new DomainError("conflict", "The Saved Agent uses a different backend type.");
      agentSelection ??= toolPolicySelectionSchema.parse(JSON.parse(agent.selection));
    }
    const policy = this.resolvePolicy(scope, {
      target: {backendId:profile.backendId,executionEnvironmentId:profile.executionEnvironmentId},
      ...(agentSelection ? { agentSelection } : {}),
      ...(input.threadSelection ? { threadSelection: input.threadSelection } : {}),
    });
    const presentationOptions = presentationOptionsForBackend(profile.backendKind,profile.environmentKind);
    const preferred = presentationOptions[0];
    const mode = preferred?.modes[0];
    if (!preferred || !mode) throw new DomainError("runtime_unavailable", "Sedes tool presentation is unavailable for this target.");
    return toolPolicyPreviewSchema.parse({...policy,presentationOptions,
      defaultPresentation:{surface:preferred.surface,mode},
    });
  }

  private validateDefinition(input: ToolPolicyDefinition): ToolPolicyDefinition {
    const definition = toolPolicyDefinitionSchema.parse(input);
    const eligible = createThreadAgentToolPolicyDependencies().eligibility.eligibleToolIds;
    if (definition.enabledToolIds.some(id => !eligible.has(id))) {
      throw new DomainError("bad_request", "The policy contains an unknown or ineligible Sedes tool.");
    }
    return definition;
  }

  private assertTarget(scope: RequestScope, target: ToolPolicySelectionTarget): void {
    if (target.kind === "account") return;
    const config = this.configuration?.get(scope).configuration;
    const found = config
      ? target.kind === "environment"
        ? config.executionEnvironments.some(item => item.id === target.executionEnvironmentId)
        : config.backends.some(item => item.id === target.backendId)
      : this.repository.database.prepare(target.kind === "environment"
        ? "SELECT 1 FROM execution_environments WHERE tenant_id=? AND owner_principal_id=? AND id=?"
        : "SELECT 1 FROM agent_backend_instances WHERE tenant_id=? AND owner_principal_id=? AND id=?",
      ).get(scope.tenantId, scope.principalId, target.kind === "environment" ? target.executionEnvironmentId : target.backendId);
    if (!found) throw new DomainError("not_found", "The tool policy selection target was not found.");
  }
}
